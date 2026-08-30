import { create } from 'zustand';
import type {
  Board,
  ChipDef,
  ChipLibrary,
  Circuit,
  Component,
  ComponentKind,
  Junction,
  ParamValue,
  Point,
  TimingSetting,
  Wire,
} from '../../core/model/types';
import { compile, CompileError, type CompiledCircuit } from '../../core/model/compile';
import { getPrimitive, hasPrimitive } from '../../core/sim/primitives/registry';
import {
  parsePinView,
  serializePinView,
  type PinViewState,
} from '../../core/sim/primitives/busPins';
import { Simulator } from '../../core/sim/kernel';
import { idealDelay, datasheetDelay } from '../../core/sim/delay';
import * as bv from '../../core/value/busValue';
import { busSignalState, type SignalState } from '../../render/theme';
import { History, applyToCircuit, diffCircuits, type ApplyFn } from './history';
import type { WireEnd } from '../../core/model/types';
import { cloneCircuit, derivePins, detachRemovedPins, findCycle, renamePinRefs } from './packaging';
import {
  attachAtHit,
  collapseJunctions,
  findWireHit,
  findWireHitsAt,
  junctionNear,
  type ResolveWireEnd,
  type WireHit,
} from './junctions';
import { autoRoute, type RoutableComponent } from './autoRoute';
import { splicePins } from './spliceOnWire';
import { wireWidth } from './pinTargets';
import {
  dataPinOf,
  deriveOutputLabels,
  labelDirectionConflict,
  labelSync,
  labelSyncForOutput,
  labelUsedElsewhere,
  netTouchedPins,
  nextLabel,
  ownNetTerminalIds,
  type NetConflict,
} from './labelSync';
import type { PinRef } from '../../core/gates/netGraph';

/** labelSync's per-net NetConflict plus a display heading, so a dialog with
 *  several rows (Task 6/7) can tell them apart -- the derived output-pin
 *  label (`dec1.y0`) for a naming-a-part conflict, or the first candidate
 *  label for a plain IO-device inheritance conflict. */
export interface LabelConflictRow extends NetConflict {
  heading: string;
}
import {
  stretchWirePoints,
  groupRotateComponent,
  rotateAboutPivot,
  halfSnap,
  type GroupRotateItem,
  type GroupRotateResult,
} from './wireGeom';
import { lowerCircuit } from '../../core/gates/lower';
import {
  composeKind,
  decomposeKind,
  getOutputBubble,
  importCircuit,
  isGateFamilyKind,
  withOutputBubble,
  type GateFamilyKind,
} from '../../core/gates/bubbleModel';
import { OUTPUT_TERMINAL_KINDS, truthTableOf } from '../../core/gates/verify';
import type { TruthTable } from '../../core/boolean/truthTable';
import { commitPush, previewPush, type PushMove, type PushPreview } from './bubble/pushController';
import type { NetChangeRecord } from '../../core/sim/kernel';
import { buildReplayIndex, replayNetValue, type ReplayIndex } from '../../core/timing/traceView';
import { analyzeTiming, TimingError, type TimingReport } from '../../core/timing/sta';
import { getPrefs } from '../prefs';
import type { TerminalFocus } from './bubble/focusOrder';
import { splitDoubleInverter, type TransformGeom } from '../../core/gates/transform';

export type { ResolveWireEnd };

/** Outcome of a wire-completion attempt onto a wire's body/junction:
 *  'connected' commits, 'miss' means there was nothing there to attach to
 *  (caller falls back to add-a-bend, P1.6), 'rejected' means something WAS
 *  there but the connection is illegal (e.g. an In/Out label direction
 *  conflict) -- distinct from 'miss' so the caller can leave the pending wire
 *  untouched instead of planting a bend on top of the rejected target. */
export type WireAttachResult = 'connected' | 'rejected' | 'miss';

export type Tool =
  | { kind: 'select' }
  /** Marquee-select from wherever the press lands. Select's empty-canvas drag
   *  does the same on a mouse; this is the explicit form, and on touch the only
   *  one, since a bare finger drag there is always a pan. */
  | { kind: 'lasso' }
  | { kind: 'wire' }
  | { kind: 'junction' }
  | { kind: 'cut' }
  | {
      kind: 'place';
      componentKind: ComponentKind;
      params?: Record<string, ParamValue>;
      defId?: string;
      /** Keep placing after a drop instead of falling back to Select. Off by
       *  default: one tap, one part. Armed by Ctrl+click on the canvas
       *  (desktop) or a long press on the palette item (touch). */
      repeat?: boolean;
    };

/** One open editor surface: the board, or a ChipDef opened via "open internals".
 *  `prefix` is the hierarchical path prefix (compile.ts's `main/<inst>:<def>/`
 *  grammar) used to read this instance's live values off the parent sim. */
export type Tab =
  | { id: 'board'; kind: 'board' }
  | {
      id: string;
      kind: 'def';
      defId: string;
      prefix: string;
      breadcrumb: string;
      /** Snapshot of the def as it was when this tab opened -- defensively
       *  cloned (`cloneCircuit`) so it never aliases the live, editable def.
       *  Restored verbatim on Discard. */
      baseline: ChipDef;
    };

// Seeded past the starter board's own hardcoded ids (below) so a freshly
// generated id can never collide with one already on the board -- genId used
// to start at 1 regardless of what ids the board already had, so the Nth
// generated entity (any kind; the counter is shared across prefixes) landed
// on e.g. "w3" whenever N happened to match a starter wire's own suffix,
// silently duplicating that id (two Wire objects sharing one id breaks any
// id-keyed lookup, most visibly insert-on-wire's `wires.findIndex`).
let nextId = 1;
const genId = (prefix: string) => `${prefix}${nextId++}`;
// Display-friendly id prefixes where the kind name reads poorly on canvas
// (starter-board switches are sw1/sw2; a placed toggle should match).
const ID_PREFIX: Record<string, string> = { toggle: 'sw' };
const idPrefix = (kind: string) => ID_PREFIX[kind] ?? kind;
export const seedNextId = (board: Board) => {
  const idNum = (id: string) => Number(/(\d+)$/.exec(id)?.[1] ?? 0);
  const ids = [
    ...board.components.map((c) => c.id),
    ...board.wires.map((w) => w.id),
    ...board.junctions.map((j) => j.id),
  ];
  nextId = Math.max(nextId, ...ids.map(idNum).map((n) => n + 1));
};

export const VARIABLE_ARITY_GATES: ReadonlySet<string> = new Set([
  'and',
  'or',
  'nand',
  'nor',
  'xor',
  'xnor',
]);

const snapPoint = (p: Point, g: number): Point => ({
  x: Math.round(p.x / g) * g,
  y: Math.round(p.y / g) * g,
});

// AND of two toggles into an LED: a non-empty starting board so power-on
// coloring is visible before the instructor builds their own. led1's y is set
// so its 'a' pin resolves onto g1's 'y' pin row, keeping w3 a straight run; a
// test locks that alignment, since glyph geometry has moved before.
export function starterBoard(): Board {
  return {
    format: 'lcir.board',
    formatVersion: 5,
    id: 'scratch',
    name: 'scratch',
    components: [
      { id: 'sw1', kind: 'toggle', pos: { x: 64, y: 72 }, params: { initial: false } },
      { id: 'sw2', kind: 'toggle', pos: { x: 64, y: 144 }, params: { initial: false } },
      { id: 'g1', kind: 'and', pos: { x: 176, y: 96 } },
      { id: 'led1', kind: 'led', pos: { x: 320, y: 88 } },
    ],
    wires: [
      {
        id: 'w1',
        a: { kind: 'pin', component: 'sw1', pin: 'y' },
        b: { kind: 'pin', component: 'g1', pin: 'a' },
        points: [],
      },
      {
        id: 'w2',
        a: { kind: 'pin', component: 'sw2', pin: 'y' },
        b: { kind: 'pin', component: 'g1', pin: 'b' },
        points: [],
      },
      {
        id: 'w3',
        a: { kind: 'pin', component: 'g1', pin: 'y' },
        b: { kind: 'pin', component: 'led1', pin: 'a' },
        points: [],
      },
    ],
    junctions: [],
    probes: [],
    view: { x: 0, y: 0, zoom: 1 },
    timing: { mode: getPrefs().timingModel, datasheet: 'typ' },
  };
}

interface SimState {
  sim: Simulator;
  compiled: CompiledCircuit;
}

interface CircuitState {
  board: Board;
  chipLib: ChipLibrary;
  tabs: Tab[];
  activeTabId: string;
  /** Chip instances that lost a wire when a def edit removed one of its pins;
   *  cleared once a new wire touches that instance again. */
  staleInstances: Set<string>;
  tool: Tool;
  selection: Set<string>;
  /** Bumped when the board should be re-framed (Home) rather than keeping the
   *  camera it happens to have. The caller decides: a bundled example always
   *  frames (it ships no meaningful camera), the user's own boards follow the
   *  `fitOnOpen` preference. */
  fitRequest: number;
  rev: number; // bumped on any board/sim mutation to force a redraw
  powered: boolean;
  running: boolean;
  error: string | null;
  /** Wires touching the component a width edit made mismatched; warn-colored
   *  in the editor, cleared on the next successful edit. */
  mismatchWires: ReadonlySet<string>;
  changedPrims: Set<string>; // component paths changed by the last delta step
  timing: TimingSetting;

  // --- Bubble-push mode (M5 fold-in). None of these fields bump `rev`: the
  // canvas redraw effect must list them (or call draw() at the mutation
  // site) explicitly -- `rev` only signals board/sim mutations.
  mode: 'edit' | 'bubble';
  /** Truth table snapshotted at mode entry; the drawer's fixed "original"
   *  column and the reference every push is verified against. */
  bubbleBaseline: TruthTable | null;
  bubbleFocus: TerminalFocus | null;
  bubblePreview: { move: PushMove; result: PushPreview } | null;
  /** Insert-¬¬ tool: focus cycles wires, a click/Enter on one inserts a pair. */
  bubblePairMode: boolean;

  /** One or more nets, each with 2+ user-named labels, raised by a single
   *  edit (wire commit or a rename that touches several output nets at
   *  once, e.g. naming a decoder); the dialog picks a radio choice per row
   *  and commits every row at once via Apply. Esc/click-outside instead
   *  undoes the whole edit that raised the conflict (the rename itself
   *  reverts, not just the label choice). Analyze prefers the pin side
   *  until resolved. */
  labelConflict: LabelConflictRow[] | null;
  /** Apply: `choices[i]` is the chosen label for `labelConflict[i]` (written
   *  to every component on that row's net) or `null` to keep both -- every
   *  row commits in ONE edit/undo step. Clears the field either way. */
  applyLabelConflicts: (choices: (string | null)[]) => void;
  /** Esc / click-outside: undo the edit that raised the conflict (the
   *  attempted rename itself, not just the label choice) and close. */
  cancelLabelConflict: () => void;

  /** Id of a def tab whose close was deferred because it has uncommitted
   *  history -- the save/discard/cancel dialog is showing for it. */
  pendingTabClose: string | null;
  /** Save: close exactly as if the tab were clean (edits already live in
   *  chipLib). Discard: restore the def to its baseline (running it back
   *  through commitDefEdit so pin re-derivation, renamePinRefs, and
   *  detachRemovedPins all apply symmetrically to a forward edit) before
   *  closing. Board wires detached mid-session keep their re-bind badge --
   *  Discard restores the def only, never the board. */
  resolveTabClose: (action: 'save' | 'discard') => void;
  /** Esc / Cancel: dismiss the dialog, tab and its undo stack stay intact. */
  cancelTabClose: () => void;

  setTool: (tool: Tool) => void;
  setSelection: (ids: Set<string>) => void;
  /** The circuit body of the active tab: the board, or an open ChipDef. */
  activeCircuit: () => Circuit;
  openDefTab: (defId: string, prefix: string, breadcrumb: string) => void;
  /** No-op (dialog opens instead) when the tab's own undo history has at
   *  least one committed command -- see `resolveTabClose`. */
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  /** Replaces the working board wholesale (session restore, File > Open, New).
   *  Seeds the id counter past the loaded board's own ids -- generated ids
   *  otherwise collide with them and any id-keyed lookup becomes ambiguous --
   *  and drops history, selection and any running sim, since none of it
   *  describes this board. */
  loadBoard: (board: Board) => void;
  /** Ask the workbench to fit the board to the viewport, as Home does. */
  requestFit: () => void;
  /** Adds a freshly built def to the in-memory library; rejects a cycle. */
  commitNewChip: (def: ChipDef) => { ok: true } | { ok: false; error: string };
  /** Bulk-load defs read from the library folder. Merges over what is already
   *  in memory (a packaged-but-unsaved chip must survive connecting a folder)
   *  and bumps `rev`, since the canvas redraw effect watches `rev` and a load
   *  that lands after first paint would otherwise draw nothing. */
  loadChipDefs: (
    defs: readonly ChipDef[],
  ) => { ok: true; count: number } | { ok: false; error: string };
  /** Inline pin rename (P2.5, M4.2): sets a component's label, one undo step.
   *  Inside a def tab this reaches `commitDefEdit` -> `derivePins`, which
   *  re-syncs the boundary pin's name from the renamed In/Out component and
   *  propagates the new name to every wire referencing the old one, on the
   *  board and in every other def (`renamePinRefs`). Returns false (board
   *  unchanged) when the label is already used on a different net (decision
   *  6); the rename overlay warn-flashes on false. */
  renameComponent: (id: string, label: string) => boolean;
  place: (
    kind: ComponentKind,
    pos: Point,
    grid: number,
    params?: Record<string, ParamValue>,
    pose?: { rot?: Component['rot']; mirror?: boolean },
    defId?: string,
  ) => void;
  /** Insert-on-wire: splices a 1-in/1-out primitive into a hit wire. When
   *  `componentId` is given, that EXISTING component is moved to `pos` and
   *  spliced in place (its own kind/rot/mirror/params/label are kept, `kind`/
   *  `rot`/`params` here are ignored) instead of minting a new one --
   *  dragged/duplicate-placed components splice this way, one undo step. */
  insertOnWire: (opts: {
    kind: ComponentKind;
    params?: Record<string, ParamValue>;
    wireId: string;
    pos: Point;
    grid: number;
    inName: string;
    outName: string;
    upstreamEnd: WireEnd;
    downstreamEnd: WireEnd;
    rot?: Component['rot'];
    mirror?: boolean;
    /** Only for a fresh placement: the name to carry over, advanced to the
     *  next free one so a duplicate spliced onto a wire keeps its identity
     *  without colliding with the component it was copied from. */
    label?: string;
    componentId?: string;
  }) => void;
  /** Shift+R group rotate: a dumb applier over pre-computed geometry (pivot +
   *  90-degree rotation, see wireGeom's groupRotateComponent/rotatePointAround)
   *  so the geometry itself stays unit-testable outside the store. One undo
   *  step covers every component/junction/wire touched. */
  applyGroupRotate: (updates: {
    components: GroupRotateResult[];
    junctions: { id: string; pos: Point }[];
    wires: { id: string; points: Point[]; a?: WireEnd; b?: WireEnd }[];
  }) => void;
  /** Align/Distribute toolbar: a dumb applier over pre-computed per-component
   *  deltas (see wireGeom's alignDeltas/distributeDeltas) -- unlike
   *  `applyGroupRotate`, each component can move by a different delta, so
   *  wires are pre-stretched by the caller per-end rather than rigidly. One
   *  undo step covers every component/wire touched. */
  applyGroupMove: (updates: {
    components: { id: string; pos: Point }[];
    wires: { id: string; points: Point[] }[];
  }) => void;
  /** Tidy wiring: re-lane every net the router is confident about and branch
   *  fan-out through junction dots, in one undo step. Geometry comes from the
   *  caller because the store has no theme; `only` scopes it to a selection,
   *  and nets the router declines keep the hand-routing they had. */
  tidyWiring: (input: {
    components: readonly RoutableComponent[];
    grid: number;
    only?: ReadonlySet<string>;
  }) => void;
  /** `resolveEnd`, when given, stretches every wire with an end on a moved
   *  component/junction so its stored bends follow (KiCad drag-stretch); the
   *  live pointer-drag preview needs it too, so it's read off the *current*
   *  (pre-move) store, not the draft being mutated -- pass it through, don't
   *  synthesize it from the draft. */
  moveSelection: (dx: number, dy: number, resolveEnd?: ResolveWireEnd) => void;
  /** Alt+drag: moves the selection, cutting touched wires to free ends. */
  moveSelectionDetached: (
    dx: number,
    dy: number,
    detachedEnds: { wireId: string; end: 'a' | 'b'; pos: Point }[],
  ) => void;
  /** Duplicate commit / paste: remaps a slice's ids fresh and offsets it in. */
  commitDuplicate: (slice: Circuit, offset: Point) => void;
  /** `R`: rotates each item individually about its OWN centre (caller-resolved
   *  bounds, same contract as `applyGroupRotate` -- the store never reaches
   *  for a theme). Shift+R (`applyGroupRotate`) rotates the selection as one
   *  rigid body instead. */
  rotateSelection: (items: GroupRotateItem[], grid: number) => void;
  mirrorSelection: (ids?: Set<string>) => void;
  /** `resolveEnd`, when given, lets a leftover junction reduced to a straight
   *  pin-to-pin 2-way pass-through collapse too (P0.2); otherwise only
   *  free/junction-ended pass-throughs collapse. */
  deleteSelection: (ids?: Set<string>, resolveEnd?: ResolveWireEnd) => void;
  /** Put the selected components in a new group, which scopes their net-label
   *  joining and label uniqueness. Returns the new group's id, or null when
   *  the selection holds no components. */
  groupSelection: (name?: string) => string | null;
  /** Dissolve every group the selection touches, returning its components to
   *  board scope. The components themselves stay exactly where they are. */
  ungroupSelection: () => void;
  /** Rename a group. Its name prefixes the net paths of the labels inside it,
   *  so this is a rename of those paths too. */
  renameGroup: (id: string, name: string) => boolean;
  /** Ctrl+X: 1-in/1-out components are healed (wired through); others delete normally. */
  deleteWithHeal: (ids?: Set<string>, resolveEnd?: ResolveWireEnd) => void;
  /** Returns false (no commit) when the connection is rejected -- e.g. an
   *  In/Out label direction conflict -- so the caller can leave the pending
   *  wire gesture armed instead of dropping it. */
  addWire: (a: Wire['a'], b: Wire['b'], points?: Point[]) => boolean;
  /** Smart-connect commit: adds every pair as one undo step. */
  addWires: (pairs: { a: Wire['a']; b: Wire['b'] }[]) => boolean;
  addJunction: (pos: Point, grid: number, resolveEnd: ResolveWireEnd) => void;
  /** Slides a bus wire's width badge along its own route. Cosmetic: the diff
   *  touches neither end, so a live sim keeps running through it. */
  setBusLabelT: (wireId: string, t: number) => void;
  /** Wire-completion onto an existing wire's body: splits it and joins at a real
   *  junction instead of a dangling free end. */
  connectToJunction: (
    a: WireEnd,
    pos: Point,
    grid: number,
    resolveEnd: ResolveWireEnd,
    points?: Point[],
  ) => WireAttachResult;
  /** Wire-completion onto a bus wire's body from a narrower pin (`aWidth`):
   *  pulls off a sub-range tap (KiCad convention) instead of splitting the bus into a same-width junction. The
   *  bus wire itself is untouched -- a tap never materializes a physical net.
   *  Returns 'miss' (no board change) when the hit wire isn't a wider bus, so
   *  the caller falls back to `connectToJunction`; 'rejected' on a label/
   *  driver conflict, same convention as `connectToJunction`/`wireFromStart`. */
  connectToTap: (
    a: WireEnd,
    pos: Point,
    grid: number,
    resolveEnd: ResolveWireEnd,
    aWidth: number,
    points?: Point[],
  ) => WireAttachResult;
  /** B3b: drags a wire's own dangling free end, one undo step. `drop`, when
   *  given (final pointer-up only), materializes the end onto whatever it
   *  landed on -- caller-resolved pin, existing junction, or wire body (split
   *  + junction, like the draw path) -- instead of staying free. */
  moveFreeEnd: (
    wireId: string,
    end: 'a' | 'b',
    pos: Point,
    drop?: { grid: number; resolveEnd: ResolveWireEnd; pinEnd?: WireEnd },
  ) => void;
  /** B4: commits a wire whose start point (`aPos`) was recorded sitting on an
   *  existing wire's body or junction at the moment the Wire tool pressed
   *  down -- symmetric with `connectToJunction`, which already does this for
   *  the END of a wire. `b` is either an already-resolved end (a matched
   *  pin) or another bare point that itself needs the same hit-test (the far
   *  end also missed every pin), so starting AND ending on a wire's body both
   *  work, still in one edit()/undo step. 'miss' only when `b` was a bare
   *  point that resolved to nothing (caller falls back to add-a-bend, P1.6);
   *  `aPos` alone always commits, degrading to a plain free start if whatever
   *  it was hit-testing has since moved or been deleted. */
  wireFromStart: (
    aPos: Point,
    b: WireEnd | { pos: Point },
    grid: number,
    resolveEnd: ResolveWireEnd,
    points?: Point[],
  ) => WireAttachResult;
  /** Wire-cut gesture: deletes whole wires (no segment splitting), one undo step. */
  deleteWires: (ids: ReadonlySet<string>, resolveEnd?: ResolveWireEnd) => void;
  setWirePoints: (id: string, points: Point[]) => void;
  setGateInputs: (id: string, delta: 1 | -1) => void;
  /** Absolute-value sibling of setGateInputs (double-click overlay), same
   *  clamp + wire-cleanup-on-shrink behavior, one undo step. */
  setGateInputCount: (id: string, next: number) => void;
  /** mux/demux/decoder/encoder's shared 1..4-bit address/select-width param
   *  (`selectBits` for mux/demux, `addressBits` for decoder/encoder): +/-
   *  steps by 1, clamped 1..4; absolute jumps straight to a clamped value.
   *  Mux/demux/encoder name individual pins per index (d<n>/y<n>/i<n>), so
   *  shrinking can orphan a wire -- those drop wires to any pin the new size
   *  removes (mirrors setGateInputs/setGateInputCount); decoder's coded `a`
   *  is a single bus pin that only widens/narrows (decision 7's width-
   *  mismatch path covers it, no pin is ever added/removed). */
  stepBitsParam: (id: string, delta: 1 | -1) => void;
  setBitsParam: (id: string, next: number) => void;
  stepToggleWidth: (id: string, delta: 1 | -1) => void;
  /** Clears a one-shot notice (`timing:`, `bubble mode:`, `label:`) on the
   *  next unrelated interaction. `width:` is standing board state owned by
   *  checkWidthMismatch and is deliberately never cleared here -- only a
   *  real recompile proving the mismatch is fixed may clear it. */
  clearTransientError: () => void;
  undo: () => void;
  redo: () => void;
  setTiming: (t: Partial<TimingSetting>) => void;
  power: () => void;
  step: () => void;
  /** Whether step() can still move time. Read during render off `rev`, not a
   *  stored field: it is a question for the kernel, not editor state. */
  canStep: () => boolean;
  toggleRun: () => void;
  pump: (ps: number) => void;
  toggleInput: (componentId: string, bit?: number, prefix?: string) => void;
  /** Momentary button: explicit press/release rather than a toggle, so a
   *  mouse-held button stays on for exactly the duration of the hold even if
   *  the cursor drags off it before release. */
  setButtonHeld: (componentId: string, held: boolean, prefix?: string) => void;
  pinSignal: (componentId: string, pinName: string, prefix?: string) => SignalState | undefined;
  /** Raw per-bit value (v/x/z), for glyphs that render more than an
   *  aggregate state (e.g. the DIP-bank switch). */
  pinRawValue: (componentId: string, pinName: string, prefix?: string) => bv.BusValue | undefined;
  changedComponentIds: (prefix?: string) => Set<string>;
  simTimePs: () => number | null;

  // --- Waveform panel / scrub-replay (M6). `replayTimePs`/`hoverTrackPath`
  // never bump `rev`; the canvas redraw effect must list them explicitly.
  waveformOpen: boolean;
  setWaveformOpen: (open: boolean) => void;
  /** Non-null while scrub-replaying: wire/glyph coloring reads the trace at
   *  this time instead of the live sim. Any sim-advancing action clears it. */
  replayTimePs: number | null;
  setReplayTime: (t: number | null) => void;
  /** Waveform track hovered in the panel (schematic wire highlight) and back. */
  hoverTrackPath: string | null;
  setHoverTrack: (path: string | null) => void;
  /** Live trace snapshot for the panel; null while unpowered. */
  simTrace: () => { compiled: CompiledCircuit; records: NetChangeRecord[] } | null;
  /** Monotonic record count: cheap rebuild trigger (simTrace copies the buffer). */
  simTraceLength: () => number;
  /** Simulator clock. The trace only records changes, so the newest state of a
   *  settled board sits between the last record and here. */
  simNow: () => number;
  /** Compiled net index for a component pin (track <-> wire mapping). */
  netOfPin: (componentId: string, pinName: string, prefix?: string) => number | undefined;
  /** Clock param editor commit: merges params (and, when `label` is given,
   *  renames with `renameComponent`'s validation) in one undo step. Returns
   *  false when the label is rejected; the board is then untouched. */
  setComponentParams: (id: string, params: Record<string, ParamValue>, label?: string) => boolean;
  /** Batch param edit (Task 6): applies each spec's params to its own
   *  component, all in one undo step. `label` is only ever set on the
   *  double-clicked entry (specs[0]) -- name/label is single-component-only
   *  (decision 1). Each plan is computed against the RUNNING draft (via
   *  computeParamsPlan inside one `edit()`), so two co-selected, wired
   *  components can't clobber each other's pin-drop/rewire. Returns false
   *  (nothing committed for that entry) only when specs[0] -- the
   *  double-clicked component -- is rejected (unknown id, or a label
   *  collision); every other spec's domain is expected to have been
   *  pre-filtered by the caller (decision 2's "silently leave the rest
   *  unchanged"), so a rejection there never surfaces. A width-affecting key
   *  in any spec re-validates the board once, same as the single-component
   *  path. */
  setComponentParamsBatch: (
    specs: {
      id: string;
      params: Record<string, ParamValue>;
      label?: string;
      kind?: ComponentKind;
    }[],
  ) => boolean;

  // --- STA overlay. View-state only: no board mutation, no undo entry;
  // cleared by any topology edit. `staReport` never bumps rev.
  staReport: { report: TimingReport; compiled: CompiledCircuit } | null;
  /** Runs analyzeTiming over the board (datasheet mode only; timing:-prefixed
   *  error strip messages for ideal mode / combinational cycles). */
  runSta: () => void;
  clearSta: () => void;

  /** Locked bubble-push mode entry: normalizes gate kinds to base+params (one
   *  undo step), snapshots the baseline truth table, powers off. Rejected
   *  (error set, mode stays 'edit') for a non-board tab, a non-combinational
   *  board, too many inputs, or missing terminals. */
  enterBubbleMode: () => void;
  /** Composes plain output bubbles back into literal kinds (one undo step);
   *  bare bubbleOnly markers and inputBubbles params survive as params. */
  exitBubbleMode: () => void;
  setBubbleFocus: (f: TerminalFocus | null) => void;
  setBubblePairMode: (on: boolean) => void;
  previewBubbleMove: (move: PushMove, geom?: TransformGeom) => void;
  clearBubblePreview: () => void;
  /** Commits iff legal (re-verified against the entry baseline); one undo step. */
  commitBubbleMove: (move: PushMove, geom?: TransformGeom) => void;
  /** N key: literal 'not' decomposes to a bare bubble marker; a buf carrying
   *  an output bubble flips its bubbleOnly render form. One undo step.
   *  `reanchor` maps the converted component to a new pos (the caller keeps
   *  the world 'a' pin fixed across the glyph-size change; the store has no
   *  glyph metrics of its own). */
  convertBubble: (
    ids?: Set<string>,
    reanchor?: (before: Component, after: Component) => { x: number; y: number } | undefined,
    geom?: TransformGeom,
  ) => void;
}

// One History per open tab, so undo in a def's internals never touches the
// board's stack (and vice versa).
const historyByTab = new Map<string, History>();
const historyFor = (id: string): History => {
  let h = historyByTab.get(id);
  if (!h) {
    h = new History();
    historyByTab.set(id, h);
  }
  return h;
};
let sim: SimState | null = null;
// Replay index over the trace at scrub start; dropped when replay exits (any
// sim-advancing action) so it can never serve stale values.
let replayIdx: ReplayIndex | null = null;

const delayFor = (t: TimingSetting) =>
  t.mode === 'datasheet' ? datasheetDelay(t.datasheet) : idealDelay;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function omitPos(v: Record<string, unknown>): Record<string, unknown> {
  const clone = { ...v };
  delete clone['pos'];
  return clone;
}

// True when a picked item's only change is its `pos` (component/junction
// drag) or, for a wire, only its `points` (drag-stretch following a moved
// end) -- the kernel never reads component/junction position or wire bend
// geometry, only the renderer does, so neither needs a power reset (P0.4,
// M4.3). A wire is still required to keep the exact same ends: a real
// rewire is a topology change. Any add/delete or other field change is real.
// Two WireEnds are the same topology if they're the same kind and (for
// 'pin'/'junction'/'tap') the same referenced target -- 'free' ends are
// compared by kind alone since a free end's own `pos` is exactly what a
// free-end drag (moveFreeEnd) changes, and that's still a pure move, not a
// rewire.
// Every prefix of `name` reachable by stripping trailing digits one digit at
// a time, longest-remaining-prefix first: 'd00' -> ['d0', 'd'] (a lane-
// expanded indexed pin's group key is ambiguous by digit count alone --
// callers resolve it by testing each candidate against the real pins()
// shape, not by guessing which one is "the" bit suffix).
function trailingDigitPrefixes(name: string): string[] {
  const m = /^(.*?)(\d+)$/.exec(name);
  if (!m) return [];
  const [, base, digits] = m;
  const out: string[] = [];
  for (let cut = 1; cut <= digits!.length; cut++) out.push(base! + digits!.slice(0, -cut));
  return out;
}

function sameEndTopology(x: WireEnd, y: WireEnd): boolean {
  if (x.kind === 'free' && y.kind === 'free') return true;
  if (x.kind === 'tap' && y.kind === 'tap')
    return x.wire === y.wire && x.range.hi === y.range.hi && x.range.lo === y.range.lo;
  return JSON.stringify(x) === JSON.stringify(y);
}

function isPureMoveItem(item: import('./history').PickedItem): boolean {
  if (!item.before || !item.after) return false;
  if (item.kind === 'wire') {
    const before = item.before as Wire;
    const after = item.after as Wire;
    return sameEndTopology(before.a, after.a) && sameEndTopology(before.b, after.b);
  }
  return (
    JSON.stringify(omitPos(item.before as unknown as Record<string, unknown>)) ===
    JSON.stringify(omitPos(item.after as unknown as Record<string, unknown>))
  );
}

export const useCircuitStore = create<CircuitState>((set, get) => {
  const activeTab = (): Tab => {
    const s = get();
    return s.tabs.find((t) => t.id === s.activeTabId) ?? s.tabs[0]!;
  };

  const activeCircuit = (): Circuit => {
    const tab = activeTab();
    if (tab.kind === 'board') return get().board;
    return get().chipLib.get(tab.defId) ?? { components: [], wires: [], junctions: [] };
  };

  // Re-derive a def's boundary pins after an edit, reject the edit if it would
  // introduce a chip-def reference cycle, and detach any wire the removal of a
  // pin stranded (across the board and every other def in the library).
  const commitDefEdit = (defId: string, draft: Circuit) => {
    const st = get();
    const def = st.chipLib.get(defId);
    if (!def) return;
    const { pins, removed, renamed } = derivePins(def.pins, draft.components);
    // A rename derivePins couldn't apply (collision with another surviving
    // boundary pin) shows up as a kept pin whose bound component's own label
    // no longer matches the pin's (unchanged) name -- surface it the same
    // way renameWith's pre-edit validation does, without blocking the rest
    // of the edit (derivePins already kept the old name for that one pin).
    let collisionError: string | null = null;
    for (const p of pins) {
      const c = draft.components.find((x) => x.id === p.boundComponent);
      if (!c) continue;
      const desired = c.label || c.id;
      if (desired !== p.name) {
        collisionError = `label: pin name '${desired}' already used by another boundary pin`;
        break;
      }
    }
    const updated: ChipDef = { ...def, ...draft, pins, version: def.version + 1 };
    const candidateLib = new Map(st.chipLib);
    candidateLib.set(defId, updated);
    const cycleError = findCycle(candidateLib);
    if (cycleError) {
      set({ error: cycleError });
      return;
    }

    let board = st.board;
    let chipLib = candidateLib;
    const stale = new Set(st.staleInstances);

    if (renamed.length > 0) {
      board = { ...board, ...renamePinRefs(board, defId, renamed) };
      const nextLib = new Map(chipLib);
      for (const [id, otherDef] of chipLib) {
        if (id === defId) continue;
        const result = renamePinRefs(otherDef, defId, renamed);
        if (result !== otherDef) nextLib.set(id, { ...otherDef, ...result });
      }
      chipLib = nextLib;
    }

    if (removed.length > 0) {
      const boardResult = detachRemovedPins(board, defId, removed);
      board = { ...board, ...boardResult.circuit };
      boardResult.staleIds.forEach((id) => stale.add(id));
      const nextLib = new Map(chipLib);
      for (const [id, otherDef] of chipLib) {
        if (id === defId) continue;
        const result = detachRemovedPins(otherDef, defId, removed);
        if (result.circuit !== otherDef) nextLib.set(id, { ...otherDef, ...result.circuit });
        result.staleIds.forEach((sid) => stale.add(sid));
      }
      chipLib = nextLib;
    }
    set((s) => ({
      board,
      chipLib,
      staleInstances: stale,
      error: collisionError,
      powered: false,
      rev: s.rev + 1,
    }));
    sim = null;
  };

  // A transient error (`label:`, `timing:`, `bubble mode:`) is a one-shot
  // notice about the *previous* attempt, not standing board state like a
  // `width:` compile error -- clear it as soon as any new interaction
  // starts, so it doesn't outlive the click/edit that caused it (the action
  // about to run re-sets it itself if it's rejected too). `width:` is owned
  // by checkWidthMismatch and only clears once a real recompile proves it.
  const clearTransientErrorImpl = () => {
    const err = get().error;
    if (err && !err.startsWith('width:')) set({ error: null });
  };

  // Edit under one history command, scoped to the active tab: clone its
  // circuit, mutate the draft, diff, commit through that tab's own history.
  // Always followed by a junction-collapse pass so any wire-end mutation that
  // could change a junction's degree (delete, rewire, ...) settles it back to
  // a plain point once it stops being a real branch (P0.2). Actions that also
  // have live pin geometry (addJunction, connectToJunction) run their own
  // collapse pass with `resolveEnd` first so pin-ended pass-throughs collapse
  // too; this generic pass (no render geometry) is the universal fallback.
  const edit = (label: string, fn: (draft: Circuit) => void, resolveEnd?: ResolveWireEnd) => {
    clearTransientErrorImpl();
    const tab = activeTab();
    const before = cloneCircuit(activeCircuit());
    const draft = cloneCircuit(activeCircuit());
    fn(draft);
    collapseJunctions(draft, () => genId('w'), resolveEnd);
    const cmd = diffCircuits(before, draft, label);
    if (cmd.items.length === 0) return;
    historyFor(tab.id).commit(cmd);
    if (tab.kind === 'board') {
      // A pure-position diff (drag) never touches connectivity, so leave a
      // live sim powered and running through it (P0.4) -- only a topology
      // change (place/delete/rewire/param) resets power like before.
      const topologyChanged = cmd.items.some((item) => !isPureMoveItem(item));
      set((s) => ({
        board: { ...s.board, ...draft },
        powered: topologyChanged ? false : s.powered,
        // STA overlay is view-state over a specific compile; a topology edit
        // invalidates it (spec choice: clear, don't auto-recompute).
        staReport: topologyChanged ? null : s.staReport,
        replayTimePs: topologyChanged ? null : s.replayTimePs,
        rev: s.rev + 1,
      }));
      if (topologyChanged) {
        sim = null;
        replayIdx = null;
        // A stale mismatch/compile-error from an earlier edit shouldn't
        // outlive this one -- re-validate against the real (just-committed)
        // board instead of optimistically clearing, so a delete/rewire that
        // *doesn't* actually fix the underlying problem doesn't silently
        // drop the warning either. Covers every topology-changing action
        // generically (place/delete/rewire/param), not just width edits.
        checkWidthMismatch('');
      }
    } else {
      commitDefEdit(tab.defId, draft);
    }
  };

  // pinsWithForcedView: the primitive's own pins(params) with one pinView
  // key pinned to a specific state, everything else left as `params` already
  // has it -- the shared building block computePinViewMigration below uses
  // to detect a pinView collapse transition without any per-kind name
  // parsing (reuses the primitive's own pins() as ground truth, same idiom
  // as applyParamsDroppingRemovedPins's own before/after diff).
  const pinsWithForcedView = (
    kind: ComponentKind,
    params: Record<string, ParamValue>,
    key: string,
    state: PinViewState,
  ) => {
    const view = { ...parsePinView(params), [key]: state };
    return getPrimitive(kind).pins({ ...params, pinView: serializePinView(view) });
  };

  // `key`'s own bit-pin names when expanded, isolated from the rest of the
  // primitive's pin list by diffing against the same primitive forced
  // collapsed instead (only `key`'s own pins can differ between those two
  // calls, since every other pinView key is held fixed) -- returns [] when
  // `key` isn't a pinView group at all (nothing differs).
  const pinGroupExpandedNames = (
    kind: ComponentKind,
    params: Record<string, ParamValue>,
    key: string,
  ): string[] => {
    const collapsedNames = new Set(
      pinsWithForcedView(kind, params, key, 'collapsed').map((p) => p.name),
    );
    return pinsWithForcedView(kind, params, key, 'expanded')
      .map((p) => p.name)
      .filter((n) => !collapsedNames.has(n));
  };

  // A pinView COLLAPSE (several individual pins merging into one bus pin)
  // keeps the user's existing wiring instead of dropping it, since the
  // merged pin is always named exactly the group's own key. EXPAND (one pin
  // splitting into several) has no safe migration -- no way to know which
  // new individual pin a downstream wire wants -- so it still drops via the
  // normal removed-pin path below. Returns OLD pin name -> NEW pin name for
  // every pin that safely migrates; empty when nothing collapsed.
  const computePinViewMigration = (
    kind: ComponentKind,
    oldParams: Record<string, ParamValue> | undefined,
    nextParams: Record<string, ParamValue>,
  ): Map<string, string> => {
    const migration = new Map<string, string>();
    if (!hasPrimitive(kind)) return migration;
    const op = oldParams ?? {};
    const keys = new Set([
      ...Object.keys(parsePinView(op)),
      ...Object.keys(parsePinView(nextParams)),
    ]);
    if (keys.size === 0) return migration;
    const actualOldNames = new Set(
      getPrimitive(kind)
        .pins(op)
        .map((p) => p.name),
    );
    const actualNewNames = new Set(
      getPrimitive(kind)
        .pins(nextParams)
        .map((p) => p.name),
    );
    for (const key of keys) {
      if (!actualNewNames.has(key)) continue; // not now a single collapsed `key` pin
      const oldExpandedNames = pinGroupExpandedNames(kind, op, key);
      if (oldExpandedNames.length <= 1) continue; // key has no expand/collapse group at all
      const wasExpanded = oldExpandedNames.every((n) => actualOldNames.has(n));
      if (!wasExpanded) continue; // old shape wasn't this key's expanded form (nothing to migrate)
      for (const n of oldExpandedNames) migration.set(n, key);
    }
    return migration;
  };

  // Inverse of computePinViewMigration: a group EXPANDING (one collapsed pin
  // `key` splitting into `key0..key(w-1)`) can also keep its wiring, when the
  // wire's far end is a pin belonging to another (or the same width, already-
  // expanded) pinView group -- bit i on one side is always named `<base>i` on
  // both sides (expandPin/packIndexed share that suffix convention), so the
  // two groups can be rewired bit-for-bit with plain 1-bit wires instead of
  // a bus tap. Only handled when the far end resolves this cleanly; anything
  // else (junction/free/tap end, width mismatch, far pin not a pinView group)
  // still drops via the caller's normal removed-pin path.
  interface PinExpansionRewire {
    dropWireIds: Set<string>;
    addWires: Wire[];
    farParamPatches: Map<string, Record<string, ParamValue>>;
    removeJunctionIds: Set<string>;
    addJunctions: Junction[];
  }

  // Resolves a wire end to its component's own w-wide bit-pin ends, when
  // that component's pin at this width is itself a pinView group of exactly
  // w bits -- shared by every fan-in-propagation path (junction or direct
  // multi-wire) below, so a branch resolves identically regardless of which
  // kind of fan-in point it's attached to.
  // Bit a `<key><bit>` member name carries, e.g. bitIndexOf('d0','d03') = 3.
  const bitIndexOf = (key: string, memberName: string): number =>
    Number.parseInt(memberName.slice(key.length), 10);

  const resolveBitEnds = (
    end: WireEnd,
    w: number,
    components: Component[],
  ): { ends: WireEnd[]; farId: string; farPin: string; farWasCollapsed: boolean } | null => {
    if (end.kind !== 'pin') return null;
    const far = components.find((c) => c.id === end.component);
    if (!far || !hasPrimitive(far.kind)) return null;
    const farPins = getPrimitive(far.kind).pins(far.params ?? {});
    const farPin = farPins.find((p) => p.name === end.pin);
    if (!farPin || farPin.width !== w) return null;
    const bitNames = pinGroupExpandedNames(far.kind, far.params ?? {}, end.pin);
    if (bitNames.length !== w) return null;
    // Bit order, NOT the group's own row order: a lane group renders MSB
    // first and an indexed group index-0 first (busPins.ts), so callers that
    // zip two of these together would cross the bits over if either side
    // were left in display order.
    const byBit = [...bitNames].sort((x, y) => bitIndexOf(end.pin, x) - bitIndexOf(end.pin, y));
    return {
      ends: byBit.map((n) => ({ kind: 'pin' as const, component: far.id, pin: n })),
      farId: far.id,
      farPin: end.pin,
      farWasCollapsed: farPins.some((p) => p.name === end.pin),
    };
  };

  // A junction is an electrical node, not a named pin: expanding a bus that
  // passes through one must propagate through EVERY branch touching it, not
  // just our own -- otherwise the junction ends up with a mismatched mix of
  // per-bit wires (ours) and still-whole bus wires (every other branch).
  // Replaces the one junction with `w` per-bit junctions (same position),
  // and rewires every branch that can itself resolve a matching w-wide bit
  // group bit-for-bit onto them; a branch that can't (unresolvable
  // component, wrong width, no matching group, or a further junction chain
  // -- not walked, a documented limitation) is simply dropped, same as the
  // existing single-wire fallback. Returns null when fewer than two branches
  // resolve (nothing meaningful to fan out), so the caller falls back to the
  // old single-junction behavior.
  const expandJunctionFully = (
    junctionId: string,
    w: number,
    wires: Wire[],
    junctions: Junction[],
    components: Component[],
  ): PinExpansionRewire | null => {
    const junction = junctions.find((j) => j.id === junctionId);
    if (!junction) return null;
    const branches = wires.filter(
      (wr) =>
        (wr.a.kind === 'junction' && wr.a.junction === junctionId) ||
        (wr.b.kind === 'junction' && wr.b.junction === junctionId),
    );
    const resolved: {
      wire: Wire;
      ends: WireEnd[];
      farId: string;
      farPin: string;
      farWasCollapsed: boolean;
    }[] = [];
    const unresolved: Wire[] = [];
    for (const wr of branches) {
      const onA = wr.a.kind === 'junction' && wr.a.junction === junctionId;
      const otherEnd = onA ? wr.b : wr.a;
      const r = resolveBitEnds(otherEnd, w, components);
      if (r) resolved.push({ wire: wr, ...r });
      else unresolved.push(wr);
    }
    if (resolved.length < 2) return null;
    const newJunctionIds = Array.from({ length: w }, () => genId('j'));
    const result: PinExpansionRewire = {
      dropWireIds: new Set(),
      addWires: [],
      farParamPatches: new Map(),
      removeJunctionIds: new Set([junctionId]),
      // Stacking every per-bit junction on the OLD junction's exact position
      // renders as one dot with wires that look like they only reach bit 0
      // -- spread them out (schematic grid unit, matching theme.gridSchematic
      // elsewhere; this module has no theme access) so each bit's fan-out is
      // visually distinct and individually clickable.
      addJunctions: newJunctionIds.map((jid, i) => ({
        id: jid,
        pos: { x: junction.pos.x, y: junction.pos.y + i * 8 },
      })),
    };
    for (const r of resolved) {
      result.dropWireIds.add(r.wire.id);
      for (let i = 0; i < w; i++) {
        result.addWires.push({
          id: genId('w'),
          a: r.ends[i]!,
          b: { kind: 'junction', junction: newJunctionIds[i]! },
          points: [],
        });
      }
      if (r.farWasCollapsed) {
        const far = components.find((c) => c.id === r.farId)!;
        const view = { ...parsePinView(far.params ?? {}), [r.farPin]: 'expanded' as const };
        result.farParamPatches.set(far.id, { ...far.params, pinView: serializePinView(view) });
      }
    }
    for (const wr of unresolved) result.dropWireIds.add(wr.id);
    return result;
  };

  // A plain pin can be a fan-in point too, not just a junction: two wires
  // landing directly on one input (e.g. a switch AND an In label both wired
  // straight to a gate's pin, no junction between them -- legal since a
  // label is never a real second driver). Expanding that pin must propagate
  // through EVERY branch touching it, exactly like expandJunctionFully, just
  // without a node to replace -- each branch instead gets a direct wire onto
  // the expanding pin's own new per-bit names. Unlike the junction case,
  // this also fires for a SINGLE branch (the plain 1-wire case): the caller
  // no longer needs its own separate single-wire fallback.
  const expandPinFanInFully = (
    farComponentId: string,
    farPinName: string,
    w: number,
    wires: Wire[],
    components: Component[],
  ): PinExpansionRewire | null => {
    const near = resolveBitEnds(
      { kind: 'pin', component: farComponentId, pin: farPinName },
      w,
      components,
    );
    if (!near) return null;
    const branches = wires.filter(
      (wr) =>
        (wr.a.kind === 'pin' && wr.a.component === farComponentId && wr.a.pin === farPinName) ||
        (wr.b.kind === 'pin' && wr.b.component === farComponentId && wr.b.pin === farPinName),
    );
    const resolved: {
      wire: Wire;
      ends: WireEnd[];
      farId: string;
      farPin: string;
      farWasCollapsed: boolean;
    }[] = [];
    const unresolved: Wire[] = [];
    for (const wr of branches) {
      const onA =
        wr.a.kind === 'pin' && wr.a.component === farComponentId && wr.a.pin === farPinName;
      const otherEnd = onA ? wr.b : wr.a;
      const other = resolveBitEnds(otherEnd, w, components);
      if (other) resolved.push({ wire: wr, ...other });
      else unresolved.push(wr);
    }
    if (resolved.length === 0) return null;
    const result: PinExpansionRewire = {
      dropWireIds: new Set(),
      addWires: [],
      farParamPatches: new Map(),
      removeJunctionIds: new Set(),
      addJunctions: [],
    };
    if (near.farWasCollapsed) {
      const far = components.find((c) => c.id === farComponentId)!;
      const view = { ...parsePinView(far.params ?? {}), [farPinName]: 'expanded' as const };
      result.farParamPatches.set(far.id, { ...far.params, pinView: serializePinView(view) });
    }
    // Each BRANCH's own component must also expand its pin, not just the
    // fan-in point itself -- otherwise the new per-bit wires reference
    // pin names (e.g. fsw.y0) that don't actually exist on that component
    // yet, since its own pinView param was never told to change.
    for (const entry of resolved) {
      if (!entry.farWasCollapsed) continue;
      const branchFar = components.find((c) => c.id === entry.farId)!;
      const view = { ...parsePinView(branchFar.params ?? {}), [entry.farPin]: 'expanded' as const };
      result.farParamPatches.set(branchFar.id, {
        ...branchFar.params,
        pinView: serializePinView(view),
      });
    }
    for (const entry of resolved) {
      result.dropWireIds.add(entry.wire.id);
      for (let i = 0; i < w; i++) {
        result.addWires.push({
          id: genId('w'),
          a: near.ends[i]!,
          b: entry.ends[i]!,
          points: [],
        });
      }
    }
    for (const wr of unresolved) result.dropWireIds.add(wr.id);
    return result;
  };

  const computePinExpansionRewire = (
    id: string,
    kind: ComponentKind,
    nextParams: Record<string, ParamValue>,
    expandedKeys: string[],
    wires: Wire[],
    junctions: Junction[],
    components: Component[],
  ): PinExpansionRewire => {
    const result: PinExpansionRewire = {
      dropWireIds: new Set(),
      addWires: [],
      farParamPatches: new Map(),
      removeJunctionIds: new Set(),
      addJunctions: [],
    };
    // A junction (or a plain fan-in pin) touched by more than one of our own
    // bits in this same call (rare) only needs its full fan-out resolved once.
    const processedJunctions = new Set<string>();
    const processedPins = new Set<string>();
    for (const key of expandedKeys) {
      const ourBitNames = pinGroupExpandedNames(kind, nextParams, key);
      if (ourBitNames.length <= 1) continue;
      const w = ourBitNames.length;
      for (const wire of wires) {
        const aIsOurs = wire.a.kind === 'pin' && wire.a.component === id && wire.a.pin === key;
        const bIsOurs = wire.b.kind === 'pin' && wire.b.component === id && wire.b.pin === key;
        if (!aIsOurs && !bIsOurs) continue;
        const farEnd = aIsOurs ? wire.b : wire.a;
        if (farEnd.kind === 'junction') {
          const jid = farEnd.junction;
          if (processedJunctions.has(jid)) continue; // already resolved via another wire
          processedJunctions.add(jid);
          const plan = expandJunctionFully(jid, w, wires, junctions, components);
          if (plan) {
            plan.dropWireIds.forEach((wid) => result.dropWireIds.add(wid));
            result.addWires.push(...plan.addWires);
            plan.farParamPatches.forEach((v, k2) => result.farParamPatches.set(k2, v));
            plan.removeJunctionIds.forEach((rid) => result.removeJunctionIds.add(rid));
            result.addJunctions.push(...plan.addJunctions);
            continue;
          }
          // Fewer than two real branches at this junction (just our own
          // wire): the plain single-connection case, same as before.
          result.dropWireIds.add(wire.id);
          for (let i = 0; i < w; i++) {
            result.addWires.push({
              id: genId('w'),
              a: { kind: 'pin', component: id, pin: `${key}${i}` },
              b: farEnd,
              points: [],
            });
          }
          continue;
        }
        if (farEnd.kind !== 'pin') continue;
        // A plain pin can be a direct multi-wire fan-in too (e.g. a switch
        // AND an In label both wired straight to this pin, no junction) --
        // resolved fully here regardless of branch count, so a sibling wire
        // never gets left pointing at the pin's now-gone collapsed name.
        const pinKey = `${farEnd.component}:${farEnd.pin}`;
        if (processedPins.has(pinKey)) continue;
        processedPins.add(pinKey);
        const plan = expandPinFanInFully(farEnd.component, farEnd.pin, w, wires, components);
        if (!plan) continue;
        plan.dropWireIds.forEach((wid) => result.dropWireIds.add(wid));
        result.addWires.push(...plan.addWires);
        plan.farParamPatches.forEach((v, k2) => result.farParamPatches.set(k2, v));
      }
    }
    return result;
  };

  // computePinViewMigration retargets each migrating wire's near end onto the
  // merged `key` pin individually, which is correct for a single wire but
  // leaves N separate (now width-mismatched) wires behind when N bit wires
  // all collapse onto the same pin -- if their far ends all belong to one
  // other component's own matching bit group, that group can (and should)
  // collapse too, letting all N wires merge into the single bus wire the
  // user actually wants. Anything that doesn't cleanly resolve this way
  // (far ends split across components/pins, or not a matching group) is left
  // for the caller's normal per-wire retarget, same as before this existed.
  interface PinCollapseRewire {
    dropWireIds: Set<string>;
    addWires: Wire[];
    farParamPatches: Map<string, Record<string, ParamValue>>;
    removeJunctionIds: Set<string>;
    addJunctions: Junction[];
    /** Single-bit devices merged into one width-N bank by mergeIntoBank. */
    removeComponentIds: Set<string>;
  }

  // Collapsing a group whose bits each go to their OWN single-pin device (a
  // switch per select line, an LED per output line) has no far pin group to
  // merge with -- the far ends are w different components. Merging them into
  // one width-w bank is the only reading that keeps the circuit intact; the
  // fallback (retarget every bit wire onto the collapsed pin) puts w 1-bit
  // drivers on one w-wide net, i.e. a width error. Bit 0's device survives
  // and widens; the rest are deleted with their wires, in the same undo step.
  const mergeIntoBank = (
    id: string,
    key: string,
    bitOf: (pinName: string) => number,
    width: number,
    entries: { wire: Wire; farEnd: Extract<WireEnd, { kind: 'pin' }>; ourPin: string }[],
    wires: Wire[],
    components: Component[],
  ): PinCollapseRewire | null => {
    if (entries.length !== width) return null;
    const byBit = new Map<number, (typeof entries)[number]>();
    for (const e of entries) {
      const bit = bitOf(e.ourPin);
      if (bit < 0 || byBit.has(bit)) return null;
      byBit.set(bit, e);
    }
    if (byBit.size !== width) return null;
    const far = [...byBit.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, e]) => ({ entry: e, comp: components.find((c) => c.id === e.farEnd.component) }));
    const kind = far[0]?.comp?.kind;
    if (!kind || !hasPrimitive(kind)) return null;
    const seen = new Set<string>();
    for (const { entry, comp } of far) {
      if (!comp || comp.kind !== kind) return null;
      if (seen.has(comp.id)) return null; // same device on two bits: not a bank
      seen.add(comp.id);
      const pins = getPrimitive(kind).pins(comp.params ?? {});
      if (pins.length !== 1 || pins[0]!.name !== entry.farEnd.pin || pins[0]!.width !== 1)
        return null;
      // Anything else attached to a device would be silently deleted with it.
      const touched = wires.filter(
        (w) =>
          (w.a.kind === 'pin' && w.a.component === comp.id) ||
          (w.b.kind === 'pin' && w.b.component === comp.id),
      );
      if (touched.length !== 1 || touched[0]!.id !== entry.wire.id) return null;
    }
    // The bank grows downward/rightward from its position, so it takes over
    // the TOP-LEFT device's spot and ends up covering roughly the span the
    // column of separate devices already occupied.
    const survivor = far
      .map((f) => f.comp!)
      .reduce((best, c) => ((c.pos.y - best.pos.y || c.pos.x - best.pos.x) < 0 ? c : best));
    const widened = { ...survivor.params, width };
    const widePins = getPrimitive(kind).pins(widened);
    // The bank must still present ONE pin of the full width -- a kind that
    // splits into per-bit pins at width>1 has nothing to wire the bus to.
    if (widePins.length !== 1 || widePins[0]!.width !== width) return null;
    return {
      dropWireIds: new Set(entries.map((e) => e.wire.id)),
      addWires: [
        {
          id: genId('w'),
          a: { kind: 'pin', component: id, pin: key },
          b: { kind: 'pin', component: survivor.id, pin: widePins[0]!.name },
          points: [],
        },
      ],
      farParamPatches: new Map([[survivor.id, widened]]),
      removeJunctionIds: new Set(),
      addJunctions: [],
      removeComponentIds: new Set(far.map((f) => f.comp!.id).filter((cid) => cid !== survivor.id)),
    };
  };

  // Inverse of expandJunctionFully: our own w bit-wires point at w DISTINCT
  // per-bit junctions (the shape a prior full-propagate expand produces).
  // Merges them into one survivor junction, our own bits into one bus wire,
  // and any OTHER branch that has exactly one wire per bit (grouped by far
  // component id, since junction/wire insertion order isn't a reliable
  // pairing key) collapses too. A branch that doesn't fully cover all w bits
  // is dropped, same as the caller's existing per-wire fallback.
  const collapseJunctionFully = (
    id: string,
    key: string,
    entries: { wire: Wire; farEnd: Extract<WireEnd, { kind: 'junction' }> }[],
    wires: Wire[],
    junctions: Junction[],
    components: Component[],
  ): PinCollapseRewire | null => {
    const w = entries.length;
    const juncIds = entries.map((e) => e.farEnd.junction);
    if (new Set(juncIds).size !== w) return null; // must be one distinct junction per bit
    if (juncIds.some((jid) => !junctions.some((j) => j.id === jid))) return null;
    const survivorJunction = genId('j');
    const survivorPos = junctions.find((j) => j.id === juncIds[0])!.pos;
    const result: PinCollapseRewire = {
      dropWireIds: new Set(entries.map((e) => e.wire.id)),
      addWires: [
        {
          id: genId('w'),
          a: { kind: 'pin', component: id, pin: key },
          b: { kind: 'junction', junction: survivorJunction },
          points: [],
        },
      ],
      farParamPatches: new Map(),
      removeJunctionIds: new Set(juncIds),
      addJunctions: [{ id: survivorJunction, pos: survivorPos }],
      removeComponentIds: new Set(),
    };
    // Every OTHER wire touching any of the w junctions, tagged by which bit
    // (which junction) it sits on and grouped by far component id.
    const byFar = new Map<
      string,
      { bit: number; wire: Wire; farEnd: Extract<WireEnd, { kind: 'pin' }> }[]
    >();
    const allOthers = new Set<string>();
    for (let i = 0; i < w; i++) {
      for (const wr of wires) {
        if (result.dropWireIds.has(wr.id)) continue;
        const onA = wr.a.kind === 'junction' && wr.a.junction === juncIds[i];
        const onB = wr.b.kind === 'junction' && wr.b.junction === juncIds[i];
        if (!onA && !onB) continue;
        allOthers.add(wr.id);
        const otherEnd = onA ? wr.b : wr.a;
        if (otherEnd.kind !== 'pin') continue;
        const list = byFar.get(otherEnd.component) ?? [];
        list.push({ bit: i, wire: wr, farEnd: otherEnd });
        byFar.set(otherEnd.component, list);
      }
    }
    for (const [farComponentId, list] of byFar) {
      if (list.length !== w || new Set(list.map((e) => e.bit)).size !== w) continue;
      const far = components.find((c) => c.id === farComponentId);
      if (!far || !hasPrimitive(far.kind)) continue;
      const byBit = [...list].sort((a, b) => a.bit - b.bit);
      const farPinNames = byBit.map((e) => e.farEnd.pin);
      const farKey = trailingDigitPrefixes(byBit[0]!.farEnd.pin).find((candidate) => {
        const names = pinGroupExpandedNames(far.kind, far.params ?? {}, candidate);
        return names.length === w && farPinNames.every((n) => names.includes(n));
      });
      if (!farKey) continue;
      for (const e of list) result.dropWireIds.add(e.wire.id);
      result.addWires.push({
        id: genId('w'),
        a: { kind: 'pin', component: far.id, pin: farKey },
        b: { kind: 'junction', junction: survivorJunction },
        points: [],
      });
      const view = { ...parsePinView(far.params ?? {}), [farKey]: 'collapsed' as const };
      result.farParamPatches.set(far.id, { ...far.params, pinView: serializePinView(view) });
    }
    // Any other branch that didn't fully collapse still loses its junction.
    for (const wid of allOthers) result.dropWireIds.add(wid);
    return result;
  };

  const computePinCollapseRewire = (
    id: string,
    migration: Map<string, string>,
    wires: Wire[],
    junctions: Junction[],
    components: Component[],
  ): PinCollapseRewire => {
    const result: PinCollapseRewire = {
      dropWireIds: new Set(),
      addWires: [],
      farParamPatches: new Map(),
      removeJunctionIds: new Set(),
      addJunctions: [],
      removeComponentIds: new Set(),
    };
    if (migration.size === 0) return result;
    const near = components.find((c) => c.id === id);
    const byKey = new Map<string, { wire: Wire; farEnd: WireEnd; ourPin: string }[]>();
    for (const wire of wires) {
      const aOurs = wire.a.kind === 'pin' && wire.a.component === id && migration.has(wire.a.pin);
      const bOurs = wire.b.kind === 'pin' && wire.b.component === id && migration.has(wire.b.pin);
      if (!aOurs && !bOurs) continue;
      const ourPin = aOurs
        ? (wire.a as Extract<WireEnd, { kind: 'pin' }>).pin
        : (wire.b as Extract<WireEnd, { kind: 'pin' }>).pin;
      const farEnd = aOurs ? wire.b : wire.a;
      const key = migration.get(ourPin)!;
      const list = byKey.get(key) ?? [];
      list.push({ wire, farEnd, ourPin });
      byKey.set(key, list);
    }
    for (const [key, entries] of byKey) {
      if (entries.length <= 1) continue; // one wire retargets fine on its own
      const first = entries[0]!.farEnd;
      if (first.kind === 'junction') {
        // All bit-wires converging on the SAME junction merge into one bus
        // wire to that junction.
        const junctionId = first.junction;
        const sameJunction = entries.every(
          (e) => e.farEnd.kind === 'junction' && e.farEnd.junction === junctionId,
        );
        if (sameJunction) {
          for (const e of entries) result.dropWireIds.add(e.wire.id);
          result.addWires.push({
            id: genId('w'),
            a: { kind: 'pin', component: id, pin: key },
            b: { kind: 'junction', junction: junctionId },
            points: [],
          });
          continue;
        }
        // Distinct per-bit junctions -- the shape a full-propagate expand
        // produces -- try folding the whole fan-out back together.
        if (entries.every((e) => e.farEnd.kind === 'junction')) {
          const plan = collapseJunctionFully(
            id,
            key,
            entries as { wire: Wire; farEnd: Extract<WireEnd, { kind: 'junction' }> }[],
            wires,
            junctions,
            components,
          );
          if (plan) {
            plan.dropWireIds.forEach((wid) => result.dropWireIds.add(wid));
            result.addWires.push(...plan.addWires);
            plan.farParamPatches.forEach((v, k2) => result.farParamPatches.set(k2, v));
            plan.removeJunctionIds.forEach((rid) => result.removeJunctionIds.add(rid));
            result.addJunctions.push(...plan.addJunctions);
            continue;
          }
        }
        // Unresolved: each wire keeps its own far junction and just
        // retargets its near pin onto the collapsed key (caller's fallback).
        continue;
      }
      if (!entries.every((e) => e.farEnd.kind === 'pin')) continue;
      const pinEntries = entries as {
        wire: Wire;
        farEnd: Extract<WireEnd, { kind: 'pin' }>;
        ourPin: string;
      }[];
      // How many distinct bits we're collapsing from -- a direct multi-wire
      // fan-in (a switch AND an In label both wired straight to this pin, no
      // junction) has its entries split across DIFFERENT far components, not
      // one shared far pin group, so this can't just be entries.length.
      const w = new Set(pinEntries.map((e) => e.ourPin)).size;
      const byFar = new Map<string, typeof pinEntries>();
      for (const e of pinEntries) {
        const list = byFar.get(e.farEnd.component) ?? [];
        list.push(e);
        byFar.set(e.farEnd.component, list);
      }
      let merged = false;
      for (const [farComponentId, list] of byFar) {
        // Must cover every bit exactly once from this one far component --
        // a partial group (or two entries on the same bit) can't merge.
        if (list.length !== w || new Set(list.map((e) => e.ourPin)).size !== w) continue;
        const far = components.find((c) => c.id === farComponentId);
        if (!far || !hasPrimitive(far.kind)) continue;
        const farPinNames = list.map((e) => e.farEnd.pin);
        // A far pin like 'd00' (line 0, bit 0 of a lane-expanded indexed
        // group) is ambiguous by blind digit-stripping -- 'd0' and 'd' are
        // both syntactically valid prefixes, only one is the group these
        // wires actually belong to. Try candidates longest-prefix-first
        // (fewest digits stripped) and accept the first whose expanded
        // members exactly match every far pin collected here.
        const farKey = trailingDigitPrefixes(list[0]!.farEnd.pin).find((candidate) => {
          const names = pinGroupExpandedNames(far.kind, far.params ?? {}, candidate);
          return names.length === w && farPinNames.every((n) => names.includes(n));
        });
        if (!farKey) continue;
        for (const e of list) result.dropWireIds.add(e.wire.id);
        result.addWires.push({
          id: genId('w'),
          a: { kind: 'pin', component: id, pin: key },
          b: { kind: 'pin', component: far.id, pin: farKey },
          points: [],
        });
        const view = { ...parsePinView(far.params ?? {}), [farKey]: 'collapsed' as const };
        result.farParamPatches.set(far.id, { ...far.params, pinView: serializePinView(view) });
        merged = true;
      }
      if (merged || !near) continue;
      const bitNames = pinGroupExpandedNames(near.kind, near.params ?? {}, key);
      const plan = mergeIntoBank(
        id,
        key,
        (pinName) => bitIndexOf(key, pinName),
        bitNames.length,
        pinEntries,
        wires,
        components,
      );
      if (plan) {
        plan.dropWireIds.forEach((wid) => result.dropWireIds.add(wid));
        result.addWires.push(...plan.addWires);
        plan.farParamPatches.forEach((v, k2) => result.farParamPatches.set(k2, v));
        plan.removeComponentIds.forEach((cid) => result.removeComponentIds.add(cid));
      }
    }
    return result;
  };

  // Generic sibling of setComponentParams for a param change that can remove
  // NAMED pins (gate arity's a..h, mux/encoder's inputs -> d<n>/i<n>/s<n>):
  // diffs the primitive's own pins(params) before/after the change (single
  // source of truth, no hand-maintained name list) and drops wires to
  // whatever pin the new params no longer expose, in the same undo step.
  // Params that only change a pin's *width* (decoder's inputs, toggle's
  // width) never remove a named pin, so they stay on plain setComponentParams
  // and decision 7's mismatch-surfacing path. A pinView collapse retargets
  // instead of dropping (computePinViewMigration above); a pinView expand
  // rewires bit-for-bit when the far end supports it (computePinExpansionRewire
  // above); anything else removed (arity shrink, an unrewireable expand)
  // still drops as before.
  //
  // `label` is optional and folds a rename into the SAME edit()/undo step
  // (same validation renameWith applies for a pure rename) -- every
  // width-editable kind that also carries a name field (toggle/led/probe/...)
  // always sends one from the param overlay, even when it's unchanged, so
  // this can't be routed through a separate label-only path without losing
  // the pin-drop/rewire logic entirely for those kinds (that was the actual
  // bug: renameWith's own params merge has none of this file's wire cleanup).
  // Pure plan computation, reading `circuit` explicitly (never `activeCircuit()`)
  // so a batch caller can pass the RUNNING draft and see prior specs' own
  // mutations -- two co-selected, wired components can't clobber each
  // other's rewire this way. Returns null on a label collision (caller
  // treats that as a rejection); otherwise a draft-mutator that applies the
  // plan and returns any labelConflict it raised. Both the single-component
  // `applyParamsDroppingRemovedPins` and the batch action below run this
  // same planner, so their behavior is provably identical.
  const computeParamsPlan = (
    circuit: Circuit,
    id: string,
    params: Record<string, ParamValue>,
    label?: string,
    kind?: ComponentKind,
  ): ((d: Circuit) => CircuitState['labelConflict']) | null => {
    const comp = circuit.components.find((c) => c.id === id);
    if (!comp) return null;
    const newKind = kind ?? comp.kind;
    const trimmedLabel = label?.trim();
    if (label !== undefined && trimmedLabel && trimmedLabel !== comp.label) {
      const netIds = ownNetTerminalIds(circuit, get().chipLib, id);
      if (labelUsedElsewhere(circuit, trimmedLabel, netIds, comp.group)) return null;
    }
    const oldPins = getPrimitive(comp.kind)
      .pins(comp.params ?? {})
      .map((p) => p.name);
    const nextParams = { ...comp.params, ...params };
    const newPinNames = new Set(
      getPrimitive(newKind)
        .pins(nextParams)
        .map((p) => p.name),
    );
    const removed = oldPins.filter((n) => !newPinNames.has(n));
    const migration = computePinViewMigration(newKind, comp.params, nextParams);
    const expandedKeys = removed.filter((n) => {
      const bits = pinGroupExpandedNames(newKind, nextParams, n);
      return bits.length > 1 && bits.every((p) => newPinNames.has(p));
    });
    const rewire = computePinExpansionRewire(
      id,
      newKind,
      nextParams,
      expandedKeys,
      circuit.wires,
      circuit.junctions,
      circuit.components,
    );
    const collapseRewire = computePinCollapseRewire(
      id,
      migration,
      circuit.wires,
      circuit.junctions,
      circuit.components,
    );
    const dropWireIds = new Set([...rewire.dropWireIds, ...collapseRewire.dropWireIds]);
    const addWires = [...rewire.addWires, ...collapseRewire.addWires];
    const farParamPatches = new Map([...rewire.farParamPatches, ...collapseRewire.farParamPatches]);
    const removeJunctionIds = new Set([
      ...rewire.removeJunctionIds,
      ...collapseRewire.removeJunctionIds,
    ]);
    const addJunctions = [...rewire.addJunctions, ...collapseRewire.addJunctions];
    const removeComponentIds = collapseRewire.removeComponentIds;
    return (d: Circuit) => {
      d.components = d.components
        .filter((c) => !removeComponentIds.has(c.id))
        .map((c) => {
          if (c.id === id) {
            const next = { ...c, kind: newKind, params: nextParams };
            if (label !== undefined) {
              if (!trimmedLabel) delete next.label;
              else next.label = trimmedLabel;
            }
            return next;
          }
          const patch = farParamPatches.get(c.id);
          return patch ? { ...c, params: patch } : c;
        });
      d.junctions = d.junctions.filter((j) => !removeJunctionIds.has(j.id)).concat(addJunctions);
      const retarget = (end: WireEnd): WireEnd =>
        end.kind === 'pin' && end.component === id && migration.has(end.pin)
          ? { ...end, pin: migration.get(end.pin)! }
          : end;
      d.wires = d.wires
        // Drop by the ORIGINAL (pre-retarget) pin name: a removed pin with no
        // migration target loses its wire in the same command (one undo); a
        // migrated pin survives (retarget below moves it onto the new `key`
        // pin) even though its original name is also in `removed`. A wire
        // rewired by expansion or merged by collapse is dropped by id (its
        // replacement is added separately below).
        .filter(
          (w) =>
            !dropWireIds.has(w.id) &&
            !(
              w.a.kind === 'pin' &&
              w.a.component === id &&
              removed.includes(w.a.pin) &&
              !migration.has(w.a.pin)
            ) &&
            !(
              w.b.kind === 'pin' &&
              w.b.component === id &&
              removed.includes(w.b.pin) &&
              !migration.has(w.b.pin)
            ),
        )
        .map((w) => ({ ...w, a: retarget(w.a), b: retarget(w.b) }))
        .concat(addWires);
      if (trimmedLabel) {
        const dataPin = dataPinOf(newKind);
        if (dataPin) return syncLabels(d, [{ component: id, pin: dataPin }]);
        return syncOutputLabels(d, id, trimmedLabel);
      }
      return null;
    };
  };

  const applyParamsDroppingRemovedPins = (
    id: string,
    params: Record<string, ParamValue>,
    label?: string,
  ): boolean => {
    const plan = computeParamsPlan(activeCircuit(), id, params, label);
    if (!plan) return false;
    let conflict: CircuitState['labelConflict'] = null;
    edit('params', (d) => {
      conflict = plan(d);
    });
    if (conflict) set({ labelConflict: conflict });
    return true;
  };

  // Shared by setGateInputs (delta) and setGateInputCount (absolute, the
  // double-click overlay): clamp 2..8.
  const applyGateInputCount = (id: string, target: number) => {
    const comp = activeCircuit().components.find((c) => c.id === id);
    if (!comp) return;
    const cur = Number(comp.params?.['inputs'] ?? 2);
    const next = Math.min(8, Math.max(2, target));
    if (next === cur) return;
    applyParamsDroppingRemovedPins(id, { inputs: next });
  };

  // Per-kind shape of the shared 1..4-bit address/select-width param: which
  // param key it lives under, and whether changing it can orphan a named
  // pin (mux/demux/encoder name individual lines per index; decoder's coded
  // `a` is one bus pin that only widens/narrows).
  const BITS_PARAM_KEY: Partial<Record<string, 'selectBits' | 'addressBits'>> = {
    mux: 'selectBits',
    demux: 'selectBits',
    decoder: 'addressBits',
    encoder: 'addressBits',
  };
  const BITS_PARAM_DROPS_PINS: Partial<Record<string, boolean>> = {
    mux: true,
    demux: true,
    decoder: false,
    encoder: true,
  };

  // Shared by mux/demux/decoder/encoder's *Bits param: step by delta or jump
  // to an absolute target, clamped 1..4.
  const applyBitsParam = (id: string, target: number, byStep: boolean) => {
    const comp = activeCircuit().components.find((c) => c.id === id);
    if (!comp) return;
    const paramKey = BITS_PARAM_KEY[comp.kind];
    if (!paramKey) return;
    const cur = Number(comp.params?.[paramKey] ?? 2);
    const next = Math.min(4, Math.max(1, byStep ? cur + target : target));
    if (next === cur) return;
    if (BITS_PARAM_DROPS_PINS[comp.kind]) {
      applyParamsDroppingRemovedPins(id, { [paramKey]: next });
    } else {
      edit('params', (d) => {
        d.components = d.components.map((c) =>
          c.id === id ? { ...c, params: { ...c.params, [paramKey]: next } } : c,
        );
      });
    }
  };

  // Toggle/led width (1..32): same reasoning as decoder's inputs -- one
  // pin, only its width changes, the width-edit mismatch path covers the
  // rest.
  const applyToggleWidth = (id: string, target: number) => {
    const comp = activeCircuit().components.find((c) => c.id === id);
    if (!comp || (comp.kind !== 'toggle' && comp.kind !== 'led')) return;
    const cur = Number(comp.params?.['width'] ?? 1);
    const next = Math.min(bv.MAX_WIDTH, Math.max(1, target));
    if (next === cur) return;
    edit('params', (d) => {
      d.components = d.components.map((c) =>
        c.id === id ? { ...c, params: { ...c.params, width: next } } : c,
      );
    });
  };

  // Label inheritance for the nets touched by a commit, applied inside the
  // same draft so wire+labels land in one undo step; returns a conflict when
  // two different user names met on one net (the dialog resolves it).
  const syncLabels = (draft: Circuit, pins: PinRef[]): CircuitState['labelConflict'] => {
    const conflicts: LabelConflictRow[] = [];
    // Two of `pins` can sit on the SAME net (e.g. a direct pin-to-pin wire
    // commit passes both its own ends) -- dedupe by net identity so that
    // net's conflict isn't reported twice.
    const seenNets = new Set<string>();
    for (const p of pins) {
      const r = labelSync(draft, p);
      for (const inh of r.inherit)
        draft.components = draft.components.map((c) =>
          c.id === inh.id ? { ...c, label: inh.label } : c,
        );
      if (r.conflict) {
        const key = [...r.conflict.netComponentIds].sort().join(',');
        if (!seenNets.has(key)) {
          seenNets.add(key);
          conflicts.push({ heading: r.conflict.candidates[0]!, ...r.conflict });
        }
      }
    }
    return conflicts.length ? conflicts : null;
  };

  // Task 1b: naming a part with output pins (gate/mux/coder/chip -- anything
  // not already a DATA_PIN terminal kind) derives one label per output net
  // (deriveOutputLabels) and syncs each the same way an IO device's label
  // does, just seeded from the proposed name rather than an existing one.
  const syncOutputLabels = (
    draft: Circuit,
    componentId: string,
    label: string,
  ): CircuitState['labelConflict'] => {
    const conflicts: LabelConflictRow[] = [];
    // No net-signature dedup here (unlike syncLabels): deriveOutputLabels
    // yields at most one entry per PIN, never the same pin twice, so two
    // entries are always genuinely different conflicts even on the rare
    // chance their nets' terminal sets happened to coincide.
    for (const { pin, label: l } of deriveOutputLabels(draft, get().chipLib, componentId, label)) {
      const r = labelSyncForOutput(draft, { component: componentId, pin }, l);
      for (const inh of r.inherit)
        draft.components = draft.components.map((c) =>
          c.id === inh.id ? { ...c, label: inh.label } : c,
        );
      if (r.conflict) conflicts.push({ heading: l, ...r.conflict });
    }
    return conflicts.length ? conflicts : null;
  };

  // Shared by renameComponent and the clock param overlay: validates the label
  // (decision 6: a label already used on a *different* net is rejected;
  // same-net duplication is the label-sharing feature), then applies rename +
  // label sync + optional param merge in ONE edit()/undo step.
  const renameWith = (
    id: string,
    label: string,
    params: Record<string, ParamValue> | null,
  ): boolean => {
    const trimmed = label.trim();
    const circuit = activeCircuit();
    const comp = circuit.components.find((c) => c.id === id);
    if (!comp) return false;
    if (trimmed && trimmed !== comp.label && comp.kind !== 'netlabel') {
      const netIds = ownNetTerminalIds(circuit, get().chipLib, id);
      if (labelUsedElsewhere(circuit, trimmed, netIds, comp.group)) return false;
    }
    let conflict: CircuitState['labelConflict'] = null;
    edit(params ? 'params' : 'rename', (d) => {
      d.components = d.components.map((c) => {
        if (c.id !== id) return c;
        const next = params ? { ...c, params: { ...c.params, ...params } } : { ...c };
        if (!trimmed) delete next.label;
        else next.label = trimmed;
        return next;
      });
      const dataPin = dataPinOf(comp.kind);
      if (trimmed && dataPin) conflict = syncLabels(d, [{ component: id, pin: dataPin }]);
      else if (trimmed) conflict = syncOutputLabels(d, id, trimmed);
    });
    if (conflict) set({ labelConflict: conflict });
    return true;
  };

  // Recompile after a width-param edit (or any topology change, via `edit()`
  // itself) and warn-color the wires touching whichever component the
  // CompileError names, without waiting for the next power() to discover the
  // mismatch. A clean compile clears any stale mismatch/compile-error from
  // an earlier edit -- including one left behind by an undo/delete that
  // fixed it, not just a fresh successful edit -- but never clobbers an
  // unrelated error kind (draw:, timing:, ...) that happens to still be set.
  // Compiles the top-level board always (same precedent as runSta/power --
  // a def-tab edit surfaces once an instance of that def sits on the board).
  const checkWidthMismatch = (editedId: string) => {
    const board = get().board;
    const tabPrefix = 'main/'; // compile() always roots the given circuit at 'main/'.
    try {
      const loweredLib: ChipLibrary = new Map(
        [...get().chipLib].map(([id, def]) => [id, lowerCircuit(def)]),
      );
      compile(lowerCircuit(board), loweredLib);
      set((s) =>
        s.mismatchWires.size > 0 || s.error?.startsWith('width:')
          ? { error: null, mismatchWires: new Set() }
          : { mismatchWires: new Set() },
      );
    } catch (e) {
      if (!(e instanceof CompileError)) return;
      const badId = e.path.startsWith(tabPrefix) ? e.path.slice(tabPrefix.length) : editedId;
      const bad = new Set(
        board.wires
          .filter(
            (w) =>
              (w.a.kind === 'pin' && w.a.component === badId) ||
              (w.b.kind === 'pin' && w.b.component === badId),
          )
          .map((w) => w.id),
      );
      set({ error: `width: ${e.message}`, mismatchWires: bad });
    }
  };

  // Pre-commit twin of compile.ts's own multi-driver check, via compile()
  // itself so it can't drift from the real rule. `before` compiles first so
  // an already-broken board never blocks an unrelated new wire.
  const multiDriverConflict = (
    before: Circuit,
    trial: Circuit,
    chipLib: ChipLibrary,
  ): string | null => {
    // `before`/`trial` are draft-derived Circuits, but at runtime they carry
    // whichever Board/ChipDef they were spread from (same assumption
    // labelDirectionConflict's own trial circuits already make) -- compile()
    // itself only needs Circuit's fields plus a lib to resolve chip
    // instances, so the wider param type is a formality here.
    const lower = (lib: ChipLibrary): ChipLibrary =>
      new Map([...lib].map(([id, def]) => [id, lowerCircuit(def)]));
    try {
      compile(lowerCircuit(before as Board | ChipDef), lower(chipLib));
    } catch {
      return null;
    }
    try {
      compile(lowerCircuit(trial as Board | ChipDef), lower(chipLib));
      return null;
    } catch (e) {
      return e instanceof CompileError && e.message.includes('drive the same wire')
        ? e.message
        : null;
    }
  };

  const pinRefs = (ends: WireEnd[]): PinRef[] =>
    ends
      .filter((e): e is Extract<WireEnd, { kind: 'pin' }> => e.kind === 'pin')
      .map((e) => ({ component: e.component, pin: e.pin }));

  const initialBoard = starterBoard();
  seedNextId(initialBoard);

  return {
    board: initialBoard,
    chipLib: new Map(),
    tabs: [{ id: 'board', kind: 'board' }],
    activeTabId: 'board',
    staleInstances: new Set(),
    tool: { kind: 'select' },
    selection: new Set(),
    fitRequest: 0,
    rev: 0,
    powered: false,
    running: false,
    error: null,
    mismatchWires: new Set(),
    changedPrims: new Set(),
    timing: { mode: getPrefs().timingModel, datasheet: 'typ' },
    waveformOpen: false,
    replayTimePs: null,
    hoverTrackPath: null,
    staReport: null,
    mode: 'edit',
    labelConflict: null,
    pendingTabClose: null,
    bubbleBaseline: null,
    bubbleFocus: null,
    bubblePreview: null,
    bubblePairMode: false,

    setTool: (tool) => set({ tool }),
    setSelection: (selection) => set({ selection }),
    activeCircuit,

    openDefTab: (defId, prefix, breadcrumb) => {
      const existing = get().tabs.find(
        (t) => t.kind === 'def' && t.defId === defId && t.prefix === prefix,
      );
      if (existing) {
        set({ activeTabId: existing.id, tool: { kind: 'select' }, selection: new Set() });
        return;
      }
      const def = get().chipLib.get(defId);
      if (!def) return;
      const baseline: ChipDef = { ...def, ...cloneCircuit(def) };
      const tab: Tab = { id: genId('tab'), kind: 'def', defId, prefix, breadcrumb, baseline };
      set((s) => ({
        tabs: [...s.tabs, tab],
        activeTabId: tab.id,
        tool: { kind: 'select' },
        selection: new Set(),
      }));
    },

    closeTab: (id) => {
      if (id === 'board') return;
      if (historyByTab.get(id)?.canUndo) {
        set({ pendingTabClose: id });
        return;
      }
      historyByTab.delete(id);
      set((s) => ({
        tabs: s.tabs.filter((t) => t.id !== id),
        activeTabId: s.activeTabId === id ? 'board' : s.activeTabId,
        tool: { kind: 'select' },
        selection: new Set(),
      }));
    },

    resolveTabClose: (action) => {
      const id = get().pendingTabClose;
      if (!id) return;
      const tab = get().tabs.find((t) => t.id === id);
      if (tab && tab.kind === 'def' && action === 'discard') {
        commitDefEdit(tab.defId, cloneCircuit(tab.baseline));
      }
      historyByTab.delete(id);
      set((s) => ({
        tabs: s.tabs.filter((t) => t.id !== id),
        activeTabId: s.activeTabId === id ? 'board' : s.activeTabId,
        tool: { kind: 'select' },
        selection: new Set(),
        pendingTabClose: null,
      }));
    },

    cancelTabClose: () => set({ pendingTabClose: null }),

    setActiveTab: (id) => {
      if (!get().tabs.some((t) => t.id === id)) return;
      set({ activeTabId: id, tool: { kind: 'select' }, selection: new Set() });
    },

    loadBoard: (board) => {
      seedNextId(board);
      historyByTab.clear();
      sim = null;
      replayIdx = null;
      set((st) => ({
        board,
        tabs: [{ id: 'board', kind: 'board' }],
        activeTabId: 'board',
        selection: new Set<string>(),
        staleInstances: new Set<string>(),
        mismatchWires: new Set<string>(),
        changedPrims: new Set<string>(),
        error: null,
        powered: false,
        running: false,
        staReport: null,
        replayTimePs: null,
        labelConflict: null,
        rev: st.rev + 1,
      }));
    },

    requestFit: () => set((st) => ({ fitRequest: st.fitRequest + 1 })),

    commitNewChip: (def) => {
      const candidateLib = new Map(get().chipLib);
      candidateLib.set(def.id, def);
      const cycleError = findCycle(candidateLib);
      if (cycleError) return { ok: false, error: cycleError };
      set({ chipLib: candidateLib });
      return { ok: true };
    },

    loadChipDefs: (defs) => {
      if (defs.length === 0) return { ok: true, count: 0 };
      const candidateLib = new Map(get().chipLib);
      for (const def of defs) candidateLib.set(def.id, def);
      const cycleError = findCycle(candidateLib);
      if (cycleError) return { ok: false, error: cycleError };
      set((st) => ({ chipLib: candidateLib, rev: st.rev + 1 }));
      return { ok: true, count: defs.length };
    },

    renameComponent: (id, label) => renameWith(id, label, null),

    applyLabelConflicts: (choices) => {
      const conflicts = get().labelConflict;
      if (!conflicts) return;
      set({ labelConflict: null });
      edit('rename', (d) => {
        conflicts.forEach((row, i) => {
          const label = choices[i];
          if (!label) return; // keep both -- no mutation for this row
          d.components = d.components.map((c) =>
            row.netComponentIds.includes(c.id) ? { ...c, label } : c,
          );
        });
      });
    },

    // The edit that raised the conflict already committed (it's the most
    // recent history entry) -- undoing it reverts the attempted rename
    // itself, not just the unresolved label choice.
    cancelLabelConflict: () => {
      if (!get().labelConflict) return;
      set({ labelConflict: null });
      get().undo();
    },

    place: (kind, pos, grid, params, pose, defId) => {
      if (kind === 'chip' ? !defId || !get().chipLib.has(defId) : !hasPrimitive(kind)) return;
      const id = genId(kind === 'chip' ? defId! : idPrefix(kind));
      edit('place', (d) =>
        d.components.push({
          id,
          kind,
          ...(kind === 'chip' ? { defId: defId as string } : {}),
          pos: snapPoint(pos, grid),
          ...(params ? { params } : {}),
          ...(pose?.rot ? { rot: pose.rot } : {}),
          ...(pose?.mirror ? { mirror: true } : {}),
        }),
      );
    },

    // Insert-on-wire: splices a 1-in/1-out primitive into the hit wire, one
    // undo step. `upstreamEnd`/`downstreamEnd` are the original wire's two
    // ends, oriented by the caller so the component's pins match signal flow.
    // `pos` arrives pre-aligned to the wire's pin geometry (spliceOnWire's
    // alignSplicePos) -- re-snapping both axes here would pull it back off
    // the wire line, so it's used verbatim. `componentId` (drag/duplicate
    // splice): moves that existing component instead of minting a new one.
    insertOnWire: (opts) => {
      if (!opts.componentId && !hasPrimitive(opts.kind)) return;
      edit(opts.componentId ? 'move' : 'place', (d) => {
        const idx = d.wires.findIndex((w) => w.id === opts.wireId);
        if (idx < 0) return;
        let compId: string;
        if (opts.componentId) {
          const ci = d.components.findIndex((c) => c.id === opts.componentId);
          if (ci < 0) return;
          compId = opts.componentId;
          d.components[ci] = { ...d.components[ci]!, pos: opts.pos };
        } else {
          compId = genId(opts.kind);
          const used = new Set(d.components.map((c) => c.label).filter((l): l is string => !!l));
          d.components.push({
            id: compId,
            kind: opts.kind,
            pos: opts.pos,
            ...(opts.params ? { params: opts.params } : {}),
            ...(opts.rot ? { rot: opts.rot } : {}),
            ...(opts.mirror ? { mirror: opts.mirror } : {}),
            ...(opts.label ? { label: nextLabel(opts.label, used) } : {}),
          });
        }
        d.wires.splice(
          idx,
          1,
          {
            id: genId('w'),
            a: opts.upstreamEnd,
            b: { kind: 'pin', component: compId, pin: opts.inName },
            points: [],
          },
          {
            id: genId('w'),
            a: { kind: 'pin', component: compId, pin: opts.outName },
            b: opts.downstreamEnd,
            points: [],
          },
        );
      });
    },

    moveSelection: (dx, dy, resolveEnd) => {
      const sel = get().selection;
      if (sel.size === 0) return;
      edit('move', (d) => {
        // Resolve every touched wire's OLD end positions off the live
        // (not-yet-mutated) store before this draft's component/junction
        // positions are rewritten below -- resolveEnd reads geometry the
        // pure draft doesn't have.
        if (resolveEnd) {
          for (const w of d.wires) {
            const aMoved =
              (w.a.kind === 'pin' && sel.has(w.a.component)) ||
              (w.a.kind === 'junction' && sel.has(w.a.junction));
            const bMoved =
              (w.b.kind === 'pin' && sel.has(w.b.component)) ||
              (w.b.kind === 'junction' && sel.has(w.b.junction));
            if (!aMoved && !bMoved) continue;
            const aOld = resolveEnd(w.a);
            const bOld = resolveEnd(w.b);
            if (!aOld || !bOld) continue;
            w.points = stretchWirePoints(w.points, aOld, bOld, aMoved, bMoved, { x: dx, y: dy });
          }
        }
        d.components = d.components.map((c) =>
          sel.has(c.id) ? { ...c, pos: { x: c.pos.x + dx, y: c.pos.y + dy } } : c,
        );
        d.junctions = d.junctions.map((j) =>
          sel.has(j.id) ? { ...j, pos: { x: j.pos.x + dx, y: j.pos.y + dy } } : j,
        );
      });
    },

    // Alt+drag (detach): moves the selection but cuts any wire touching it to
    // a free end at the pin's pre-move position, instead of stretching the
    // wire along. `detachedEnds` are pre-resolved by the caller (positions
    // need live pin geometry the store doesn't have).
    moveSelectionDetached: (dx, dy, detachedEnds) => {
      const sel = get().selection;
      if (sel.size === 0) return;
      edit('move', (d) => {
        d.components = d.components.map((c) =>
          sel.has(c.id) ? { ...c, pos: { x: c.pos.x + dx, y: c.pos.y + dy } } : c,
        );
        d.junctions = d.junctions.map((j) =>
          sel.has(j.id) ? { ...j, pos: { x: j.pos.x + dx, y: j.pos.y + dy } } : j,
        );
        for (const e of detachedEnds) {
          const w = d.wires.find((w) => w.id === e.wireId);
          if (!w) continue;
          if (e.end === 'a') w.a = { kind: 'free', pos: e.pos };
          else w.b = { kind: 'free', pos: e.pos };
        }
      });
    },

    // Duplicate (Shift+D) commit and paste (Ctrl+V) share this: `slice` is an
    // extracted sub-circuit with its original ids (from extractInternalSelection),
    // remapped fresh here so a clipboard can be pasted repeatedly without id
    // collisions; `offset` moves the copy clear of the source. One undo step;
    // the new component/junction ids are selected afterward.
    commitDuplicate: (slice, offset) => {
      if (slice.components.length === 0 && slice.junctions.length === 0) return;
      const idMap = new Map<string, string>();
      edit('duplicate', (d) => {
        for (const c of slice.components) idMap.set(c.id, genId(idPrefix(c.kind)));
        for (const j of slice.junctions) idMap.set(j.id, genId('j'));
        // A copied label would collide across nets (blank-screen compile
        // failure for ports, uniqueness violation for devices) -- each
        // labeled copy advances to the next free label instead. A NET LABEL is
        // the exception: copying one and keeping its name is how you extend a
        // named net, so it is never renamed.
        const usedLabels = new Set(
          d.components.map((c) => c.label).filter((l): l is string => !!l),
        );
        const relabel = (label: string): string => {
          const next = nextLabel(label, usedLabels);
          usedLabels.add(next);
          return next;
        };
        const remapEnd = (end: WireEnd): WireEnd => {
          if (end.kind === 'pin')
            return { kind: 'pin', component: idMap.get(end.component)!, pin: end.pin };
          if (end.kind === 'junction')
            return { kind: 'junction', junction: idMap.get(end.junction)! };
          return end;
        };
        for (const c of slice.components)
          d.components.push({
            ...c,
            id: idMap.get(c.id)!,
            ...(c.label && c.kind !== 'netlabel' ? { label: relabel(c.label) } : {}),
            pos: { x: c.pos.x + offset.x, y: c.pos.y + offset.y },
          });
        for (const j of slice.junctions)
          d.junctions.push({
            ...j,
            id: idMap.get(j.id)!,
            pos: { x: j.pos.x + offset.x, y: j.pos.y + offset.y },
          });
        for (const w of slice.wires)
          d.wires.push({
            id: genId('w'),
            a: remapEnd(w.a),
            b: remapEnd(w.b),
            points: w.points.map((p) => ({ x: p.x + offset.x, y: p.y + offset.y })),
          });
      });
      if (idMap.size > 0) set({ selection: new Set(idMap.values()) });
    },

    rotateSelection: (items, grid) => {
      if (items.length === 0) return;
      const results = new Map(
        items.map((item) => [
          item.id,
          // `item.pivot`, when given (a single-pin part hinging on its own
          // pin's world position, per the owner), is a genuine external
          // fixed point -- true corner-rotation (rotateAboutPivot), exact
          // whenever the pivot is grid-aligned (a real pin always is). With
          // no explicit pivot (the default own-body rotate), a plain corner
          // rotation about an approximated center would still drift, so
          // that case keeps groupRotateComponent's "recentre" formula.
          item.pivot
            ? rotateAboutPivot(item, item.pivot)
            : groupRotateComponent(
                item,
                {
                  x: item.bounds.x + halfSnap(item.bounds.w, grid),
                  y: item.bounds.y + halfSnap(item.bounds.h, grid),
                },
                grid,
              ),
        ]),
      );
      edit('rotate', (d) => {
        d.components = d.components.map((c) => {
          const r = results.get(c.id);
          return r ? { ...c, pos: r.pos, rot: r.rot } : c;
        });
      });
    },

    // Shift+R: rotate the whole selection as one rigid body about its shared
    // pivot. Geometry is fully pre-computed by the caller (wireGeom's
    // groupRotateComponent/rotatePointAround); this just writes it in.
    applyGroupRotate: (updates) => {
      if (
        updates.components.length === 0 &&
        updates.junctions.length === 0 &&
        updates.wires.length === 0
      )
        return;
      edit('rotate', (d) => {
        const compById = new Map(updates.components.map((u) => [u.id, u]));
        d.components = d.components.map((c) => {
          const u = compById.get(c.id);
          return u ? { ...c, pos: u.pos, rot: u.rot } : c;
        });
        const juncById = new Map(updates.junctions.map((u) => [u.id, u]));
        d.junctions = d.junctions.map((j) => {
          const u = juncById.get(j.id);
          return u ? { ...j, pos: u.pos } : j;
        });
        const wireById = new Map(updates.wires.map((u) => [u.id, u]));
        d.wires = d.wires.map((w) => {
          const u = wireById.get(w.id);
          if (!u) return w;
          return { ...w, points: u.points, ...(u.a ? { a: u.a } : {}), ...(u.b ? { b: u.b } : {}) };
        });
      });
    },

    // Align/Distribute toolbar: writes pre-computed component positions and
    // wire bend points in one undo step (see wireGeom's alignDeltas/
    // distributeDeltas and the caller's per-end stretchWirePoints calls).
    applyGroupMove: (updates) => {
      if (updates.components.length === 0 && updates.wires.length === 0) return;
      edit('move', (d) => {
        const compById = new Map(updates.components.map((u) => [u.id, u]));
        d.components = d.components.map((c) => {
          const u = compById.get(c.id);
          return u ? { ...c, pos: u.pos } : c;
        });
        const wireById = new Map(updates.wires.map((u) => [u.id, u]));
        d.wires = d.wires.map((w) => {
          const u = wireById.get(w.id);
          return u ? { ...w, points: u.points } : w;
        });
      });
    },

    tidyWiring: ({ components, grid, only }) => {
      edit('tidy', (d) => {
        const r = autoRoute({
          components,
          wires: d.wires,
          junctions: d.junctions,
          grid,
          ...(only && only.size > 0 ? { only } : {}),
        });
        if (r.routed === 0) return;
        d.wires = r.wires;
        d.junctions = r.junctions;
      });
    },

    mirrorSelection: (ids) => {
      const sel = ids ?? get().selection;
      if (sel.size === 0) return;
      edit('mirror', (d) => {
        d.components = d.components.map((c) => (sel.has(c.id) ? { ...c, mirror: !c.mirror } : c));
      });
    },

    groupSelection: (name) => {
      const sel = get().selection;
      const circuit = activeCircuit();
      const members = circuit.components.filter((c) => sel.has(c.id));
      if (members.length === 0) return null;
      const id = genId('g');
      // Numbered from what the board already has, so dissolving and regrouping
      // does not reuse a name the instructor is still reading on screen.
      const taken = new Set((circuit.groups ?? []).map((g) => g.name));
      let n = (circuit.groups?.length ?? 0) + 1;
      let chosen = name?.trim() || `Group ${n}`;
      while (!name && taken.has(chosen)) chosen = `Group ${++n}`;
      // Grouping inside a group NESTS rather than overwriting: when every
      // member already shares one group, that group becomes the new one's
      // parent and keeps the components it still visually encloses.
      const parents = new Set(members.map((c) => c.group));
      const parent = parents.size === 1 ? [...parents][0] : undefined;
      edit('group', (d) => {
        d.groups = [...(d.groups ?? []), { id, name: chosen, ...(parent ? { parent } : {}) }];
        d.components = d.components.map((c) => (sel.has(c.id) ? { ...c, group: id } : c));
      });
      return id;
    },

    ungroupSelection: () => {
      const sel = get().selection;
      const circuit = activeCircuit();
      const touched = new Set(
        circuit.components.filter((c) => sel.has(c.id) && c.group).map((c) => c.group!),
      );
      if (touched.size === 0) return;
      const parentOf = new Map((circuit.groups ?? []).map((g) => [g.id, g.parent]));
      edit('ungroup', (d) => {
        // A dissolved group's children rise to its own parent rather than
        // being orphaned onto the board.
        d.groups = (d.groups ?? [])
          .filter((g) => !touched.has(g.id))
          .map((g) => {
            if (!g.parent || !touched.has(g.parent)) return g;
            const up = parentOf.get(g.parent);
            const next = { ...g };
            if (up) next.parent = up;
            else delete next.parent;
            return next;
          });
        d.components = d.components.map((c) => {
          if (!c.group || !touched.has(c.group)) return c;
          const up = parentOf.get(c.group);
          const rest = { ...c };
          if (up) rest.group = up;
          else delete rest.group;
          return rest;
        });
      });
    },

    renameGroup: (id, name) => {
      const trimmed = name.trim();
      if (!trimmed) return false;
      const circuit = activeCircuit();
      if (circuit.groups?.some((g) => g.id !== id && g.name === trimmed)) return false;
      edit('rename group', (d) => {
        d.groups = (d.groups ?? []).map((g) => (g.id === id ? { ...g, name: trimmed } : g));
      });
      return true;
    },

    deleteSelection: (ids, resolveEnd) => {
      const sel = ids ?? get().selection;
      if (sel.size === 0) return;
      edit(
        'delete',
        (d) => {
          d.components = d.components.filter((c) => !sel.has(c.id));
          // Selected wires go too; heal-free delete drops wires that touched a
          // removed component or a deleted junction (Task 4: a dangling
          // {kind:'junction', junction: <deleted id>} end would otherwise
          // keep its other end's pin permanently occupied).
          d.wires = d.wires.filter(
            (w) =>
              !sel.has(w.id) &&
              !(w.a.kind === 'pin' && sel.has(w.a.component)) &&
              !(w.b.kind === 'pin' && sel.has(w.b.component)) &&
              !(w.a.kind === 'junction' && sel.has(w.a.junction)) &&
              !(w.b.kind === 'junction' && sel.has(w.b.junction)),
          );
          d.junctions = d.junctions.filter((j) => !sel.has(j.id));
        },
        resolveEnd,
      );
      set((s) => ({ selection: new Set([...s.selection].filter((id) => !sel.has(id))) }));
    },

    // Ctrl+X: 1-in/1-out components in the set are healed (a wire is added
    // from whatever drove their `in` pin to each thing their `out` pin fed,
    // for every fan-out consumer); anything else is a normal delete. One undo
    // step covers the whole set.
    deleteWithHeal: (ids, resolveEnd) => {
      const sel = ids ?? get().selection;
      if (sel.size === 0) return;
      edit(
        'delete',
        (d) => {
          const otherEnd = (w: Wire, componentId: string) =>
            w.a.kind === 'pin' && w.a.component === componentId ? w.b : w.a;
          // Degree-2 pass-through junctions heal too: merge the two legs into
          // one wire, keeping the junction's position as a bend (an explicit
          // Ctrl+X heals even non-collinear legs, unlike auto-collapse).
          // T/cross junctions (3+ legs) fall through to a plain delete.
          for (const id of sel) {
            const j = d.junctions.find((x) => x.id === id);
            if (!j) continue;
            const refs: { wire: Wire; end: 'a' | 'b' }[] = [];
            for (const w of d.wires) {
              if (w.a.kind === 'junction' && w.a.junction === j.id)
                refs.push({ wire: w, end: 'a' });
              if (w.b.kind === 'junction' && w.b.junction === j.id)
                refs.push({ wire: w, end: 'b' });
            }
            if (refs.length !== 2) continue;
            const [r1, r2] = refs as [(typeof refs)[number], (typeof refs)[number]];
            if (r1.wire.id === r2.wire.id) continue;
            const seg1 = r1.end === 'a' ? [...r1.wire.points].reverse() : r1.wire.points;
            const seg2 = r2.end === 'a' ? r2.wire.points : [...r2.wire.points].reverse();
            d.wires = d.wires.filter((w) => w.id !== r1.wire.id && w.id !== r2.wire.id);
            d.wires.push({
              id: genId('w'),
              a: r1.end === 'a' ? r1.wire.b : r1.wire.a,
              b: r2.end === 'a' ? r2.wire.b : r2.wire.a,
              points: [...seg1, { ...j.pos }, ...seg2],
            });
            d.junctions = d.junctions.filter((x) => x.id !== j.id);
          }
          for (const id of sel) {
            const comp = d.components.find((c) => c.id === id);
            if (!comp) continue;
            const spec = splicePins(comp.kind, comp.params ?? {});
            if (!spec) continue;
            const inWire = d.wires.find(
              (w) =>
                (w.a.kind === 'pin' && w.a.component === id && w.a.pin === spec.inName) ||
                (w.b.kind === 'pin' && w.b.component === id && w.b.pin === spec.inName),
            );
            const outWires = d.wires.filter(
              (w) =>
                (w.a.kind === 'pin' && w.a.component === id && w.a.pin === spec.outName) ||
                (w.b.kind === 'pin' && w.b.component === id && w.b.pin === spec.outName),
            );
            if (!inWire || outWires.length === 0) continue;
            const upstreamEnd = otherEnd(inWire, id);
            for (const ow of outWires)
              d.wires.push({ id: genId('w'), a: upstreamEnd, b: otherEnd(ow, id), points: [] });
          }
          d.components = d.components.filter((c) => !sel.has(c.id));
          // A 3+-way junction falls through the heal loop above untouched
          // (only the degree-2 case explicitly removes+merges its two
          // wires); every wire still ending in a junction about to be
          // deleted must go too, or it survives as a dangling
          // {kind:'junction', junction: <deleted id>} end -- which keeps its
          // OTHER end's pin permanently occupied (Task 4).
          d.wires = d.wires.filter(
            (w) =>
              !sel.has(w.id) &&
              !(w.a.kind === 'pin' && sel.has(w.a.component)) &&
              !(w.b.kind === 'pin' && sel.has(w.b.component)) &&
              !(w.a.kind === 'junction' && sel.has(w.a.junction)) &&
              !(w.b.kind === 'junction' && sel.has(w.b.junction)),
          );
          d.junctions = d.junctions.filter((j) => !sel.has(j.id));
        },
        resolveEnd,
      );
      set((s) => ({ selection: new Set([...s.selection].filter((id) => !sel.has(id))) }));
    },

    setGateInputs: (id, delta) => {
      const comp = activeCircuit().components.find((c) => c.id === id);
      if (!comp || !VARIABLE_ARITY_GATES.has(comp.kind)) return;
      const cur = Number(comp.params?.['inputs'] ?? 2);
      applyGateInputCount(id, cur + delta);
    },

    setGateInputCount: (id, next) => {
      const comp = activeCircuit().components.find((c) => c.id === id);
      if (!comp || !VARIABLE_ARITY_GATES.has(comp.kind)) return;
      applyGateInputCount(id, next);
    },

    stepBitsParam: (id, delta) => {
      const comp = activeCircuit().components.find((c) => c.id === id);
      if (!comp || !(comp.kind in BITS_PARAM_KEY)) return;
      applyBitsParam(id, delta, true);
    },

    setBitsParam: (id, next) => {
      const comp = activeCircuit().components.find((c) => c.id === id);
      if (!comp || !(comp.kind in BITS_PARAM_KEY)) return;
      applyBitsParam(id, next, false);
    },

    stepToggleWidth: (id, delta) => {
      const comp = activeCircuit().components.find((c) => c.id === id);
      if (!comp || (comp.kind !== 'toggle' && comp.kind !== 'led')) return;
      const cur = Number(comp.params?.['width'] ?? 1);
      applyToggleWidth(id, cur + delta);
    },

    clearTransientError: clearTransientErrorImpl,

    setWirePoints: (id, points) => {
      edit('wire-drag', (d) => {
        d.wires = d.wires.map((w) => (w.id === id ? { ...w, points } : w));
      });
    },

    deleteWires: (ids, resolveEnd) => {
      if (ids.size === 0) return;
      edit(
        'cut',
        (d) => {
          d.wires = d.wires.filter((w) => !ids.has(w.id));
        },
        resolveEnd,
      );
    },

    addWire: (a, b, points = []) => {
      let conflict: CircuitState['labelConflict'] = null;
      let dirError: string | null = null;
      edit('wire', (d) => {
        const trial: Circuit = { ...d, wires: [...d.wires, { id: '__trial', a, b, points: [] }] };
        dirError =
          labelDirectionConflict(trial, get().chipLib, netTouchedPins(trial, [a, b])) ??
          multiDriverConflict(d, trial, get().chipLib);
        if (dirError) return; // no mutation -> edit() diffs empty and no-ops
        d.wires.push({ id: genId('w'), a, b, points });
        conflict = syncLabels(d, pinRefs([a, b]));
      });
      if (dirError) {
        set({ error: `label: ${dirError}` });
        return false;
      }
      if (conflict) set({ labelConflict: conflict });
      // Rewiring an instance that lost a pin clears its re-bind badge.
      const touched = [a, b]
        .filter((e): e is Extract<WireEnd, { kind: 'pin' }> => e.kind === 'pin')
        .map((e) => e.component);
      if (touched.some((id) => get().staleInstances.has(id))) {
        set((s) => {
          const next = new Set(s.staleInstances);
          touched.forEach((id) => next.delete(id));
          return { staleInstances: next };
        });
      }
      return true;
    },

    // Smart-connect commit: every proposed pair lands in one undo step.
    addWires: (pairs) => {
      if (pairs.length === 0) return true;
      let conflict: CircuitState['labelConflict'] = null;
      let dirError: string | null = null;
      edit('wire', (d) => {
        const trialWires = [
          ...d.wires,
          ...pairs.map(({ a, b }, i) => ({ id: `__trial${i}`, a, b, points: [] })),
        ];
        const trial: Circuit = { ...d, wires: trialWires };
        const touchedPins = netTouchedPins(
          trial,
          pairs.flatMap(({ a, b }) => [a, b]),
        );
        dirError =
          labelDirectionConflict(trial, get().chipLib, touchedPins) ??
          multiDriverConflict(d, trial, get().chipLib);
        if (dirError) return;
        for (const { a, b } of pairs) d.wires.push({ id: genId('w'), a, b, points: [] });
        conflict = syncLabels(d, touchedPins);
      });
      if (dirError) {
        set({ error: `label: ${dirError}` });
        return false;
      }
      if (conflict) set({ labelConflict: conflict });
      const touched = pairs
        .flatMap(({ a, b }) => [a, b])
        .filter((e): e is Extract<WireEnd, { kind: 'pin' }> => e.kind === 'pin')
        .map((e) => e.component);
      if (touched.some((id) => get().staleInstances.has(id))) {
        set((s) => {
          const next = new Set(s.staleInstances);
          touched.forEach((id) => next.delete(id));
          return { staleInstances: next };
        });
      }
      return true;
    },

    addJunction: (pos, grid, resolveEnd) => {
      // A junction only exists on a wire: hit-test and split it there. Splits
      // *every* wire that actually passes through pos (P0.1) -- at a genuine
      // crossing of two independently-drawn wires that's two splits sharing
      // one junction, not just the nearer wire. Real electrical connection
      // (not a decorative dot) -- each half terminates at the new junction,
      // which compile.ts already unions. Deliberately does *not* run its own
      // resolveEnd-aware collapse pass afterward: splitting one single
      // (uncrossed) wire is itself a degree-2 collinear split by construction,
      // and an explicit user placement there should stick, not vanish
      // immediately -- P0.2's auto-collapse is for a junction that *becomes*
      // an ordinary pass-through after a later mutation, not for this one.
      edit('junction', (d) => {
        if (junctionNear(d.junctions, pos, grid)) return; // already connected here
        const hits = findWireHitsAt(d.wires, pos, grid, resolveEnd);
        if (hits.length === 0) return;
        const jid = genId('j');
        const junctionPos = hits[0]!.snapped;
        for (const hit of hits) attachAtHit(d, hit, jid, grid, () => genId('w'));
        d.junctions.push({ id: jid, pos: junctionPos });
      });
    },

    // Wire-completion when the new wire's other end lands on an existing wire's
    // body rather than a pin: split that wire and join at a real junction
    // instead of leaving a dangling free end. Returns whether it found a wire
    // to connect to (the caller falls back to a free end when it didn't, in
    // Wire-tool mode only).
    connectToJunction: (a, pos, grid, resolveEnd, points = []) => {
      let connected = false;
      let conflict: CircuitState['labelConflict'] = null;
      let dirError: string | null = null;
      edit(
        'wire',
        (d) => {
          const existing = junctionNear(d.junctions, pos, grid);
          if (existing) {
            const trial: Circuit = {
              ...d,
              wires: [
                ...d.wires,
                { id: '__trial', a, b: { kind: 'junction', junction: existing.id }, points: [] },
              ],
            };
            const bEnd: WireEnd = { kind: 'junction', junction: existing.id };
            dirError =
              labelDirectionConflict(trial, get().chipLib, netTouchedPins(trial, [a, bEnd])) ??
              multiDriverConflict(d, trial, get().chipLib);
            if (dirError) return;
            d.wires.push({
              id: genId('w'),
              a,
              b: bEnd,
              points,
            });
            connected = true;
            conflict = syncLabels(d, pinRefs([a]));
            return;
          }
          const hit = findWireHit(d.wires, pos, grid, resolveEnd);
          if (!hit) return;
          // Splitting `hit` into a junction doesn't change its net -- checking
          // against a direct trial wire to one of its existing endpoints reads
          // the same merged net without mutating the draft before we know
          // whether the connection is even legal.
          const trial: Circuit = {
            ...d,
            wires: [...d.wires, { id: '__trial', a, b: hit.wire.a, points: [] }],
          };
          dirError =
            labelDirectionConflict(trial, get().chipLib, netTouchedPins(trial, [a, hit.wire.a])) ??
            multiDriverConflict(d, trial, get().chipLib);
          if (dirError) return;
          const jid = genId('j');
          attachAtHit(d, hit, jid, grid, () => genId('w'));
          d.junctions.push({ id: jid, pos: hit.snapped });
          d.wires.push({ id: genId('w'), a, b: { kind: 'junction', junction: jid }, points });
          connected = true;
          conflict = syncLabels(d, pinRefs([a]));
        },
        resolveEnd,
      );
      if (dirError) {
        set({ error: `label: ${dirError}` });
        return 'rejected';
      }
      if (conflict) set({ labelConflict: conflict });
      return connected ? 'connected' : 'miss';
    },

    // Wire-completion onto a bus wire's body from a narrower pin: pulls off a
    // sub-range tap instead of a same-width junction split. The bus wire is
    // left completely alone -- a tap only ever adds a new wire referencing it,
    // matching "a tap never materializes N physical nets".
    // Default range is the bus's bottom `aWidth` bits; callers wanting a
    // different sub-range place the tap then edit its range (not built yet --
    // see the residual note in the same doc section).
    connectToTap: (a, pos, grid, resolveEnd, aWidth, points = []) => {
      let connected = false;
      let conflict: CircuitState['labelConflict'] = null;
      let dirError: string | null = null;
      edit(
        'wire',
        (d) => {
          const hit = findWireHit(d.wires, pos, grid, resolveEnd);
          if (!hit) return;
          const busWidth = wireWidth(hit.wire, d.components, get().chipLib);
          if (busWidth === undefined || busWidth <= aWidth) return; // not a wider bus; caller falls back
          const hi = Math.min(aWidth - 1, busWidth - 1);
          const bEnd: WireEnd = {
            kind: 'tap',
            wire: hit.wire.id,
            range: { hi, lo: 0 },
            pos: hit.snapped,
          };
          const trial: Circuit = {
            ...d,
            wires: [...d.wires, { id: '__trial', a, b: bEnd, points: [] }],
          };
          dirError =
            labelDirectionConflict(trial, get().chipLib, netTouchedPins(trial, [a, bEnd])) ??
            multiDriverConflict(d, trial, get().chipLib);
          if (dirError) return;
          d.wires.push({ id: genId('w'), a, b: bEnd, points });
          connected = true;
          conflict = syncLabels(d, pinRefs([a]));
        },
        resolveEnd,
      );
      if (dirError) {
        set({ error: `label: ${dirError}` });
        return 'rejected';
      }
      if (conflict) set({ labelConflict: conflict });
      return connected ? 'connected' : 'miss';
    },

    // B3b: drags a wire's own free end; called once on drop, never mid-drag.
    // With `drop` geometry the end materializes the same way the draw path
    // does (pin > existing junction > wire-body split); a plain move keeps
    // the free end and stays a pure move (P0.4).
    setBusLabelT: (wireId, t) => {
      const clamped = Math.min(1, Math.max(0, t));
      edit('move', (d) => {
        const w = d.wires.find((x) => x.id === wireId);
        if (w) w.busLabelT = clamped;
      });
    },

    moveFreeEnd: (wireId, end, pos, drop) => {
      // Resolved read-only first so a rejected drop leaves the free end put.
      type DropCandidate =
        | { kind: 'pin'; wireEnd: WireEnd }
        | { kind: 'existingJunction'; wireEnd: WireEnd }
        | { kind: 'hit'; wireEnd: WireEnd; hit: WireHit }
        | { kind: 'none' };
      const resolveDrop = (
        d: Circuit,
        drop: { grid: number; resolveEnd: ResolveWireEnd; pinEnd?: WireEnd },
      ): DropCandidate => {
        if (drop.pinEnd) return { kind: 'pin', wireEnd: drop.pinEnd };
        const existing = junctionNear(d.junctions, pos, drop.grid);
        if (existing)
          return { kind: 'existingJunction', wireEnd: { kind: 'junction', junction: existing.id } };
        const hit = findWireHit(
          d.wires.filter((x) => x.id !== wireId),
          pos,
          drop.grid,
          drop.resolveEnd,
        );
        return hit ? { kind: 'hit', wireEnd: hit.wire.a, hit } : { kind: 'none' };
      };
      let dirError: string | null = null;
      edit(
        'move',
        (d) => {
          const w = d.wires.find((w) => w.id === wireId);
          if (!w || w[end].kind !== 'free') return;
          if (drop) {
            const candidate = resolveDrop(d, drop);
            if (candidate.kind !== 'none') {
              const trial: Circuit = {
                ...d,
                wires: d.wires.map((x) =>
                  x.id === wireId ? { ...x, [end]: candidate.wireEnd } : x,
                ),
              };
              dirError =
                labelDirectionConflict(
                  trial,
                  get().chipLib,
                  netTouchedPins(trial, [candidate.wireEnd]),
                ) ?? multiDriverConflict(d, trial, get().chipLib);
              if (dirError) return; // no mutation -> free end stays put
              if (candidate.kind === 'pin' || candidate.kind === 'existingJunction') {
                w[end] = candidate.wireEnd;
                return;
              }
              const jid = genId('j');
              attachAtHit(d, candidate.hit, jid, drop.grid, () => genId('w'));
              d.junctions.push({ id: jid, pos: candidate.hit.snapped });
              w[end] = { kind: 'junction', junction: jid };
              return;
            }
          }
          w[end] = { kind: 'free', pos };
        },
        drop?.resolveEnd,
      );
      if (dirError) {
        set({ error: `label: ${dirError}` });
        return;
      }
      // Dragging a dangling stub back onto a pin is the natural way to fix a
      // re-bind badge (Task 3) -- addWire/addWires already clear it on a fresh
      // wire, this materialize-onto-a-pin path just never mirrored that.
      if (drop?.pinEnd?.kind === 'pin') {
        const id = drop.pinEnd.component;
        if (get().staleInstances.has(id)) {
          set((s) => {
            const next = new Set(s.staleInstances);
            next.delete(id);
            return { staleInstances: next };
          });
        }
      }
    },

    wireFromStart: (aPos, b, grid, resolveEnd, points = []) => {
      let committed = false;
      let wireFromStartError: string | null = null;
      edit(
        'wire',
        (d) => {
          // Read-only probe first (no mutation) so a `b` that fails to
          // resolve leaves the draft untouched -- committing `a`'s junction
          // split/creation and then bailing on `b` would strand a real
          // split with no wire ever added.
          type Probe =
            | { kind: 'existingJunction'; id: string }
            | { kind: 'hit'; hit: WireHit }
            | { kind: 'none' };
          const probe = (pos: Point): Probe => {
            const existing = junctionNear(d.junctions, pos, grid);
            if (existing) return { kind: 'existingJunction', id: existing.id };
            const hit = findWireHit(d.wires, pos, grid, resolveEnd);
            return hit ? { kind: 'hit', hit } : { kind: 'none' };
          };
          const bIsPoint = !('kind' in b);
          const bProbe = bIsPoint ? probe(b.pos) : undefined;
          // `b` only bails the whole gesture when IT was a bare point that
          // missed everything (the far end also missed every pin) -- `a`
          // (the start) always commits, falling back to a free end.
          if (bIsPoint && bProbe!.kind === 'none') return;

          // Read-only stand-in for a bare-point end's resolution (existing
          // junction / a wire hit's own `.a` end, `connectToJunction`'s
          // idiom / a free end) -- validated regardless of which end is a
          // literal pin, not just when `b` is.
          const trialEndFor = (pos: Point, p: Probe): WireEnd =>
            p.kind === 'existingJunction'
              ? { kind: 'junction', junction: p.id }
              : p.kind === 'hit'
                ? p.hit.wire.a
                : { kind: 'free', pos };
          const aTrialEnd = trialEndFor(aPos, probe(aPos));
          const bTrialEnd = bIsPoint ? trialEndFor(b.pos, bProbe!) : b;
          const trial: Circuit = {
            ...d,
            wires: [...d.wires, { id: '__trial', a: aTrialEnd, b: bTrialEnd, points: [] }],
          };
          const dirError =
            labelDirectionConflict(
              trial,
              get().chipLib,
              netTouchedPins(trial, [aTrialEnd, bTrialEnd]),
            ) ?? multiDriverConflict(d, trial, get().chipLib);
          if (dirError) {
            wireFromStartError = dirError;
            return;
          }

          const materialize = (pos: Point, p: Probe): WireEnd => {
            if (p.kind === 'existingJunction') return { kind: 'junction', junction: p.id };
            if (p.kind === 'hit') {
              const jid = genId('j');
              attachAtHit(d, p.hit, jid, grid, () => genId('w'));
              d.junctions.push({ id: jid, pos: p.hit.snapped });
              return { kind: 'junction', junction: jid };
            }
            return { kind: 'free', pos };
          };
          const aEnd = materialize(aPos, probe(aPos));
          const bEnd = bIsPoint ? materialize(b.pos, bProbe!) : b;
          d.wires.push({ id: genId('w'), a: aEnd, b: bEnd, points });
          committed = true;
        },
        resolveEnd,
      );
      if (wireFromStartError) {
        set({ error: `label: ${wireFromStartError}` });
        return 'rejected';
      }
      return committed ? 'connected' : 'miss';
    },

    undo: () => {
      const tab = activeTab();
      const draft = cloneCircuit(activeCircuit());
      const apply: ApplyFn = (kind, id, value) => applyToCircuit(draft, kind, id, value as never);
      if (!historyFor(tab.id).undo(apply)) return;
      if (tab.kind === 'board') {
        set((s) => ({ board: { ...s.board, ...draft }, powered: false, rev: s.rev + 1 }));
        sim = null;
        // Re-validate against the now-reverted board: a stale compile-error/
        // mismatch from the edit just undone shouldn't outlive it.
        checkWidthMismatch('');
      } else {
        commitDefEdit(tab.defId, draft);
      }
    },

    redo: () => {
      const tab = activeTab();
      const draft = cloneCircuit(activeCircuit());
      const apply: ApplyFn = (kind, id, value) => applyToCircuit(draft, kind, id, value as never);
      if (!historyFor(tab.id).redo(apply)) return;
      if (tab.kind === 'board') {
        set((s) => ({ board: { ...s.board, ...draft }, powered: false, rev: s.rev + 1 }));
        sim = null;
        checkWidthMismatch('');
      } else {
        commitDefEdit(tab.defId, draft);
      }
    },

    setTiming: (t) => {
      const timing = { ...get().timing, ...t };
      replayIdx = null;
      set((s) => ({
        timing,
        board: { ...s.board, timing },
        powered: false,
        replayTimePs: null,
        rev: s.rev + 1,
      }));
      sim = null;
    },

    power: () => {
      replayIdx = null;
      if (get().powered) {
        sim = null;
        set((s) => ({
          powered: false,
          running: false,
          changedPrims: new Set(),
          replayTimePs: null,
          rev: s.rev + 1,
        }));
        return;
      }
      try {
        // Bubble params (base-kind gates, input bubbles, bare markers) lower
        // to plain literal kinds/spliced NOTs before compile; identity on a
        // bubble-free circuit, so ordinary boards compile exactly as before.
        // ChipDefs are lowered too so a packaged def carrying bubble params
        // still compiles.
        const loweredLib: ChipLibrary = new Map(
          [...get().chipLib].map(([id, def]) => [id, lowerCircuit(def)]),
        );
        const compiled = compile(lowerCircuit(get().board), loweredLib);
        const s = new Simulator(compiled, delayFor(get().timing));
        s.powerOn();
        sim = { sim: s, compiled };
        set((st) => ({
          powered: true,
          error: null,
          changedPrims: new Set(),
          replayTimePs: null,
          rev: st.rev + 1,
        }));
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e), powered: false });
        sim = null;
      }
    },

    step: () => {
      if (!sim) return;
      replayIdx = null;
      const report = sim.sim.stepToNextEvent();
      const changed = new Set<string>();
      if (report) for (const pi of report.evaluated) changed.add(sim.compiled.primitives[pi]!.path);
      // Park the cursor on the time just stepped to rather than snapping back
      // to live: stepping is for reading the moment you landed on.
      set((s) => ({
        changedPrims: changed,
        replayTimePs: report ? report.time : null,
        rev: s.rev + 1,
      }));
    },

    canStep: () => (sim ? sim.sim.canStep : false),

    toggleRun: () => {
      if (!sim) return;
      replayIdx = null;
      const running = !get().running;
      if (running) sim.sim.start();
      else sim.sim.stop();
      set((s) => ({ running, replayTimePs: null, rev: s.rev + 1 }));
    },

    pump: (ps) => {
      if (!sim || !get().running) return;
      sim.sim.runUntil(sim.sim.time + ps);
      set((s) => ({ rev: s.rev + 1 }));
    },

    // P0.3 (M4.2): 'inport' is deliberately excluded -- it drives X until
    // *externally* assigned, so a ChipDef's `input` boundary pin can sit
    // between an outside driver and an internal consumer without itself
    // contributing a competing drive to that net. Toggling it here would let a
    // boundary pin be both externally fed and self-toggled, which
    // compile.ts's multi-driver check (not `input`-exempt) turns into a hard
    // CompileError the moment both sides drive. `toggle` is a plain source
    // with no such boundary role and keeps working as before. `button` is
    // momentary, not a toggle -- see setButtonHeld.
    toggleInput: (componentId, bit = 0, prefix = 'main/') => {
      if (!sim) return;
      const comp = activeCircuit().components.find((c) => c.id === componentId);
      if (!comp || comp.kind !== 'toggle') return;
      // By component, never by path: a net label joining this switch's net to
      // another terminal makes that terminal inherit the switch's label, and
      // both then compile to the same path -- addressing by path flipped the
      // other component's state and left the switch stuck.
      const pi = sim.compiled.componentToPrimitive.get(`${prefix}${comp.id}`);
      if (pi === undefined) return;
      // Read the switch's own kernel state directly, not back off a `y` net
      // lookup -- once `y` is pinView-expanded into y0..y(w-1), there is no
      // single `y` net to read (pinNet returns undefined), which silently
      // read the current value as 0 on every click and made toggling one
      // bit reset every other bit to 0 instead of flipping just that bit.
      const state = sim.sim.primitiveStateAt(pi) as { value?: number } | undefined;
      const curValue = typeof state?.value === 'number' ? state.value : 0;
      replayIdx = null;
      sim.sim.setPrimitiveStateAt(pi, { value: (curValue ^ (1 << bit)) >>> 0 });
      // settle() drains the queue to empty; while free-running, a clock always
      // has a future wake queued, so settling here fast-forwarded sim time by
      // thousands of clock edges per switch click. Running mode leaves the
      // queued toggle wake to the next frame's pump instead.
      if (!get().running) sim.sim.settle();
      set((s) => ({ replayTimePs: null, rev: s.rev + 1 }));
    },

    setButtonHeld: (componentId, held, prefix = 'main/') => {
      if (!sim) return;
      const comp = activeCircuit().components.find((c) => c.id === componentId);
      if (!comp || comp.kind !== 'button') return;
      const pi = sim.compiled.componentToPrimitive.get(`${prefix}${comp.id}`);
      if (pi === undefined) return;
      replayIdx = null;
      // Button's state shape ({on}) is distinct from toggle's; see the kernel.
      sim.sim.setPrimitiveStateAt(pi, { on: held });
      if (!get().running) sim.sim.settle();
      set((s) => ({ replayTimePs: null, rev: s.rev + 1 }));
    },

    pinSignal: (componentId, pinName, prefix = 'main/') => {
      if (!sim) return undefined;
      const comp = activeCircuit().components.find((c) => c.id === componentId);
      if (!comp) return undefined;
      const net = pinNet(sim.compiled, comp, pinName, prefix);
      if (net === undefined) return undefined;
      const replayT = get().replayTimePs;
      const value =
        replayT !== null && replayIdx
          ? replayNetValue(replayIdx, net, replayT)
          : sim.sim.netValue(net);
      return busSignalState(value, sim.compiled.nets[net]!.width);
    },

    pinRawValue: (componentId, pinName, prefix = 'main/') => {
      if (!sim) return undefined;
      const comp = activeCircuit().components.find((c) => c.id === componentId);
      if (!comp) return undefined;
      const net = pinNet(sim.compiled, comp, pinName, prefix);
      if (net === undefined) return undefined;
      const replayT = get().replayTimePs;
      return replayT !== null && replayIdx
        ? replayNetValue(replayIdx, net, replayT)
        : sim.sim.netValue(net);
    },

    simTimePs: () => (sim ? sim.sim.time : null),

    setWaveformOpen: (open) => {
      if (!open) {
        replayIdx = null;
        set({ waveformOpen: false, replayTimePs: null, hoverTrackPath: null });
      } else set({ waveformOpen: true });
    },

    setReplayTime: (t) => {
      if (t !== null && sim && !replayIdx)
        replayIdx = buildReplayIndex(sim.compiled, sim.sim.traceRecords());
      if (t === null) replayIdx = null;
      set({ replayTimePs: sim ? t : null });
    },

    setHoverTrack: (path) => {
      if (get().hoverTrackPath !== path) set({ hoverTrackPath: path });
    },

    simTrace: () => (sim ? { compiled: sim.compiled, records: sim.sim.traceRecords() } : null),

    simTraceLength: () => (sim ? sim.sim.traceLength : 0),

    simNow: () => (sim ? sim.sim.time : 0),

    netOfPin: (componentId, pinName, prefix = 'main/') => {
      if (!sim) return undefined;
      const comp = activeCircuit().components.find((c) => c.id === componentId);
      if (!comp) return undefined;
      return pinNet(sim.compiled, comp, pinName, prefix);
    },

    setComponentParams: (id, params, label) => {
      // applyParamsDroppingRemovedPins covers any param change that can drop
      // a NAMED pin (mux/encoder inputs, mux's hasEnable toggling off) as
      // well as plain width-only changes (decoder inputs, toggle/constant/
      // probe/busdisplay/input/output width) -- it's a strict generalization
      // of the old plain-merge edit, not a behavior change for those. It
      // ALSO now owns the optional rename (same validation renameWith uses)
      // in the same call -- every width-editable kind that carries a name
      // field always sends one from the overlay, even unchanged, so a
      // rename-vs-params fork here previously routed those edits through
      // renameWith's plain merge and skipped this file's pin-drop/rewire
      // logic entirely (the toggle/led "expand doesn't propagate" bug).
      const ok = applyParamsDroppingRemovedPins(id, params, label);
      // A width edit always commits; a resulting mismatch surfaces
      // immediately as a hard error + warn-colored wire, instead of waiting
      // for the next power() click to discover it. pinView reshapes pins
      // into narrower/wider lanes just like a width edit -- same path.
      if (ok && Object.keys(params).some((k) => /width/i.test(k) || k === 'pinView'))
        checkWidthMismatch(id);
      return ok;
    },

    setComponentParamsBatch: (specs) => {
      if (specs.length === 0) return true;
      let firstOk = true;
      let anyApplied = false;
      let anyWidthLike = false;
      // Accumulated across every spec in the batch, not first-wins -- two
      // co-selected components can each independently raise a conflict.
      const conflicts: LabelConflictRow[] = [];
      edit('params', (d) => {
        specs.forEach((spec, i) => {
          // Read/mutate the same running draft `d` so a spec later in the
          // list sees any pin-drop/rewire an earlier spec already made.
          const plan = computeParamsPlan(d, spec.id, spec.params, spec.label, spec.kind);
          if (!plan) {
            if (i === 0) firstOk = false;
            return;
          }
          const c = plan(d);
          if (c) conflicts.push(...c);
          anyApplied = true;
          if (Object.keys(spec.params).some((k) => /width/i.test(k) || k === 'pinView'))
            anyWidthLike = true;
        });
      });
      if (conflicts.length) {
        // Two specs in the batch can each reach the same net (e.g. renaming
        // a switch AND the LED it already drives together) -- dedupe by net
        // identity before publishing, same rule syncLabels/syncOutputLabels
        // already apply within a single call.
        const seenNets = new Set<string>();
        const deduped = conflicts.filter((c) => {
          const key = [...c.netComponentIds].sort().join(',');
          if (seenNets.has(key)) return false;
          seenNets.add(key);
          return true;
        });
        set({ labelConflict: deduped });
      }
      if (anyApplied && anyWidthLike) checkWidthMismatch('');
      return firstOk;
    },

    runSta: () => {
      const st = get();
      if (st.timing.mode !== 'datasheet') {
        set({ error: 'timing: switch to datasheet mode for static timing analysis' });
        return;
      }
      try {
        // Reuse the live sim's compile when powered; otherwise compile fresh
        // (same lowering as power()) so STA works on an unpowered board too.
        const compiled =
          sim?.compiled ??
          compile(
            lowerCircuit(st.board),
            new Map([...st.chipLib].map(([id, def]) => [id, lowerCircuit(def)])),
          );
        const report = analyzeTiming(compiled, { column: st.timing.datasheet });
        set({ staReport: { report, compiled }, error: null });
      } catch (e) {
        if (e instanceof TimingError) set({ error: `timing: ${e.message}`, staReport: null });
        else set({ error: `timing: ${e instanceof Error ? e.message : String(e)}` });
      }
    },

    clearSta: () => set({ staReport: null }),

    enterBubbleMode: () => {
      if (get().mode === 'bubble') return;
      if (activeTab().kind !== 'board') {
        set({ error: 'Bubble-push mode works on the board tab' });
        return;
      }
      const normalized = importCircuit(get().board);
      // Entering bubble mode never blocks on a wide (width>1) gate/terminal
      // elsewhere on the board -- each bubble-push transform refuses
      // individually on the specific wide gate it would touch, and
      // truthTableOf below bit-expands wide terminals so the baseline
      // equivalence check doesn't require 1-bit-only.
      const outputs = normalized.components.filter((c) => OUTPUT_TERMINAL_KINDS.has(c.kind));
      let baseline: TruthTable;
      try {
        if (outputs.length === 0) throw new RangeError('no output terminal (output/LED/probe)');
        baseline = truthTableOf(normalized, get().chipLib);
      } catch (e) {
        set({ error: `bubble mode: ${e instanceof Error ? e.message : String(e)}` });
        return;
      }
      if (get().powered) get().power(); // toggles off, drops the sim
      // Normalization (literal nand/nor/not -> base kind + params) is a real
      // board edit, committed through the normal history so Ctrl+Z works on
      // it like anything else; empty diff (already-normalized board) is fine.
      edit('bubble mode', (d) => {
        d.components = normalized.components;
      });
      set({
        mode: 'bubble',
        bubbleBaseline: baseline,
        bubbleFocus: null,
        bubblePreview: null,
        bubblePairMode: false,
        tool: { kind: 'select' },
        selection: new Set(),
        error: null,
      });
    },

    exitBubbleMode: () => {
      if (get().mode !== 'bubble') return;
      edit('bubble mode', (d) => {
        d.components = d.components.map((c) => {
          if (!isGateFamilyKind(c.kind)) return c;
          const { base, outputBubble: literal } = decomposeKind(c.kind as GateFamilyKind);
          if (literal) return c; // already a literal composed kind
          if (c.params?.['bubbleOnly'] === true) return c; // bare marker keeps its form (A2)
          if (!getOutputBubble(c)) return c;
          const params = { ...c.params };
          delete params['outputBubble'];
          const composed = { ...c, kind: composeKind(base, true), params };
          if (Object.keys(params).length === 0) delete (composed as { params?: unknown }).params;
          return composed;
        });
      });
      set({
        mode: 'edit',
        bubbleBaseline: null,
        bubbleFocus: null,
        bubblePreview: null,
        bubblePairMode: false,
      });
    },

    setBubbleFocus: (f) => set({ bubbleFocus: f, bubblePreview: null }),

    setBubblePairMode: (on) => set({ bubblePairMode: on, bubbleFocus: null, bubblePreview: null }),

    previewBubbleMove: (move, geom) => {
      const result = previewPush(get().board, move, get().chipLib, geom);
      set({ bubblePreview: { move, result } });
    },

    clearBubblePreview: () => set({ bubblePreview: null }),

    commitBubbleMove: (move, geom) => {
      const result = commitPush(get().board, move, get().chipLib, geom);
      if (!result) return; // illegal: the caller is already showing the failed ghost
      edit('bubble push', (d) => {
        d.components = result.components;
        d.wires = result.wires;
        d.junctions = result.junctions;
      });
      set({ bubblePreview: null, bubbleFocus: null });
    },

    convertBubble: (ids, reanchor, geom) => {
      const targets = ids && ids.size > 0 ? ids : get().selection;
      if (targets.size === 0) return;
      const place = (before: Component, after: Component): Component => {
        const pos = reanchor?.(before, after);
        return pos ? { ...after, pos } : after;
      };
      edit('bubble marker', (d) => {
        // A buf carrying BOTH bubbles (¬¬) splits into two chained bare
        // markers -- a single marker would display one inversion where two
        // exist.
        for (const id of targets) {
          const c = d.components.find((x) => x.id === id);
          // The bare-marker glyph is a bubble-push-mode convention for 1-bit
          // gates only; width>1 gates refuse the bubble interaction entirely,
          // N-convert included.
          if (!c || (c.kind !== 'buf' && c.kind !== 'not')) continue;
          if (Number(c.params?.['width'] ?? 1) > 1) continue;
          const split = splitDoubleInverter(d, id, geom);
          if (split) {
            d.components = split.components;
            d.wires = split.wires;
          }
        }
        d.components = d.components.map((c) => {
          if (!targets.has(c.id) || Number(c.params?.['width'] ?? 1) > 1) return c;
          if (c.kind === 'not')
            return place(c, {
              ...withOutputBubble({ ...c, kind: 'buf' }, true),
              params: { ...c.params, outputBubble: true, bubbleOnly: true },
            });
          if (c.kind === 'buf' && getOutputBubble(c))
            return place(c, {
              ...c,
              params: { ...c.params, bubbleOnly: c.params?.['bubbleOnly'] !== true },
            });
          return c;
        });
      });
    },

    changedComponentIds: (prefix = 'main/') => {
      const ids = new Set<string>();
      const re = new RegExp(`^${escapeRegExp(prefix)}(.+)$`);
      for (const path of get().changedPrims) {
        const m = re.exec(path);
        if (m) ids.add(m[1]!);
      }
      return ids;
    },
  };
});

// Net index feeding a component pin, via the compiled path map. Chip instances
// and stripped connectivity kinds have no single primitive, so return undefined.
export function pinNet(
  compiled: CompiledCircuit,
  comp: Component,
  pinName: string,
  prefix = 'main/',
): number | undefined {
  // Chip instances and ports have no primitive of their own; compile.ts
  // aliases their net as `<path>.<pinName>` instead.
  if (comp.kind === 'chip' || comp.kind === 'inport' || comp.kind === 'outport')
    return compiled.pathToNet.get(`${prefix}${comp.label || comp.id}.${pinName}`);
  if (!hasPrimitive(comp.kind)) return undefined;
  // Keyed by component, not path: label sharing puts two components on one
  // path and pathToPrimitive is last-write-wins, which resolved an LED that
  // had inherited a switch's label to the switch's own pins.
  const pi = compiled.componentToPrimitive.get(`${prefix}${comp.id}`);
  if (pi === undefined) return undefined;
  const prim = compiled.primitives[pi]!;
  const specPins = getPrimitive(comp.kind).pins(comp.params ?? {});
  const ins = specPins.filter((p) => p.dir === 'in');
  const outs = specPins.filter((p) => p.dir === 'out');
  const oi = outs.findIndex((p) => p.name === pinName);
  if (oi >= 0) return prim.outputs[oi];
  const ii = ins.findIndex((p) => p.name === pinName);
  if (ii >= 0) return prim.inputs[ii];
  return undefined;
}
