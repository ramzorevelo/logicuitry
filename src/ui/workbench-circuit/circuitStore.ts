import { create } from 'zustand';
import type {
  Board,
  BoardSequence,
  Challenge,
  ChipDef,
  ChipInstance,
  ChipLibrary,
  Circuit,
  Component,
  ComponentKind,
  Group,
  Junction,
  PaletteSlot,
  ParamValue,
  PinDir,
  Point,
  TimingMode,
  TimingSetting,
  Wire,
} from '../../core/model/types';
import { DEFAULT_RUN_SPEED } from '../../core/model/types';
import {
  compile,
  CompileError,
  type CompiledCircuit,
  type StaleContentsKey,
} from '../../core/model/compile';
import { getPrimitive, hasPrimitive } from '../../core/sim/primitives/registry';
import { pinNet } from '../../core/model/pinNet';
import { pruneHiddenChecks as pruneHiddenChecksOf } from '../../core/checks/checks';
import {
  ramAddress,
  ramSize,
  withResizedPreload,
  type RamState,
} from '../../core/sim/primitives/ram';
import {
  clockShape,
  ledLitValue,
  nextClockFall,
  settledState,
  spdtPosition,
  type ButtonState,
  type SpdtState,
  type Throw,
} from '../../core/sim/primitives/stimulus';
import type { Params } from '../../core/sim/primitives/types';
import {
  addRow,
  columnWidth,
  emptySequence,
  maskToWidth,
  pruneSequence,
  rowPasses,
} from '../../core/model/sequence';
import { printPreload } from '../../core/sim/primitives/ramPreload';
import { listRams, type RamEntry } from '../../core/model/ramView';
import {
  parsePinView,
  serializePinView,
  type PinViewState,
} from '../../core/sim/primitives/busPins';
import { Simulator } from '../../core/sim/kernel';
import { pulseClock } from '../../core/sim/pulse';
import { loopNetNames, loopOf } from './oscillation';
import {
  gateOverlay as overlayOfRun,
  gateStatusText,
  nextGateRun,
  pressGateStep,
  type GateOverlay,
  type GateRun,
} from './gateStep';
import {
  inheritedColor,
  nextGroupColor,
  recoloredWire,
  styledGroup,
} from '../../core/model/palette';
import { builtinChipLibrary, isBuiltinChipDef, isBuiltinChipId } from '../../core/parts/packages';
import { idealDelay, datasheetDelay } from '../../core/sim/delay';
import * as bv from '../../core/value/busValue';
import { busSignalState, type SignalState } from '../../render/theme';
import {
  History,
  applyToCircuit,
  diffCircuits,
  type ApplyFn,
  type ChallengeHolder,
  type SequenceHolder,
} from './history';
import { paramLiveness } from './paramLiveness';
import { withPartChoice } from './partsView';
import type { WireEnd } from '../../core/model/types';
import { canFloat, isOutputSlot, mayShareNet } from '../../core/model/pinSlots';
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
import { autoRoute, type AutoRouteResult, type RoutableComponent } from './autoRoute';
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
import { lowerCircuit, lowerLibrary } from '../../core/gates/lower';
import {
  composeKind,
  decomposeKind,
  getOutputBubble,
  importCircuit,
  isGateFamilyKind,
  withOutputBubble,
  type GateFamilyKind,
} from '../../core/gates/bubbleModel';
import { renameVarInExprText } from '../../core/boolean/expr';
import {
  boardDiffRows,
  INPUT_TERMINAL_KINDS,
  OUTPUT_TERMINAL_KINDS,
} from '../../core/gates/verify';
import { commitPush, previewPush, type PushMove, type PushPreview } from './bubble/pushController';
import type { NetChangeRecord } from '../../core/sim/kernel';
import { buildReplayIndex, replayNetValue, type ReplayIndex } from '../../core/timing/traceView';
import { analyzeTiming, type TimingReport } from '../../core/timing/sta';
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

/** Identity of the active circuit's arrays (every edit replaces them), plus
 *  power, since landing a tidy powers the board off, and the chip library,
 *  whose defs place the pins the routes were drawn to. */
export interface TidyBasis {
  tabId: string;
  powered: boolean;
  chipLib: ChipLibrary;
  components: readonly Component[];
  wires: readonly Wire[];
  junctions: readonly Junction[];
}

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
      /** The live def as last opened or saved: any other def object is unsaved work. */
      saved: ChipDef;
    };

// One counter PER PREFIX, seeded past whatever ids the board already carries.
// A single shared counter made the first button on a board "button42", which
// is the number the user then reads back in an error message. Uniqueness still
// holds because the prefix differs.
const nextId = new Map<string, number>();
const genId = (prefix: string) => {
  const n = nextId.get(prefix) ?? 1;
  nextId.set(prefix, n + 1);
  return `${prefix}${n}`;
};
// Display-friendly id prefixes where the kind name reads poorly on canvas
// (starter-board switches are sw1/sw2; a placed toggle should match).
const ID_PREFIX: Record<string, string> = { toggle: 'sw', timer555: 'timer' };
const idPrefix = (kind: string) => ID_PREFIX[kind] ?? kind;
const sameBody = (a: Circuit, b: Circuit) =>
  JSON.stringify([a.components, a.wires, a.junctions, a.groups ?? []]) ===
  JSON.stringify([b.components, b.wires, b.junctions, b.groups ?? []]);

// An undo back to the saved state still bumps `version`; that alone is nothing to save.
export const sameDefIgnoringVersion = (a: ChipDef, b: ChipDef) =>
  JSON.stringify({ ...a, version: 0 }) === JSON.stringify({ ...b, version: 0 });

export const seedNextId = (board: Board) => {
  const ids = [
    ...board.components.map((c) => c.id),
    ...board.wires.map((w) => w.id),
    ...board.junctions.map((j) => j.id),
  ];
  // Where an id splits into prefix and number is ambiguous, because a chip's
  // defId can itself end in digits ("74LS00" generates "74LS001"). Every legal
  // split is seeded rather than guessing one, so no generated id can collide
  // with one the board already carries.
  for (const id of ids) {
    for (let cut = id.length - 1; cut >= 0; cut--) {
      if (!/^\d+$/.test(id.slice(cut))) break;
      const prefix = id.slice(0, cut);
      nextId.set(prefix, Math.max(nextId.get(prefix) ?? 1, Number(id.slice(cut)) + 1));
    }
  }
};

export const VARIABLE_ARITY_GATES: ReadonlySet<string> = new Set([
  'and',
  'or',
  'nand',
  'nor',
  'xor',
  'xnor',
]);

/** A palette LED carries no colour or shape of its own, so the user's chosen
 *  defaults are stamped on at placement. Explicit params always win, which is
 *  what keeps a duplicated or pasted LED its own colour. */
const ledDefaults = (
  params: Record<string, ParamValue> | undefined,
): Record<string, ParamValue> => {
  const prefs = getPrefs();
  return {
    color: prefs.defaultLedColor,
    shape: prefs.defaultLedShape,
    ...(params ?? {}),
  };
};

/** Pin geometry for one component, supplied by the canvas layer: the store
 *  never reaches for a theme. */
export type ComponentPins = (
  component: Component,
) => readonly { name: string; pos: Point; width: number; dir: PinDir; threeState?: boolean }[];

/** Parts dropped pin-on-pin are wired where they touch, so landing an LED on a
 *  gate's output connects it. Wire ends are pin references, so dragging the
 *  parts apart later leaves a real routed wire. Anything the rule refuses is
 *  simply left unconnected. */
const connectAbutting = (
  draft: Circuit,
  moved: ReadonlySet<string>,
  pinsOf: ComponentPins,
  newWireId: () => string,
): void => {
  const wired = new Set<string>();
  for (const w of draft.wires)
    for (const end of [w.a, w.b]) if (end.kind === 'pin') wired.add(`${end.component} ${end.pin}`);
  // An output may fan out further, but a second driver on an input is the
  // conflict multiDriverConflict exists to report, so never create one.
  const spoken = (id: string, pin: string, dir: PinDir) =>
    dir === 'in' && wired.has(`${id} ${pin}`);
  const others = draft.components.filter((c) => !moved.has(c.id));
  for (const c of draft.components) {
    if (!moved.has(c.id)) continue;
    for (const mine of pinsOf(c)) {
      if (spoken(c.id, mine.name, mine.dir)) continue;
      for (const other of others) {
        const hit = pinsOf(other).find(
          (p) =>
            p.pos.x === mine.pos.x &&
            p.pos.y === mine.pos.y &&
            p.width === mine.width &&
            mayShareNet(p, mine) &&
            !spoken(other.id, p.name, p.dir),
        );
        if (!hit) continue;
        draft.wires.push({
          id: newWireId(),
          a: { kind: 'pin', component: c.id, pin: mine.name },
          b: { kind: 'pin', component: other.id, pin: hit.name },
          points: [],
        });
        wired.add(`${c.id} ${mine.name}`);
        wired.add(`${other.id} ${hit.name}`);
        break;
      }
    }
  }
};

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
    formatVersion: 16,
    id: 'scratch',
    name: 'Untitled board',
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
    timing: { mode: getPrefs().timingModel, datasheet: 'typ', vendor: 'ti' },
    runSpeed: DEFAULT_RUN_SPEED,
  };
}

/** Nothing on it: the starter board's settings without its circuit. */
export function emptyBoard(id: string): Board {
  return { ...starterBoard(), id, components: [], wires: [], junctions: [] };
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
  /** Something over the canvas's lower part (a phone's tutorial card) starts at this client y. */
  revealAbove: { aboveY: number; seq: number } | null;
  rev: number; // bumped on any board/sim mutation to force a redraw
  powered: boolean;
  running: boolean;
  /** The last frame could not reach its target at the board's run speed. */
  runBehind: boolean;
  /** Named nets of a loop that never goes quiet: the last paused settle hit the
   *  event limit, or a running frame spent its budget with time standing still. */
  oscillation: string[] | null;
  error: string | null;
  /** Wires touching the component a width edit made mismatched; warn-colored
   *  in the editor, cleared on the next successful edit. */
  mismatchWires: ReadonlySet<string>;
  timing: TimingSetting;

  // --- Bubble-push mode (M5 fold-in). None of these fields bump `rev`: the
  // canvas redraw effect must list them (or call draw() at the mutation
  // site) explicitly -- `rev` only signals board/sim mutations.
  mode: 'edit' | 'bubble';
  bubbleFocus: TerminalFocus | null;
  bubblePreview: { move: PushMove; result: PushPreview } | null;
  /** Insert-¬¬ tool: focus cycles wires, a click/Enter on one inserts a pair. */
  bubblePairMode: boolean;

  /** One or more nets, each with 2+ user-named labels, raised by a single
   *  edit (wire commit or a rename that touches several output nets at
   *  once, e.g. naming a decoder); the dialog picks a radio choice per row
   *  and commits every row at once via Apply. Esc/click-outside instead
   *  reverts what raised the conflict: the wire, or the rename alone (a
   *  param overlay's other edits stay). Analyze prefers the pin side until
   *  resolved. */
  labelConflict: LabelConflictRow[] | null;
  /** Apply: `choices[i]` is the chosen label for `labelConflict[i]` (written
   *  to every component on that row's net) or `null` to keep both -- every
   *  row commits in ONE edit/undo step. Clears the field either way. */
  applyLabelConflicts: (choices: (string | null)[]) => void;
  /** Esc / click-outside: undo the wire or rename that raised the conflict,
   *  keeping a param overlay's other edits, and close. */
  cancelLabelConflict: () => void;

  /** Id of a def tab whose close was deferred because it has unsaved edits:
   *  the save/discard/cancel dialog is showing for it. */
  pendingTabClose: string | null;
  /** Save: close once the caller has written the chip (edits stay live in
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
  /** Whether the active tab's history has a step to undo or redo. Read on render, which `rev` drives. */
  canUndo: () => boolean;
  canRedo: () => boolean;
  /** Some open chip tab holds unsaved edits; replacing the board closes them all. */
  hasTabEdits: () => boolean;
  /** The tab is a chip tab whose def changed since it opened or was last saved. */
  chipTabDirty: (tabId: string) => boolean;
  /** `written` (default: the def as it is now) is on disk: it becomes the tabs' clean mark and
   *  their Discard point. */
  markChipSaved: (defId: string, written?: ChipDef) => void;
  openDefTab: (defId: string, prefix: string, breadcrumb: string) => void;
  /** No-op (dialog opens instead) when the chip has unsaved edits; see `resolveTabClose`. */
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
  /** Brings the whole circuit above `aboveY` if part of it is hidden; never zooms in. */
  requestRevealAbove: (aboveY: number) => void;
  /** Adds a freshly built def to the in-memory library; rejects a cycle. */
  commitNewChip: (def: ChipDef) => { ok: true } | { ok: false; error: string };
  /** Bulk-load defs read from the library folder. Merges over what is already
   *  in memory (a packaged-but-unsaved chip must survive connecting a folder).
   *  Leaves `rev` alone: a library load is not a board change, so nothing
   *  watching `rev` (autosave) need run. The canvas redraws off `chipLib`. */
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
    pinsOf?: ComponentPins,
    /** Group to join, which the caller reads off the drawn borders
     *  (groupHit's groupContaining) since rects are geometry the store has no
     *  theme to compute. Dropping a part inside a border joins that group. */
    group?: string,
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
    /** Only for a fresh placement, and read off the drawn borders exactly as
     *  `place`'s is: a part spliced into a wire inside a group joins it. */
    group?: string;
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
  /** The circuit a background Tidy wiring routes from, kept to tell whether
   *  its result still fits when it lands. */
  tidyBasis: () => TidyBasis;
  /** Commits a routed result as Tidy wiring's one undo step, unless the
   *  active tab or its circuit changed since `basis`: routes drawn for an
   *  older board would undo the user's newer edit. */
  applyTidy: (basis: TidyBasis, result: AutoRouteResult) => 'applied' | 'stale' | 'unchanged';
  /** `resolveEnd`, when given, stretches every wire with an end on a moved
   *  component/junction so its stored bends follow (KiCad drag-stretch); the
   *  live pointer-drag preview needs it too, so it's read off the *current*
   *  (pre-move) store, not the draft being mutated -- pass it through, don't
   *  synthesize it from the draft. */
  /** `pinsOf`, when given, wires up any pin the move landed exactly on another. */
  moveSelection: (
    dx: number,
    dy: number,
    resolveEnd?: ResolveWireEnd,
    pinsOf?: ComponentPins,
  ) => void;
  /** Alt+drag: moves the selection, cutting touched wires to free ends. */
  moveSelectionDetached: (
    dx: number,
    dy: number,
    detachedEnds: { wireId: string; end: 'a' | 'b'; pos: Point }[],
  ) => void;
  /** Duplicate commit / paste: remaps a slice's ids fresh and offsets it in. */
  commitDuplicate: (slice: Circuit, offset: Point) => void;
  /** Build from an expression or a truth table: drops a synthesized slice on
   *  the board as its own group, one undo step. Returns the new group's id, or
   *  null when nothing was committed (off the board tab, powered, bubble mode). */
  commitSynthesis: (slice: Circuit, groupName: string) => string | null;
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
  /** Name, colour and tab of a group in one undo step. `color: null` makes it
   *  plain, which also drops the tab. False when the name is empty or taken. */
  styleGroup: (
    id: string,
    patch: { name?: string; color?: PaletteSlot | null; tab?: boolean },
  ) => boolean;
  /** Insulation colour on each listed wire, `null` to clear it. One undo step,
   *  and a live sim keeps running: compile never reads it. */
  colorWires: (ids: ReadonlySet<string>, color: PaletteSlot | null) => void;
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
  /** A lesson's timing switch: the same restart as setTiming, but the board
   *  keeps its saved mode, so nothing is dirtied or saved. */
  setSessionTiming: (mode: TimingMode) => void;
  /** Where a lesson replay starts: the board as it is, unpowered, with no
   *  switch or RAM memory carried in. Never touches `board` or history. */
  resetForLesson: () => void;
  /** Parts the open lesson step points at. Session-only, and it never bumps
   *  `rev`: the canvas redraw effect lists it. */
  lessonHighlight: ReadonlySet<string>;
  setLessonHighlight: (ids: Iterable<string>) => void;
  /** Bumped by every loadBoard, so a session over one board can tell it was replaced. */
  boardLoads: number;
  /** Sim ps per wall second while running. Saved with the board, so it
   *  dirties the document, but pacing alone never powers the sim off. */
  setRunSpeed: (psPerSecond: number) => void;
  /** Pick the 74LS package for one loose-gate key, or clear it with undefined; not an undo step. */
  setPartChoice: (key: string, part: string | undefined) => void;
  power: () => void;
  /** One gate delay while paused; see pressGateStep. */
  gateStep: () => void;
  /** Whether gateStep() can still move time. Read during render off `rev`, not a
   *  stored field: it is a question for the kernel, not editor state. */
  canStep: () => boolean;
  /** Runs a paused sim on until nothing is pending, counting the gate delays it took. */
  settle: () => void;
  /** Whether settle() has anything to do: something is pending. */
  canSettle: () => boolean;
  /** The paused sim's status line, null while unpowered or running. */
  gateStatus: (prefix?: string) => string | null;
  /** What the last gate step draws, while it is still the sim's latest move. */
  gateOverlay: (prefix?: string) => GateOverlay | undefined;
  toggleRun: () => void;
  pump: (ps: number) => void;
  toggleInput: (componentId: string, bit?: number, prefix?: string) => void;
  /** Momentary button: explicit press/release rather than a toggle, so a
   *  mouse-held button stays on for exactly the duration of the hold even if
   *  the cursor drags off it before release. */
  setButtonHeld: (componentId: string, held: boolean, prefix?: string) => void;
  /** Throws an SPDT's lever to its other contact. */
  flipSpdt: (componentId: string, prefix?: string) => void;
  /** Where a powered SPDT's lever sits; undefined while unpowered or scrubbing. */
  spdtThrow: (componentId: string, prefix?: string) => Throw | undefined;
  /** Whether a powered button is held now; undefined while scrubbing, which has no press history. */
  buttonHeld: (componentId: string, prefix?: string) => boolean | undefined;
  pinSignal: (componentId: string, pinName: string, prefix?: string) => SignalState | undefined;
  /** Raw per-bit value (v/x/z), for glyphs that render more than an
   *  aggregate state (e.g. the DIP-bank switch). */
  pinRawValue: (componentId: string, pinName: string, prefix?: string) => bv.BusValue | undefined;
  simTimePs: () => number | null;

  // --- Waveform panel / scrub-replay (M6). `replayTimePs`/`hoverTrackPath`
  // never bump `rev`; the canvas redraw effect must list them explicitly.
  waveformOpen: boolean;
  setWaveformOpen: (open: boolean) => void;
  /** Which view the open dock shows. Memory clears any scrub replay, since
   *  the grid has no history to rewind. */
  dockTab: DockTab;
  setDockTab: (tab: DockTab) => void;

  // --- Input sequence.
  /** Row cursor and per-row results of the live sim; null while unpowered. */
  sequenceRun: () => SequenceRunView | null;
  /**
   * Sets every input column to that row's values; false when refused. Paused, the change stays
   * pending unless `settleNow` (a lesson step, which shows a settled board).
   */
  applySequenceRow: (index: number, settleNow?: boolean) => boolean;
  /** The row after or before the cursor. */
  stepSequence: (delta: 1 | -1) => boolean;
  /** One rise and fall of a top-level clock on the paused sim, then settled; a lesson's pulse. */
  pulseClockOnce: (clockId: string) => ClockPulseResult;
  /** One undoable edit of the board's sequence; undefined removes it. */
  editSequence: (label: string, fn: (seq: BoardSequence) => BoardSequence | undefined) => void;
  /** Writes or, with undefined, removes the board's challenge as one undo step. */
  setChallenge: (label: string, next: Challenge | undefined) => void;
  /** Appends a row of the inputs' live values (powered) or saved initial ones. */
  captureSequenceRow: () => void;

  // --- Memory panel.
  /** The board's RAMs, from the live compile while powered; memoized on the
   *  board and library, so a pointer-driven `rev` bump does not recompile. */
  memoryRams: () => { rams: RamEntry[] } | { error: string };
  /** Cells and current address of the RAM at a compiled index; null while unpowered. */
  ramLive: (index: number) => { cells: readonly bv.BusValue[]; address: number | null } | null;
  /** One undoable edit of a RAM's preload or its chip instance's `contents`
   *  entry, on the board tab. False when refused (powered, a chip tab active,
   *  a misfit slot, or the RAM is gone). */
  setRamPreload: (entry: RamEntry, text: string) => boolean;
  /** Final cells of the last Space power-off, by RAM `componentId`; valid only
   *  while `board` and `chipLib` are the ones it was taken from. */
  lastRun: LastRun | null;
  keepLastRun: (entry: RamEntry) => void;
  /** RAMs whose cells a powered edit is holding for the next power-on. */
  heldRamIds: () => ReadonlySet<string>;
  /** Non-null while scrub-replaying: wire/glyph coloring reads the trace at
   *  this time instead of the live sim. Any sim-advancing action clears it. */
  replayTimePs: number | null;
  setReplayTime: (t: number | null) => void;
  /** Waveform track hovered in the panel (schematic wire highlight) and back. */
  hoverTrackPath: string | null;
  setHoverTrack: (path: string | null) => void;
  /** Live trace snapshot for the panel; null while unpowered. */
  simTrace: () => { compiled: CompiledCircuit; records: NetChangeRecord[] } | null;
  /** Nets two enabled drivers fight over right now; null while unpowered. */
  simFights: () => { compiled: CompiledCircuit; nets: number[] } | null;
  /** Bumped by a Checks row click: the canvas pans these into view, zoom kept. */
  revealRequest: { seq: number; ids: readonly string[] } | null;
  /** Select what a Checks row points at and ask the canvas to show it. Ids
   *  gone from the circuit are dropped; nothing left is a no-op. */
  revealItems: (ids: readonly string[]) => void;
  /** Hide or unhide checks on the active tab: one undo step, no recompile. */
  setChecksHidden: (keys: readonly string[], hide: boolean) => void;
  /** Drops silenced checks whose part or pin is gone, before a save. */
  pruneHiddenChecks: () => Board;
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
  /** Patches stimulus params into the running sim alone, no board edit and no
   *  undo step: a slider retimes while it drags and commits once on release. */
  previewComponentParams: (id: string, params: Record<string, ParamValue>) => void;
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
   *  path. `reanchor` maps an edited component to a new pos, as for
   *  convertBubble: the caller holds the glyph metrics. */
  setComponentParamsBatch: (
    specs: {
      id: string;
      params: Record<string, ParamValue>;
      label?: string;
      kind?: ComponentKind;
    }[],
    reanchor?: (before: Component, after: Component) => { x: number; y: number } | undefined,
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

/** A run of gate steps on one sim, current only while nothing else has moved it since. */
interface GateRunRecord extends GateRun {
  owner: SimState;
  traceLength: number;
}
let gateRun: GateRunRecord | null = null;
let gateOverlayCache: {
  run: GateRunRecord;
  circuit: Circuit;
  prefix: string;
  overlay: GateOverlay;
} | null = null;

/** Most presses one Settle takes before a loop that never settles goes to the kernel's own budget. */
const SETTLE_PRESS_LIMIT = 1000;

/** A sequence's progress on one sim; any other sim reads as a fresh start. */
interface SequenceRun {
  owner: SimState;
  cursor: number;
  results: (boolean | null)[];
  /** A row applied while running, compared just before the next one lands. */
  pendingCompare: number | null;
  /** The clock fall already acted on; a fall at or before it never fires again. */
  handledFallPs: number;
}
let sequenceRun: SequenceRun | null = null;

/**
 * What a lesson's clock pulse did. `off`, `running` and `missing` leave the board as it was;
 * `stuck` ran out of budget mid-cycle; `loop` finished the cycle and then oscillated.
 */
export type ClockPulseResult = 'ok' | 'off' | 'running' | 'missing' | 'stuck' | 'loop';

export interface SequenceRunView {
  cursor: number;
  results: readonly (boolean | null)[];
  pending: number | null;
}
// Replay index over the trace at scrub start; dropped when replay exits (any
// sim-advancing action) so it can never serve stale values.
let replayIdx: ReplayIndex | null = null;

const delayFor = (t: TimingSetting) =>
  t.mode === 'datasheet' ? datasheetDelay(t.datasheet, t.vendor) : idealDelay;

/** Ids among `incoming` that take a built-in part's place for the first time. */
function shadowedBuiltins(lib: ChipLibrary, incoming: readonly ChipDef[]): string[] {
  return incoming
    .filter((def) => {
      const current = lib.get(def.id);
      return isBuiltinChipId(def.id) && current !== undefined && isBuiltinChipDef(current);
    })
    .map((def) => def.id);
}

/**
 * Bends drawn for a part's old pin side no longer lead anywhere sensible once
 * it turns or mirrors, so its wires re-route from the new side. A tapped wire
 * keeps its bends (its taps sit on them), and so does one in `moved`, whose
 * bends the caller turned along with the part.
 */
function clearTurnedBends(
  d: Circuit,
  turned: (componentId: string) => boolean,
  moved: ReadonlySet<string> = new Set(),
): void {
  const onTurned = (end: WireEnd) => end.kind === 'pin' && turned(end.component);
  const tapped = new Set(
    d.wires.flatMap((w) => [w.a, w.b].flatMap((e) => (e.kind === 'tap' ? [e.wire] : []))),
  );
  d.wires = d.wires.map((w) =>
    w.points.length > 0 && (onTurned(w.a) || onTurned(w.b)) && !tapped.has(w.id) && !moved.has(w.id)
      ? { ...w, points: [] }
      : w,
  );
}

const STRUCTURAL_KEYS = new Set(['delay', 'enableTiming']);

/**
 * A copy taken out of an opened built-in part is an ordinary gate: it must
 * not keep the mark that exempts the part's power gate from any delay.
 */
function withoutStructuralMark(c: Component): Component {
  if (c.params?.['delay'] === undefined) return c;
  const params = Object.fromEntries(
    Object.entries(c.params).filter(([key]) => !STRUCTURAL_KEYS.has(key)),
  );
  return { ...c, params };
}

function shadowNotice(ids: readonly string[]): { error?: string } {
  if (ids.length === 0) return {};
  return { error: `chips: your ${ids.join(', ')} replaces the built-in part of the same name` };
}

export type DockTab = 'waves' | 'memory' | 'checks' | 'sequence' | 'challenge' | 'parts';

export interface LastRun {
  board: Board;
  chipLib: ChipLibrary;
  runs: ReadonlyMap<string, readonly bv.BusValue[]>;
}

/** The run Keep last run would store for one RAM, or null once an edit,
 *  power-on or load has retired the offer. */
export function offeredRun(
  s: { lastRun: LastRun | null; board: Board; chipLib: ChipLibrary },
  componentId: string,
): readonly bv.BusValue[] | null {
  const run = s.lastRun;
  if (!run || run.board !== s.board || run.chipLib !== s.chipLib) return null;
  return run.runs.get(componentId) ?? null;
}

export function staleContentsNotice(keys: readonly StaleContentsKey[]): string {
  const where = (reason: StaleContentsKey['reason']) =>
    keys
      .filter((k) => k.reason === reason)
      .map((k) => `${k.instance.replace(/^main\//, '')}/${k.key}`)
      .join(', ');
  const missing = where('missing');
  const misfit = where('misfit');
  const parts = [
    missing && `no RAM at ${missing} now`,
    misfit && `${misfit} no longer fits its RAM`,
  ];
  return `contents: ${parts.filter(Boolean).join('; ')}; the saved memory is kept`;
}

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

/** How a committed diff item affects a live sim, from least to most costly.
 *  `none`     -- nothing compiled reads what changed (a drag, an LED colour),
 *                so a powered sim keeps running untouched.
 *  `live`     -- a param evaluate() re-reads, applied by patching the compiled
 *                primitive and waking it instead of recompiling.
 *  `topology` -- the netlist itself differs; only a recompile can honour it,
 *                so power drops as it always has. */
export type SimEffect = 'none' | 'live' | 'topology';

/** Keys on a Component that are pure geometry: changing only these cannot
 *  affect what the sim computes. `label` is deliberately absent -- a label
 *  feeds the compiled net path that value readouts look up (see netOfPin),
 *  so renaming under a live sim would desync those lookups from the board. */
const GEOMETRY_KEYS = new Set(['pos', 'rot', 'mirror', 'nameOffset']);

export function simEffectOfItem(item: import('./history').PickedItem): SimEffect {
  if (item.kind === 'checks' || item.kind === 'sequence' || item.kind === 'challenge')
    return 'none';
  if (isPureMoveItem(item)) return 'none';
  if (item.kind === 'group' && item.before && item.after) {
    // The name prefixes compiled paths; colour and tab are drawing only.
    const structural = (g: Group) => JSON.stringify({ ...g, color: undefined, tab: undefined });
    return structural(item.before as Group) === structural(item.after as Group)
      ? 'none'
      : 'topology';
  }
  if (item.kind !== 'component' || !item.before || !item.after) return 'topology';
  const before = item.before as unknown as Component;
  const after = item.after as unknown as Component;
  if (before.kind !== after.kind || before.group !== after.group) return 'topology';
  // Any non-param, non-geometry field differing (label included) is topology.
  const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const f of fields) {
    if (f === 'params' || GEOMETRY_KEYS.has(f)) continue;
    if (
      JSON.stringify((before as unknown as Record<string, unknown>)[f]) !==
      JSON.stringify((after as unknown as Record<string, unknown>)[f])
    )
      return 'topology';
  }
  const pb = (before.params ?? {}) as Record<string, unknown>;
  const pa = (after.params ?? {}) as Record<string, unknown>;
  let effect: SimEffect = 'none';
  for (const key of new Set([...Object.keys(pb), ...Object.keys(pa)])) {
    if (JSON.stringify(pb[key]) === JSON.stringify(pa[key])) continue;
    const liveness = paramLiveness(after.kind, key);
    if (liveness === 'structural') return 'topology';
    if (liveness === 'stimulus') effect = 'live';
  }
  return effect;
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

/** Switch/button positions captured at the last power-off, so the next power-on
 *  can restore them when the pref asks. Deliberately outside the store: it is
 *  not board content, nothing should undo it, and no file should carry it. */
const heldSwitchState = new Map<string, unknown>();
/** A lesson's timing restart keeps the switches whatever the pref says: a step
 *  only changes what it names. Consumed by the next power-on. */
let restoreSwitchesOnce = false;
const HELD_KINDS = new Set(['toggle', 'button', 'spdt']);

/** RAM cells a powered edit dropped the sim on, by `componentId`, restored at
 *  the next power-on whatever the switch pref says. Unlike switch positions
 *  they survive later unpowered edits: an unrelated rewire must not cost the
 *  program the circuit just wrote. */
const heldRamCells = new Map<
  string,
  { width: number; addressBits: number; cells: readonly bv.BusValue[] }
>();

let liveRamList: { compiled: CompiledCircuit; rams: RamEntry[] } | null = null;

/** listRams over the unpowered board, keyed on the inputs it was built from. */
let ramListCache: {
  board: Board;
  chipLib: ChipLibrary;
  result: { rams: RamEntry[] } | { error: string };
} | null = null;

/** Stale `contents` keys last shown, so a recompile of the same board does not
 *  repeat the notice; only a change in the set shows it again. */
let shownStaleContents = '';

export const useCircuitStore = create<CircuitState>((set, get) => {
  const activeTab = (): Tab => {
    const s = get();
    return s.tabs.find((t) => t.id === s.activeTabId) ?? s.tabs[0]!;
  };

  // Silenced checks are not circuit content: no recompile, no power loss, no
  // def version bump, so a powered demo keeps running through a hide.
  const setHiddenChecks = (tab: Tab, keys: string[] | undefined) => {
    if (tab.kind === 'board') {
      set((s) => ({ board: { ...s.board, hiddenChecks: keys }, rev: s.rev + 1 }));
      return;
    }
    const def = get().chipLib.get(tab.defId);
    if (!def) return;
    const chipLib = new Map(get().chipLib);
    chipLib.set(tab.defId, { ...def, hiddenChecks: keys });
    set((s) => ({ chipLib, rev: s.rev + 1 }));
  };

  const boardSequence = (): BoardSequence | undefined =>
    activeTab().kind === 'board' ? get().board.sequence : undefined;

  const runOfSim = (): SequenceRun | null => {
    if (!sim) return null;
    if (sequenceRun?.owner !== sim)
      sequenceRun = {
        owner: sim,
        cursor: -1,
        results: [],
        pendingCompare: null,
        handledFallPs: -1,
      };
    return sequenceRun;
  };

  const primOf = (componentId: string): number | undefined =>
    sim?.compiled.componentToPrimitive.get(`main/${componentId}`);

  // A lane-expanded LED or probe has no single `a` pin; its lanes read LSB first.
  const readExpectColumn = (comp: Component): bv.BusValue | undefined => {
    if (!sim || !hasPrimitive(comp.kind)) return undefined;
    const pins = getPrimitive(comp.kind).pins((comp.params ?? {}) as never);
    const parts: { value: bv.BusValue; width: number }[] = [];
    for (const pin of [...pins].reverse()) {
      const net = pinNet(sim.compiled, comp, pin.name);
      if (net === undefined) return undefined;
      parts.push({ value: sim.sim.netValue(net), width: pin.width });
    }
    const value = parts.length === 1 ? parts[0]!.value : bv.concat(parts);
    if (comp.kind !== 'led') return value;
    const width = parts.reduce((sum, p) => sum + p.width, 0);
    return ledLitValue(value, width, (comp.params ?? {}) as Params);
  };

  const compareRow = (run: SequenceRun, seq: BoardSequence, index: number) => {
    const row = seq.rows[index];
    if (!row) return;
    if (!row.expect || row.expect.every((cell) => cell === null)) {
      run.results[index] = null;
      return;
    }
    const byId = new Map(get().board.components.map((c) => [c.id, c]));
    const comps = seq.expect.map((id) => byId.get(id));
    const actual = comps.map((c) => (c ? readExpectColumn(c) : undefined));
    run.results[index] = rowPasses(row, actual, comps.map(columnWidth));
  };

  // Same state shapes a click writes; a button or SPDT already in place is left
  // alone so a repeat does not restart its bounce.
  const writeRowInputs = (seq: BoardSequence, index: number) => {
    const live = sim;
    const row = seq.rows[index];
    if (!live || !row) return;
    const byId = new Map(get().board.components.map((c) => [c.id, c]));
    seq.inputs.forEach((id, col) => {
      const comp = byId.get(id);
      const pi = primOf(id);
      if (!comp || pi === undefined) return;
      const value = row.set[col] ?? 0;
      if (comp.kind === 'toggle') {
        live.sim.setPrimitiveStateAt(pi, { value: maskToWidth(value, columnWidth(comp)) });
      } else if (comp.kind === 'button') {
        const on = (value & 1) === 1;
        if ((live.sim.primitiveStateAt(pi) as ButtonState).on !== on)
          live.sim.setPrimitiveStateAt(pi, { on } satisfies ButtonState);
      } else if (comp.kind === 'spdt') {
        const position: Throw = (value & 1) === 1 ? 'b' : 'a';
        if ((live.sim.primitiveStateAt(pi) as SpdtState).position !== position)
          live.sim.setPrimitiveStateAt(pi, { position } satisfies SpdtState);
      }
    });
  };

  /**
   * Applies a row on the live sim; the caller bumps `rev`. Without `settleNow`
   * the board settles under the run, Gate step or Settle, so the comparison
   * waits for the board to settle, the next row, the next fall or Run stopping.
   */
  const applyRowNow = (index: number, settleNow = false, settlePrevious = true): boolean => {
    const seq = boardSequence();
    const run = runOfSim();
    const live = sim;
    if (!seq || !run || !live || index < 0 || index >= seq.rows.length) return false;
    if (run.pendingCompare !== null) {
      // Moving on while paused lets the last row finish: it is never judged mid-ripple. A fall
      // reached inside a gate step judges it where the step stands, as a running sim does.
      if (settlePrevious && !get().running && !live.sim.settled)
        set({ oscillation: loopOf(live.compiled, live.sim.settle()) });
      compareRow(run, seq, run.pendingCompare);
    }
    run.pendingCompare = null;
    writeRowInputs(seq, index);
    replayIdx = null;
    gateRun = null;
    run.cursor = index;
    if (!settleNow || get().running) run.pendingCompare = index;
    else {
      set({ oscillation: loopOf(live.compiled, live.sim.settle()) });
      compareRow(run, seq, index);
    }
    return true;
  };

  const resolvePendingCompare = () => {
    const run = sim && sequenceRun?.owner === sim ? sequenceRun : null;
    const seq = boardSequence();
    if (!run || !seq || run.pendingCompare === null) return;
    compareRow(run, seq, run.pendingCompare);
    run.pendingCompare = null;
  };

  // Past the last row a fall still closes that row's comparison.
  const onSequenceFall = (run: SequenceRun, seq: BoardSequence, fall: number) => {
    run.handledFallPs = fall;
    if (run.cursor + 1 < seq.rows.length) applyRowNow(run.cursor + 1, false, false);
    else resolvePendingCompare();
  };

  const sequenceClock = (): ReturnType<typeof clockShape> | null => {
    const advance = boardSequence()?.advance;
    if (advance?.mode !== 'clock') return null;
    const clock = get().board.components.find((c) => c.id === advance.clock);
    if (clock?.kind !== 'clock') return null;
    try {
      return clockShape((clock.params ?? {}) as never);
    } catch {
      return null;
    }
  };

  // Runs to `target`, stopping at each fall of the sequence clock to apply the
  // next row there. A fall the budget did not reach carries to the next frame.
  const runSplitAtSequenceFalls = (target: number) => {
    const live = sim;
    if (!live) return;
    const shape = sequenceClock();
    const run = shape ? runOfSim() : null;
    const seq = boardSequence();
    if (!shape || !run || !seq) {
      live.sim.runUntil(target);
      return;
    }
    for (;;) {
      const fall = nextClockFall(shape, Math.max(run.handledFallPs, live.sim.time - 1));
      if (fall > target) break;
      live.sim.runUntil(fall);
      if (live.sim.isBehind(fall)) return;
      onSequenceFall(run, seq, fall);
    }
    live.sim.runUntil(target);
  };

  /** The gate-step run, while the sim's latest move was one of its presses. */
  const currentGateRun = (): GateRunRecord | null => {
    const run = gateRun;
    if (!run || !sim || run.owner !== sim || get().running) return null;
    return run.timePs === sim.sim.time && run.traceLength === sim.sim.traceLength ? run : null;
  };

  /** A cursor Gate step or Settle parked on the sim's own time still shows the live state. */
  const scrubbedBack = () => {
    const shown = get().replayTimePs;
    return shown !== null && shown !== sim?.sim.time;
  };

  /** Paused, a row still pending is settled and judged before a click changes its inputs. */
  const finishPendingRow = () => {
    const run = sim && sequenceRun?.owner === sim ? sequenceRun : null;
    if (!sim || get().running || !run || run.pendingCompare === null) return;
    if (!sim.sim.settled) set({ oscillation: loopOf(sim.compiled, sim.sim.settle()) });
    resolvePendingCompare();
  };

  /**
   * After a switch, button, SPDT or stimulus edit. Paused, the change stays pending so Gate
   * step walks it from t = 0 and Settle or Run finishes it; a loop reported earlier is stale.
   * Running, the next frame's pump takes it: settling there would fast-forward through every
   * queued clock edge.
   */
  const leaveInputPending = () => {
    gateRun = null;
    set((s) => ({
      ...(s.running ? {} : { oscillation: null }),
      replayTimePs: null,
      rev: s.rev + 1,
    }));
  };

  // Only falls inside this step count: one passed while clock mode was off is history.
  const applyFallsInStep = (from: number, to: number) => {
    const shape = sequenceClock();
    const run = shape ? runOfSim() : null;
    const seq = boardSequence();
    if (!shape || !run || !seq) return;
    let fall = nextClockFall(shape, Math.max(run.handledFallPs, from - 1));
    while (fall <= to) {
      onSequenceFall(run, seq, fall);
      fall = nextClockFall(shape, fall);
    }
  };

  const activeCircuit = (): Circuit => {
    const tab = activeTab();
    if (tab.kind === 'board') return get().board;
    return get().chipLib.get(tab.defId) ?? { components: [], wires: [], junctions: [] };
  };

  // Undo can remove what was selected, and a stale id keeps the phone action bar up with dead
  // buttons.
  const dropStaleSelection = () => {
    const { selection } = get();
    const c = activeCircuit();
    const live = new Set([
      ...c.components.map((x) => x.id),
      ...c.wires.map((x) => x.id),
      ...c.junctions.map((x) => x.id),
      ...(c.groups ?? []).map((x) => x.id),
    ]);
    if ([...selection].every((id) => live.has(id))) return;
    set({ selection: new Set([...selection].filter((id) => live.has(id))) });
  };

  // Re-derive a def's boundary pins after an edit, reject the edit if it would
  // introduce a chip-def reference cycle, and detach any wire the removal of a
  // pin stranded (across the board and every other def in the library).
  /** False when the edit is refused, so the caller keeps it out of history. */
  const commitDefEdit = (defId: string, draft: Circuit): boolean => {
    const st = get();
    const def = st.chipLib.get(defId);
    if (!def) return false;
    // A built-in part is generated from its datasheet pinout: opening one to
    // see why the rails matter is the point, editing it is not.
    if (isBuiltinChipDef(def)) {
      set({ error: `${def.name} is a built-in part and cannot be edited` });
      return false;
    }
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
      return false;
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
      running: false,
      rev: s.rev + 1,
    }));
    holdRamCells();
    sim = null;
    checkStaleContents();
    return true;
  };

  // A transient error (`label:`, `timing:`, `bubble mode:`) is a one-shot
  // notice about the *previous* attempt, not standing board state like a
  // `width:` compile error -- clear it as soon as any new interaction
  // starts, so it doesn't outlive the click/edit that caused it (the action
  // about to run re-sets it itself if it's rejected too). `width:` is owned
  // by checkWidthMismatch and only clears once a real recompile proves it.
  // Switch/button positions, kept across the loss of a sim so that an edit
  // needing a recompile does not also cost the input setup built up to
  // demonstrate something. Every path that drops `sim` while powered calls
  // this; the next power-on consumes it, and only if the pref asks.
  const captureSwitchState = () => {
    heldSwitchState.clear();
    if (!sim) return;
    for (const [componentId, pi] of sim.compiled.componentToPrimitive) {
      const kind = sim.compiled.primitives[pi]?.kind;
      if (!kind || !HELD_KINDS.has(kind)) continue;
      heldSwitchState.set(componentId, settledState(kind, sim.sim.primitiveStateAt(pi)));
    }
  };

  const holdRamCells = () => {
    if (!sim) return;
    for (const [i, prim] of sim.compiled.primitives.entries()) {
      if (prim.kind !== 'ram') continue;
      const { width, addressBits } = ramSize(prim.params);
      const { cells } = sim.sim.primitiveStateAt(i) as RamState;
      heldRamCells.set(prim.componentId, { width, addressBits, cells });
    }
  };

  /** `boardTiming` null leaves the board alone: a lesson's timing is session state. */
  const restartTiming = (timing: TimingSetting, boardTiming: TimingSetting | null) => {
    replayIdx = null;
    if (get().powered) captureSwitchState();
    set((s) => ({
      timing,
      ...(boardTiming ? { board: { ...s.board, timing: boardTiming } } : {}),
      powered: false,
      running: false,
      replayTimePs: null,
      rev: s.rev + 1,
    }));
    holdRamCells();
    sim = null;
    refreshSta(timing);
  };

  // An open report would go on showing the old column's or vendor's figures.
  const refreshSta = (timing: TimingSetting) => {
    if (!get().staReport) return;
    if (timing.mode === 'datasheet') get().runSta();
    else get().clearSta();
  };

  // Bubble params lower to literal kinds and spliced NOTs before compile; the
  // defs are lowered too so a packaged def carrying bubble params compiles.
  const compileBoard = (): CompiledCircuit => {
    return compile(lowerCircuit(get().board), lowerLibrary(get().chipLib));
  };

  // A notice already on the strip wins; the keys are shown on a later compile.
  const noteStaleContents = (compiled: CompiledCircuit) => {
    const signature = JSON.stringify(compiled.staleContents.map((k) => [k.instanceId, k.key]));
    if (signature === shownStaleContents) return;
    if (compiled.staleContents.length === 0) {
      shownStaleContents = signature;
      return;
    }
    if (get().error) return;
    shownStaleContents = signature;
    set({ error: staleContentsNotice(compiled.staleContents) });
  };

  const checkStaleContents = () => {
    try {
      noteStaleContents(compileBoard());
    } catch {
      // A board that does not compile says so on power-on, in its own words.
    }
  };

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
    // Deleting a switch drops its column in the same undo step.
    const held = draft as SequenceHolder;
    if (held.sequence) held.sequence = pruneSequence(held.sequence, draft.components);
    const cmd = diffCircuits(before, draft, label);
    if (cmd.items.length === 0) return;
    if (tab.kind !== 'board') {
      if (commitDefEdit(tab.defId, draft)) historyFor(tab.id).commit(cmd);
      return;
    }
    historyFor(tab.id).commit(cmd);
    // A pure-position diff (drag) never touches connectivity, so leave a
    // live sim powered and running through it (P0.4). A render-only param
    // (an LED's colour) is the same case: nothing compiled reads it. A
    // stimulus param is applied by patching the live sim instead. Only a
    // real topology change (place/delete/rewire/width/arity) resets power.
    const effects = cmd.items.map(simEffectOfItem);
    const topologyChanged = effects.includes('topology');
    const liveParamItems = topologyChanged ? [] : cmd.items.filter((_, i) => effects[i] === 'live');
    set((s) => ({
      board: { ...s.board, ...draft },
      powered: topologyChanged ? false : s.powered,
      running: topologyChanged ? false : s.running,
      // STA overlay is view-state over a specific compile; a topology edit
      // invalidates it (spec choice: clear, don't auto-recompute).
      staReport: topologyChanged ? null : s.staReport,
      replayTimePs: topologyChanged ? null : s.replayTimePs,
      rev: s.rev + 1,
    }));
    if (!topologyChanged && liveParamItems.length > 0 && sim) {
      // Params evaluate() re-reads: patch the compiled primitive and wake it,
      // the same path a switch flip takes, so the board stays powered.
      finishPendingRow();
      for (const item of liveParamItems) {
        const after = item.after as unknown as Component | undefined;
        if (!after) continue;
        const pi = sim.compiled.componentToPrimitive.get(`main/${after.id}`);
        if (pi === undefined) continue;
        sim.sim.setPrimitiveParamsAt(pi, (after.params ?? {}) as never);
      }
      replayIdx = null;
      leaveInputPending();
    }
    if (topologyChanged) {
      holdRamCells();
      captureSwitchState();
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
    // The overlay always sends the current name: re-syncing an unchanged one would re-raise a
    // conflict left on "keep both" and name unnamed partners, though nothing was renamed.
    const renaming = !!trimmedLabel && trimmedLabel !== comp.label;
    if (renaming) {
      const netIds = ownNetTerminalIds(circuit, get().chipLib, id);
      if (labelUsedElsewhere(circuit, trimmedLabel, netIds, comp.group)) return null;
    }
    const oldPins = getPrimitive(comp.kind)
      .pins(comp.params ?? {})
      .map((p) => p.name);
    const merged = { ...comp.params, ...params };
    const nextParams = newKind === 'ram' ? withResizedPreload(comp.params ?? {}, merged) : merged;
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
      if (!renaming) return null;
      const dataPin = dataPinOf(newKind);
      if (dataPin) return syncLabels(d, [{ component: id, pin: dataPin }]);
      return syncOutputLabels(d, id, trimmedLabel);
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
    let driverError: string | null = null;
    edit('params', (d) => {
      const before = cloneCircuit(d);
      conflict = plan(d);
      driverError = revertOnDriverConflict(before, d);
    });
    if (driverError) {
      set({ error: driverError });
      return false;
    }
    if (conflict) raiseRenameConflict(conflict, () => get().setComponentParams(id, params));
    return true;
  };

  // A rename conflict's cancel reverts the name only: the undo takes the whole edit, then this
  // replays its params. Keyed by the rows, so a later wire conflict never runs a stale one.
  let renameConflictReplay: { rows: LabelConflictRow[]; replay: () => void } | null = null;
  const raiseRenameConflict = (rows: LabelConflictRow[], replay: () => void) => {
    renameConflictReplay = { rows, replay };
    set({ labelConflict: rows });
  };

  // Unticking output enable makes a shared q plain, which may leave two plain
  // drivers on its bus; restoring `d` leaves edit() an empty diff to drop.
  // Gated on that: a pinView expand compiles dirty until junctions collapse.
  const revertOnDriverConflict = (before: Circuit, d: Circuit): string | null => {
    if (!d.components.some((c) => outputStoppedFloating(before, c))) return null;
    const error = multiDriverConflict(before, d, get().chipLib);
    if (error) Object.assign(d, before);
    return error;
  };

  const outputStoppedFloating = (before: Circuit, c: Component): boolean => {
    const old = before.components.find((o) => o.id === c.id);
    if (!old || !hasPrimitive(c.kind) || !hasPrimitive(old.kind)) return false;
    const floatedBefore = new Set(
      getPrimitive(old.kind)
        .pins(old.params ?? {})
        .filter(canFloat)
        .map((p) => p.name),
    );
    return getPrimitive(c.kind)
      .pins(c.params ?? {})
      .some((p) => isOutputSlot(p.dir) && !canFloat(p) && floatedBefore.has(p.name));
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
    const renaming = !!trimmed && trimmed !== comp.label;
    if (renaming && comp.kind !== 'netlabel') {
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
      // A built output is labelled with its expression, which would otherwise
      // keep the old input name after the rename.
      if (trimmed && comp.label && INPUT_TERMINAL_KINDS.has(comp.kind)) {
        const inputNames = new Set(
          d.components
            .filter((c) => INPUT_TERMINAL_KINDS.has(c.kind) && c.group === comp.group && c.label)
            .map((c) => c.label!),
        );
        inputNames.add(comp.label);
        d.components = d.components.map((c) => {
          if (!OUTPUT_TERMINAL_KINDS.has(c.kind) || c.group !== comp.group) return c;
          // A bare name is a shared net label, not a built expression.
          if (!c.label || c.label === comp.label) return c;
          const next = renameVarInExprText(c.label, comp.label!, trimmed, inputNames);
          return next === null ? c : { ...c, label: next };
        });
      }
      const dataPin = dataPinOf(comp.kind);
      if (renaming && dataPin) conflict = syncLabels(d, [{ component: id, pin: dataPin }]);
      else if (renaming) conflict = syncOutputLabels(d, id, trimmed);
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
  // Entering bubble mode rewrites literal gates into bubble params as an undo
  // step, so undoing it (or redoing past it) would leave literal kinds that
  // expose no bubble anchors to drag.
  const renormalizeForBubbleMode = (draft: Circuit) => {
    if (get().mode !== 'bubble') return;
    draft.components = importCircuit({ ...get().board, ...draft }).components;
  };

  const checkWidthMismatch = (editedId: string) => {
    const board = get().board;
    const tabPrefix = 'main/'; // compile() always roots the given circuit at 'main/'.
    try {
      const compiled = compileBoard();
      set((s) =>
        s.mismatchWires.size > 0 || s.error?.startsWith('width:')
          ? { error: null, mismatchWires: new Set() }
          : { mismatchWires: new Set() },
      );
      noteStaleContents(compiled);
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

  // The two pre-commit checks report different faults; one shared prefix made a
  // multi-driver conflict read as a naming problem.
  const labelFault = (message: string | null): string | null =>
    message === null ? null : `label: ${message}`;

  // Compile speaks in flattened paths ("main/button42.y"), and the root scope
  // is not the board's name, so a user reads it as a save problem. Rewritten
  // against the components actually on the board; compile's own wording stands
  // if the shape ever changes.
  const describeMultiDriver = (circuit: Circuit, message: string): string => {
    const m = /^pins (.+) drive the same wire/.exec(message);
    if (!m) return message;
    const named = m[1]!.split(' and ').map((token) => {
      const bare = token.replace(/^main\//, '');
      const dot = bare.lastIndexOf('.');
      const owner = dot > 0 ? bare.slice(0, dot) : bare;
      const comp = circuit.components.find((c) => c.label === owner || c.id === owner);
      return comp?.label ?? owner;
    });
    return `${named.join(' and ')} both drive this wire. A wire can have only one output that is not three-state.`;
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
    try {
      compile(lowerCircuit(before as Board | ChipDef), lowerLibrary(chipLib));
    } catch {
      return null;
    }
    try {
      compile(lowerCircuit(trial as Board | ChipDef), lowerLibrary(chipLib));
      return null;
    } catch (e) {
      if (!(e instanceof CompileError)) return null;
      // The trial wire's path prefix means nothing to the user.
      const message = e.message.slice(e.path.length + 2);
      if (message.includes('drive the same wire')) return describeMultiDriver(before, message);
      // Same compile rule, so a tap gesture and a moved free end refuse alike.
      return message.includes('bidirectional pin') ? message : null;
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
    chipLib: new Map(builtinChipLibrary()),
    tabs: [{ id: 'board', kind: 'board' }],
    activeTabId: 'board',
    staleInstances: new Set(),
    tool: { kind: 'select' },
    selection: new Set(),
    fitRequest: 0,
    revealAbove: null,
    rev: 0,
    powered: false,
    running: false,
    runBehind: false,
    oscillation: null,
    error: null,
    mismatchWires: new Set(),
    timing: { mode: getPrefs().timingModel, datasheet: 'typ', vendor: 'ti' },
    waveformOpen: false,
    dockTab: 'waves',
    lastRun: null,
    replayTimePs: null,
    hoverTrackPath: null,
    staReport: null,
    lessonHighlight: new Set(),
    boardLoads: 0,
    mode: 'edit',
    labelConflict: null,
    pendingTabClose: null,
    bubbleFocus: null,
    bubblePreview: null,
    bubblePairMode: false,

    setTool: (tool) => set({ tool }),
    setSelection: (selection) => set({ selection }),
    activeCircuit,
    canUndo: () => historyFor(activeTab().id).canUndo,
    canRedo: () => historyFor(activeTab().id).canRedo,
    hasTabEdits: () => get().tabs.some((t) => get().chipTabDirty(t.id)),
    chipTabDirty: (tabId) => {
      const tab = get().tabs.find((t) => t.id === tabId);
      if (tab?.kind !== 'def') return false;
      const def = get().chipLib.get(tab.defId);
      return def !== undefined && def !== tab.saved && !sameDefIgnoringVersion(def, tab.saved);
    },
    markChipSaved: (defId, written) => {
      const def = written ?? get().chipLib.get(defId);
      if (!def) return;
      const baseline: ChipDef = { ...def, ...cloneCircuit(def) };
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.kind === 'def' && t.defId === defId ? { ...t, saved: def, baseline } : t,
        ),
      }));
    },

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
      const tab: Tab = {
        id: genId('tab'),
        kind: 'def',
        defId,
        prefix,
        breadcrumb,
        baseline,
        saved: def,
      };
      set((s) => ({
        tabs: [...s.tabs, tab],
        activeTabId: tab.id,
        tool: { kind: 'select' },
        selection: new Set(),
      }));
    },

    closeTab: (id) => {
      if (id === 'board') return;
      const tab = get().tabs.find((t) => t.id === id);
      const def = tab?.kind === 'def' ? get().chipLib.get(tab.defId) : undefined;
      // A hide alone is no edit to save or discard: Discard would cost a powered board.
      const onlyHides = tab?.kind === 'def' && def !== undefined && sameBody(def, tab.baseline);
      if (get().chipTabDirty(id) && !onlyHides) {
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

    loadBoard: (loaded) => {
      const checked = loaded.hiddenChecks
        ? { ...loaded, hiddenChecks: pruneHiddenChecksOf(loaded, get().chipLib) }
        : loaded;
      const board = checked.sequence
        ? { ...checked, sequence: pruneSequence(checked.sequence, checked.components) }
        : checked;
      seedNextId(board);
      historyByTab.clear();
      sim = null;
      replayIdx = null;
      heldRamCells.clear();
      set((st) => ({
        board,
        lastRun: null,
        // The saved timing wins; the pref only seeds a New board.
        timing: board.timing,
        tabs: [{ id: 'board', kind: 'board' }],
        activeTabId: 'board',
        selection: new Set<string>(),
        staleInstances: new Set<string>(),
        mismatchWires: new Set<string>(),
        error: null,
        powered: false,
        running: false,
        staReport: null,
        replayTimePs: null,
        labelConflict: null,
        lessonHighlight: new Set<string>(),
        boardLoads: st.boardLoads + 1,
        rev: st.rev + 1,
      }));
      shownStaleContents = '';
      checkStaleContents();
    },

    requestFit: () => set((st) => ({ fitRequest: st.fitRequest + 1 })),
    requestRevealAbove: (aboveY) =>
      set((st) => ({ revealAbove: { aboveY, seq: (st.revealAbove?.seq ?? 0) + 1 } })),

    commitNewChip: (def) => {
      const candidateLib = new Map(get().chipLib);
      candidateLib.set(def.id, def);
      const cycleError = findCycle(candidateLib);
      if (cycleError) return { ok: false, error: cycleError };
      const shadowed = shadowedBuiltins(get().chipLib, [def]);
      set({ chipLib: candidateLib, ...shadowNotice(shadowed) });
      return { ok: true };
    },

    loadChipDefs: (defs) => {
      if (defs.length === 0) return { ok: true, count: 0 };
      const candidateLib = new Map(get().chipLib);
      for (const def of defs) candidateLib.set(def.id, def);
      for (const def of defs) {
        const kept = pruneHiddenChecksOf(def, candidateLib);
        if (kept !== def.hiddenChecks) candidateLib.set(def.id, { ...def, hiddenChecks: kept });
      }
      const cycleError = findCycle(candidateLib);
      if (cycleError) return { ok: false, error: cycleError };
      const shadowed = shadowedBuiltins(get().chipLib, defs);
      set({ chipLib: candidateLib, ...shadowNotice(shadowed) });
      checkStaleContents();
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
    // recent history entry): undoing it reverts the wire or rename itself. A cancelled edit is
    // not redoable: redo would bring it back past the dialog it was cancelled from.
    cancelLabelConflict: () => {
      const rows = get().labelConflict;
      if (!rows) return;
      const replay = renameConflictReplay?.rows === rows ? renameConflictReplay.replay : null;
      renameConflictReplay = null;
      set({ labelConflict: null });
      get().undo();
      historyFor(activeTab().id).discardRedo();
      replay?.();
    },

    place: (kind, pos, grid, params, pose, defId, pinsOf, group) => {
      if (kind === 'chip' ? !defId || !get().chipLib.has(defId) : !hasPrimitive(kind)) return;
      const id = genId(kind === 'chip' ? defId! : idPrefix(kind));
      const withDefaults = kind === 'led' ? ledDefaults(params) : params;
      edit('place', (d) => {
        d.components.push({
          id,
          kind,
          ...(kind === 'chip' ? { defId: defId as string } : {}),
          pos: snapPoint(pos, grid),
          ...(withDefaults ? { params: withDefaults } : {}),
          ...(pose?.rot ? { rot: pose.rot } : {}),
          ...(pose?.mirror ? { mirror: true } : {}),
          ...(group ? { group } : {}),
        });
        if (pinsOf) connectAbutting(d, new Set([id]), pinsOf, () => genId('w'));
      });
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
        const spliced = d.wires[idx];
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
            ...(opts.group ? { group: opts.group } : {}),
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
            ...inheritedColor(spliced),
          },
          {
            id: genId('w'),
            a: { kind: 'pin', component: compId, pin: opts.outName },
            b: opts.downstreamEnd,
            points: [],
            ...inheritedColor(spliced),
          },
        );
      });
    },

    moveSelection: (dx, dy, resolveEnd, pinsOf) => {
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
        if (pinsOf) connectAbutting(d, sel, pinsOf, () => genId('w'));
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
            ...withoutStructuralMark(c),
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
            ...inheritedColor(w),
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
        clearTurnedBends(d, (id) => results.has(id));
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
        // A wire with both ends inside the selection turned rigidly with it; one leaving it re-routes.
        const inside = (e: WireEnd) =>
          e.kind === 'pin'
            ? compById.has(e.component)
            : e.kind !== 'junction' || juncById.has(e.junction);
        const rigid = d.wires.filter((w) => wireById.has(w.id) && inside(w.a) && inside(w.b));
        clearTurnedBends(d, (id) => compById.has(id), new Set(rigid.map((w) => w.id)));
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
      const basis = get().tidyBasis();
      // Cloned: autoRoute passes untouched wires through and the junction
      // collapse after it mutates wire ends in place.
      const r = autoRoute({
        components,
        wires: structuredClone(basis.wires),
        junctions: structuredClone(basis.junctions),
        grid,
        ...(only && only.size > 0 ? { only } : {}),
      });
      get().applyTidy(basis, r);
    },

    tidyBasis: () => {
      const c = activeCircuit();
      return {
        tabId: get().activeTabId,
        powered: get().powered,
        chipLib: get().chipLib,
        components: c.components,
        wires: c.wires,
        junctions: c.junctions,
      };
    },

    applyTidy: (basis, result) => {
      const c = activeCircuit();
      if (
        get().activeTabId !== basis.tabId ||
        get().powered !== basis.powered ||
        get().chipLib !== basis.chipLib ||
        c.components !== basis.components ||
        c.wires !== basis.wires ||
        c.junctions !== basis.junctions
      )
        return 'stale';
      if (result.routed === 0) return 'unchanged';
      edit('tidy', (d) => {
        d.wires = result.wires;
        d.junctions = result.junctions;
      });
      return 'applied';
    },

    mirrorSelection: (ids) => {
      const sel = ids ?? get().selection;
      if (sel.size === 0) return;
      edit('mirror', (d) => {
        d.components = d.components.map((c) => (sel.has(c.id) ? { ...c, mirror: !c.mirror } : c));
        clearTurnedBends(d, (id) => sel.has(id));
      });
    },

    // Synthesis lands as its own isolated group, so the built circuit has its
    // own switches and its own LED and never reads a signal from whatever is
    // already on the board. Ids are remapped the same way a paste is, so
    // building twice from the same expression never collides.
    commitSynthesis: (slice, groupName) => {
      if (slice.components.length === 0) return null;
      const st = get();
      if (activeTab().kind !== 'board' || st.mode === 'bubble' || st.powered) return null;
      const revBefore = st.rev;
      const groupId = genId('g');
      const idMap = new Map<string, string>();
      edit('place', (d) => {
        for (const c of slice.components) idMap.set(c.id, genId(idPrefix(c.kind)));
        for (const j of slice.junctions) idMap.set(j.id, genId('j'));
        const taken = new Set((d.groups ?? []).map((g) => g.name));
        let chosen = groupName;
        for (let n = 2; taken.has(chosen); n++) chosen = `${groupName} ${n}`;
        d.groups = [
          ...(d.groups ?? []),
          { id: groupId, name: chosen, color: nextGroupColor(d.groups ?? []) },
        ];
        // Labels are scoped to the group, so a second build of the same
        // expression keeps its own A and B rather than colliding with the
        // first one's.
        const remapEnd = (end: WireEnd): WireEnd => {
          if (end.kind === 'pin')
            return { kind: 'pin', component: idMap.get(end.component)!, pin: end.pin };
          if (end.kind === 'junction')
            return { kind: 'junction', junction: idMap.get(end.junction)! };
          return end;
        };
        for (const c of slice.components)
          d.components.push({ ...c, id: idMap.get(c.id)!, group: groupId });
        for (const j of slice.junctions) d.junctions.push({ ...j, id: idMap.get(j.id)! });
        for (const w of slice.wires)
          d.wires.push({
            id: genId('w'),
            a: remapEnd(w.a),
            b: remapEnd(w.b),
            points: w.points.map((p) => ({ ...p })),
            ...(w.color ? { color: w.color } : {}),
          });
      });
      if (get().rev === revBefore) return null;
      set({ selection: new Set(idMap.values()) });
      return groupId;
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
      const color = nextGroupColor(circuit.groups ?? [], parent);
      edit('group', (d) => {
        d.groups = [
          ...(d.groups ?? []),
          { id, name: chosen, ...(parent ? { parent } : {}), color },
        ];
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

    styleGroup: (id, patch) => {
      const circuit = activeCircuit();
      const group = circuit.groups?.find((g) => g.id === id);
      if (!group) return false;
      const name = patch.name === undefined ? group.name : patch.name.trim();
      if (!name || circuit.groups!.some((g) => g.id !== id && g.name === name)) return false;
      const next = styledGroup(
        group,
        name,
        patch.color === undefined ? group.color : patch.color,
        patch.tab === undefined ? group.tab : patch.tab,
      );
      edit('style group', (d) => {
        d.groups = (d.groups ?? []).map((g) => (g.id === id ? next : g));
      });
      return true;
    },

    colorWires: (ids, color) => {
      if (ids.size === 0) return;
      edit('wire colour', (d) => {
        d.wires = d.wires.map((w) => (ids.has(w.id) ? recoloredWire(w, color) : w));
      });
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
              ...inheritedColor(r1.wire, r2.wire),
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
              d.wires.push({
                id: genId('w'),
                a: upstreamEnd,
                b: otherEnd(ow, id),
                points: [],
                ...inheritedColor(inWire, ow),
              });
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
          labelFault(labelDirectionConflict(trial, get().chipLib, netTouchedPins(trial, [a, b]))) ??
          multiDriverConflict(d, trial, get().chipLib);
        if (dirError) return; // no mutation -> edit() diffs empty and no-ops
        d.wires.push({ id: genId('w'), a, b, points });
        conflict = syncLabels(d, pinRefs([a, b]));
      });
      if (dirError) {
        set({ error: dirError });
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
          labelFault(labelDirectionConflict(trial, get().chipLib, touchedPins)) ??
          multiDriverConflict(d, trial, get().chipLib);
        if (dirError) return;
        for (const { a, b } of pairs) d.wires.push({ id: genId('w'), a, b, points: [] });
        conflict = syncLabels(d, touchedPins);
      });
      if (dirError) {
        set({ error: dirError });
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
              labelFault(
                labelDirectionConflict(trial, get().chipLib, netTouchedPins(trial, [a, bEnd])),
              ) ?? multiDriverConflict(d, trial, get().chipLib);
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
            labelFault(
              labelDirectionConflict(trial, get().chipLib, netTouchedPins(trial, [a, hit.wire.a])),
            ) ?? multiDriverConflict(d, trial, get().chipLib);
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
        set({ error: dirError });
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
            labelFault(
              labelDirectionConflict(trial, get().chipLib, netTouchedPins(trial, [a, bEnd])),
            ) ?? multiDriverConflict(d, trial, get().chipLib);
          if (dirError) return;
          d.wires.push({ id: genId('w'), a, b: bEnd, points });
          connected = true;
          conflict = syncLabels(d, pinRefs([a]));
        },
        resolveEnd,
      );
      if (dirError) {
        set({ error: dirError });
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
                labelFault(
                  labelDirectionConflict(
                    trial,
                    get().chipLib,
                    netTouchedPins(trial, [candidate.wireEnd]),
                  ),
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
        set({ error: dirError });
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
            labelFault(
              labelDirectionConflict(
                trial,
                get().chipLib,
                netTouchedPins(trial, [aTrialEnd, bTrialEnd]),
              ),
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
        set({ error: wireFromStartError });
        return 'rejected';
      }
      return committed ? 'connected' : 'miss';
    },

    undo: () => {
      const tab = activeTab();
      const draft = cloneCircuit(activeCircuit());
      const apply: ApplyFn = (kind, id, value) => applyToCircuit(draft, kind, id, value as never);
      const cmd = historyFor(tab.id).undo(apply);
      if (!cmd) return;
      if (tab.kind === 'board') {
        renormalizeForBubbleMode(draft);
        // Undoing a recolour or a drag must not cost the instructor every
        // switch position, any more than making it did.
        if (cmd.items.every((item) => simEffectOfItem(item) === 'none')) {
          set((s) => ({ board: { ...s.board, ...draft }, rev: s.rev + 1 }));
          dropStaleSelection();
          return;
        }
        set((s) => ({
          board: { ...s.board, ...draft },
          powered: false,
          running: false,
          rev: s.rev + 1,
        }));
        holdRamCells();
        sim = null;
        // Re-validate against the now-reverted board: a stale compile-error/
        // mismatch from the edit just undone shouldn't outlive it.
        checkWidthMismatch('');
      } else if (cmd.items.every((item) => item.kind === 'checks')) {
        setHiddenChecks(tab, draft.hiddenChecks);
      } else {
        commitDefEdit(tab.defId, draft);
      }
      dropStaleSelection();
    },

    redo: () => {
      const tab = activeTab();
      const draft = cloneCircuit(activeCircuit());
      const apply: ApplyFn = (kind, id, value) => applyToCircuit(draft, kind, id, value as never);
      const cmd = historyFor(tab.id).redo(apply);
      if (!cmd) return;
      if (tab.kind === 'board') {
        renormalizeForBubbleMode(draft);
        if (cmd.items.every((item) => simEffectOfItem(item) === 'none')) {
          set((s) => ({ board: { ...s.board, ...draft }, rev: s.rev + 1 }));
          dropStaleSelection();
          return;
        }
        set((s) => ({
          board: { ...s.board, ...draft },
          powered: false,
          running: false,
          rev: s.rev + 1,
        }));
        holdRamCells();
        sim = null;
        checkWidthMismatch('');
      } else if (cmd.items.every((item) => item.kind === 'checks')) {
        setHiddenChecks(tab, draft.hiddenChecks);
      } else {
        commitDefEdit(tab.defId, draft);
      }
      dropStaleSelection();
    },

    // Merged separately: a lesson's session mode must not leak into the board
    // when the instructor changes the column or vendor mid-lesson.
    setTiming: (t) => restartTiming({ ...get().timing, ...t }, { ...get().board.timing, ...t }),

    setSessionTiming: (mode) => {
      restoreSwitchesOnce = true;
      restartTiming({ ...get().timing, mode }, null);
    },

    resetForLesson: () => {
      replayIdx = null;
      sim = null;
      sequenceRun = null;
      heldSwitchState.clear();
      heldRamCells.clear();
      restoreSwitchesOnce = false;
      set((s) => ({
        timing: s.board.timing,
        powered: false,
        running: false,
        runBehind: false,
        oscillation: null,
        lastRun: null,
        replayTimePs: null,
        rev: s.rev + 1,
      }));
      refreshSta(get().timing);
    },

    setLessonHighlight: (ids) => set({ lessonHighlight: new Set(ids) }),

    setRunSpeed: (psPerSecond) => {
      if (get().board.runSpeed === psPerSecond) return;
      set((s) => ({ board: { ...s.board, runSpeed: psPerSecond }, rev: s.rev + 1 }));
    },

    setPartChoice: (key, part) => {
      if (get().board.partChoices?.[key] === part) return;
      set((s) => {
        const next = withPartChoice(s.board.partChoices, key, part);
        const board = { ...s.board };
        if (next) board.partChoices = next;
        else delete board.partChoices;
        return { board, rev: s.rev + 1 };
      });
    },

    power: () => {
      replayIdx = null;
      if (get().powered) {
        captureSwitchState();
        const runs = new Map<string, readonly bv.BusValue[]>();
        if (sim)
          for (const [i, prim] of sim.compiled.primitives.entries())
            if (prim.kind === 'ram')
              runs.set(prim.componentId, (sim.sim.primitiveStateAt(i) as RamState).cells);
        sim = null;
        set((s) => ({
          lastRun: runs.size > 0 ? { board: s.board, chipLib: s.chipLib, runs } : null,
          powered: false,
          running: false,
          replayTimePs: null,
          rev: s.rev + 1,
        }));
        return;
      }
      try {
        const compiled = compileBoard();
        const s = new Simulator(compiled, delayFor(get().timing));
        let report = s.powerOn();
        // Consumed by the power-on that follows the capture, never held past it:
        // a later session (another board, the pref flipped on in between) must
        // not inherit positions from whatever was powered before it.
        const keep = getPrefs().keepSwitchesAcrossPower || restoreSwitchesOnce;
        const restoring = keep ? new Map(heldSwitchState) : null;
        heldSwitchState.clear();
        restoreSwitchesOnce = false;
        if (restoring) {
          // Addressed by component id, never by path: two components can share
          // a label, and a path would then drive the wrong one.
          for (const [componentId, state] of restoring) {
            const pi = compiled.componentToPrimitive.get(componentId);
            if (pi === undefined) continue;
            const kind = compiled.primitives[pi]?.kind;
            // A component whose kind changed while unpowered is a different
            // part now; its old position means nothing.
            if (!kind || !HELD_KINDS.has(kind)) continue;
            s.setPrimitiveStateAt(pi, state);
          }
          if (restoring.size > 0) report = s.settle();
        }
        let restoredRam = false;
        for (const [componentId, held] of heldRamCells) {
          const pi = compiled.componentToPrimitive.get(componentId);
          const prim = pi === undefined ? undefined : compiled.primitives[pi];
          if (pi === undefined || prim?.kind !== 'ram') continue;
          const size = ramSize(prim.params);
          if (size.width !== held.width || size.addressBits !== held.addressBits) continue;
          s.setPrimitiveStateAt(pi, { ...(s.primitiveStateAt(pi) as RamState), cells: held.cells });
          restoredRam = true;
        }
        heldRamCells.clear();
        if (restoredRam) report = s.settle();
        sim = { sim: s, compiled };
        set((st) => ({
          powered: true,
          // A fresh sim is parked until Run starts it, whatever the last one was doing.
          running: false,
          oscillation: loopOf(compiled, report),
          lastRun: null,
          error: null,
          replayTimePs: null,
          // Powering on drops any edit tool. The board cannot be edited while
          // the sim owns it, so a live wire tool could only start a wire that
          // would never commit, and on touch there is no Esc to abandon the
          // ghost it leaves behind.
          tool: { kind: 'select' } as Tool,
          rev: st.rev + 1,
        }));
        noteStaleContents(compiled);
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e), powered: false, running: false });
        sim = null;
      }
    },

    gateStep: () => {
      // Free-running, the pump owns time; the button is disabled, and so is the key.
      if (!sim || get().running) return;
      const live = sim;
      const from = live.sim.time;
      const prev = currentGateRun();
      const fromSettled = live.sim.settled;
      const report = pressGateStep(live.sim, live.compiled, get().timing.mode === 'ideal');
      if (!report) return;
      replayIdx = null;
      applyFallsInStep(from, report.time);
      gateRun = {
        ...nextGateRun(prev, report, live.compiled, from, fromSettled),
        // A sequence row applied at a fall above has just woken its switches.
        pendingPrimitives: live.sim.pendingPrimitives(),
        owner: live,
        traceLength: live.sim.traceLength,
      };
      if (report.settled) resolvePendingCompare();
      // Park the cursor on the time just stepped to rather than snapping back
      // to live: stepping is for reading the moment you landed on.
      set((s) => ({
        // A loop found earlier stands until a press finds it again or the board settles.
        oscillation: report.oscillation
          ? loopNetNames(live.compiled, report.oscillation.nets)
          : report.settled
            ? null
            : s.oscillation,
        replayTimePs: report.time,
        rev: s.rev + 1,
      }));
    },

    canStep: () => (sim ? sim.sim.canStep : false),

    settle: () => {
      if (!sim || get().running || sim.sim.settled) return;
      replayIdx = null;
      const live = sim;
      const ideal = get().timing.mode === 'ideal';
      let run: GateRun | null = currentGateRun();
      let loop: string[] | null = null;
      // Press by press rather than one kernel settle, so the readout can say how many gate
      // delays it took.
      for (let i = 0; i < SETTLE_PRESS_LIMIT && !live.sim.settled; i++) {
        const from = live.sim.time;
        const report = pressGateStep(live.sim, live.compiled, ideal);
        if (!report) break;
        applyFallsInStep(from, report.time);
        run = nextGateRun(run, report, live.compiled, from, false);
        if (report.oscillation) {
          loop = loopNetNames(live.compiled, report.oscillation.nets);
          break;
        }
      }
      if (!live.sim.settled && !loop) {
        // A loop with delay in it never settles; the kernel's event budget calls it.
        const from = live.sim.time;
        const report = live.sim.settle();
        applyFallsInStep(from, report.time);
        loop = loopOf(live.compiled, report);
        run = null;
      }
      gateRun = run ? { ...run, owner: live, traceLength: live.sim.traceLength } : null;
      if (live.sim.settled) resolvePendingCompare();
      set((s) => ({ oscillation: loop, replayTimePs: live.sim.time, rev: s.rev + 1 }));
    },

    canSettle: () => !!sim && !get().running && !sim.sim.settled,

    gateStatus: (prefix = 'main/') => {
      if (!sim || !get().powered || get().running) return null;
      const run = currentGateRun();
      return gateStatusText({
        run,
        ideal: get().timing.mode === 'ideal',
        boardNets: run ? (get().gateOverlay(prefix)?.boardNets ?? 0) : 0,
        settled: sim.sim.settled,
        canStep: sim.sim.canStep,
      });
    },

    gateOverlay: (prefix = 'main/') => {
      const run = currentGateRun();
      if (!run || !sim) return undefined;
      // Scrubbed to another time, the board shows values the run's rings do not describe.
      const shown = get().replayTimePs;
      if (shown !== null && shown !== run.timePs) return undefined;
      const circuit = activeCircuit();
      const hit = gateOverlayCache;
      if (hit && hit.run === run && hit.circuit === circuit && hit.prefix === prefix)
        return hit.overlay;
      const overlay = overlayOfRun(circuit, sim.compiled, prefix, run);
      gateOverlayCache = { run, circuit, prefix, overlay };
      return overlay;
    },

    toggleRun: () => {
      if (!sim) return;
      replayIdx = null;
      const running = !get().running;
      if (running) sim.sim.start();
      else {
        sim.sim.stop();
        resolvePendingCompare();
      }
      set((s) => ({
        running,
        runBehind: false,
        oscillation: null,
        replayTimePs: null,
        rev: s.rev + 1,
      }));
    },

    sequenceRun: () => {
      if (!sim || !get().powered || !boardSequence()) return null;
      const run = runOfSim()!;
      return { cursor: run.cursor, results: run.results, pending: run.pendingCompare };
    },

    applySequenceRow: (index, settleNow = false) => {
      if (!get().powered) return false;
      if (!applyRowNow(index, settleNow)) return false;
      set((s) => ({ replayTimePs: null, rev: s.rev + 1 }));
      return true;
    },

    pulseClockOnce: (clockId) => {
      if (!sim || !get().powered) return 'off';
      if (get().running) return 'running';
      const comp = get().board.components.find((c) => c.id === clockId);
      const pi = comp?.kind === 'clock' ? primOf(clockId) : undefined;
      const net = pi === undefined ? undefined : sim.compiled.primitives[pi]?.outputs[0];
      if (net === undefined) return 'missing';
      const live = sim;
      const from = live.sim.time;
      const report = pulseClock(live.sim, net);
      replayIdx = null;
      gateRun = null;
      if (!report) {
        set((s) => ({ replayTimePs: null, rev: s.rev + 1 }));
        return 'stuck';
      }
      let loop = loopOf(live.compiled, report);
      if (!loop) {
        // A clock-mode sequence row lands on the fall the pulse stopped at.
        applyFallsInStep(from, live.sim.time);
        if (!live.sim.settled) loop = loopOf(live.compiled, live.sim.settle());
      }
      set((s) => ({ oscillation: loop, replayTimePs: null, rev: s.rev + 1 }));
      return loop ? 'loop' : 'ok';
    },

    stepSequence: (delta) => {
      const run = sim && get().powered ? runOfSim() : null;
      if (!run) return false;
      return get().applySequenceRow(run.cursor + delta);
    },

    editSequence: (label, fn) => {
      if (activeTab().kind !== 'board') return;
      edit(label, (draft) => {
        const held = draft as SequenceHolder;
        held.sequence = fn(held.sequence ?? emptySequence());
      });
    },

    setChallenge: (label, next) => {
      if (activeTab().kind !== 'board') return;
      edit(label, (draft) => {
        (draft as ChallengeHolder).challenge = next;
      });
    },

    captureSequenceRow: () => {
      const seq = boardSequence();
      if (!seq) return;
      const byId = new Map(get().board.components.map((c) => [c.id, c]));
      const live = get().powered ? sim : null;
      const cells = seq.inputs.map((id) => {
        const comp = byId.get(id);
        if (!comp) return 0;
        const pi = live ? primOf(id) : undefined;
        if (live && pi !== undefined) {
          const state = live.sim.primitiveStateAt(pi);
          if (comp.kind === 'toggle') return (state as { value: number }).value >>> 0;
          if (comp.kind === 'button') return (state as ButtonState).on ? 1 : 0;
          return (state as SpdtState).position === 'b' ? 1 : 0;
        }
        if (comp.kind === 'toggle') return Number(comp.params?.['initial'] ?? 0) >>> 0;
        if (comp.kind === 'spdt') return spdtPosition((comp.params ?? {}) as never) === 'b' ? 1 : 0;
        return 0;
      });
      const expect = seq.expect.length ? { expect: seq.expect.map(() => null) } : {};
      get().editSequence('capture row', (cur) => addRow(cur, { set: cells, ...expect }));
    },

    pump: (ps) => {
      if (!sim || !get().running) return;
      const target = sim.sim.time + ps;
      // Integer ps runs out after about 2.5 hours of real time; stop short of it.
      if (!Number.isSafeInteger(target)) {
        get().toggleRun();
        return;
      }
      const from = sim.sim.time;
      runSplitAtSequenceFalls(target);
      const runBehind = sim.sim.isBehind(target);
      // A budget spent with time standing still is a zero-delay loop, not a slow board.
      const oscillation =
        runBehind && sim.sim.time === from
          ? loopNetNames(sim.compiled, sim.sim.oscillationReport().nets)
          : null;
      set((s) => ({ runBehind, oscillation, rev: s.rev + 1 }));
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
      finishPendingRow();
      const state = sim.sim.primitiveStateAt(pi) as { value?: number } | undefined;
      const curValue = typeof state?.value === 'number' ? state.value : 0;
      replayIdx = null;
      sim.sim.setPrimitiveStateAt(pi, { value: (curValue ^ (1 << bit)) >>> 0 });
      leaveInputPending();
    },

    setButtonHeld: (componentId, held, prefix = 'main/') => {
      if (!sim) return;
      const comp = activeCircuit().components.find((c) => c.id === componentId);
      if (!comp || comp.kind !== 'button') return;
      const pi = sim.compiled.componentToPrimitive.get(`${prefix}${comp.id}`);
      if (pi === undefined) return;
      // A repeat of the same position would restart a bounce already under way.
      if ((sim.sim.primitiveStateAt(pi) as ButtonState).on === held) return;
      replayIdx = null;
      finishPendingRow();
      // Holding a button is time passing: the press lands before the release,
      // or a paused click would vanish before anyone stepped it.
      if (!held && !get().running && !sim.sim.settled)
        set({ oscillation: loopOf(sim.compiled, sim.sim.settle()) });
      // Button's state shape ({on}) is distinct from toggle's; see the kernel.
      sim.sim.setPrimitiveStateAt(pi, { on: held } satisfies ButtonState);
      leaveInputPending();
    },

    flipSpdt: (componentId, prefix = 'main/') => {
      if (!sim) return;
      const comp = activeCircuit().components.find((c) => c.id === componentId);
      if (!comp || comp.kind !== 'spdt') return;
      const pi = sim.compiled.componentToPrimitive.get(`${prefix}${comp.id}`);
      if (pi === undefined) return;
      replayIdx = null;
      finishPendingRow();
      const { position } = sim.sim.primitiveStateAt(pi) as SpdtState;
      sim.sim.setPrimitiveStateAt(pi, {
        position: position === 'a' ? 'b' : 'a',
      } satisfies SpdtState);
      leaveInputPending();
    },

    spdtThrow: (componentId, prefix = 'main/') => {
      if (scrubbedBack()) return undefined;
      const pi = sim?.compiled.componentToPrimitive.get(`${prefix}${componentId}`);
      if (!sim || pi === undefined || sim.compiled.primitives[pi]?.kind !== 'spdt')
        return undefined;
      return (sim.sim.primitiveStateAt(pi) as SpdtState).position;
    },

    buttonHeld: (componentId, prefix = 'main/') => {
      if (scrubbedBack()) return undefined;
      const pi = sim?.compiled.componentToPrimitive.get(`${prefix}${componentId}`);
      if (!sim || pi === undefined || sim.compiled.primitives[pi]?.kind !== 'button')
        return undefined;
      return (sim.sim.primitiveStateAt(pi) as ButtonState).on;
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

    setDockTab: (tab) => {
      // The replay cursor parks the board on an instant only the waveforms can release.
      if (tab !== 'waves') {
        replayIdx = null;
        set({ dockTab: tab, replayTimePs: null, hoverTrackPath: null });
      } else set({ dockTab: tab });
    },

    memoryRams: () => {
      // Same array while the compile stands, or a drag under power resets the live view.
      if (sim) {
        if (liveRamList?.compiled !== sim.compiled)
          liveRamList = { compiled: sim.compiled, rams: listRams(sim.compiled) };
        return { rams: liveRamList.rams };
      }
      const { board, chipLib } = get();
      if (ramListCache?.board === board && ramListCache.chipLib === chipLib)
        return ramListCache.result;
      let result: { rams: RamEntry[] } | { error: string };
      try {
        result = { rams: listRams(compileBoard()) };
      } catch (e) {
        result = { error: e instanceof Error ? e.message : String(e) };
      }
      ramListCache = { board, chipLib, result };
      return result;
    },

    ramLive: (index) => {
      if (!sim) return null;
      const prim = sim.compiled.primitives[index];
      if (prim?.kind !== 'ram') return null;
      const live = sim.sim;
      const { cells } = live.primitiveStateAt(index) as RamState;
      const inputs = prim.inputs.map((net) => live.netValue(net));
      return { cells, address: ramAddress(prim.params, inputs) };
    },

    setRamPreload: (entry, text) => {
      const st = get();
      if (st.powered || activeTab().kind !== 'board' || entry.misfit) return false;
      const target = entry.target;
      const id = target.kind === 'preload' ? target.componentId : target.instanceId;
      if (!st.board.components.some((c) => c.id === id)) return false;
      edit('memory', (d) => {
        d.components = d.components.map((c) => {
          if (c.id !== id) return c;
          if (target.kind === 'contents')
            return { ...c, contents: { ...(c as ChipInstance).contents, [target.key]: text } };
          const params = { ...c.params };
          // An absent preload is all X, the same as an empty one.
          if (text === '') delete params['preload'];
          else params['preload'] = text;
          return { ...c, params };
        });
      });
      heldRamCells.delete(entry.componentId);
      return true;
    },

    keepLastRun: (entry) => {
      const run = offeredRun(get(), entry.componentId);
      if (!run) return;
      if (!get().setRamPreload(entry, printPreload(run, entry.width))) return;
      // Keeping one RAM's run is not the edit that retires the other RAMs' offers.
      set((s) => {
        if (!s.lastRun) return {};
        const runs = new Map(s.lastRun.runs);
        runs.delete(entry.componentId);
        return { lastRun: runs.size > 0 ? { board: s.board, chipLib: s.chipLib, runs } : null };
      });
    },

    heldRamIds: () => new Set(heldRamCells.keys()),

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

    revealRequest: null,

    revealItems: (ids) => {
      const c = activeCircuit();
      const live = new Set([...c.components.map((x) => x.id), ...c.wires.map((x) => x.id)]);
      const kept = ids.filter((id) => live.has(id));
      if (kept.length === 0) return;
      set((s) => ({
        selection: new Set(kept),
        revealRequest: { seq: (s.revealRequest?.seq ?? 0) + 1, ids: kept },
      }));
    },

    simFights: () =>
      sim && get().powered ? { compiled: sim.compiled, nets: sim.sim.fightingNets() } : null,

    setChecksHidden: (keys, hide) => {
      const tab = activeTab();
      const circuit = activeCircuit();
      if (tab.kind === 'def') {
        const def = get().chipLib.get(tab.defId);
        if (!def || isBuiltinChipDef(def)) return;
      }
      const before = circuit.hiddenChecks ?? [];
      const next = hide
        ? [...new Set([...before, ...keys])]
        : before.filter((k) => !keys.includes(k));
      const draft = cloneCircuit(circuit);
      draft.hiddenChecks = next.length > 0 ? next : undefined;
      const cmd = diffCircuits(cloneCircuit(circuit), draft, hide ? 'hide check' : 'unhide check');
      if (cmd.items.length === 0) return;
      historyFor(tab.id).commit(cmd);
      setHiddenChecks(tab, draft.hiddenChecks);
    },

    pruneHiddenChecks: () => {
      const { board, chipLib } = get();
      const kept = pruneHiddenChecksOf(board, chipLib);
      if (kept === board.hiddenChecks) return board;
      const next = { ...board, hiddenChecks: kept };
      set({ board: next });
      return next;
    },

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

    previewComponentParams: (id, params) => {
      if (!sim || activeTab().kind !== 'board') return;
      const comp = get().board.components.find((c) => c.id === id);
      if (!comp || Object.keys(params).some((k) => paramLiveness(comp.kind, k) !== 'stimulus'))
        return;
      const pi = sim.compiled.componentToPrimitive.get(`main/${id}`);
      if (pi === undefined) return;
      finishPendingRow();
      sim.sim.setPrimitiveParamsAt(pi, params as never);
      replayIdx = null;
      leaveInputPending();
    },

    setComponentParamsBatch: (specs, reanchor) => {
      if (specs.length === 0) return true;
      let firstOk = true;
      let anyApplied = false;
      let anyWidthLike = false;
      // Accumulated across every spec in the batch, not first-wins -- two
      // co-selected components can each independently raise a conflict.
      const conflicts: LabelConflictRow[] = [];
      let driverError: string | null = null;
      edit('params', (d) => {
        const before = cloneCircuit(d);
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
          const was = before.components.find((x) => x.id === spec.id);
          const now = d.components.find((x) => x.id === spec.id);
          const pos = was && now ? reanchor?.(was, now) : undefined;
          if (now && pos) now.pos = pos;
          if (Object.keys(spec.params).some((k) => /width/i.test(k) || k === 'pinView'))
            anyWidthLike = true;
        });
        driverError = revertOnDriverConflict(before, d);
      });
      if (driverError) {
        set({ error: driverError });
        return false;
      }
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
        const paramsOnly = specs.map((spec) => {
          const copy = { ...spec };
          delete copy.label;
          return copy;
        });
        raiseRenameConflict(deduped, () => get().setComponentParamsBatch(paramsOnly, reanchor));
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
        const compiled = sim?.compiled ?? compile(lowerCircuit(st.board), lowerLibrary(st.chipLib));
        const report = analyzeTiming(compiled, {
          column: st.timing.datasheet,
          vendor: st.timing.vendor,
        });
        set({ staReport: { report, compiled }, error: null });
      } catch (e) {
        // A report left up after a failed re-run would show figures for other settings.
        set({
          error: `timing: ${e instanceof Error ? e.message : String(e)}`,
          staReport: null,
        });
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
      // individually on the specific wide gate it would touch, and the
      // equivalence check bit-expands wide terminals so it doesn't require
      // 1-bit-only.
      try {
        if (boardDiffRows(get().board, normalized, get().chipLib).length > 0)
          throw new RangeError('normalizing the board changed its function');
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
  };
});

export { pinNet };
