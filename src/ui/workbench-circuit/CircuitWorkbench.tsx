import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import './circuit.css';
import { schematicTheme, type Theme } from '../../render/theme';
import { screenToWorld, worldToScreen, type Vec2, type Viewport } from '../../render/scene';
import { useCircuitStore, VARIABLE_ARITY_GATES, type Tab } from './circuitStore';

/** Gate kinds a wired gate can be swapped between: one shared pin vocabulary
 *  (a0..an, y), so no wire is disturbed by the change. */
const SWAPPABLE_GATE_KINDS = ['and', 'or', 'nand', 'nor', 'xor', 'xnor'] as const;
import { MAX_WIDTH } from '../../core/value/busValue';
import { clampInt, clampPopupToCanvas, parseConstantValue } from './paramEdit';
import { clampParamValue, clampWidth, isWidthCapable, paramKeysFor } from './paramSpecs';
import type { Params } from '../../core/sim/primitives/types';
import {
  collectPinTargets,
  labelExempt,
  nearestCompatiblePin,
  smartConnectTargets,
  type PinTarget,
} from './pinTargets';
import { renderBoard } from './editorScene';
import { useCompact } from '../compact';
import { useCoarsePointer } from '../pointerKind';
import { SelectionActionBar } from './SelectionActionBar';
import { LONG_PRESS_MS, initialGestureState, reduceGesture, type Intent } from './touchGestures';
import { WaveformPanel } from './WaveformPanel';
import { buildStaOverlay } from './staOverlay';
import type { RoutablePin } from './autoRoute';
import { StaCard } from './StaCard';
import {
  buildLocalGeometry,
  resolveComponentPins,
  captionAwareBounds,
  symbolBounds,
  worldToLocal,
} from '../../render/glyphs/symbol';
import {
  buttonCapCircle,
  buttonLayout,
  dipBankLayout,
  dipCellIndexAt,
} from '../../render/glyphs/io';
import { rectContains, rectFromPoints, rectsIntersect, type Rect } from '../../render/scene';
import { pickDocumentFile, readDocumentFile } from '../../io/boardFile';
import { filePickersSupported } from '../../io/fsAccess';
import { useShellStore } from '../store';
import type {
  Circuit,
  Component,
  ComponentKind,
  Junction,
  ParamValue,
  PinDir,
  Wire,
  WireEnd,
} from '../../core/model/types';
import {
  alignDeltas,
  computeWireRoutes,
  distributeDeltas,
  dragCorner,
  groupRotate,
  halfSnap,
  normalizeBends,
  packDeltas,
  polylineIntersectsRect,
  projectOntoSegment,
  rotatePointAround,
  rotatePointSnapped,
  routeOrthogonal,
  stretchWirePoints,
  tAlongPolyline,
  wiresCrossedBy,
  type AlignMode,
  type DistributeAxis,
} from './wireGeom';
import {
  outputAlignedWithInputs,
  smartConnect,
  smartConnectChainWithin,
  smartConnectSingleSource,
  type ChainComp,
} from './smartConnect';
import {
  LOOSE_HIT_RADIUS,
  MIN_HIT_RADIUS,
  TOUCH_HIT_RADIUS,
  WIRE_BODY_HIT_RADIUS,
} from '../../render/hitTest';
import { PreviewController } from '../../render/ghostPreview';
import { PackageDialog } from './PackageDialog';
import { LabelConflictDialog } from './LabelConflictDialog';
import { CloseTabDialog } from './CloseTabDialog';
import { SmartConnectPicker } from './SmartConnectPicker';
import {
  alignSplicePos,
  canHealSelection,
  findSpliceWire,
  splicePins,
  type SplicePins,
} from './spliceOnWire';
import { extractInternalSelection } from './duplicate';
import { usePrefsStore } from '../prefs';
import { busLabelHitPoints, wireBusWidth } from './busBadge';
import { useContributeMenus, useMenuCommand } from '../menu/MenuProvider';
import type { Menu } from '../menu/menuModel';
import { SHORTCUTS } from '../menu/shortcuts';
import { getPrimitive, hasPrimitive } from '../../core/sim/primitives/registry';
import { serializePinView, type PinViewState } from '../../core/sim/primitives/busPins';
import { currentPinView, pinViewGroupsFor } from './pinViewUI';
import {
  bareBubbleGeometry,
  bubbleAnchors,
  GATE_KINDS,
  gateContainsLocalPoint,
  gateLayout,
  isBareBubble,
  type GateKind,
} from '../../render/glyphs/gates';
import { primitivePins, transformGeometry } from '../../render/glyphs/symbol';
import {
  getInputBubbles,
  getOutputBubble,
  isBubbleEligibleGate,
  normalizeGateComponent,
} from '../../core/gates/bubbleModel';
import { connectedPins, netWireIds } from '../../core/gates/netGraph';
import {
  absorbInverterIntoDriver,
  isStandaloneInverter,
  mergeInversionsUpstream,
  type TransformGeom,
} from '../../core/gates/transform';
import type { PushMove } from './bubble/pushController';
import {
  dragDirectionPoles,
  nearestArrowKey,
  oppositeArrow,
  type ArrowKey,
} from './bubble/bubbleGeometry';
import { nextFocus } from './bubble/focusOrder';
import { AnalyzeDrawer } from './AnalyzeDrawer';
import { useReferenceDrawer, useReferenceDrawerControl } from '../components/ReferenceDrawer';
import { analysisTablesOf, OUTPUT_TERMINAL_KINDS } from '../../core/gates/verify';

import { PaletteRail } from './PaletteRail';
import { ToolIcon, type IconName } from '../components/ToolIcon';

interface DragState {
  ids: Set<string>;
  last: Vec2;
  dx: number;
  dy: number;
  // Alt+drag: leave touched wires behind, cut at their pre-move pin position.
  detach: boolean;
}

interface PanState {
  startClient: Vec2;
  startPan: Vec2;
}

interface LassoState {
  start: Vec2;
  current: Vec2;
  // Pre-existing selection to union with (Ctrl-drag adds to selection).
  base: Set<string>;
}

interface CutState {
  start: Vec2;
  current: Vec2;
  flagged: Set<string>;
}

// M4.3: segment drag slides a segment perpendicular to itself only (KiCad);
// corner drag is a distinct mode -- an interior vertex follows the cursor on
// both axes while its neighbors stay fixed and each adjacent leg re-elbows
// (see wireGeom's `dragCorner`). Both modes keep a live `bends` array `draw()`
// splices onto the wire for the preview, and commit through the same
// `setWirePoints` call on pointer-up.
interface WireDragStateSegment {
  mode: 'segment';
  wireId: string;
  bends: Vec2[]; // materialized interior bend points, live-updated
  origBends: Vec2[]; // frozen snapshot at drag start; every frame rebuilds `bends` from this
  orig: [Vec2, Vec2]; // dragged segment's original bend positions
  bi0: number; // index into origBends of the dragged segment's first end
  // Resolved pin positions the wire's true ends are pinned to -- the anchor
  // beyond origBends[0]/[length-1] when the dragged segment is endpoint-
  // adjacent (origBends has no entry further out than the pin itself there).
  pinA: Vec2;
  pinB: Vec2;
  axis: 'h' | 'v';
  startWorld: Vec2;
  moved: boolean;
}

interface WireDragStateCorner {
  mode: 'corner';
  wireId: string;
  bends: Vec2[]; // live-updated interior bend points
  displayPts: Vec2[]; // frozen full polyline (incl. both resolved endpoints) at drag start
  cornerIdx: number; // index into displayPts of the vertex being dragged
  moved: boolean;
}

type WireDragState = WireDragStateSegment | WireDragStateCorner;

// B3b: dragging a wire's own dangling free end (no component/junction owns
// it) -- distinct from WireDragState, which drags a segment/corner of an
// otherwise-anchored wire. `pos` is grid-snapped and live-updated each move;
// `moved` gates whether pointer-up commits (a zero-movement press+release
// shouldn't create an undo step).
// Align/distribute/pack labels, shared by the Edit menu and anything else
// that offers the same commands.
const ALIGN_ITEMS: [AlignMode, string][] = [
  ['left', 'Align left edges'],
  ['right', 'Align right edges'],
  ['top', 'Align top edges'],
  ['bottom', 'Align bottom edges'],
  ['centerX', 'Align horizontal centers'],
  ['centerY', 'Align vertical centers'],
];

const DISTRIBUTE_ITEMS: [DistributeAxis, string][] = [
  ['x', 'Distribute horizontally'],
  ['y', 'Distribute vertically'],
];

const PACK_ITEMS: [DistributeAxis, string][] = [
  ['x', 'Pack horizontally'],
  ['y', 'Pack vertically'],
];

interface FreeEndDragState {
  wireId: string;
  end: 'a' | 'b';
  pos: Vec2;
  moved: boolean;
}

/** Sliding a bus wire's width badge along its own route. `t` is the live
 *  arc-length fraction; `moved` gates the commit so a press+release with no
 *  movement leaves no undo step, like every other drag here. */
interface BusLabelDragState {
  wireId: string;
  t: number;
  moved: boolean;
}

interface SmartConnectState {
  // undefined: no-hover resolve-from-selection-alone (P1.5).
  targetId: string | undefined;
  rotation: number;
  pairs: { source: PinTarget; target: PinTarget }[];
}

/** A pending wire starts from a pin, a free grid point (Wire tool, empty
 *  canvas), or (B4) right on an existing wire's body/junction -- `worldPos`
 *  is the actual hit-tested snapped point in that case, not a bare grid
 *  round, so the ghost preview starts exactly on the wire; resolved into a
 *  real junction (or degraded to a plain free start) at commit time via
 *  `wireFromStart`, never at pointer-down (an Esc-canceled wire must leave
 *  no trace). */
type WiringStart =
  | PinTarget
  | { kind: 'freeStart'; worldPos: Vec2 }
  | { kind: 'onWire'; worldPos: Vec2 };

/** A bubble mid-drag (bubble-push mode): the grabbed terminal, its gate's
 *  body center for toward/away classification, and the live cursor for the
 *  ghost bubble. */
interface BubbleDragState {
  gateId: string;
  pin: string;
  side: 'input' | 'output';
  anchor: Vec2;
  gateCenter: Vec2;
  /** Downstream pole (far end of the inverter's own output wire) for the
   *  two-pole direction read; only set where gateCenter is a remote,
   *  heuristically-resolved point (bare marker / standalone-inverter body). */
  awayPole?: Vec2 | undefined;
  cursor: Vec2;
  d: number;
  /** Standalone-inverter body grabbed whole; gateCenter is the upstream
   *  driver's center ('toward' = absorb into the driver). */
  body?: boolean;
  /** Keyboard pseudo-drag: no cursor distance to read, so an input bubble's
   *  away move is always the junction-wide merge, never the short-drag
   *  materialize. */
  keyboard?: boolean;
}

const isFreeStart = (w: WiringStart): w is { kind: 'freeStart'; worldPos: Vec2 } =>
  'kind' in w && w.kind === 'freeStart';
const isOnWireStart = (w: WiringStart): w is { kind: 'onWire'; worldPos: Vec2 } =>
  'kind' in w && w.kind === 'onWire';

// Owner decision 2026-07-10: post-2x-rescale default density; retune after TV review.
const DEFAULT_ZOOM = 0.8;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_FACTOR = 1.1;
const DEFAULT_VIEW: Viewport = { panX: -16, panY: -24, zoom: DEFAULT_ZOOM };

/** Movement below this is a tap, not a drag -- a finger never holds still. */
const TAP_SLOP = 6;

/** Waveform-track kinds and the pin whose net the track observes. */
const TRACK_PIN: Record<string, string> = {
  clock: 'y',
  toggle: 'y',
  button: 'y',
  inport: 'y',
  outport: 'a',
  led: 'a',
  probe: 'a',
};

// Only toggle/constant/probe/busdisplay/port/decoder/encoder/mux
// get the width param overlay, each with its own shape (see paramEdit
// state + onCanvasDoubleClick).
// Long enough that a drag or a burst of typing writes once, short enough
// that a crash loses at most a moment's work.
/** Palette floor, matching `.circuit-palette`'s CSS default width. */
const PALETTE_MIN_W = 116;

const WIDTH_LABEL_KINDS = new Set(['inport', 'outport', 'probe', 'busdisplay', 'led']);
// Distinctive-shape gate kinds get a shape-accurate click hit-test instead
// of bbox; lasso/routing stay bbox, via GATE_SHAPE_KINDS being scoped to
// click dispatch only.
const GATE_SHAPE_KINDS = new Set<string>(GATE_KINDS);

/** Kinds whose label is a caption the reader looks at, so it may run to a
 *  second row (Shift+Enter). A port, a net label and a clock are excluded on
 *  purpose: their text is a net identifier, not a caption. */
const CAPTION_KINDS = new Set(['led', 'probe', 'busdisplay', 'toggle', 'switch', 'button']);

export function CircuitWorkbench() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const themeRef = useRef<Theme | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const wiringRef = useRef<WiringStart | null>(null);
  // The ref is what every handler reads synchronously mid-gesture; this mirror
  // exists only so the toolbar can re-render, since a wire in flight turns the
  // wire button into its own cancel. Always set through setWiringStart.
  const [wiring, setWiring] = useState(false);
  // Which tool was armed when the wire began, so switching tools can abandon
  // it without also abandoning the wire that pressing W just started.
  const wiringToolRef = useRef<string | null>(null);
  const setWiringStart = (next: WiringStart | null) => {
    wiringRef.current = next;
    wiringToolRef.current = next ? store.getState().tool.kind : null;
    setWiring(next !== null);
  };
  const [viewport, setViewport] = useState<Viewport>(DEFAULT_VIEW);
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const panRef = useRef<PanState | null>(null);
  const lassoRef = useRef<LassoState | null>(null);
  const cutRef = useRef<CutState | null>(null);
  // P1.6: bend points committed so far on the in-progress wire (empty-grid
  // clicks push here and keep drawing instead of ending the wire); reset
  // whenever a new wire starts or the pending one completes/cancels.
  const wireBendsRef = useRef<Vec2[]>([]);
  const smartConnectRef = useRef<SmartConnectState | null>(null);
  const [precisePicker, setPrecisePicker] = useState<{ targetId: string } | null>(null);
  // Duplicate ghost: `base` keeps the source's own ids/positions (fresh ids
  // are only minted on commit, via commitDuplicate). `offset` is recomputed
  // on every cursor move (M4.5) as `snap(cursorWorld) - groupTopLeft(base)`
  // -- an anchor-plus-delta scheme (the pre-M4.5 shape) preserved the base's
  // absolute location instead of following the cursor whenever the anchor
  // went stale; this way the ghost's top-left is always exactly where the
  // place tool would put a fresh single component, single-component
  // duplicate included (byte-identical anchoring). `stamp`: Shift+D keeps
  // placing (mirrors place-tool stamping) -- a click commits and the ghost
  // stays live for another; Ctrl+V is single-shot.
  const duplicateRef = useRef<{
    base: Circuit;
    offset: Vec2;
    stamp: boolean;
  } | null>(null);
  const clipboardRef = useRef<Circuit | null>(null);
  const lastMouseWorldRef = useRef<Vec2>({ x: 0, y: 0 });
  const wireDragRef = useRef<WireDragState | null>(null);
  const freeEndDragRef = useRef<FreeEndDragState | null>(null);
  const busLabelDragRef = useRef<BusLabelDragState | null>(null);
  const hoverItemRef = useRef<string | null>(null);
  /** Last hovered net-label NAME, so the peer highlight repaints on change
   *  instead of on every pointer move. */
  const hoverLabelNameRef = useRef<string | null>(null);
  const ghostRef = useRef(new PreviewController<Component>());
  const ghostPoseRef = useRef<{ rot: NonNullable<Component['rot']>; mirror: boolean }>({
    rot: 0,
    mirror: false,
  });
  const [hoverPin, setHoverPin] = useState<Vec2 | undefined>(undefined);
  // P2.5: inline pin rename overlay -- a port double-click opens a tiny
  // text input positioned at the glyph in screen space.
  const [renaming, setRenaming] = useState<{
    id: string;
    screen: Vec2;
    value: string;
    flash?: boolean;
  } | null>(null);

  const [packaging, setPackaging] = useState(false);
  /** How many wires the pending smart-connect proposal would add; 0 = none. */
  const [connectPairs, setConnectPairs] = useState(0);
  // Component's own screen-space bounds at popup-open time, kept alongside
  // `screen` so a layout effect can flip/clamp the popup into the canvas
  // once its real rendered size is known (can't compute this up front --
  // content height varies by kind/field values).
  interface PopupAnchor {
    compLeft: number;
    compTop: number;
    compRight: number;
    compBottom: number;
  }
  // Clock param overlay (double-click a clock): ns-facing inputs over ps storage.
  const [clockEdit, setClockEdit] = useState<{
    id: string;
    screen: Vec2;
    anchor: PopupAnchor;
    name: string;
    periodNs: number;
    dutyPct: number;
    phaseNs: number;
    flash?: boolean;
  } | null>(null);
  const clockEditBoxRef = useRef<HTMLDivElement | null>(null);
  // Width/param overlay (double-click, clock precedent): one shape for
  // every width-editable kind; unused fields per kind stay undefined.
  const [paramEdit, setParamEdit] = useState<{
    id: string;
    kind: ComponentKind;
    screen: Vec2;
    anchor: PopupAnchor;
    name?: string;
    width?: number;
    initial?: number;
    valueText?: string;
    hasEnable?: boolean;
    inputs?: number;
    /** Gate-kind swap (variable-arity gates only): same pin vocabulary, so
     *  every wire survives the change. */
    swapKind?: string;
    selSide?: 'bottom' | 'top';
    // Per-pin-group bus expand/collapse. Keys and eligibility come from
    // pinViewUI.ts's pinViewGroupsFor. Serialized into the `pinView` param
    // string on commit.
    pinView: Record<string, PinViewState>;
    flash?: boolean;
    // Task 6 batch param edit. `ids` is every component the commit applies
    // to -- [id] alone (today's single-component shape) unless this opened
    // on a multi-selection with a non-empty shared descriptor-key
    // intersection, in which case `batchKeys` names exactly the fields
    // shown/applied to the OTHER selected components (pinView/name/label
    // stay scoped to `id` alone regardless -- decisions 1/4).
    ids: string[];
    batchKeys?: ReadonlySet<string>;
    focusedField: string | null;
  } | null>(null);
  const paramEditBoxRef = useRef<HTMLDivElement | null>(null);
  // Momentary buttons currently held down (onPointerDown -> onPointerUp);
  // pointer capture keeps the up event firing on this canvas even if the
  // cursor drags off the button (or off the canvas) before release.
  const heldButtonsRef = useRef<Set<string>>(new Set());
  const bubbleDragRef = useRef<BubbleDragState | null>(null);
  // Failed-drag ghost decay (~1.5s), cancelable on click.
  const bubbleRejectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // View-only: the board can be driven (power, switches, buttons) but not
  // edited. It is a deliberate mode now, not a platform verdict: a phone gets
  // the real editor, with the touch grammar in touchGestures.ts and the
  // selection action bar standing in for the modifier keys.
  const compact = useCompact();
  // Layout is a question about width; gesture affordances are a question about
  // the input device, so a touchscreen laptop gets grips at desktop width.
  const coarse = useCoarsePointer();
  const coarseRef = useRef(coarse);
  coarseRef.current = coarse;
  // Naming a key to someone holding a phone is noise, and naming a tap to
  // someone holding a mouse is wrong. Every tooltip that mentions either goes
  // through these two.
  const key = (k: string) => (coarse ? '' : ` (${k})`);
  const press = coarse ? 'tap' : 'click';
  // The File menu is a poor first reach on a phone, and an empty canvas is a
  // dead end there; the same command the menu runs gets a toolbar button.
  const examplesCmd = useMenuCommand('file', 'examples');
  const [viewOnly, setViewOnly] = useState(false);
  const viewOnlyRef = useRef(viewOnly);
  viewOnlyRef.current = viewOnly;
  // Touch classification (tap / pan / long press / pinch) lives in a pure
  // reducer so it can be tested; this component keeps only the anchor the
  // pinch zooms about.
  const gestureRef = useRef(initialGestureState());
  const pinchRef = useRef<{ dist: number; mid: Vec2; vp: Viewport } | null>(null);
  // A press that never moves still has to report itself, and only a timer can
  // say so; cleared on any lift or cancel.
  const longPressTimer = useRef(0);
  // A pan drag ends with a click too; this tells a tap from a drag.
  const panMovedRef = useRef(false);

  const store = useCircuitStore;
  const rev = useCircuitStore((s) => s.rev);
  const tool = useCircuitStore((s) => s.tool);
  const powered = useCircuitStore((s) => s.powered);
  const running = useCircuitStore((s) => s.running);
  // Declared here rather than beside the menus: the redraw effect below lists
  // it, and a dep array is read during render.
  const alwaysShowBusWidth = usePrefsStore((s) => s.prefs.alwaysShowPinBusWidth);
  // Free-running, the pump owns time and a single delta is invisible under it;
  // settled with no self-timed source, there is nothing to step to. Recomputed
  // off rev, which every simulation mutation bumps.
  const canStep = useMemo(
    () => powered && !running && store.getState().canStep(),
    [powered, running, rev, store],
  );
  // --- Palette width --------------------------------------------------------
  // Session-only, like the waveform panel's height: a display preference, not
  // board state. `null` = the CSS default.
  const [paletteW, setPaletteW] = useState<number | null>(null);
  const paletteRef = useRef<HTMLElement>(null);
  const paletteResizeRef = useRef<{ startX: number; startW: number } | null>(null);
  /** Width at which the longest item name stops being ellipsised. A label's
   *  own `scrollWidth` reports its untruncated text even while clipped, so the
   *  fit is measured off what is really rendered rather than re-measured font
   *  metrics. */
  const paletteFitWidth = useCallback((): number => {
    const el = paletteRef.current;
    if (!el) return PALETTE_MIN_W;
    let widest = 0;
    for (const item of el.querySelectorAll<HTMLElement>('.palette-item')) {
      const label = item.querySelector<HTMLElement>('.palette-item__label');
      if (!label) continue;
      widest = Math.max(widest, item.clientWidth - label.clientWidth + label.scrollWidth);
    }
    const pad = el.offsetWidth - el.clientWidth; // scrollbar + borders
    return Math.max(PALETTE_MIN_W, Math.ceil(widest + pad) + 2);
  }, []);

  // Import starts in the boards folder: it merges a circuit, not a part.
  const boardsDir = useShellStore((st) => st.boardsDir);

  // Shared by Ctrl+C/Ctrl+V and their menu items, so the two routes can never
  // diverge. Copy falls back to the hovered item when nothing is selected
  // (KiCad precedence); paste arms the same cursor-following ghost Shift+D
  // uses rather than committing at a fixed offset.
  const copySelection = (hoverIds?: Set<string>) => {
    const s = store.getState();
    const sel = s.selection.size > 0 ? s.selection : hoverIds;
    if (!sel || sel.size === 0) return;
    const slice = extractInternalSelection(s.activeCircuit(), sel);
    if (slice.components.length > 0 || slice.junctions.length > 0) clipboardRef.current = slice;
  };

  const pasteClipboard = () => {
    const base = clipboardRef.current;
    if (!base) return;
    const grid = themeRef.current?.gridSchematic ?? 1;
    duplicateRef.current = {
      base,
      offset: computeDupOffset(base, lastMouseWorldRef.current, grid),
      stamp: false,
    };
    drawRef.current();
  };

  /** Merge another document's contents into THIS board instead of replacing
   *  it. Board or chip alike -- both are circuits. The slice goes through the
   *  paste path, so ids are remapped, labels advance clear of the board's own,
   *  the whole import is one undo step, and it lands selected. */
  const fileImport = async () => {
    try {
      const file = await pickDocumentFile(boardsDir ?? undefined);
      if (!file) return;
      const doc = await readDocumentFile(file);
      const circuit: Circuit = doc.kind === 'board' ? doc.board : doc.def;
      const ids = new Set([
        ...circuit.components.map((c) => c.id),
        ...circuit.junctions.map((j) => j.id),
      ]);
      const slice = extractInternalSelection(circuit, ids);
      if (slice.components.length === 0 && slice.junctions.length === 0) {
        useCircuitStore.setState({ error: 'import: that file has nothing to place' });
        return;
      }
      // Land the import's top-left at the grid-snapped centre of what the user
      // is currently looking at, so it never arrives off-screen.
      const rect = canvasRef.current?.getBoundingClientRect();
      const centre = screenToWorld(viewportRef.current, {
        x: (rect?.width ?? 0) / 2,
        y: (rect?.height ?? 0) / 2,
      });
      const grid = themeRef.current?.gridSchematic ?? 8;
      const xs = [...slice.components.map((c) => c.pos.x), ...slice.junctions.map((j) => j.pos.x)];
      const ys = [...slice.components.map((c) => c.pos.y), ...slice.junctions.map((j) => j.pos.y)];
      const topLeft = { x: Math.min(...xs), y: Math.min(...ys) };
      store.getState().commitDuplicate(slice, {
        x: Math.round(centre.x / grid) * grid - topLeft.x,
        y: Math.round(centre.y / grid) * grid - topLeft.y,
      });
    } catch (e) {
      useCircuitStore.setState({ error: `import: ${(e as Error).message}` });
    }
  };

  // Themes whose palette is itself a power indicator read this class; the
  // canvas picks the change up through its existing data-theme/class observer.
  useEffect(() => {
    document.documentElement.classList.toggle('powered', powered);
    return () => document.documentElement.classList.remove('powered');
  }, [powered]);
  const timing = useCircuitStore((s) => s.timing);
  const error = useCircuitStore((s) => s.error);
  const simTime = useCircuitStore((s) => (s.rev >= 0 ? s.simTimePs() : null));
  const tabs = useCircuitStore((s) => s.tabs);
  const activeTabId = useCircuitStore((s) => s.activeTabId);
  const chipLib = useCircuitStore((s) => s.chipLib);
  const selection = useCircuitStore((s) => s.selection);
  const mode = useCircuitStore((s) => s.mode);
  const replayTimePs = useCircuitStore((s) => s.replayTimePs);
  const hoverTrackPath = useCircuitStore((s) => s.hoverTrackPath);
  const staReport = useCircuitStore((s) => s.staReport);
  const waveformOpen = useCircuitStore((s) => s.waveformOpen);
  const bubbleFocus = useCircuitStore((s) => s.bubbleFocus);
  const bubblePreview = useCircuitStore((s) => s.bubblePreview);
  const bubblePairMode = useCircuitStore((s) => s.bubblePairMode);
  const activeTab: Tab = tabs.find((t) => t.id === activeTabId) ?? tabs[0]!;
  const prefix = activeTab.kind === 'board' ? 'main/' : activeTab.prefix;

  // Analyze drawer: reachable from edit mode's toolbar and
  // via bubble mode's Analyze exit. Content registers only while open-able.
  const [analyzeOpen, setAnalyzeOpen] = useState(false);
  const drawerControl = useReferenceDrawerControl();
  const closeAnalyze = useCallback(() => {
    setAnalyzeOpen(false);
    drawerControl.setOpen(false);
  }, [drawerControl]);
  useReferenceDrawer(
    useMemo(
      () =>
        analyzeOpen ? { label: 'Analyze', body: <AnalyzeDrawer onClose={closeAnalyze} /> } : null,
      [analyzeOpen, closeAnalyze],
    ),
  );
  const tryOpenAnalyze = () => {
    const st = store.getState();
    if (activeTab.kind !== 'board') {
      useCircuitStore.setState({ error: 'analyze: works on the board tab' });
      return;
    }
    const outputs = st.board.components.filter((c) => OUTPUT_TERMINAL_KINDS.has(c.kind));
    try {
      if (outputs.length === 0) throw new RangeError('no output terminal (output/LED/probe)');
      // Compile-level validation only (cycles, multi-driver, ...) -- per-bit
      // width expansion is analysisTablesOf's own job below, wide terminals
      // are not an Analyze error.
      analysisTablesOf(st.board, st.chipLib);
    } catch (err) {
      useCircuitStore.setState({
        error: `analyze: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    setAnalyzeOpen(true);
    drawerControl.setOpen(true);
  };

  // Wires on the hovered waveform track's net (panel -> schematic highlight).
  const trackHighlightWires = (): Set<string> | undefined => {
    const st = store.getState();
    const path = st.hoverTrackPath;
    if (!path || !st.powered || activeTab.kind !== 'board') return undefined;
    const name = path.startsWith('main/') ? path.slice(5) : path;
    const comp = st.board.components.find((c) => (c.label || c.id) === name);
    if (!comp) return undefined;
    const pin = TRACK_PIN[comp.kind];
    if (!pin) return undefined;
    const net = st.netOfPin(comp.id, pin);
    if (net === undefined) return undefined;
    const ids = new Set<string>();
    for (const w of st.board.wires)
      for (const end of [w.a, w.b])
        if (end.kind === 'pin' && st.netOfPin(end.component, end.pin) === net) {
          ids.add(w.id);
          break;
        }
    return ids;
  };

  // Selecting a junction highlights every wire on its whole physically-joined
  // run (crossing through any other junctions too), regardless of power --
  // this is a topology view, not a live-signal one.
  const junctionHighlightWires = (): Set<string> | undefined => {
    const st = store.getState();
    const circuit = st.activeCircuit();
    const ids = new Set<string>();
    for (const jid of st.selection) {
      if (!circuit.junctions.some((j) => j.id === jid)) continue;
      for (const wid of netWireIds(circuit, { kind: 'junction', junction: jid })) ids.add(wid);
    }
    return ids.size ? ids : undefined;
  };

  // Hovering or selecting a net label lights every label sharing its name and
  // every wire on the joined net. A name join is invisible on the canvas --
  // there is no wire to follow -- so this is what makes an accidental one
  // (two labels you did not mean to name alike) findable.
  const netLabelPeers = (): { comps: Set<string>; wires: Set<string> } | undefined => {
    const st = store.getState();
    const circuit = st.activeCircuit();
    const focus = [...st.selection, hoverItemRef.current].filter((id): id is string => !!id);
    const names = new Set<string>();
    for (const id of focus) {
      const c = circuit.components.find((x) => x.id === id);
      if (c?.kind !== 'netlabel') continue;
      const name = (c.label ?? '').trim();
      if (name) names.add(name);
    }
    if (names.size === 0) return undefined;
    const comps = new Set<string>();
    const wires = new Set<string>();
    for (const c of circuit.components) {
      if (c.kind !== 'netlabel' || !names.has((c.label ?? '').trim())) continue;
      comps.add(c.id);
      // netWireIds crosses the name join itself, so one call per label already
      // reaches the far side; the loop is for labels on separate names.
      for (const wid of netWireIds(circuit, { kind: 'pin', component: c.id, pin: 'a' }))
        wires.add(wid);
    }
    return { comps, wires };
  };

  const combinedHighlightWires = (): Set<string> | undefined => {
    const a = trackHighlightWires();
    const b = junctionHighlightWires();
    const c = netLabelPeers()?.wires;
    const sets = [a, b, c].filter((x): x is Set<string> => !!x && x.size > 0);
    if (sets.length === 0) return undefined;
    if (sets.length === 1) return sets[0];
    return new Set(sets.flatMap((x) => [...x]));
  };

  const draw = () => {
    const canvas = canvasRef.current;
    const theme = themeRef.current;
    if (!canvas || !theme) return;
    const ctx = canvas.getContext('2d')!;
    const st = store.getState();
    let board: Circuit = st.activeCircuit();
    const drag = dragRef.current;
    if (drag && drag.ids.size) {
      // M4.3: live-preview the drag-stretch too (not just the moved
      // components/junctions), or an obstructed detour or bend re-elbow
      // would flash into place only once the drag commits. Old-end
      // resolution reads `board` from *before* this override applies (the
      // store's actual current state), matching what the commit-time
      // resolveWireEnd call reads.
      const delta = { x: drag.dx, y: drag.dy };
      const wires = board.wires.map((w) => {
        const aMoved =
          (w.a.kind === 'pin' && drag.ids.has(w.a.component)) ||
          (w.a.kind === 'junction' && drag.ids.has(w.a.junction));
        const bMoved =
          (w.b.kind === 'pin' && drag.ids.has(w.b.component)) ||
          (w.b.kind === 'junction' && drag.ids.has(w.b.junction));
        if (!aMoved && !bMoved) return w;
        const aOld = resolveWireEnd(w.a);
        const bOld = resolveWireEnd(w.b);
        if (!aOld || !bOld) return w;
        return { ...w, points: stretchWirePoints(w.points, aOld, bOld, aMoved, bMoved, delta) };
      });
      board = {
        ...board,
        components: board.components.map((c) =>
          drag.ids.has(c.id) ? { ...c, pos: { x: c.pos.x + drag.dx, y: c.pos.y + drag.dy } } : c,
        ),
        junctions: board.junctions.map((j) =>
          drag.ids.has(j.id) ? { ...j, pos: { x: j.pos.x + drag.dx, y: j.pos.y + drag.dy } } : j,
        ),
        wires,
      };
    }
    const wd = wireDragRef.current;
    if (wd)
      board = {
        ...board,
        wires: board.wires.map((w) => (w.id === wd.wireId ? { ...w, points: wd.bends } : w)),
      };
    const fd = freeEndDragRef.current;
    if (fd)
      board = {
        ...board,
        wires: board.wires.map((w) =>
          w.id === fd.wireId ? { ...w, [fd.end]: { kind: 'free', pos: fd.pos } } : w,
        ),
      };
    const from = wiringRef.current;
    try {
      renderBoard(ctx, theme, {
        board,
        chipLib: st.chipLib,
        viewport: viewportRef.current,
        selection: st.selection,
        changed: st.changedComponentIds(prefix),
        stale: st.staleInstances,
        pinSignal: (id, pin) => st.pinSignal(id, pin, prefix),
        highlightWires: combinedHighlightWires(),
        mismatchWires: st.mismatchWires,
        paramHighlight:
          paramEdit && paramEdit.ids.length > 1 && paramEdit.focusedField
            ? new Set(paramEdit.ids)
            : undefined,
        peerLabels: netLabelPeers()?.comps,
        pinRawValue: (id, pin) => st.pinRawValue(id, pin, prefix),
        staOverlay: (() => {
          if (!st.staReport || activeTab.kind !== 'board') return undefined;
          const data = buildStaOverlay(
            st.board,
            st.staReport.compiled,
            st.staReport.report,
            st.selection,
          );
          return data ?? undefined;
        })(),
        hoverPin,
        // P1.6: the preview is the full polyline through every committed bend
        // so far, then a live orthogonal route from the last bend to the
        // cursor -- not just a single elbow from the wire's start.
        wiringPreview:
          from && hoverPin
            ? (() => {
                const bends = wireBendsRef.current;
                const lastFixed = bends.length ? bends[bends.length - 1]! : from.worldPos;
                return [from.worldPos, ...bends, ...routeOrthogonal(lastFixed, hoverPin).slice(1)];
              })()
            : undefined,
        grid: theme.gridSchematic,
        dpr: window.devicePixelRatio || 1,
        ghost: ghostRef.current.current?.proposal,
        lasso: lassoRef.current
          ? rectFromPoints(lassoRef.current.start, lassoRef.current.current)
          : undefined,
        cutFlags: cutRef.current?.flagged,
        cutSlash: cutRef.current
          ? { from: cutRef.current.start, to: cutRef.current.current }
          : undefined,
        smartConnectPreview: smartConnectRef.current?.pairs.map(({ source, target }) => ({
          from: source.worldPos,
          to: target.worldPos,
          label: `${source.pinName} -> ${target.pinName}`,
        })),
        bubbleOverlay: (() => {
          const pv = st.bubblePreview;
          if (st.mode !== 'bubble' || !pv) return undefined;
          if (pv.result.legal) return { board: pv.result.result, legal: true };
          return pv.result.attempted ? { board: pv.result.attempted, legal: false } : undefined;
        })(),
        bubbleFocus: st.mode === 'bubble' ? bubbleFocusOverlay() : undefined,
        dragBubble: bubbleDragRef.current
          ? { center: bubbleDragRef.current.cursor, d: bubbleDragRef.current.d * 2 }
          : undefined,
        ghostGroup: duplicateRef.current
          ? {
              components: duplicateRef.current.base.components.map((c) => ({
                ...c,
                pos: {
                  x: c.pos.x + duplicateRef.current!.offset.x,
                  y: c.pos.y + duplicateRef.current!.offset.y,
                },
              })),
              junctions: duplicateRef.current.base.junctions.map((j) => ({
                ...j,
                pos: {
                  x: j.pos.x + duplicateRef.current!.offset.x,
                  y: j.pos.y + duplicateRef.current!.offset.y,
                },
              })),
              wires: duplicateRef.current.base.wires,
            }
          : undefined,
      });
      if (st.error?.startsWith('draw: ')) store.setState({ error: null });
    } catch (e) {
      // A drawing bug degrades to the toolbar error strip, never a blank app.
      store.setState({ error: `draw: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  // Effects registered once (wheel, observers) call through drawRef so they
  // never render with a stale closure's viewport.
  const drawRef = useRef(draw);
  drawRef.current = draw;

  // Coalesces a burst of state-driven redraws (e.g. rapid switch/button
  // taps, each its own independent DOM event -> its own render -> its own
  // effect run) into at most one actual draw() per animation frame, instead
  // of one full renderBoard() per tap -- that per-tap cost is what made
  // fast repeated tapping feel buffered/delayed. Direct draw() calls made
  // for live interactive feedback (drag/hover previews) are untouched.
  const drawScheduledRef = useRef(false);
  const scheduleDraw = () => {
    if (drawScheduledRef.current) return;
    drawScheduledRef.current = true;
    requestAnimationFrame(() => {
      drawScheduledRef.current = false;
      drawRef.current();
    });
  };

  // Redraw on any store mutation (rev), hover, viewport, or tab change.
  // Bubble-mode fields never bump rev (circuitStore comment), so they must
  // be listed here explicitly.
  useEffect(() => {
    scheduleDraw();
  }, [
    rev,
    hoverPin,
    viewport,
    tool,
    powered,
    activeTabId,
    mode,
    bubbleFocus,
    bubblePreview,
    bubblePairMode,
    // Scrub-replay/track-hover/STA overlay never bump rev; the canvas must
    // watch them.
    replayTimePs,
    hoverTrackPath,
    staReport,
    selection,
    // Task 6: paramEdit is React state, not a store field -- it never bumps
    // rev, so the focused-field highlight needs its own explicit watch here
    // (the same "state changed, screen didn't" class of bug as Ctrl+click's).
    paramEdit,
    // The renderer reads this preference straight out of the prefs store, so
    // nothing else here notices when it flips.
    alwaysShowBusWidth,
  ]);

  // Entering/leaving bubble mode cancels any in-flight editing gesture; the
  // rest of the lockout is the top-of-handler delegation in the handlers.
  useEffect(() => {
    setWiringStart(null);
    wireBendsRef.current = [];
    lassoRef.current = null;
    cutRef.current = null;
    setSmartConnect(null);
    duplicateRef.current = null;
    bubbleDragRef.current = null;
    ghostRef.current.cancel();
    setHoverPin(undefined);
    drawRef.current();
  }, [mode]);

  // Leaving place mode drops the pending ghost; selecting any other tool also
  // exits Shift+D/Ctrl+V's duplicate-stamp ghost the same way (mirrors place
  // mode's own exit rule -- no separate exit gesture invented for stamping).
  useEffect(() => {
    if (tool.kind !== 'place' && ghostRef.current.active) {
      ghostRef.current.cancel();
      drawRef.current();
    }
    if (duplicateRef.current) {
      duplicateRef.current = null;
      drawRef.current();
    }
  }, [tool]);

  // Wheel = zoom to cursor; Shift+wheel pans instead (the same Shift = pan
  // alias the drag gesture uses), since a laptop trackpad has no middle-drag
  // and a two-finger swipe arrives as a wheel event. A trackpad pinch arrives
  // as a ctrlKey wheel, which keeps zooming. Native non-passive listener:
  // React's synthetic onWheel can register passive and then cannot prevent
  // browser page zoom.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const sc = smartConnectRef.current;
      if (sc) {
        // Scroll rotates the assignment while a smart-connect preview is open,
        // instead of zooming.
        sc.rotation += e.deltaY < 0 ? 1 : -1;
        sc.pairs = computeSmartConnect(sc.targetId, sc.rotation);
        setConnectPairs(sc.pairs.length);
        drawRef.current();
        return;
      }
      const vp = viewportRef.current;
      // Shift+swipe pans; so does a plain horizontal swipe, which carries no
      // deltaY to zoom by in the first place.
      if (e.shiftKey || (!e.ctrlKey && e.deltaY === 0 && e.deltaX !== 0)) {
        // Free 2-D pan: both deltas straight through, never snapped to an
        // axis. A trackpad reports each axis independently and a frame of a
        // diagonal swipe can legitimately carry zero on one of them, so any
        // per-frame guess about which axis the user "meant" makes a smooth
        // diagonal or circular drag stutter between the two.
        setViewport({
          ...vp,
          panX: vp.panX + e.deltaX / vp.zoom,
          panY: vp.panY + e.deltaY / vp.zoom,
        });
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const s = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const world = screenToWorld(vp, s);
      const zoom = Math.min(
        MAX_ZOOM,
        Math.max(MIN_ZOOM, vp.zoom * (e.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR)),
      );
      // Keep the world point under the cursor fixed: pan = world - screen/zoom.
      setViewport({ panX: world.x - s.x / zoom, panY: world.y - s.y / zoom, zoom });
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  const fitView = () => {
    const canvas = canvasRef.current;
    const theme = themeRef.current;
    const st = store.getState();
    if (!canvas || !theme) return;
    const circuit = st.activeCircuit();
    if (circuit.components.length === 0) {
      setViewport(DEFAULT_VIEW);
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const c of circuit.components) {
      const def = c.defId ? st.chipLib.get(c.defId) : undefined;
      // Labels are drawn outside the symbol box, so fitting the boxes alone
      // pushed the outermost captions off the edge of the view.
      const b = captionAwareBounds(symbolBounds(c, theme, def).bounds, c.label, theme);
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w);
      maxY = Math.max(maxY, b.y + b.h);
    }
    const margin = 2 * theme.gridSchematic;
    const w = maxX - minX + 2 * margin;
    const h = maxY - minY + 2 * margin;
    const cw = canvas.clientWidth || canvas.width;
    const ch = canvas.clientHeight || canvas.height;
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(cw / w, ch / h, DEFAULT_ZOOM * 2)));
    setViewport({
      panX: minX - margin - (cw / zoom - w) / 2,
      panY: minY - margin - (ch / zoom - h) / 2,
      zoom,
    });
  };

  useEffect(() => {
    themeRef.current = schematicTheme();
    const sync = () => {
      themeRef.current = schematicTheme();
      drawRef.current();
    };
    const obs = new MutationObserver(sync);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class'],
    });
    const size = () => {
      const c = canvasRef.current;
      const box = containerRef.current;
      if (c && box) {
        const dpr = window.devicePixelRatio || 1;
        c.width = Math.round(box.clientWidth * dpr);
        c.height = Math.round(box.clientHeight * dpr);
        drawRef.current();
      }
    };
    const ro = new ResizeObserver(size);
    if (containerRef.current) ro.observe(containerRef.current);
    // Re-size the backing store when the devicePixelRatio changes (monitor
    // move, browser zoom); each match is one-shot, so re-arm per change.
    let mq: MediaQueryList | null = null;
    const watchDpr = () => {
      mq?.removeEventListener('change', onDprChange);
      mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      mq.addEventListener('change', onDprChange);
    };
    const onDprChange = () => {
      size();
      watchDpr();
    };
    watchDpr();
    return () => {
      obs.disconnect();
      ro.disconnect();
      mq?.removeEventListener('change', onDprChange);
    };
  }, []);

  // Continuous run: advance sim time each frame while running.
  useEffect(() => {
    if (!running) return;
    let raf = 0;
    const tick = () => {
      store.getState().pump(400);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [running, store]);

  const fitRef = useRef(fitView);
  fitRef.current = fitView;

  // A different tab is a different circuit: fit it instead of keeping the
  // previous tab's viewport.
  useEffect(() => {
    fitRef.current();
  }, [activeTabId]);

  // An explicit Home request (opening a bundled example, which ships no
  // meaningful camera). Skipped on the first render, where the tab effect
  // above has already fitted.
  const fitRequest = useCircuitStore((s) => s.fitRequest);
  const lastFit = useRef(fitRequest);
  useEffect(() => {
    if (lastFit.current === fitRequest) return;
    lastFit.current = fitRequest;
    fitRef.current();
  }, [fitRequest]);

  const updateGhostPose = () => {
    const cur = ghostRef.current.current?.proposal;
    if (!cur) return;
    const pose = ghostPoseRef.current;
    ghostRef.current.update({ ...cur, rot: pose.rot, mirror: pose.mirror });
    drawRef.current();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const s = store.getState();
      s.clearTransientError();
      // View-only: same strict top-of-handler delegation bubble mode uses. Only
      // the three keys that drive the board rather than change it survive.
      if (viewOnlyRef.current) {
        if (e.key === 'Home') {
          e.preventDefault();
          fitRef.current();
        } else if (e.key === ' ') {
          e.preventDefault();
          s.power();
        } else if (e.key === '.') {
          s.step();
        }
        return;
      }
      // Bubble-push mode: ALL keyboard input routes to the push controller
      // before any editor branch below can see it (the M4.2 Ctrl+click
      // lesson: an unguarded earlier branch silently intercepting events).
      if (s.mode === 'bubble') {
        handleBubbleKey(e);
        return;
      }
      if (e.key === 'b' || e.key === 'B') {
        s.enterBubbleMode();
        return;
      }
      if (e.key === 'Home') {
        e.preventDefault();
        fitRef.current();
      } else if (e.key === ' ') {
        e.preventDefault();
        s.power();
      } else if (e.key === '.') {
        s.step();
        return;
      }
      // Keys act on the hovered item when one is under the cursor, else the
      // selection (KiCad precedence).
      const hoverIds = hoverItemRef.current ? new Set([hoverItemRef.current]) : undefined;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        s.deleteSelection(hoverIds, resolveWireEnd);
        hoverItemRef.current = null;
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'x' || e.key === 'X')) {
        e.preventDefault();
        s.deleteWithHeal(hoverIds, resolveWireEnd);
        hoverItemRef.current = null;
      } else if (e.key === 'r' || e.key === 'R') {
        if (s.tool.kind === 'place') {
          const pose = ghostPoseRef.current;
          pose.rot = ((pose.rot + 90) % 360) as NonNullable<Component['rot']>;
          updateGhostPose();
        } else if (e.shiftKey) {
          const sel = s.selection.size > 0 ? s.selection : (hoverIds ?? new Set<string>());
          applyGroupRotateFromSelection(sel);
        } else {
          const sel = hoverIds ?? s.selection;
          rotateSelectionIndividually(sel);
        }
      } else if (e.key === 'm' || e.key === 'M') {
        if (s.tool.kind === 'place') {
          ghostPoseRef.current.mirror = !ghostPoseRef.current.mirror;
          updateGhostPose();
        } else s.mirrorSelection(hoverIds);
      } else if (e.key === 'n' || e.key === 'N') {
        // Bubble<->NOT convert works outside bubble mode too (a literal 'not'
        // becomes a bare inline bubble marker and back).
        s.convertBubble(hoverIds, convertReanchor, bubbleGeom());
      } else if (e.key === 'w' || e.key === 'W') {
        // P2.3: hovering a free pin starts the wire immediately, no extra
        // click needed -- same shape a Select-mode pin press already produces.
        const theme = themeRef.current;
        const circuit = s.activeCircuit();
        const pinHit =
          theme && !s.powered
            ? nearestFree(
                collectPinTargets(circuit.components, circuit.wires, theme, s.chipLib),
                lastMouseWorldRef.current,
                hitScale(theme),
                MIN_HIT_RADIUS,
              )
            : undefined;
        // Always arm the wire tool, even when a hovered pin also starts the
        // wire immediately below -- onPointerDown checks tool.kind === 'place'
        // before it ever looks at a pending wiringRef, so pressing W while
        // still in place mode (e.g. right after placing something the mouse
        // is still hovering) silently dropped the pending wire on the next
        // click and placed another copy instead.
        s.setTool({ kind: 'wire' });
        if (pinHit) {
          setWiringStart(pinHit);
          wireBendsRef.current = [];
          setHoverPin(pinHit.worldPos);
        }
      } else if (e.key === 'j' || e.key === 'J') {
        // P2.3: hovering a wire crossing places the (now dual-splitting, per
        // P0.1) junction immediately instead of only arming the tool.
        const theme = themeRef.current;
        const before = s.activeCircuit().junctions.length;
        if (theme) s.addJunction(lastMouseWorldRef.current, theme.gridSchematic, resolveWireEnd);
        if (!theme || s.activeCircuit().junctions.length === before)
          s.setTool({ kind: 'junction' });
      } else if (e.key === 'l' || e.key === 'L') {
        s.setTool({ kind: 'lasso' });
      } else if ((e.key === 'c' || e.key === 'C') && !e.ctrlKey && !e.metaKey) {
        // Plain C enters the wire-cut tool; Ctrl/Cmd+C is reserved for copy.
        s.setTool({ kind: 'cut' });
      } else if (e.key === 'f' || e.key === 'F') {
        const targetId = hoverItemRef.current;
        const isComponent = targetId && s.activeCircuit().components.some((c) => c.id === targetId);
        if (isComponent && e.shiftKey) {
          setPrecisePicker({ targetId });
        } else if (isComponent && s.selection.size > 0) {
          const pairs = computeSmartConnect(targetId, 0);
          if (pairs.length > 0) {
            setSmartConnect({ targetId, rotation: 0, pairs });
            drawRef.current();
          } else {
            store.setState({ error: smartConnectFailureReason(targetId, s.selection) });
          }
        } else if (!targetId && s.selection.size > 1) {
          // P1.5: no hover target -- resolve source/target roles from the
          // selection alone.
          const pairs = computeSmartConnect(undefined, 0);
          if (pairs.length > 0) {
            setSmartConnect({ targetId: undefined, rotation: 0, pairs });
            drawRef.current();
          } else {
            store.setState({ error: smartConnectFailureReason(undefined, s.selection) });
          }
        }
      } else if (e.key === 'd' || e.key === 'D') {
        // P2.3: falls back to the hovered item when nothing is selected,
        // mirroring the Del/Ctrl+X/R/M hover-scoped pattern above.
        const dupSel = s.selection.size > 0 ? s.selection : hoverIds;
        if (e.shiftKey) startDuplicate(dupSel);
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
        copySelection(hoverIds);
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
        pasteClipboard();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'g' || e.key === 'G')) {
        // Ctrl+G / Ctrl+Shift+G, not a bare letter: the single-key grammar is
        // spoken for by the tools, and grouping is the same pair everywhere.
        e.preventDefault();
        if (e.shiftKey) s.ungroupSelection();
        else void s.groupSelection();
      } else if (e.key === 'Enter' && smartConnectRef.current) {
        commitSmartConnect();
      } else if (e.key === 'Enter' && duplicateRef.current) {
        const dup = duplicateRef.current;
        duplicateRef.current = null;
        s.commitDuplicate(dup.base, dup.offset);
        drawRef.current();
      } else if (e.key === 'Escape') {
        cancelPending();
      } else if (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_') {
        // Plain `=`/`-` adjust pin count; `+`/`_` adjust width. On a US
        // keyboard `+` is Shift+`=` and `_` is Shift+`-`, so e.shiftKey can't
        // be read reliably off the `+`/`_` glyphs themselves -- it's only a
        // secondary signal for non-US layouts where a shifted `=`/`-` might
        // not produce the `+`/`_` glyph at all.
        const isWidthKey =
          e.key === '+' || e.key === '_' || (e.shiftKey && (e.key === '=' || e.key === '-'));
        const delta = (e.key === '-' || e.key === '_' ? -1 : 1) as 1 | -1;
        if (s.tool.kind === 'place') {
          // Adjust a pending placement ghost's size-like param -- same kinds
          // and clamps as the on-board shortcut below, just mutating the
          // tool/ghost instead of a placed component (nothing to rewire yet).
          const kind = s.tool.componentKind;
          const p = s.tool.params;
          let next: Record<string, ParamValue> | null = null;
          if (isWidthKey) {
            if (isWidthCapable(kind, (p ?? {}) as Params)) {
              const cur = Number(p?.['width'] ?? 1);
              const v = clampWidth(cur + delta, MAX_WIDTH);
              if (v !== cur) next = { width: v };
            }
          } else if (VARIABLE_ARITY_GATES.has(kind)) {
            const cur = Number(p?.['inputs'] ?? 2);
            const v = Math.min(8, Math.max(2, cur + delta));
            if (v !== cur) next = { inputs: v };
          } else if (
            kind === 'mux' ||
            kind === 'demux' ||
            kind === 'decoder' ||
            kind === 'encoder'
          ) {
            const key = kind === 'mux' || kind === 'demux' ? 'selectBits' : 'addressBits';
            const cur = Number(p?.[key] ?? 2);
            const v = Math.min(4, Math.max(1, cur + delta));
            if (v !== cur) next = { [key]: v };
          }
          if (!next) return;
          s.setTool({ ...s.tool, params: { ...p, ...next } });
          const g = ghostRef.current.current?.proposal;
          if (g) {
            ghostRef.current.update({ ...g, params: { ...g.params, ...next } });
            drawRef.current();
          }
        } else {
          // Selection wins; hover is only the fallback when nothing is
          // selected (Task 3) -- opposite of R/M/Del's hover-first
          // precedence just above, deliberately, per the owner's decision.
          const targetIds =
            s.selection.size > 0
              ? [...s.selection]
              : hoverItemRef.current
                ? [hoverItemRef.current]
                : [];
          if (targetIds.length === 0) return;
          const circuit = s.activeCircuit();
          const specs: { id: string; params: Record<string, ParamValue> }[] = [];
          for (const id of targetIds) {
            const comp = circuit.components.find((c) => c.id === id);
            if (!comp) continue;
            const params = (comp.params ?? {}) as Params;
            if (isWidthKey) {
              if (!isWidthCapable(comp.kind, params)) continue; // silently skip, no error/flash
              const cur = Number(params['width'] ?? 1);
              const v = clampWidth(cur + delta, MAX_WIDTH);
              if (v !== cur) specs.push({ id, params: { width: v } });
            } else {
              const key = VARIABLE_ARITY_GATES.has(comp.kind)
                ? 'inputs'
                : comp.kind === 'mux' || comp.kind === 'demux'
                  ? 'selectBits'
                  : comp.kind === 'decoder' || comp.kind === 'encoder'
                    ? 'addressBits'
                    : null;
              if (!key) continue;
              const cur = Number(params[key] ?? 2);
              const v = clampParamValue(comp.kind, key, cur + delta);
              if (v !== null && v !== cur) specs.push({ id, params: { [key]: v } });
            }
          }
          if (specs.length > 0) s.setComponentParamsBatch(specs);
        }
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store]);

  const toWorld = (e: React.PointerEvent): Vec2 => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return screenToWorld(viewportRef.current, {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
  };

  const beginPan = (e: React.PointerEvent) => {
    panMovedRef.current = false;
    const vp = viewportRef.current;
    panRef.current = {
      startClient: { x: e.clientX, y: e.clientY },
      startPan: { x: vp.panX, y: vp.panY },
    };
    (e.target as Element).setPointerCapture(e.pointerId);
  };

  // M4.5: the duplicate/paste ghost's offset formula -- top-left of the
  // copied group's own (unmoved) bounding box, so the ghost's group top-left
  // lands exactly at the grid-snapped cursor, matching the place tool's
  // ghost exactly for a single component.
  const groupTopLeft = (base: Circuit): Vec2 => {
    const xs = [...base.components.map((c) => c.pos.x), ...base.junctions.map((j) => j.pos.x)];
    const ys = [...base.components.map((c) => c.pos.y), ...base.junctions.map((j) => j.pos.y)];
    if (xs.length === 0) return { x: 0, y: 0 };
    return { x: Math.min(...xs), y: Math.min(...ys) };
  };
  const computeDupOffset = (base: Circuit, cursorWorld: Vec2, grid: number): Vec2 => {
    const gtl = groupTopLeft(base);
    const snapped = {
      x: Math.round(cursorWorld.x / grid) * grid,
      y: Math.round(cursorWorld.y / grid) * grid,
    };
    return { x: snapped.x - gtl.x, y: snapped.y - gtl.y };
  };

  const resolveWireEnd = (end: WireEnd): Vec2 | undefined => {
    const st = store.getState();
    const theme = themeRef.current!;
    if (end.kind === 'pin') {
      const comp = st.activeCircuit().components.find((c) => c.id === end.component);
      if (!comp) return undefined;
      const def = comp.defId ? st.chipLib.get(comp.defId) : undefined;
      return symbolBounds(comp, theme, def).pins.get(end.pin);
    }
    if (end.kind === 'junction')
      return st.activeCircuit().junctions.find((j) => j.id === end.junction)?.pos;
    return end.pos; // 'free' and 'tap' both carry their own click point
  };

  // --- Bubble-push mode (M5 fold-in) ---

  // Live pin geometry for the transform core (A4: spliced markers land on
  // the actual wire span, not a gate's own pos).
  const bubbleGeom = (): TransformGeom => ({
    resolvePin: (componentId, pin) => {
      const st = store.getState();
      const comp = st.activeCircuit().components.find((c) => c.id === componentId);
      if (!comp) return undefined;
      const def = comp.defId ? st.chipLib.get(comp.defId) : undefined;
      return symbolBounds(comp, themeRef.current!, def).pins.get(pin);
    },
    grid: themeRef.current!.gridSchematic,
    anchorNot: (mid, spanA, spanB) => {
      // Same math as insert-on-wire: shift the top-left pos so the NOT's pin
      // centerline rides the wire line instead of hanging half a body below.
      const theme = themeRef.current!;
      const pins = symbolBounds(
        { id: '__not', kind: 'buf', pos: { x: 0, y: 0 }, params: { outputBubble: true } },
        theme,
      ).pins;
      const pinIn = pins.get('a');
      const pinOut = pins.get('y');
      return pinIn && pinOut
        ? alignSplicePos(mid, spanA, spanB, pinIn, pinOut, theme.gridSchematic)
        : mid;
    },
    // The on-screen route, so a spliced NOT rides the wire's real leg (the
    // straight a->b span misplaces it on any elbowed/detoured wire).
    routeWire: (wireId) => computeRoutes().get(wireId),
  });

  interface WorldAnchor {
    pin: string;
    side: 'input' | 'output';
    center: Vec2;
    r: number;
  }

  // World-space bubble anchors for a (base-form) gate, via the shared glyph
  // module's own accessor -- draw and hit-test share one geometry (A3).
  const gateAnchorsWorld = (c: Component): WorldAnchor[] => {
    // A wide (width>1) gate never exposes a bubble anchor at all -- no drag
    // can start on/land on it, and it never becomes a Tab-focus stop.
    if (!isBubbleEligibleGate(c)) return [];
    const theme = themeRef.current!;
    const params = (c.params ?? {}) as NonNullable<Parameters<typeof primitivePins>[1]>;
    const placement = { pos: c.pos, rot: c.rot, mirror: c.mirror };
    const input = { kind: c.kind, params, pins: primitivePins(c.kind, params) };
    if (isBareBubble(input)) {
      const geo = bareBubbleGeometry(theme);
      const g = theme.gridSchematic;
      const t = transformGeometry(
        { bounds: geo.bounds, pins: new Map([['y', { x: g, y: g }]]) },
        placement,
      );
      // Both anchors share the marker's single visual bubble; bubbledAnchors'
      // state filter keeps whichever side actually carries the inversion, so
      // an input-form marker (bubble pushed to its own 'a') stays draggable.
      const center = t.pins.get('y')!;
      return [
        { pin: 'y', side: 'output', center, r: g / 2 },
        { pin: 'a', side: 'input', center, r: g / 2 },
      ];
    }
    const layout = gateLayout(c.kind as GateKind, input, theme);
    const anchors = bubbleAnchors(layout);
    const t = transformGeometry(
      { bounds: layout.bounds, pins: new Map(anchors.map((a) => [a.pin, a.center])) },
      placement,
    );
    return anchors.map((a) => ({
      pin: a.pin,
      side: a.pin === layout.outputName ? 'output' : 'input',
      center: t.pins.get(a.pin)!,
      r: a.r,
    }));
  };

  const gateCenterWorld = (c: Component): Vec2 => {
    const b = symbolBounds(c, themeRef.current!).bounds;
    return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  };

  // Anchors currently carrying a bubble -- the only grabbable ones.
  const bubbledAnchors = (c: Component): WorldAnchor[] => {
    const inputs = getInputBubbles(c);
    return gateAnchorsWorld(c).filter((a) =>
      a.side === 'output' ? getOutputBubble(c) : inputs.has(a.pin),
    );
  };

  const bubbleFocusOverlay = ():
    | { kind: 'point'; pos: Vec2 }
    | { kind: 'wire'; wireId: string }
    | { kind: 'rect'; rect: { x: number; y: number; w: number; h: number } }
    | undefined => {
    const f = store.getState().bubbleFocus;
    if (!f) return undefined;
    if (f.kind === 'wire') return { kind: 'wire', wireId: f.wireId };
    const comp = store
      .getState()
      .activeCircuit()
      .components.find((c) => c.id === f.component);
    if (!comp) return undefined;
    if (f.kind === 'body')
      return { kind: 'rect', rect: symbolBounds(comp, themeRef.current!).bounds };
    const anchor = gateAnchorsWorld(comp).find((a) => a.pin === f.pin && a.side === f.side);
    return anchor ? { kind: 'point', pos: anchor.center } : undefined;
  };

  const clearBubbleReject = () => {
    if (bubbleRejectTimerRef.current) {
      clearTimeout(bubbleRejectTimerRef.current);
      bubbleRejectTimerRef.current = null;
    }
  };

  // True when the gate carries a cancelling inversion at that terminal: an
  // input bubble on `pin`, or -- for its 'a' input -- the whole gate being a
  // bare NOT/marker (buf + output bubble only).
  const cancelsAt = (c: Component, pin: string): boolean => {
    if (!isBubbleEligibleGate(c)) return false;
    if (getInputBubbles(c).has(pin)) return true;
    return pin === 'a' && c.kind === 'buf' && getOutputBubble(c) && getInputBubbles(c).size === 0;
  };

  const buildPushMove = (drag: BubbleDragState, dir: 'toward' | 'away'): PushMove | null => {
    if (drag.body && dir === 'toward') {
      // Body dragged at its upstream driver: absorb when the inverter is the
      // driver's sole consumer, else the junction merge. Pre-test the merge:
      // an identity relocation must show NO preview, not a naive red-flash.
      const c = store.getState().activeCircuit();
      if (absorbInverterIntoDriver(c, drag.gateId))
        return { kind: 'absorbInverter', inverterId: drag.gateId };
      return mergeInversionsUpstream(c, { inverter: drag.gateId })
        ? { kind: 'mergeUpstream', from: { inverter: drag.gateId } }
        : null;
    }
    if (dir === 'toward') {
      if (drag.side === 'output') {
        // A standalone inverter's own bubble dragged back against an
        // inverted upstream driver cancels both units right away (only a
        // full NOT receiving a bubble stages the double-negation); a plain
        // upstream keeps the staging push through the body.
        const c = store.getState().activeCircuit();
        const src = c.components.find((x) => x.id === drag.gateId);
        if (src && isStandaloneInverter(src)) {
          const feeders = connectedPins(c, { component: drag.gateId, pin: 'a' });
          const d = feeders.find((p) => p.pin === 'y');
          const dc = d ? c.components.find((x) => x.id === d.component) : undefined;
          const upstreamInverted =
            !!dc &&
            isBubbleEligibleGate(dc) &&
            (getOutputBubble(normalizeGateComponent(dc)) || isStandaloneInverter(dc));
          if (upstreamInverted && absorbInverterIntoDriver(c, drag.gateId))
            return { kind: 'absorbInverter', inverterId: drag.gateId };
        }
        return { kind: 'outputBackward', gateId: drag.gateId };
      }
      return { kind: 'inputsForward', gateId: drag.gateId };
    }
    // Away along the wire. Cancellation is an explicit gesture: dragging a
    // bubble onto a facing bubble annihilates the pair; otherwise an output
    // bubble relocates across fan-out as before, and an input bubble has
    // nowhere to go.
    const circuit = store.getState().activeCircuit();
    if (drag.side === 'output') {
      const consumers = connectedPins(circuit, { component: drag.gateId, pin: 'y' });
      if (consumers.length === 1) {
        const t = consumers[0]!;
        const tc = circuit.components.find((c) => c.id === t.component);
        if (tc && cancelsAt(tc, t.pin))
          return { kind: 'annihilate', driverId: drag.gateId, consumer: t };
      }
      // Identity guard: a lone inverter relocating toward a SINGLE non-gate
      // consumer would just mint another NOT; show no preview at all (same
      // feel as dragDirection 'none'). With 2+ consumers the push duplicates
      // the inverter per branch. The transform-level null is the backstop.
      const src = circuit.components.find((c) => c.id === drag.gateId);
      const anyGateConsumer = consumers.some(({ component }) => {
        const cc = circuit.components.find((c) => c.id === component);
        return !!cc && isBubbleEligibleGate(cc);
      });
      if (src && isStandaloneInverter(src) && !anyGateConsumer && consumers.length === 1)
        return null;
      return { kind: 'outputAcrossFanout', gateId: drag.gateId };
    }
    const feeders = connectedPins(circuit, { component: drag.gateId, pin: drag.pin });
    const driver = feeders.find((p) => p.pin === 'y');
    if (driver) {
      const dc = circuit.components.find((c) => c.id === driver.component);
      const consumers = connectedPins(circuit, { component: driver.component, pin: 'y' });
      // True pairwise cancel only when this pin is the bubbled driver's sole
      // consumer -- with fan-out the driver's bubble belongs to every branch
      // and cancelling it here would strand the siblings (red-flash lock).
      if (dc && isBubbleEligibleGate(dc) && getOutputBubble(dc) && consumers.length === 1)
        return {
          kind: 'annihilate',
          driverId: driver.component,
          consumer: { component: drag.gateId, pin: drag.pin },
        };
      const comp = circuit.components.find((c) => c.id === drag.gateId);
      const bufForm = !!comp && normalizeGateComponent(comp).kind === 'buf';
      // A standalone inverter's input bubble dragged toward the driver acts
      // on the WHOLE unit, same as a body drag: absorb into a gate driver,
      // else merge; an identity relocation shows no preview at all.
      if (bufForm) {
        if (absorbInverterIntoDriver(circuit, drag.gateId))
          return { kind: 'absorbInverter', inverterId: drag.gateId };
        return mergeInversionsUpstream(circuit, { inverter: drag.gateId })
          ? { kind: 'mergeUpstream', from: { inverter: drag.gateId } }
          : null;
      }
      // Short drag onto the pin's own wire re-materializes the bubble as a
      // NOT there; a drag reaching the fan-out pole (junction or driver pin)
      // resolves the whole net via the junction merge. Keyboard has no drag
      // distance and always merges.
      const pole = inputFanPole({ component: drag.gateId, pin: drag.pin });
      const nearPole =
        drag.keyboard ||
        !pole ||
        Math.hypot(drag.cursor.x - pole.x, drag.cursor.y - pole.y) <
          Math.hypot(drag.cursor.x - drag.anchor.x, drag.cursor.y - drag.anchor.y);
      if (!nearPole)
        return { kind: 'materializeNot', at: { component: drag.gateId, pin: drag.pin } };
    }
    // Re-merge a fan-out split into one NOT upstream (or cancel into an
    // inverted driver); a failure red-flashes via the naive attempt.
    return { kind: 'mergeUpstream', from: { component: drag.gateId, pin: drag.pin } };
  };

  const isBareMarker = (c: Component): boolean =>
    c.kind === 'buf' && c.params?.['bubbleOnly'] === true;

  // Keeps the world 'a' pin fixed across a NOT<->bare-marker convert: the two
  // glyphs differ in size, so an unadjusted pos leaves the marker floating
  // off the wire line instead of sitting at the old input.
  const convertReanchor = (
    before: Component,
    after: Component,
  ): { x: number; y: number } | undefined => {
    const theme = themeRef.current;
    if (!theme) return undefined;
    const a0 = symbolBounds(before, theme).pins.get('a');
    const a1 = symbolBounds(after, theme).pins.get('a');
    return a0 && a1
      ? { x: after.pos.x + (a0.x - a1.x), y: after.pos.y + (a0.y - a1.y) }
      : undefined;
  };

  // The fan-out pole an input-side backward drag is heading for: the far end
  // of the pin's own wire (a junction dot, or the driver pin itself).
  const inputFanPole = (at: { component: string; pin: string }): Vec2 | undefined => {
    const circuit = store.getState().activeCircuit();
    const isAt = (e: Wire['a']) =>
      e.kind === 'pin' && e.component === at.component && e.pin === at.pin;
    const w = circuit.wires.find((w) => isAt(w.a) || isAt(w.b));
    if (!w) return undefined;
    return resolveWireEnd(isAt(w.a) ? w.b : w.a);
  };

  const onBubblePointerDown = (e: React.PointerEvent) => {
    if (e.shiftKey) {
      beginPan(e);
      return;
    }
    const world = toWorld(e);
    const st = store.getState();
    clearBubbleReject();
    if (st.bubblePreview && !st.bubblePreview.result.legal) st.clearBubblePreview();
    if (st.bubblePairMode) {
      const wh = wireAt(world);
      if (wh)
        st.commitBubbleMove({ kind: 'pairInsert', wireId: wh.wire.id, pos: world }, bubbleGeom());
      return;
    }
    // Fat 12px screen-space target on every bubble currently drawn.
    const radius = MIN_HIT_RADIUS / viewportRef.current.zoom;
    let best: { comp: Component; a: WorldAnchor; d: number } | undefined;
    for (const c of st.activeCircuit().components) {
      for (const a of bubbledAnchors(c)) {
        const d = Math.hypot(a.center.x - world.x, a.center.y - world.y);
        if (d <= Math.max(radius, a.r * 2) && (!best || d < best.d)) best = { comp: c, a, d };
      }
    }
    if (best) {
      bubbleDragRef.current = {
        gateId: best.comp.id,
        pin: best.a.pin,
        side: best.a.side,
        anchor: best.a.center,
        // A bare marker's bubble IS its center, so direction against the body
        // center never resolves; its 'toward' pole is upstream along the wire.
        gateCenter: isBareMarker(best.comp)
          ? (inverterTowardPole(best.comp.id) ?? gateCenterWorld(best.comp))
          : gateCenterWorld(best.comp),
        awayPole: isBareMarker(best.comp)
          ? inputFanPole({ component: best.comp.id, pin: 'y' })
          : undefined,
        cursor: world,
        d: best.a.r,
      };
      st.setBubbleFocus({
        kind: 'terminal',
        component: best.comp.id,
        pin: best.a.pin,
        side: best.a.side,
      });
      (e.target as Element).setPointerCapture(e.pointerId);
      return;
    }
    // No bubble anchor hit: a standalone inverter's whole body is a second,
    // bigger handle (bubble anchors keep hit precedence over bodies).
    for (const c of st.activeCircuit().components) {
      if (!isStandaloneInverter(c)) continue;
      const bb = symbolBounds(c, themeRef.current!).bounds;
      if (world.x < bb.x || world.x > bb.x + bb.w || world.y < bb.y || world.y > bb.y + bb.h)
        continue;
      const driverCenter = inverterTowardPole(c.id);
      if (!driverCenter) continue;
      bubbleDragRef.current = {
        gateId: c.id,
        pin: 'y',
        side: 'output',
        anchor: gateCenterWorld(c),
        gateCenter: driverCenter,
        awayPole: inputFanPole({ component: c.id, pin: 'y' }),
        cursor: world,
        d: MIN_HIT_RADIUS / viewportRef.current.zoom,
        body: true,
      };
      st.setBubbleFocus({ kind: 'body', component: c.id });
      (e.target as Element).setPointerCapture(e.pointerId);
      return;
    }
    st.setBubbleFocus(null);
  };

  // Upstream gate-family driver's body center for a standalone inverter --
  // the 'toward' pole of a body drag.
  const inverterDriverCenter = (id: string): Vec2 | undefined => {
    const circuit = store.getState().activeCircuit();
    const feeders = connectedPins(circuit, { component: id, pin: 'a' });
    const d = feeders.find((p) => {
      if (p.pin !== 'y') return false;
      const dc = circuit.components.find((c) => c.id === p.component);
      return !!dc && isBubbleEligibleGate(dc);
    });
    const dc = d ? circuit.components.find((c) => c.id === d.component) : undefined;
    return dc ? gateCenterWorld(dc) : undefined;
  };

  // 'Toward' pole for arming a body drag: the gate-family driver's center
  // when one exists, else the near end of the inverter's own input wire (a
  // junction, a switch pin, ...) -- a NOT fed by a non-gate must still be
  // draggable AWAY; the toward move just resolves to null there.
  const inverterTowardPole = (id: string): Vec2 | undefined => {
    const direct = inverterDriverCenter(id);
    if (direct) return direct;
    return inputFanPole({ component: id, pin: 'a' });
  };

  const onBubblePointerMove = (e: React.PointerEvent) => {
    const world = toWorld(e);
    const drag = bubbleDragRef.current;
    if (!drag) {
      // Hover tracking so N (bubble<->NOT) can act on the gate under the cursor.
      hoverItemRef.current = topComponentAt(world)?.id ?? null;
      return;
    }
    drag.cursor = world;
    const st = store.getState();
    const dir = dragDirectionPoles(drag.anchor, drag.gateCenter, drag.awayPole, world);
    const move = dir === 'none' ? null : buildPushMove(drag, dir);
    const cur = st.bubblePreview;
    if (move) {
      if (!cur || JSON.stringify(cur.move) !== JSON.stringify(move))
        st.previewBubbleMove(move, bubbleGeom());
    } else if (cur) {
      st.clearBubblePreview();
    }
    draw();
  };

  const onBubblePointerUp = () => {
    const drag = bubbleDragRef.current;
    if (!drag) return;
    bubbleDragRef.current = null;
    const st = store.getState();
    const pv = st.bubblePreview;
    if (pv && pv.result.legal) {
      st.commitBubbleMove(pv.move, bubbleGeom());
    } else if (pv) {
      // Failed drag: the red ghost + differing rows decay after ~1.5s (spec).
      clearBubbleReject();
      bubbleRejectTimerRef.current = setTimeout(() => {
        bubbleRejectTimerRef.current = null;
        store.getState().clearBubblePreview();
      }, 1500);
    }
    draw();
  };

  const handleBubbleKey = (e: KeyboardEvent) => {
    const s = store.getState();
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) s.redo();
      else s.undo();
    } else if (e.key === 'Home') {
      e.preventDefault();
      fitRef.current();
    } else if (e.key === 'b' || e.key === 'B') {
      s.exitBubbleMode();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      s.setBubbleFocus(nextFocus(s.board, s.bubbleFocus, e.shiftKey ? -1 : 1, s.bubblePairMode));
    } else if (e.key === 'Escape') {
      clearBubbleReject();
      s.clearBubblePreview();
      s.setBubbleFocus(null);
    } else if (e.key === 'n' || e.key === 'N') {
      const f = s.bubbleFocus;
      const id = hoverItemRef.current ?? (f && f.kind === 'terminal' ? f.component : undefined);
      if (id) s.convertBubble(new Set([id]), convertReanchor, bubbleGeom());
    } else if (e.key === 'Enter') {
      const pv = s.bubblePreview;
      if (pv && pv.result.legal) {
        clearBubbleReject();
        s.commitBubbleMove(pv.move, bubbleGeom());
        return;
      }
      const f = s.bubbleFocus;
      if (f && f.kind === 'wire' && s.bubblePairMode) {
        const w = s.board.wires.find((x) => x.id === f.wireId);
        const a = w && resolveWireEnd(w.a);
        const b = w && resolveWireEnd(w.b);
        if (!w || !a || !b) return;
        s.commitBubbleMove(
          {
            kind: 'pairInsert',
            wireId: f.wireId,
            pos: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
          },
          bubbleGeom(),
        );
      }
    } else if (e.key.startsWith('Arrow')) {
      // Arrow toward the gate previews the push, exactly like a hover-drag;
      // the opposite arrow relocates an output bubble across fan-out.
      const f = s.bubbleFocus;
      if (!f || f.kind === 'wire') return;
      e.preventDefault();
      const comp = s.board.components.find((c) => c.id === f.component);
      if (!comp) return;
      if (f.kind === 'body') {
        // Arrow toward the upstream driver previews absorb; the opposite
        // arrow previews the away move, same as a body drag.
        const bodyCenter = gateCenterWorld(comp);
        const driverCenter = inverterTowardPole(comp.id);
        if (!driverCenter) return;
        const toward = nearestArrowKey(bodyCenter, driverCenter);
        if (!toward) return;
        const key = e.key as ArrowKey;
        const pseudoDrag: BubbleDragState = {
          gateId: comp.id,
          pin: 'y',
          side: 'output',
          anchor: bodyCenter,
          gateCenter: driverCenter,
          cursor: bodyCenter,
          d: MIN_HIT_RADIUS,
          body: true,
          keyboard: true,
        };
        const move =
          key === toward
            ? buildPushMove(pseudoDrag, 'toward')
            : key === oppositeArrow(toward)
              ? buildPushMove(pseudoDrag, 'away')
              : null;
        if (move) {
          clearBubbleReject();
          s.previewBubbleMove(move, bubbleGeom());
        }
        return;
      }
      const anchor = gateAnchorsWorld(comp).find((a) => a.pin === f.pin && a.side === f.side);
      if (!anchor) return;
      const pole = isBareMarker(comp)
        ? (inverterTowardPole(comp.id) ?? gateCenterWorld(comp))
        : gateCenterWorld(comp);
      const toward = nearestArrowKey(anchor.center, pole);
      if (!toward) return;
      const key = e.key as ArrowKey;
      const pseudoDrag: BubbleDragState = {
        gateId: comp.id,
        pin: f.pin,
        side: f.side,
        anchor: anchor.center,
        gateCenter: pole,
        cursor: anchor.center,
        d: anchor.r,
        keyboard: true,
      };
      const move =
        key === toward
          ? buildPushMove(pseudoDrag, 'toward')
          : key === oppositeArrow(toward)
            ? buildPushMove(pseudoDrag, 'away')
            : null;
      if (move) {
        clearBubbleReject();
        s.previewBubbleMove(move, bubbleGeom());
      }
    }
  };

  // M4.5: single source of truth for every wire's on-screen route, shared by
  // every hit-test below -- computed fresh from the live store each call
  // (cheap at this app's circuit sizes), so it can never drift from what
  // editorScene.ts's draw loop rendered from the exact same inputs (the
  // M4.2 follow-up "route-consistency bug": a private per-call route here
  // used to check a different, invisible path than the one on screen).
  const computeRoutes = (): Map<string, Vec2[]> => {
    const st = store.getState();
    const theme = themeRef.current!;
    const circuit = st.activeCircuit();
    const boundsById = new Map(
      circuit.components.map((c) => [
        c.id,
        symbolBounds(c, theme, c.defId ? st.chipLib.get(c.defId) : undefined).bounds,
      ]),
    );
    return computeWireRoutes(circuit.wires, resolveWireEnd, boundsById, theme.gridSchematic);
  };

  const wireAt = (world: Vec2): { wire: Wire; seg: number } | undefined => {
    const st = store.getState();
    // Tight (not a fat point-target): must not swallow a parallel wire one
    // grid unit over.
    const radius = WIRE_BODY_HIT_RADIUS / viewportRef.current.zoom;
    const routes = computeRoutes();
    let best: { wire: Wire; seg: number; d: number } | undefined;
    for (const wire of st.activeCircuit().wires) {
      const pts = routes.get(wire.id);
      if (!pts) continue;
      for (let i = 0; i < pts.length - 1; i++) {
        const proj = projectOntoSegment(world, pts[i]!, pts[i + 1]!);
        const d = Math.hypot(proj.x - world.x, proj.y - world.y);
        if (d <= radius && (!best || d < best.d)) best = { wire, seg: i, d };
      }
    }
    return best;
  };

  const beginWireDrag = (wire: Wire, seg: number, world: Vec2) => {
    const a = resolveWireEnd(wire.a);
    const b = resolveWireEnd(wire.b);
    if (!a || !b) return;
    const pts = computeRoutes().get(wire.id);
    if (!pts) return;
    const s0 = pts[seg]!;
    const s1 = pts[seg + 1]!;
    if (s0.x !== s1.x && s0.y !== s1.y) return; // diagonal segments don't drag
    const axis: 'h' | 'v' = s0.y === s1.y ? 'h' : 'v';
    const bends = pts.slice(1, -1).map((p) => ({ ...p }));
    let i = seg;
    // Endpoint-adjacent segments gain a bend at the endpoint so the endpoint
    // itself stays attached to its pin while the segment slides.
    if (i === 0) {
      bends.unshift({ ...pts[0]! });
      i = 1;
    }
    if (seg + 1 === pts.length - 1) bends.push({ ...pts[pts.length - 1]! });
    wireDragRef.current = {
      mode: 'segment',
      wireId: wire.id,
      bends,
      origBends: bends.map((p) => ({ ...p })),
      orig: [{ ...bends[i - 1]! }, { ...bends[i]! }],
      bi0: i - 1,
      pinA: { ...a },
      pinB: { ...b },
      axis,
      startWorld: world,
      moved: false,
    };
  };

  // Interior-vertex hit-test for a true corner drag (M4.3), checked before
  // the segment case in select mode -- clicking near a bend should grab the
  // corner itself, not the nearer of its two adjacent segments.
  const cornerAt = (world: Vec2): { wire: Wire; idx: number; displayPts: Vec2[] } | undefined => {
    const st = store.getState();
    const radius = MIN_HIT_RADIUS / viewportRef.current.zoom;
    const routes = computeRoutes();
    let best: { wire: Wire; idx: number; displayPts: Vec2[]; d: number } | undefined;
    for (const wire of st.activeCircuit().wires) {
      const pts = routes.get(wire.id);
      if (!pts) continue;
      for (let i = 1; i < pts.length - 1; i++) {
        const d = Math.hypot(pts[i]!.x - world.x, pts[i]!.y - world.y);
        if (d <= radius && (!best || d < best.d)) best = { wire, idx: i, displayPts: pts, d };
      }
    }
    return best;
  };

  const beginCornerDrag = (wire: Wire, idx: number, displayPts: Vec2[]) => {
    wireDragRef.current = {
      mode: 'corner',
      wireId: wire.id,
      bends: displayPts.slice(1, -1).map((p) => ({ ...p })),
      displayPts: displayPts.map((p) => ({ ...p })),
      cornerIdx: idx,
      moved: false,
    };
  };

  /** The id a press here would act on, in the precedence onPointerDown
   *  resolves handles by: component, then the wire NODES (junction, free end),
   *  then the bus label, then a bend vertex, then a plain segment. Touch needs
   *  it in two more places than the mouse does -- a tap selects with it, and
   *  the pan rule asks whether the press landed on something already selected
   *  -- and all three have to agree on what "the thing under here" means. */
  const handleIdAt = (world: Vec2): string | undefined => {
    const hit = topComponentAt(world);
    if (hit) return hit.id;
    const jh = junctionAt(world);
    if (jh) return jh.id;
    const fh = freeEndAt(world);
    if (fh) return fh.wire.id;
    const bl = busLabelAt(world);
    if (bl) return bl.id;
    const corner = cornerAt(world);
    if (corner) return corner.wire.id;
    return wireAt(world)?.wire.id;
  };

  const topComponentAt = (world: Vec2): Component | undefined => {
    const st = store.getState();
    const theme = themeRef.current!;
    const components = st.activeCircuit().components;
    for (let i = components.length - 1; i >= 0; i--) {
      const c = components[i]!;
      const def = c.defId ? st.chipLib.get(c.defId) : undefined;
      const geo = symbolBounds(c, theme, def);
      if (!rectContains(geo.bounds, world)) continue;
      if (!GATE_SHAPE_KINDS.has(c.kind)) return c;
      const params = (c.params as Record<string, ParamValue>) ?? {};
      const input = { kind: c.kind, params, pins: primitivePins(c.kind, params) };
      if (isBareBubble(input)) return c; // 2G square marker, bbox is already tight
      const layout = gateLayout(c.kind as GateKind, input, theme);
      const placement = { pos: c.pos, rot: c.rot, mirror: c.mirror };
      const localPt = worldToLocal(world, layout.bounds, placement);
      // Inside the bbox but outside the actual curve (e.g. an AND gate's
      // rounded corner gap): keep looking, don't claim the click -- it falls
      // through to whatever's actually drawn there (usually a wire).
      if (gateContainsLocalPoint(layout, localPt, layout.bubble)) return c;
    }
    return undefined;
  };

  const junctionAt = (world: Vec2): Junction | undefined => {
    const st = store.getState();
    const radius = MIN_HIT_RADIUS / viewportRef.current.zoom;
    let best: { j: Junction; d: number } | undefined;
    for (const j of st.activeCircuit().junctions) {
      const d = Math.hypot(j.pos.x - world.x, j.pos.y - world.y);
      if (d <= radius && (!best || d < best.d)) best = { j, d };
    }
    return best?.j;
  };

  // B3b: a wire's own dangling free end (no component/junction owns it) --
  // no hit-test existed for these at all before, so a free end could never
  // be dragged; the hollow marker (editorScene.ts) had to be reconnected by
  // redrawing a whole new wire onto it instead.
  const freeEndAt = (world: Vec2): { wire: Wire; end: 'a' | 'b' } | undefined => {
    const st = store.getState();
    const radius = MIN_HIT_RADIUS / viewportRef.current.zoom;
    let best: { wire: Wire; end: 'a' | 'b'; d: number } | undefined;
    for (const w of st.activeCircuit().wires) {
      for (const end of ['a', 'b'] as const) {
        const e = w[end];
        if (e.kind !== 'free') continue;
        const d = Math.hypot(e.pos.x - world.x, e.pos.y - world.y);
        if (d <= radius && (!best || d < best.d)) best = { wire: w, end, d };
      }
    }
    return best;
  };

  // A bus wire's own width badge, grabbable by either the slash or the number.
  // Only wires that actually draw one are candidates, so a 1-bit wire has no
  // invisible target sitting on it.
  const busLabelAt = (world: Vec2): Wire | undefined => {
    const st = store.getState();
    const circuit = st.activeCircuit();
    const theme = themeRef.current!;
    const radius = MIN_HIT_RADIUS / viewportRef.current.zoom;
    const routes = computeRoutes();
    let best: { wire: Wire; d: number } | undefined;
    for (const wire of circuit.wires) {
      const pts = routes.get(wire.id);
      if (!pts || pts.length < 2) continue;
      if (wireBusWidth(circuit, st.chipLib, wire) <= 1) continue;
      for (const p of busLabelHitPoints(pts, wire.busLabelT, theme.gridSchematic)) {
        const d = Math.hypot(p.x - world.x, p.y - world.y);
        if (d <= radius && (!best || d < best.d)) best = { wire, d };
      }
    }
    return best?.wire;
  };

  // Direction of the pin a wire end attaches to, when resolvable (used to
  // orient insert-on-wire so the spliced component's in/out match signal flow).
  const wireEndDir = (end: WireEnd): PinDir | undefined => {
    if (end.kind !== 'pin') return undefined;
    const st = store.getState();
    const comp = st.activeCircuit().components.find((c) => c.id === end.component);
    if (!comp) return undefined;
    if (comp.kind === 'chip') {
      const def = comp.defId ? st.chipLib.get(comp.defId) : undefined;
      return def?.pins.find((p) => p.name === end.pin)?.dir;
    }
    if (!hasPrimitive(comp.kind)) return undefined;
    return getPrimitive(comp.kind)
      .pins(comp.params ?? {})
      .find((p) => p.name === end.pin)?.dir;
  };

  // Every free pin a component contributes, in VISUAL reading order (4a): top
  // to bottom, then left to right -- not raw pin-declaration `order`, which
  // assumes a fixed layout that breaks the moment a gate is rotated 90/270
  // (its declared a/b order no longer matches which pin is visually left vs.
  // right). worldPos already reflects the component's actual rendered
  // rotation/mirror, so sorting by it is orientation-correct for any pose.
  const visualPinSort = (a: PinTarget, b: PinTarget): number =>
    a.worldPos.y - b.worldPos.y || a.worldPos.x - b.worldPos.x;
  const freeOutPins = (targets: PinTarget[], componentId: string): PinTarget[] =>
    targets.filter((t) => t.componentId === componentId && t.dir === 'out').sort(visualPinSort);
  const freeInPins = (targets: PinTarget[], componentId: string): PinTarget[] =>
    targets.filter((t) => t.componentId === componentId && t.dir === 'in').sort(visualPinSort);

  // Spatial priority for smart-connect matching: closest column (on `axis`)
  // to `ref` wins first (a switch column feeding a gate/mux several rows tall
  // should match top-to-bottom *within its own column*, not get interleaved
  // with an unrelated component that happens to share a coordinate on the
  // other axis), ties broken by ascending position on the other axis. `ref`
  // is the thing this group is wiring *to* -- the hovered target's position
  // for the hover case, or the opposite role group's mean position for the
  // no-hover multi-select case. `axis` is 'x' for a horizontal flow (default)
  // and 'y' for a vertical one (4a: a rotated gate whose free input pins
  // spread across x rather than y) -- orderByCloseness itself stays agnostic,
  // callers derive the axis from the target pins' own spread.
  const orderByCloseness = (comps: Component[], ref: number, axis: 'x' | 'y' = 'x'): Component[] =>
    [...comps].sort((a, b) => {
      const pa = axis === 'x' ? a.pos.x : a.pos.y;
      const pb = axis === 'x' ? b.pos.x : b.pos.y;
      const da = Math.abs(pa - ref);
      const db = Math.abs(pb - ref);
      if (da !== db) return da - db;
      return axis === 'x' ? a.pos.y - b.pos.y : a.pos.x - b.pos.x;
    });
  // Flow axis for a group of already-visually-sorted pins: vertical when the
  // pins spread further in x than in y (e.g. a 90-rotated gate's inputs,
  // which face up/down and so sit side-by-side), horizontal otherwise.
  const spreadAxis = (pins: readonly PinTarget[]): 'x' | 'y' => {
    if (pins.length === 0) return 'x';
    const xs = pins.map((p) => p.worldPos.x);
    const ys = pins.map((p) => p.worldPos.y);
    const spreadX = Math.max(...xs) - Math.min(...xs);
    const spreadY = Math.max(...ys) - Math.min(...ys);
    return spreadX > spreadY ? 'y' : 'x';
  };

  // Sources: every selected component (except the target itself) contributes
  // all its free output pins, ordered by pin `order`; components are visited
  // by x-distance-then-y closeness to what they're wiring to.
  //
  // `targetId` undefined (P1.5): no hover -- resolve from the selection alone.
  // Partition selected components by which free pins they actually have: a
  // pure-out component is a source, a pure-in component is a target, and a
  // component with both (e.g. a packaged full-adder) contributes to *both*
  // pools, resolved by the same role/order matching as the hover case --
  // not treated as an ambiguous blocker. A selection with no pure source
  // and no pure target at all (nothing to anchor the split) fails
  // gracefully: no pairs, no partial/garbled wiring.
  const computeSmartConnect = (
    targetId: string | undefined,
    rotation: number,
  ): { source: PinTarget; target: PinTarget }[] => {
    const st = store.getState();
    const theme = themeRef.current!;
    const circuit = st.activeCircuit();
    const targets = collectPinTargets(circuit.components, circuit.wires, theme, st.chipLib);
    const availTargets = smartConnectTargets(targets, circuit.wires);
    // Top-level In ports are pure labels (no driver emitted at compile), so
    // wiring one onto an ALREADY-driven gate input just names that net --
    // when every source is an In label, the wired-input exclusion is lifted
    // for the target side. Gate-to-gate pairing keeps the exclusion (a real
    // second driver).
    const isInPort = (id: string) => circuit.components.find((c) => c.id === id)?.kind === 'inport';
    // A target pin already carrying an In/Out label's wire -- the "next open
    // pin" default skips these first (each label logically wants its own
    // pin), same rule for any single-pin/bus source cycling onto a
    // multi-pin target, not just In-label sources specifically.
    const isLabelClaimed = (t: PinTarget): boolean =>
      circuit.wires.some((w) => {
        for (const end of [w.a, w.b] as const) {
          if (end.kind !== 'pin' || end.component !== t.componentId || end.pin !== t.pinName)
            continue;
          const other = end === w.a ? w.b : w.a;
          return other.kind === 'pin' && isInPort(other.component);
        }
        return false;
      });
    // A single source against a multi-pin target group is a "pick one of N"
    // choice (smartConnectSingleSource), not the permutation smartConnect()
    // does for equal/larger source groups -- pairByPermutation caps rotation
    // at min(srcs.length, tgts.length), so a lone source could never reach
    // past the first-sorted candidate no matter how far you scrolled.
    const connect = (
      sources: readonly PinTarget[],
      targetPins: readonly PinTarget[],
    ): { source: PinTarget; target: PinTarget }[] => {
      if (sources.length === 1 && targetPins.length > 1) {
        const pair = smartConnectSingleSource(sources[0]!, targetPins, rotation, isLabelClaimed);
        return pair ? [pair] : [];
      }
      return smartConnect(sources, targetPins, rotation).pairs;
    };

    if (targetId === undefined) {
      // 4b: chain-staged matching -- a switch/gate/LED selection with no hover
      // target resolves stage by stage (source -> middle -> ... -> sink), not
      // as one flat pool, so an intervening gate/chip's inputs fill before a
      // direct switch-to-LED connection is even considered.
      // Every component, not just the selected ones: smartConnectChainWithin
      // resolves inside the selection first and only widens to the board when
      // that finds nothing (a switch column whose gate is unselected).
      const chainComps: ChainComp[] = circuit.components.map((c) => {
        const def = c.defId ? st.chipLib.get(c.defId) : undefined;
        const b = symbolBounds(c, theme, def).bounds;
        return {
          id: c.id,
          pos: c.pos,
          center: { x: b.x + b.w / 2, y: b.y + b.h / 2 },
          hasAnyInputPinSpec: resolveComponentPins(c, def).some((p) => p.dir === 'in'),
          freeIns: freeInPins(availTargets, c.id),
          freeOuts: freeOutPins(availTargets, c.id),
          isInPort: c.kind === 'inport',
          wiredIns: freeInPins(targets, c.id).filter((p) => !p.free),
        };
      });
      return smartConnectChainWithin(chainComps, st.selection, rotation).pairs;
    }

    // Hover case: classify by what's actually free on each side (P1.4).
    // Default is hover = target, selection = sources (today's shape);
    // reversed when the hovered component is unambiguously the source (zero
    // free inputs, at least one free output) OR when it has free outputs but
    // the selection itself cannot supply any (no free outputs of its own but
    // has free inputs) -- the latter closes the case where the hovered part
    // has BOTH directions free (mux, decoder, demux, encoder, a gate) and the
    // selection is a pure sink (an LED, or a gate whose only free pin is an
    // input): the old one-sided test asked only "can the hovered thing be a
    // sink?" and never "can the selection even be a source?", so it fell
    // through to the default branch, which builds zero sources from a
    // sink-only selection and silently produces no pairs. A hovered
    // component with both (or neither) direction free, and a selection that
    // can also supply an output, still falls through to the default -- the
    // ghost preview lets the user see (and reject) a wrong guess.
    const hoveredComp = circuit.components.find((c) => c.id === targetId);
    const selectionIds = [...st.selection].filter((id) => id !== targetId);
    // When every selected source is an In-label, the hovered target's inputs
    // must be read from the full (unfiltered) pool too -- an In-label never
    // counts as a real second driver, so an already-wired input still has
    // capacity. Computed up front: `hoveredFreeIns` (and thus
    // `hoveredIsSource` below) otherwise reads an already-labeled input as
    // fully occupied, making the target look like a pure-source device and
    // flipping the inferred direction backwards before the label-aware
    // fallback at the bottom of this function ever gets a chance to run.
    const labelSources = selectionIds.length > 0 && selectionIds.every(isInPort);
    const selectionOuts = selectionIds.flatMap((id) => freeOutPins(availTargets, id));
    const selectionIns = selectionIds.flatMap((id) => freeInPins(availTargets, id));
    // smartConnect() itself re-filters every target/source by its own `.free`
    // flag (a plain per-pin occupancy bit, no notion of who's asking) -- an
    // exempted pin pulled in from the wider `targets` pool still reads as
    // occupied there and gets silently dropped, so it must be marked free
    // here at the source, not just made reachable. `labelExempt` (also used
    // by manual wire-dragging) covers BOTH directions -- source is a label,
    // or the pin's existing occupant is one -- so a single real-driver
    // source (a switch) can also cycle onto an already-labeled-only input,
    // not just another label onto an already-driven one.
    const singleSourceId = selectionIds.length === 1 ? selectionIds[0] : undefined;
    const hoveredFreeIns = freeInPins(targets, targetId)
      .filter(
        (t) =>
          t.free ||
          labelSources ||
          (singleSourceId !== undefined &&
            labelExempt(circuit.components, circuit.wires, singleSourceId, t)),
      )
      .map((t) => (t.free ? t : { ...t, free: true }));
    const hoveredFreeOuts = freeOutPins(availTargets, targetId);
    let hoveredIsSource =
      (hoveredFreeIns.length === 0 && hoveredFreeOuts.length > 0) ||
      (hoveredFreeOuts.length > 0 && selectionOuts.length === 0 && selectionIns.length > 0);
    // Both the hovered part and the (single) selected part can have BOTH
    // directions free at once (decoder/encoder/mux/demux/a gate placed
    // facing each other) -- neither branch above fires, so this used to
    // silently fall through to the hover=target/selection=source default
    // regardless of which side's pins actually face the other, wiring
    // whichever unrelated pins that default happened to pick (e.g. an
    // encoder's own output onto a decoder's own input) instead of the pins
    // the user visually lined up. Break the tie geometrically: prefer
    // whichever direction has its source's output pin and the other side's
    // input group mutually facing each other (outputAlignedWithInputs,
    // already used by the no-hover chain path for the same purpose).
    if (
      !hoveredIsSource &&
      hoveredFreeIns.length > 0 &&
      hoveredFreeOuts.length > 0 &&
      selectionOuts.length > 0 &&
      selectionIns.length > 0 &&
      selectionIds.length === 1 &&
      hoveredComp
    ) {
      const selComp = circuit.components.find((c) => c.id === selectionIds[0]);
      if (selComp) {
        const centerOf = (c: Component) => {
          const def = c.defId ? st.chipLib.get(c.defId) : undefined;
          const b = symbolBounds(c, theme, def).bounds;
          return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
        };
        const hovCenter = centerOf(hoveredComp);
        const selCenter = centerOf(selComp);
        const hoveredAsSourceAligned = outputAlignedWithInputs(
          hoveredFreeOuts[0]!.worldPos,
          hovCenter,
          selectionIns.map((p) => p.worldPos),
          selCenter,
        );
        const selectionAsSourceAligned = outputAlignedWithInputs(
          selectionOuts[0]!.worldPos,
          selCenter,
          hoveredFreeIns.map((p) => p.worldPos),
          hovCenter,
        );
        if (hoveredAsSourceAligned && !selectionAsSourceAligned) hoveredIsSource = true;
      }
    }
    if (hoveredIsSource) {
      // 4a: axis comes from the hovered SOURCE's own free output pins' spread.
      const sources = hoveredFreeOuts;
      const axis = spreadAxis(sources);
      const ref = axis === 'x' ? (hoveredComp?.pos.x ?? 0) : (hoveredComp?.pos.y ?? 0);
      const selectionComps = orderByCloseness(
        circuit.components.filter((c) => st.selection.has(c.id) && c.id !== targetId),
        ref,
        axis,
      );
      // Same two-directional labelExempt widening as hoveredFreeIns above --
      // the hovered part is the single source here, so it's always the
      // `from` side regardless of how many target components are selected.
      const targetPins = selectionComps
        .flatMap((c) => freeInPins(targets, c.id))
        .filter((t) => t.free || labelExempt(circuit.components, circuit.wires, targetId, t))
        .map((t) => (t.free ? t : { ...t, free: true }));
      return connect(sources, targetPins);
    }
    // 4a: axis comes from the hovered TARGET's own free input pins' spread --
    // a rotated gate's inputs facing up/down spread in x, not y. `hoveredFreeIns`
    // already reads from the label-aware pool when labelSources is true.
    const targetPins = hoveredFreeIns;
    const axis = spreadAxis(targetPins);
    const ref = axis === 'x' ? (hoveredComp?.pos.x ?? 0) : (hoveredComp?.pos.y ?? 0);
    const selectionComps = orderByCloseness(
      circuit.components.filter((c) => st.selection.has(c.id) && c.id !== targetId),
      ref,
      axis,
    );
    const sources = selectionComps.flatMap((c) => freeOutPins(availTargets, c.id));
    return connect(sources, targetPins);
  };

  // F produced zero pairs and gave no other feedback -- a silent no-op reads
  // as "nothing happened," not "here's why." Not a full re-derivation of
  // computeSmartConnect's own role/direction logic (that's already run and
  // failed); just a width-focused diagnostic, since a width mismatch is the
  // single most common and most legible reason to name specifically.
  const smartConnectFailureReason = (
    targetId: string | undefined,
    selection: ReadonlySet<string>,
  ): string => {
    const st = store.getState();
    const theme = themeRef.current!;
    const circuit = st.activeCircuit();
    const targets = collectPinTargets(circuit.components, circuit.wires, theme, st.chipLib);
    const selIds = [...selection].filter((id) => id !== targetId);
    const widthsOf = (ids: readonly string[]) =>
      new Set(targets.filter((t) => ids.includes(t.componentId)).map((t) => t.width));
    const hoveredWidths = targetId ? widthsOf([targetId]) : widthsOf(selIds.slice(0, 0));
    const selectionWidths = widthsOf(selIds);
    if (targetId && hoveredWidths.size > 0 && selectionWidths.size > 0) {
      const overlap = [...hoveredWidths].some((w) => selectionWidths.has(w));
      if (!overlap) {
        return `smart-connect: incompatible pin width (${[...selectionWidths].join('/')} vs ${[...hoveredWidths].join('/')})`;
      }
    }
    return 'smart-connect: no compatible pins to connect';
  };

  // Touching containment (KiCad/Blender box-select default): anything whose
  // bounds overlap the lasso rect at all is selected, not just fully-enclosed items.
  const idsInRect = (rect: Rect): Set<string> => {
    const st = store.getState();
    const theme = themeRef.current!;
    const circuit = st.activeCircuit();
    const ids = new Set<string>();
    for (const c of circuit.components) {
      const def = c.defId ? st.chipLib.get(c.defId) : undefined;
      if (rectsIntersect(rect, symbolBounds(c, theme, def).bounds)) ids.add(c.id);
    }
    const routes = computeRoutes();
    for (const w of circuit.wires) {
      const pts = routes.get(w.id);
      if (!pts) continue;
      // The wire's actual drawn path, not its bounding box -- a box would
      // falsely catch the empty space inside an L-shaped wire's corner.
      if (polylineIntersectsRect(pts, rect)) ids.add(w.id);
    }
    // P1.2: junctions had no rect-containment check at all, so a lasso
    // touching a dot silently skipped it (and any group move/delete after).
    // Same fat radius junctionAt already hit-tests a single click against, in
    // world units (idsInRect's rect is already world-space).
    for (const j of circuit.junctions) {
      const bounds: Rect = {
        x: j.pos.x - MIN_HIT_RADIUS,
        y: j.pos.y - MIN_HIT_RADIUS,
        w: MIN_HIT_RADIUS * 2,
        h: MIN_HIT_RADIUS * 2,
      };
      if (rectsIntersect(rect, bounds)) ids.add(j.id);
    }
    return ids;
  };

  // Insert-on-wire detection (Item 2, Bug B): shared by the place tool, a
  // component drag, and a duplicate/paste commit -- any component landing on
  // a wire splices, regardless of how it got there. Cursor-based hit-test
  // (cursor-nearest-segment, or -- when the cursor missed every wire's fat
  // radius but the component's own drawn body still overlaps a wire, the
  // common "cursor in an L-wire's empty corner" case -- body-overlap) only
  // DETECTS which wire/segment; the returned `dropPos` is always the
  // pending component's own ghost-body CENTER projected onto that segment
  // (M4.5) -- the cursor is a click affordance, not where the component
  // visually is, so projecting the cursor left the spliced component
  // noticeably off the ghost the user actually saw.
  const detectSplice = (
    world: Vec2,
    comp: {
      kind: ComponentKind;
      params?: Record<string, ParamValue>;
      rot?: Component['rot'];
      mirror?: boolean;
    },
    opts?: { altKey?: boolean },
  ): { wire: Wire; seg: number; dropPos: Vec2; segA: Vec2; segB: Vec2 } | undefined => {
    if (opts?.altKey || comp.kind === 'chip') return undefined;
    const spec = splicePins(comp.kind, comp.params ?? {});
    if (!spec) return undefined;
    const theme = themeRef.current!;
    const grid = theme.gridSchematic;
    const snapped = { x: Math.round(world.x / grid) * grid, y: Math.round(world.y / grid) * grid };
    const bodyBounds = symbolBounds(
      {
        id: '__drop',
        kind: comp.kind,
        pos: snapped,
        rot: comp.rot ?? 0,
        mirror: comp.mirror ?? false,
        ...(comp.params ? { params: comp.params } : {}),
      },
      theme,
    ).bounds;
    const refPoint = { x: bodyBounds.x + bodyBounds.w / 2, y: bodyBounds.y + bodyBounds.h / 2 };
    const wh = wireAt(world);
    if (wh) {
      const pts = computeRoutes().get(wh.wire.id);
      const segA = pts?.[wh.seg];
      const segB = pts?.[wh.seg + 1];
      if (!segA || !segB) return undefined;
      return {
        wire: wh.wire,
        seg: wh.seg,
        dropPos: projectOntoSegment(refPoint, segA, segB),
        segA,
        segB,
      };
    }
    const circuit = store.getState().activeCircuit();
    const routes = computeRoutes();
    const found = findSpliceWire(refPoint, bodyBounds, circuit.wires, (w) => routes.get(w.id));
    if (!found) return undefined;
    const wire = circuit.wires.find((w) => w.id === found.wireId);
    if (!wire) return undefined;
    return {
      wire,
      seg: found.seg,
      dropPos: projectOntoSegment(refPoint, found.segA, found.segB),
      segA: found.segA,
      segB: found.segB,
    };
  };

  // Commits a detected splice: resolves upstream/downstream flow, aligns the
  // component's placement pos onto the wire's pin geometry (Bug A), and calls
  // the store. `rot: 'auto'` reproduces the place tool's today-unchanged
  // auto-orientation heuristic; a fixed rot (drag/duplicate) keeps the
  // component's own orientation, never auto-rotating something the user
  // already posed. `componentId` present = move-and-splice an existing
  // component instead of minting a new one.
  const commitSplice = (
    hit: { wire: Wire; seg: number; dropPos: Vec2; segA: Vec2; segB: Vec2 },
    spec: SplicePins,
    kind: ComponentKind,
    params: Record<string, ParamValue> | undefined,
    rot: Component['rot'] | 'auto',
    mirror: boolean | undefined,
    componentId?: string,
    label?: string,
  ) => {
    const st = store.getState();
    const theme = themeRef.current!;
    const grid = theme.gridSchematic;
    const aDir = wireEndDir(hit.wire.a);
    const bDir = wireEndDir(hit.wire.b);
    const aUpstream = aDir === 'out' || (aDir === undefined && bDir !== 'out');
    const upstreamEnd = aUpstream ? hit.wire.a : hit.wire.b;
    const downstreamEnd = aUpstream ? hit.wire.b : hit.wire.a;
    const resolvedRot: NonNullable<Component['rot']> =
      rot === 'auto'
        ? (() => {
            const upPt = resolveWireEnd(upstreamEnd);
            const downPt = resolveWireEnd(downstreamEnd);
            const dx = upPt && downPt ? downPt.x - upPt.x : 1;
            const dy = upPt && downPt ? downPt.y - upPt.y : 0;
            return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 0 : 180) : dy >= 0 ? 90 : 270;
          })()
        : (rot ?? 0);
    const throwaway: Component = {
      id: '__drop',
      kind,
      pos: { x: 0, y: 0 },
      rot: resolvedRot,
      ...(mirror ? { mirror } : {}),
      ...(params ? { params } : {}),
    };
    const pinPositions = symbolBounds(throwaway, theme).pins;
    const pinIn = pinPositions.get(spec.inName);
    const pinOut = pinPositions.get(spec.outName);
    const pos =
      pinIn && pinOut
        ? alignSplicePos(hit.dropPos, hit.segA, hit.segB, pinIn, pinOut, grid)
        : {
            x: Math.round(hit.dropPos.x / grid) * grid,
            y: Math.round(hit.dropPos.y / grid) * grid,
          };
    st.insertOnWire({
      kind,
      ...(params ? { params } : {}),
      wireId: hit.wire.id,
      pos,
      grid,
      inName: spec.inName,
      outName: spec.outName,
      upstreamEnd,
      downstreamEnd,
      rot: resolvedRot,
      ...(mirror ? { mirror } : {}),
      ...(label ? { label } : {}),
      ...(componentId ? { componentId } : {}),
    });
  };

  // Drag commit (Bug B): a single unwired 1-in/1-out component dropped onto a
  // wire splices in place (one undo step, keeps its own pos/rot) instead of
  // just moving; returns whether it handled the commit so the caller falls
  // back to a plain moveSelection on a miss. M4.5: detection/projection use
  // the dropped component's own ghost-body CENTER, not the raw cursor --
  // same rationale as detectSplice.
  const trySpliceOnDrag = (sel: Set<string>, dx: number, dy: number): boolean => {
    if (sel.size !== 1) return false;
    const id = [...sel][0]!;
    const st = store.getState();
    const circuit = st.activeCircuit();
    const comp = circuit.components.find((c) => c.id === id);
    if (!comp) return false; // a lone dragged junction, not a component
    const spec = splicePins(comp.kind, comp.params ?? {});
    if (!spec) return false;
    const pinWired = (pin: string) =>
      circuit.wires.some(
        (w) =>
          (w.a.kind === 'pin' && w.a.component === id && w.a.pin === pin) ||
          (w.b.kind === 'pin' && w.b.component === id && w.b.pin === pin),
      );
    if (pinWired(spec.inName) || pinWired(spec.outName)) return false;
    const theme = themeRef.current!;
    const dropped = { x: comp.pos.x + dx, y: comp.pos.y + dy };
    const bodyBounds = symbolBounds({ ...comp, pos: dropped }, theme).bounds;
    const refPoint = { x: bodyBounds.x + bodyBounds.w / 2, y: bodyBounds.y + bodyBounds.h / 2 };
    const routes = computeRoutes();
    const found = findSpliceWire(refPoint, bodyBounds, circuit.wires, (w) => routes.get(w.id));
    if (!found) return false;
    const wire = circuit.wires.find((w) => w.id === found.wireId);
    if (!wire) return false;
    const hit = {
      wire,
      seg: found.seg,
      dropPos: projectOntoSegment(refPoint, found.segA, found.segB),
      segA: found.segA,
      segB: found.segB,
    };
    commitSplice(hit, spec, comp.kind, comp.params, comp.rot ?? 0, comp.mirror, comp.id);
    return true;
  };

  // Shift+R: rotates the whole selection (components + junctions + wires) as
  // one rigid body about the union bounding box's center, snapped to grid.
  // Wires fully inside the selection (or whose id is itself selected) have
  // their bend points and any free end rotated exactly (no snap -- a wire
  // line needn't be grid-aligned); a wire with only one end inside is left
  // alone, since its connection survives by pin reference and the display
  // route re-elbows on its own.
  // A single-pin part (In/Out label, 1-bit switch, button, 1-bit LED,
  // probe) hinges on its own pin's world position instead of its body
  // centre -- the owner's live-QA call: these read as a device dangling off
  // one wire, so the wire-attach point staying fixed reads more naturally
  // than the body's geometric centre. Gated by width===1 for toggle/led
  // (a multi-bit bank has more than one pin, so it falls back to centre);
  // Ports, buttons and probes are always effectively single-pin.
  const SINGLE_PIN_KIND: Partial<Record<string, string>> = {
    inport: 'y',
    outport: 'a',
    toggle: 'y',
    button: 'y',
    led: 'a',
    probe: 'a',
  };
  const rotationPivot = (c: Component, pins: Map<string, Vec2>): Vec2 | undefined => {
    const pin = SINGLE_PIN_KIND[c.kind];
    if (!pin) return undefined;
    if ((c.kind === 'toggle' || c.kind === 'led') && Number(c.params?.['width'] ?? 1) !== 1)
      return undefined;
    return pins.get(pin);
  };

  // `R`: rotate each selected/hovered component individually about its own
  // body centre (Task 8). Bounds are resolved here, not in the store, per
  // applyGroupRotate's caller-resolved-bounds contract.
  // Arms the duplicate ghost, which then follows the pointer and commits on
  // the next click or Enter. Shared by Shift+D and the touch action bar so
  // both produce the same one-undo-step stamp.
  const startDuplicate = (ids: Set<string> | undefined) => {
    if (!ids || ids.size === 0) return;
    const st_ = store.getState();
    const base = extractInternalSelection(st_.activeCircuit(), ids);
    if (base.components.length === 0 && base.junctions.length === 0) return;
    const grid = themeRef.current?.gridSchematic ?? 1;
    duplicateRef.current = {
      base,
      // A finger leaves no pointer where the copy should go: on touch
      // lastMouseWorldRef is wherever it last landed, usually the action bar's
      // own tap, which is why the ghost appeared somewhere arbitrary. Offset it
      // from the original instead and let the drop tap place it.
      offset: coarse
        ? { x: grid * 2, y: grid * 2 }
        : computeDupOffset(base, lastMouseWorldRef.current, grid),
      stamp: true,
    };
    drawRef.current();
  };

  const rotateSelectionIndividually = (sel: Set<string>) => {
    if (sel.size === 0) return;
    const st = store.getState();
    const theme = themeRef.current!;
    const circuit = st.activeCircuit();
    const items = circuit.components
      .filter((c) => sel.has(c.id))
      .map((c) => {
        const def = c.defId ? st.chipLib.get(c.defId) : undefined;
        const sb = symbolBounds(c, theme, def);
        const pivot = rotationPivot(c, sb.pins);
        return { id: c.id, bounds: sb.bounds, rot: c.rot ?? 0, ...(pivot ? { pivot } : {}) };
      });
    st.rotateSelection(items, theme.gridSchematic);
  };

  const applyGroupRotateFromSelection = (sel: Set<string>) => {
    const st = store.getState();
    const theme = themeRef.current!;
    const circuit = st.activeCircuit();
    const grid = theme.gridSchematic;
    const comps = circuit.components.filter((c) => sel.has(c.id));
    const juncs = circuit.junctions.filter((j) => sel.has(j.id));
    const endIn = (end: WireEnd) =>
      (end.kind === 'pin' && sel.has(end.component)) ||
      (end.kind === 'junction' && sel.has(end.junction));
    const selWires = circuit.wires.filter((w) => sel.has(w.id) || (endIn(w.a) && endIn(w.b)));
    if (comps.length === 0 && juncs.length === 0 && selWires.length === 0) return;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const grow = (p: Vec2) => {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    };
    const compBounds = new Map<string, ReturnType<typeof symbolBounds>['bounds']>();
    for (const c of comps) {
      const def = c.defId ? st.chipLib.get(c.defId) : undefined;
      const b = symbolBounds(c, theme, def).bounds;
      compBounds.set(c.id, b);
      grow({ x: b.x, y: b.y });
      grow({ x: b.x + b.w, y: b.y + b.h });
    }
    for (const j of juncs) grow(j.pos);
    for (const w of selWires) {
      const a = resolveWireEnd(w.a);
      const b = resolveWireEnd(w.b);
      if (a) grow(a);
      if (b) grow(b);
      for (const p of w.points) grow(p);
    }
    if (!Number.isFinite(minX)) return;
    // halfSnap, not Math.round: a plain rounded center re-derived fresh each
    // turn from the (already-transformed) union bbox is exactly the same
    // asymmetric-tie-breaking bug that caused Task 8's individual-rotate
    // drift, just at the group level -- halfSnap's consistent direction is
    // what makes the pivot itself repeat identically turn after turn.
    const pivot = {
      x: minX + halfSnap(maxX - minX, grid),
      y: minY + halfSnap(maxY - minY, grid),
    };

    const rotateItems = comps.map((c) => ({
      id: c.id,
      bounds: compBounds.get(c.id)!,
      rot: c.rot ?? 0,
    }));
    const { items: rotated, correction } = groupRotate(rotateItems, pivot, grid);
    const addCorrection = (p: Vec2) => ({ x: p.x + correction.x, y: p.y + correction.y });
    const components = rotated.map((r) => ({ ...r, pos: addCorrection(r.pos) }));
    const junctions = juncs.map((j) => ({
      id: j.id,
      pos: addCorrection(rotatePointSnapped(j.pos, pivot, grid)),
    }));
    const wires = selWires.map((w) => ({
      id: w.id,
      points: w.points.map((p) => addCorrection(rotatePointAround(p, pivot))),
      ...(w.a.kind === 'free'
        ? { a: { kind: 'free' as const, pos: addCorrection(rotatePointAround(w.a.pos, pivot)) } }
        : {}),
      ...(w.b.kind === 'free'
        ? { b: { kind: 'free' as const, pos: addCorrection(rotatePointAround(w.b.pos, pivot)) } }
        : {}),
    }));
    st.applyGroupRotate({ components, junctions, wires });
  };

  // Align/Distribute toolbar: applies a caller-resolved per-component delta
  // map (wireGeom's alignDeltas/distributeDeltas) to component positions and
  // stretches every touched wire's bends. Unlike Shift+R's rigid group
  // rotate, different components can move by different deltas here, so a
  // wire between two selected (and possibly differently-moved) components
  // has each of its ends stretched independently -- two sequential
  // single-end stretchWirePoints calls rather than one rigid-delta call.
  const applyGroupTranslate = (deltas: Map<string, Vec2>) => {
    if (deltas.size === 0) return;
    const st = store.getState();
    const circuit = st.activeCircuit();
    const components = circuit.components
      .filter((c) => deltas.has(c.id))
      .map((c) => {
        const d = deltas.get(c.id)!;
        return { id: c.id, pos: { x: c.pos.x + d.x, y: c.pos.y + d.y } };
      });
    const wires: { id: string; points: Vec2[] }[] = [];
    for (const w of circuit.wires) {
      const deltaFor = (end: WireEnd) =>
        end.kind === 'pin' ? deltas.get(end.component) : undefined;
      const da = deltaFor(w.a);
      const db = deltaFor(w.b);
      if (!da && !db) continue;
      const aOld = resolveWireEnd(w.a);
      const bOld = resolveWireEnd(w.b);
      if (!aOld || !bOld) continue;
      let points = w.points;
      if (da) points = stretchWirePoints(points, aOld, bOld, true, false, da);
      const aNew = da ? { x: aOld.x + da.x, y: aOld.y + da.y } : aOld;
      if (db) points = stretchWirePoints(points, aNew, bOld, false, true, db);
      wires.push({ id: w.id, points });
    }
    st.applyGroupMove({ components, wires });
  };

  const componentBounds = (sel: Set<string>) => {
    const st = store.getState();
    const theme = themeRef.current!;
    const circuit = st.activeCircuit();
    return circuit.components
      .filter((c) => sel.has(c.id))
      .map((c) => {
        const def = c.defId ? st.chipLib.get(c.defId) : undefined;
        return { id: c.id, bounds: symbolBounds(c, theme, def).bounds };
      });
  };

  const applyAlignFromSelection = (sel: Set<string>, mode: AlignMode) => {
    const theme = themeRef.current!;
    applyGroupTranslate(alignDeltas(componentBounds(sel), mode, theme.gridSchematic));
  };

  const applyDistributeFromSelection = (sel: Set<string>, axis: DistributeAxis) => {
    const theme = themeRef.current!;
    applyGroupTranslate(distributeDeltas(componentBounds(sel), axis, theme.gridSchematic));
  };

  const applyPackFromSelection = (sel: Set<string>, axis: DistributeAxis) => {
    const theme = themeRef.current!;
    applyGroupTranslate(packDeltas(componentBounds(sel), axis, theme.gridSchematic));
  };

  const tidyWiring = (sel: Set<string>) => {
    const theme = themeRef.current!;
    const st = store.getState();
    const components = st.activeCircuit().components.map((c) => {
      const def = c.defId ? st.chipLib.get(c.defId) : undefined;
      const { bounds, pins } = symbolBounds(c, theme, def);
      const dirs = new Map(resolveComponentPins(c, def).map((p) => [p.name, p.dir]));
      const routable = new Map<string, RoutablePin>();
      for (const [name, pos] of pins) {
        const dir = dirs.get(name);
        if (dir) routable.set(name, { pos, dir });
      }
      return { id: c.id, bounds, pins: routable };
    });
    st.tidyWiring({
      components,
      grid: theme.gridSchematic,
      ...(sel.size > 0 ? { only: sel } : {}),
    });
  };

  // Two-finger pinch: zoom about the midpoint and pan with it, the touch
  // equivalent of the wheel handler's Ctrl+wheel and Shift+wheel. Two fingers
  // are never an editing gesture, so this runs ahead of every other branch.
  const beginPinch = (dist: number, cx: number, cy: number) => {
    pinchRef.current = { dist, mid: { x: cx, y: cy }, vp: viewportRef.current };
  };

  const updatePinch = (now: Extract<Intent, { kind: 'pinch' }>) => {
    const start = pinchRef.current;
    if (!start || start.dist === 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dist = now.dist;
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, start.vp.zoom * (dist / start.dist)));
    const rect = canvas.getBoundingClientRect();
    // The world point under the gesture's starting midpoint stays under the
    // current midpoint: that is both the zoom anchor and the pan.
    const anchor = screenToWorld(start.vp, {
      x: start.mid.x - rect.left,
      y: start.mid.y - rect.top,
    });
    const mid = { x: now.cx - rect.left, y: now.cy - rect.top };
    setViewport({ panX: anchor.x - mid.x / zoom, panY: anchor.y - mid.y / zoom, zoom });
  };

  // Long press = the precise/alternate variant of a tap. Its one job today is
  // the parameter overlay, which the mouse reaches by double-clicking.
  const onLongPress = (clientX: number, clientY: number) => {
    if (viewOnlyRef.current || mode === 'bubble') return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const world = screenToWorld(viewportRef.current, {
      x: clientX - rect.left,
      y: clientY - rect.top,
    });
    const c = topComponentAt(world);
    if (c) store.getState().setSelection(new Set([c.id]));
    openParamsAt(clientX, clientY, false);
  };

  /** How much bigger a hit target is than its drawn glyph. Presentation
   *  enlarges everything for a TV; a finger needs a 44px target whatever the
   *  glyph measures. The two multiply. */
  /** Multiplier the nearest-pin helpers apply to LOOSE_HIT_RADIUS. A hit
   *  budget belongs to the input device and the screen, never to the drawing,
   *  so it is a fixed number of SCREEN pixels converted to world units here.
   *  Without the zoom term the touch budget was 44 world units -- five and a
   *  half grid squares -- at every zoom, so a press well beside a pin still
   *  wired to it, and zooming in only made the swallowed area larger. */
  const hitScale = (t: { presentation: boolean }): number => {
    const px =
      (coarseRef.current ? TOUCH_HIT_RADIUS : LOOSE_HIT_RADIUS) * (t.presentation ? 1.4 : 1);
    return px / LOOSE_HIT_RADIUS / Math.max(viewportRef.current.zoom, 0.01);
  };

  // One click, one part. Placement used to stay armed after every drop, so a
  // single click was really "place, and now you are holding another one",
  // which then needed Esc to put down. Continuous placement is now opt-in:
  // Ctrl+click with the ghost up (desktop), or a long press on the palette
  // item (touch), which latches `repeat`.
  const endPlacement = (e: { ctrlKey?: boolean; metaKey?: boolean }) => {
    const st = store.getState();
    const t = st.tool;
    if (t.kind !== 'place') return;
    if (t.repeat) return;
    if (e.ctrlKey || e.metaKey) {
      st.setTool({ ...t, repeat: true });
      return;
    }
    st.setTool({ kind: 'select' });
  };

  /** Press a momentary button under the cursor; true when one was pressed. */
  const tryButtonPress = (e: React.PointerEvent): boolean => {
    if (!powered || e.button !== 0) return false;
    const world = toWorld(e);
    const st = store.getState();
    const circuit = st.activeCircuit();
    const hit = circuit.components.find((c) => c.kind === 'button' && buttonHit(c, world));
    if (!hit) return false;
    const group =
      st.selection.has(hit.id) && st.selection.size > 1
        ? circuit.components.filter((c) => c.kind === 'button' && st.selection.has(c.id))
        : [hit];
    for (const c of group) {
      st.setButtonHeld(c.id, true, prefix);
      heldButtonsRef.current.add(c.id);
    }
    (e.target as Element).setPointerCapture(e.pointerId);
    return true;
  };

  // Mirrors smartConnectRef into render state. A pending proposal has to be
  // visible as chrome, not only as ghost wires on the canvas: the wheel that
  // cycles the pairing and the Enter that accepts it are both unreachable
  // from a touchscreen.
  const setSmartConnect = (next: SmartConnectState | null) => {
    smartConnectRef.current = next;
    setConnectPairs(next ? next.pairs.length : 0);
  };

  const cycleSmartConnect = (delta: 1 | -1) => {
    const sc = smartConnectRef.current;
    if (!sc) return;
    sc.rotation += delta;
    sc.pairs = computeSmartConnect(sc.targetId, sc.rotation);
    setConnectPairs(sc.pairs.length);
    drawRef.current();
  };

  const commitSmartConnect = () => {
    const sc = smartConnectRef.current;
    if (!sc) return;
    setSmartConnect(null);
    store.getState().addWires(
      sc.pairs.map(({ source, target }) => ({
        a: { kind: 'pin', component: source.componentId, pin: source.pinName },
        b: { kind: 'pin', component: target.componentId, pin: target.pinName },
      })),
    );
    drawRef.current();
  };

  // Smart connect from the selection alone, with no hovered target: the path
  // `F` takes when the pointer is over empty canvas, and the only one a finger
  // can reach, since a finger cannot hover. Proposing is all it does -- the
  // proposal is committed by tapping the board or pressing Enter, exactly as
  // the key-driven one is.
  const proposeSmartConnect = () => {
    const s = store.getState();
    if (s.selection.size < 2) return;
    const pairs = computeSmartConnect(undefined, 0);
    if (pairs.length === 0) {
      store.setState({ error: smartConnectFailureReason(undefined, s.selection) });
      return;
    }
    setSmartConnect({ targetId: undefined, rotation: 0, pairs });
    drawRef.current();
  };

  // Picking any other tool abandons a half-drawn wire. It used to survive the
  // switch, leaving a ghost and a pin marker that only Esc cleared, and a
  // phone has no Esc.
  useEffect(() => {
    if (wiringRef.current && wiringToolRef.current !== tool.kind) discardWire();
  }, [tool.kind]);

  /** Throw away the wire being drawn, bends and all. Distinct from Esc, which
   *  finishes it as a free end: a control labelled Cancel must not leave a
   *  wire behind. The tool stays armed, since cancelling one wire is usually
   *  the prelude to drawing a better one. */
  const discardWire = () => {
    setWiringStart(null);
    wireBendsRef.current = [];
    setHoverPin(undefined);
    drawRef.current();
  };

  /** Abandon whatever gesture is half-finished: a wire being drawn, a lasso,
   *  a cut, a suggestion, a duplicate ghost. Shared by Esc and by a press
   *  outside the canvas, which is the only way to reach it on a touchscreen. */
  const cancelPending = () => {
    const s = store.getState();

    // P1.6: Esc is the only way to end a wire as a free end -- an
    // empty-grid click during drawing now adds a bend and continues
    // instead. If any bends were placed, commit up to the last one as a
    // free-ended wire; with none yet, there's nothing to commit (matches
    // the old cancel-only behavior).
    const from = wiringRef.current;
    const bends = wireBendsRef.current;
    if (from && bends.length > 0) {
      const last = bends[bends.length - 1]!;
      if (isOnWireStart(from)) {
        // B4: the start may still need its own junction resolution, so
        // this goes through wireFromStart too, with the far end forced
        // free (matching the non-onWire branch's Esc behavior exactly --
        // no hit-test on `last`, always a plain free end).
        s.wireFromStart(
          from.worldPos,
          { kind: 'free', pos: last },
          themeRef.current?.gridSchematic ?? 1,
          resolveWireEnd,
          bends.slice(0, -1),
        );
      } else {
        const a: WireEnd = isFreeStart(from)
          ? { kind: 'free', pos: from.worldPos }
          : { kind: 'pin', component: from.componentId, pin: from.pinName };
        s.addWire(a, { kind: 'free', pos: last }, bends.slice(0, -1));
      }
    }
    setWiringStart(null);
    wireBendsRef.current = [];
    lassoRef.current = null;
    cutRef.current = null;
    setSmartConnect(null);
    duplicateRef.current = null;
    ghostRef.current.cancel();
    setHoverPin(undefined);
    s.setTool({ kind: 'select' });
    s.setSelection(new Set());
  };

  // Powering on abandons anything half-drawn. The tool reset in powerOn stops
  // a NEW wire starting; this clears one that was already in flight, whose
  // ghost otherwise hung over a board that could no longer accept it.
  useEffect(() => {
    // Deliberately keyed on `powered` alone: cancelPending is rebuilt every
    // render, and depending on it would abandon a wire on any render at all.
    if (powered) cancelPending();
  }, [powered]);

  const onPointerDown = (e: React.PointerEvent) => {
    store.getState().clearTransientError();
    if (e.pointerType === 'touch') {
      reduceGesture(gestureRef.current, {
        kind: 'down',
        point: { id: e.pointerId, x: e.clientX, y: e.clientY },
        t: e.timeStamp,
      });
      const pts = gestureRef.current.points;
      if (pts.length === 2) {
        panRef.current = null;
        lassoRef.current = null;
        window.clearTimeout(longPressTimer.current);
        const [a, b] = pts;
        if (a && b) beginPinch(Math.hypot(a.x - b.x, a.y - b.y), (a.x + b.x) / 2, (a.y + b.y) / 2);
        return;
      }
      // Long press is the touch stand-in for Shift: the precise variant.
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = window.setTimeout(() => {
        const intent = reduceGesture(gestureRef.current, {
          kind: 'tick',
          t: e.timeStamp + LONG_PRESS_MS,
        });
        if (intent.kind === 'longPress') onLongPress(intent.x, intent.y);
      }, LONG_PRESS_MS);
    }
    if (e.button === 1) {
      // Middle-button drag pans in any tool mode.
      e.preventDefault();
      beginPan(e);
      return;
    }
    // View-only: no editing gesture below is reachable. Driving the board is
    // not editing, so a momentary button still presses (and a switch still
    // toggles, via onCanvasClick); anything else pans.
    if (viewOnlyRef.current) {
      if (tryButtonPress(e)) return;
      if (e.button === 0) beginPan(e);
      return;
    }
    // Bubble-push mode: strict top-of-handler delegation -- every editing
    // gesture below is locked out while the mode is active.
    if (mode === 'bubble') {
      onBubblePointerDown(e);
      return;
    }
    // The lasso tool: a marquee from wherever the press lands, over anything.
    // Placed above the touch-pan rule because it is the answer to the question
    // that rule creates -- with a bare drag reserved for panning, a finger has
    // no other way to select several things at once.
    if (e.button === 0 && store.getState().tool.kind === 'lasso') {
      window.clearTimeout(longPressTimer.current);
      const st = store.getState();
      const world = toWorld(e);
      if (!e.ctrlKey) st.setSelection(new Set());
      lassoRef.current = {
        start: world,
        current: world,
        base: e.ctrlKey ? new Set(st.selection) : new Set(),
      };
      (e.target as Element).setPointerCapture(e.pointerId);
      return;
    }
    // The touch grammar's one rule: a bare finger drag is ALWAYS a pan, and
    // editing starts from a handle. A finger has no hover to aim with and no
    // modifier to qualify itself, so dragging the board around must never be
    // ambiguous with lassoing or dragging a part. Press something already
    // selected to move it; press anywhere else and the board moves instead.
    // ...but a pending ghost outranks it. Every bare touch press pans, so a
    // duplicate raised from the action bar could never be put down: the press
    // that resolves a proposal is not a navigation gesture. The resolution
    // paths below recompute against this exact drop point, which is what makes
    // "tap where it should go" work without a hover to aim with.
    if (
      e.pointerType === 'touch' &&
      store.getState().tool.kind === 'select' &&
      !smartConnectRef.current &&
      !duplicateRef.current
    ) {
      if (tryButtonPress(e)) return;
      const world = toWorld(e);
      // Components are not the only things worth dragging. Asking only
      // topComponentAt here meant every press on a wire, a junction, a bend or
      // a free end panned instead, so none of them could be moved by finger at
      // all. Past this point a touch press behaves exactly like a mouse press
      // at the same spot.
      const handleId = handleIdAt(world);
      const selected = store.getState().selection;
      if (!handleId || !selected.has(handleId)) {
        beginPan(e);
        return;
      }
    }
    // Momentary button press-and-hold: takes precedence over the normal
    // select/lasso path so a button's circle is always pressable while
    // powered, even under the select tool. Pressing a button that's part of
    // a multi-item selection (2+) drives every selected button together.
    if (powered && e.button === 0) {
      const world = toWorld(e);
      const st = store.getState();
      const circuit = st.activeCircuit();
      const hit = circuit.components.find((c) => c.kind === 'button' && buttonHit(c, world));
      if (hit) {
        const group =
          st.selection.has(hit.id) && st.selection.size > 1
            ? circuit.components.filter((c) => c.kind === 'button' && st.selection.has(c.id))
            : [hit];
        for (const c of group) {
          st.setButtonHeld(c.id, true, prefix);
          heldButtonsRef.current.add(c.id);
        }
        // No explicit draw() here: setButtonHeld already bumps `rev`, which
        // the redraw effect below picks up -- a synchronous draw() on top of
        // that doubles the repaint cost per tap and is what made rapid
        // tapping feel buffered/delayed.
        (e.target as Element).setPointerCapture(e.pointerId);
        return;
      }
    }
    if (smartConnectRef.current) {
      // Any click commits the smart-connect preview (Enter does the same).
      commitSmartConnect();
      return;
    }
    const dup = duplicateRef.current;
    if (dup) {
      // Any click commits the duplicate ghost (Enter does the same). Item 1:
      // Shift+D's stamp mode keeps the ghost live after the commit; Ctrl+V
      // stays single-shot. Item 2 Bug B: a lone duplicated/pasted component
      // dropped on a wire splices in (as a fresh component -- duplicates
      // always mint new ids), same as a fresh palette placement or a drag.
      const dropWorld = toWorld(e);
      // Recompute against this exact drop position (the click's own pointer
      // event carries no prior onPointerMove) rather than trusting whatever
      // the last move happened to leave.
      dup.offset = computeDupOffset(dup.base, dropWorld, themeRef.current!.gridSchematic);
      let spliced = false;
      if (dup.base.components.length === 1 && dup.base.junctions.length === 0) {
        const base = dup.base.components[0]!;
        const spec = base.kind !== 'chip' ? splicePins(base.kind, base.params ?? {}) : undefined;
        if (spec) {
          const hit = detectSplice(
            dropWorld,
            {
              kind: base.kind,
              ...(base.params ? { params: base.params } : {}),
              ...(base.rot ? { rot: base.rot } : {}),
              ...(base.mirror ? { mirror: base.mirror } : {}),
            },
            { altKey: e.altKey },
          );
          if (hit) {
            commitSplice(
              hit,
              spec,
              base.kind,
              base.params,
              base.rot ?? 0,
              base.mirror,
              undefined,
              base.label,
            );
            spliced = true;
          }
        }
      }
      if (!spliced) store.getState().commitDuplicate(dup.base, dup.offset);
      // Same rule as a palette placement: one drop unless Ctrl says keep
      // going. `stamp` no longer means "repeat forever" on its own.
      if (!(dup.stamp && (e.ctrlKey || e.metaKey))) duplicateRef.current = null;
      draw();
      return;
    }
    const world = toWorld(e);
    const st = store.getState();
    const theme = themeRef.current!;
    const grid = theme.gridSchematic;

    if (tool.kind === 'place') {
      // Placing into a running sim would edit the board out from under it.
      if (powered) return;
      // Insert-on-wire: dropping a 1-in/1-out primitive onto a wire splices it
      // in (Alt suppresses). Multi-pin/chip placements never auto-splice.
      // `rot: 'auto'` picks the nearest cardinal direction along the wire's
      // resolved flow; electrical wiring is correct regardless of rotation.
      const hit = detectSplice(
        world,
        {
          kind: tool.componentKind,
          ...(tool.params ? { params: tool.params } : {}),
          rot: ghostPoseRef.current.rot,
          mirror: ghostPoseRef.current.mirror,
        },
        { altKey: e.altKey },
      );
      if (hit) {
        const spec = splicePins(tool.componentKind, tool.params ?? {})!;
        commitSplice(
          hit,
          spec,
          tool.componentKind,
          tool.params,
          'auto',
          ghostPoseRef.current.mirror,
        );
        endPlacement(e);
        return;
      }
      st.place(tool.componentKind, world, grid, tool.params, ghostPoseRef.current, tool.defId);
      endPlacement(e);
      return;
    }
    if (tool.kind === 'junction') {
      if (powered) return;
      st.addJunction(world, grid, resolveWireEnd);
      return;
    }
    if (tool.kind === 'cut') {
      if (powered) return;
      cutRef.current = { start: world, current: world, flagged: new Set() };
      (e.target as Element).setPointerCapture(e.pointerId);
      return;
    }
    const circuit = st.activeCircuit();
    const targets = collectPinTargets(circuit.components, circuit.wires, theme, st.chipLib);
    const from = wiringRef.current;
    if (from && e.ctrlKey) {
      // Ctrl held means "toggle selection," unambiguously (same precedent as
      // the pinHit guard below) -- a leftover pending wire must not swallow
      // the click into wire-completion logic. Discard it silently (like Esc
      // with no bends placed) and fall through to the normal hit-test/toggle
      // path instead of returning.
      setWiringStart(null);
      wireBendsRef.current = [];
      setHoverPin(undefined);
    } else if (from) {
      // A wire is pending (started from the Wire tool or a Select-mode pin
      // press): this click completes or drops it, whatever the tool.
      let end =
        isFreeStart(from) || isOnWireStart(from)
          ? nearestFree(targets, world, hitScale(theme))
          : nearestCompatiblePin(
              targets,
              world,
              { width: from.width, dir: from.dir },
              hitScale(theme),
              (t) => labelExempt(circuit.components, circuit.wires, from.componentId, t),
            );
      // A pin's loose (2x) snap radius otherwise makes any junction sitting
      // close to it practically unreachable -- whichever is actually nearer
      // the cursor wins; a closer junction defers to the junction-connect
      // path below (falls through as if the pin click had missed).
      if (end) {
        const j = junctionAt(world);
        if (j) {
          const jDist = Math.hypot(j.pos.x - world.x, j.pos.y - world.y);
          const pinDist = Math.hypot(end.worldPos.x - world.x, end.worldPos.y - world.y);
          if (jDist < pinDist) end = undefined;
        }
      }
      if (isOnWireStart(from)) {
        // B4: the START was recorded sitting on an existing wire's body/
        // junction -- resolve (or re-resolve, if the board moved since
        // pointer-down) that connection in the same commit as the far end,
        // via wireFromStart (symmetric with connectToJunction, which already
        // does this for the END).
        const bSpec: WireEnd | { pos: Vec2 } = end
          ? { kind: 'pin', component: end.componentId, pin: end.pinName }
          : { pos: world };
        const result = st.wireFromStart(
          from.worldPos,
          bSpec,
          grid,
          resolveWireEnd,
          wireBendsRef.current,
        );
        if (result === 'connected') {
          setWiringStart(null);
          wireBendsRef.current = [];
          setHoverPin(undefined);
          return;
        }
        // Rejected (e.g. a label conflict): leave the pending wire exactly as
        // it was, same as the plain-start path below -- don't plant a bend.
        if (result === 'rejected') return;
        // Same guard as the plain-start path below: a pin sits right at the
        // click but was incompatible -- don't plant a bend on top of it.
        if (nearestAnyPin(targets, world, hitScale(theme))) return;
        // Neither a pin nor a wire/junction at the far end: P1.6 bend-add,
        // same as the plain free-start path below.
        const pos = { x: Math.round(world.x / grid) * grid, y: Math.round(world.y / grid) * grid };
        wireBendsRef.current = [...wireBendsRef.current, pos];
        return;
      }
      const a: WireEnd = isFreeStart(from)
        ? { kind: 'free', pos: from.worldPos }
        : { kind: 'pin', component: from.componentId, pin: from.pinName };
      if (end) {
        const added = st.addWire(
          a,
          { kind: 'pin', component: end.componentId, pin: end.pinName },
          wireBendsRef.current,
        );
        // Rejected (e.g. an In/Out label direction conflict): leave the
        // pending wire armed, exactly as if this click never landed, instead
        // of dropping a wire that only *looks* uncommitted.
        if (!added) return;
        setWiringStart(null);
        wireBendsRef.current = [];
        setHoverPin(undefined);
        return;
      }
      // Wire-body hit-test runs before the incompatible-pin guard below, so a
      // click near a pin but on a wire still hits the wire.
      //
      // Dropping onto a wider bus wire's body from a known-width pin pulls off
      // a tap instead of a same-width junction (only when `from` started at a
      // real pin -- a free-start has no width to size the tap's range from).
      if (!isFreeStart(from)) {
        const tapResult = st.connectToTap(
          a,
          world,
          grid,
          resolveWireEnd,
          from.width,
          wireBendsRef.current,
        );
        if (tapResult === 'connected') {
          setWiringStart(null);
          wireBendsRef.current = [];
          setHoverPin(undefined);
          return;
        }
        // Rejected (e.g. an In/Out label direction conflict on the tapped
        // net): leave the pending wire exactly as it was, no bend planted.
        if (tapResult === 'rejected') return;
      }
      // No pin/tap match: dropping onto an existing wire's body joins at a
      // real junction (splitting that wire) instead of a dangling free end.
      const junctionResult = st.connectToJunction(
        a,
        world,
        grid,
        resolveWireEnd,
        wireBendsRef.current,
      );
      if (junctionResult === 'connected') {
        setWiringStart(null);
        wireBendsRef.current = [];
        setHoverPin(undefined);
        return;
      }
      // Rejected (a wire body sat right there, but joining it is illegal --
      // e.g. an In label's net reaching a gate output through that wire):
      // leave the pending wire exactly as it was, don't plant a bend on top
      // of the rejected wire.
      if (junctionResult === 'rejected') return;
      // A pin sits right where the click landed but wasn't offered as `end`
      // and no wire body caught it either (incompatible width/direction --
      // e.g. an In label's own output pin clicked against a gate output, both
      // `dir: 'out'`) -- treat this as a miss on that pin, not an empty
      // click, so it doesn't fall through to P1.6's bend-add and silently
      // plant a bend on top of the rejected pin.
      if (nearestAnyPin(targets, world, hitScale(theme))) return;
      // P1.6: empty-grid click adds a bend and keeps drawing from there,
      // instead of ending the wire with a free end -- only Esc does that now.
      const pos = { x: Math.round(world.x / grid) * grid, y: Math.round(world.y / grid) * grid };
      wireBendsRef.current = [...wireBendsRef.current, pos];
      return;
    }
    if (tool.kind === 'wire') {
      // Belt and braces with the tool reset in powerOn: a wire started while
      // the sim owns the board could never commit, and would strand a ghost
      // that only Esc clears, which a phone has not got.
      if (powered) return;
      const pin = nearestFree(targets, world, hitScale(theme));
      if (pin) {
        setWiringStart(pin);
      } else {
        // B4: starting a wire on top of an existing wire/junction must
        // connect, same as ending on one already does -- record the
        // hit-tested snapped point now (so the ghost previews from exactly
        // on the wire) but don't mutate the board until commit (wireFromStart
        // at completion), so Esc still leaves no trace.
        const j = junctionAt(world);
        const wh = j ? undefined : wireAt(world);
        if (j) {
          setWiringStart({ kind: 'onWire', worldPos: j.pos });
        } else if (wh) {
          const pts = computeRoutes().get(wh.wire.id);
          const snapped = pts ? projectOntoSegment(world, pts[wh.seg]!, pts[wh.seg + 1]!) : world;
          setWiringStart({ kind: 'onWire', worldPos: snapped });
        } else {
          setWiringStart({
            kind: 'freeStart',
            worldPos: {
              x: Math.round(world.x / grid) * grid,
              y: Math.round(world.y / grid) * grid,
            },
          });
        }
      }
      wireBendsRef.current = [];
      return;
    }

    // select: a free pin's fat target starts a wire (KiCad model); the
    // component body still selects/drags. Ctrl held means "toggle selection,"
    // unambiguously -- skip the pin check entirely so Ctrl+click never starts
    // a wire even when it lands within a nearby pin's (larger) loose radius
    // (P1.1: this pin check ran unconditionally before the ctrl-toggle branch
    // below, so Ctrl+click near a pin -- most of a compact gate's body --
    // never reached it).
    // A pin's touch target is larger than a switch's whole body, so while the
    // sim owns the board this path turned "tap the switch to drive it" into
    // "start a wire from its output" -- a wire that could never commit.
    let pinHit =
      e.ctrlKey || powered
        ? undefined
        : nearestFree(targets, world, hitScale(theme), MIN_HIT_RADIUS);
    // A bare marker's whole 2G body sits inside its pins' loose radius, so a
    // pin press here would make the marker impossible to grab -- fall through
    // to the body drag instead, UNLESS the click lands within a tight radius
    // of the pin's exact point, which still starts a wire (the wire tool / W
    // always wire marker pins regardless). Probe/busdisplay tags share the
    // same small-body geometry and the same treatment.
    if (pinHit) {
      const pc = circuit.components.find((c) => c.id === pinHit!.componentId);
      if (pc && (isBareMarker(pc) || pc.kind === 'probe' || pc.kind === 'busdisplay')) {
        const tightRadius = WIRE_BODY_HIT_RADIUS / viewportRef.current.zoom;
        const d = Math.hypot(pinHit.worldPos.x - world.x, pinHit.worldPos.y - world.y);
        if (d > tightRadius) pinHit = undefined;
      }
    }
    // A junction sitting close to a pin (a common layout right after placing
    // one) is otherwise permanently unpickable once dropped there -- the
    // pin's own loose radius always wins first, so a junction closer to the
    // cursor than the pin gets first refusal instead (falls through to the
    // node hit-test below, same as any other junction pick-up).
    if (pinHit) {
      const j = junctionAt(world);
      if (j) {
        const jDist = Math.hypot(j.pos.x - world.x, j.pos.y - world.y);
        const pinDist = Math.hypot(pinHit.worldPos.x - world.x, pinHit.worldPos.y - world.y);
        if (jDist < pinDist) pinHit = undefined;
      }
    }
    if (pinHit) {
      setWiringStart(pinHit);
      wireBendsRef.current = [];
      setHoverPin(pinHit.worldPos);
      return;
    }
    const hit = topComponentAt(world);
    // B3a: junction and free-end (the NODES) win before any wire geometry --
    // a junction sits on every route it joins, and an avoidance elbow can land
    // within a corner's fat radius of a node, so corner-before-node grabbed
    // the wire and left the node behind. Corner still beats a plain segment
    // hit (clicking near a bend grabs the vertex, not the nearer leg).
    const jh = hit ? undefined : junctionAt(world);
    const fh = hit || jh ? undefined : freeEndAt(world);
    // The badge sits offset off the wire, so it rarely competes with the line
    // itself -- but where it does, grabbing the label must beat reshaping the
    // wire under it.
    const bl = hit || jh || fh ? undefined : busLabelAt(world);
    const corner = hit || jh || fh || bl ? undefined : cornerAt(world);
    const wh = hit || corner || jh || fh || bl ? undefined : wireAt(world);
    const hitId = hit?.id ?? corner?.wire.id ?? jh?.id ?? fh?.wire.id ?? wh?.wire.id ?? bl?.id;
    if (hitId) {
      if (e.ctrlKey) {
        // Ctrl+click toggles membership without starting a drag (decision-8).
        // No drag begins here, so unlike every other selection path this one
        // never lands in onPointerUp's dx=0/dy=0 `else draw()` fallback --
        // setSelection() doesn't bump `rev`, and the canvas redraw effect
        // only watches [rev, hoverPin, viewport, tool, powered, activeTabId],
        // so the toggle would otherwise stay invisible until some unrelated
        // later interaction happened to trigger a draw (e.g. a lasso release,
        // which always calls draw() -- the "needs a second click outside"
        // symptom this was reported as).
        const next = new Set(st.selection);
        if (next.has(hitId)) next.delete(hitId);
        else next.add(hitId);
        st.setSelection(next);
        draw();
        return;
      }
      const sel = st.selection.has(hitId) ? st.selection : new Set([hitId]);
      st.setSelection(sel);
      if (hit) {
        dragRef.current = { ids: sel, last: world, dx: 0, dy: 0, detach: e.altKey };
        (e.target as Element).setPointerCapture(e.pointerId);
      } else if (corner) {
        beginCornerDrag(corner.wire, corner.idx, corner.displayPts);
        (e.target as Element).setPointerCapture(e.pointerId);
      } else if (jh) {
        // Junctions aren't components; reuse the drag machinery (moveSelection
        // already translates selected junction positions too). Detach doesn't
        // apply -- a dragged junction just moves, wires follow it live.
        dragRef.current = { ids: sel, last: world, dx: 0, dy: 0, detach: false };
        (e.target as Element).setPointerCapture(e.pointerId);
      } else if (fh) {
        const endPos = fh.wire[fh.end];
        freeEndDragRef.current = {
          wireId: fh.wire.id,
          end: fh.end,
          pos: endPos.kind === 'free' ? { ...endPos.pos } : { ...world },
          moved: false,
        };
        (e.target as Element).setPointerCapture(e.pointerId);
      } else if (bl) {
        busLabelDragRef.current = { wireId: bl.id, t: bl.busLabelT ?? 0.5, moved: false };
        (e.target as Element).setPointerCapture(e.pointerId);
      } else if (wh) {
        beginWireDrag(wh.wire, wh.seg, world);
        (e.target as Element).setPointerCapture(e.pointerId);
      }
      return;
    }
    // Empty canvas in Select mode: empty-drag lasso-selects (decision-8).
    // Shift+left-drag is an alternate pan binding (P2.4) alongside middle-drag
    // -- trackpad users get a pan gesture with no middle button. Shift is
    // otherwise only a keydown-tap modifier here (Shift+D/Shift+F), so it
    // never collides with a held-during-drag reading.
    if (e.shiftKey) {
      beginPan(e);
      return;
    }
    if (!e.ctrlKey) st.setSelection(new Set());
    lassoRef.current = {
      start: world,
      current: world,
      base: e.ctrlKey ? new Set(st.selection) : new Set(),
    };
    (e.target as Element).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (e.pointerType === 'touch') {
      const intent = reduceGesture(gestureRef.current, {
        kind: 'move',
        point: { id: e.pointerId, x: e.clientX, y: e.clientY },
        t: e.timeStamp,
      });
      if (intent.kind === 'pinch') {
        window.clearTimeout(longPressTimer.current);
        updatePinch(intent);
        return;
      }
      if (intent.kind === 'pan') window.clearTimeout(longPressTimer.current);
    }
    lastMouseWorldRef.current = toWorld(e);
    const pan = panRef.current;
    if (pan) {
      if (Math.hypot(e.clientX - pan.startClient.x, e.clientY - pan.startClient.y) > TAP_SLOP)
        panMovedRef.current = true;
      const vp = viewportRef.current;
      setViewport({
        panX: pan.startPan.x - (e.clientX - pan.startClient.x) / vp.zoom,
        panY: pan.startPan.y - (e.clientY - pan.startClient.y) / vp.zoom,
        zoom: vp.zoom,
      });
      return;
    }
    if (mode === 'bubble') {
      onBubblePointerMove(e);
      return;
    }
    const world = toWorld(e);
    const theme = themeRef.current!;
    const dup = duplicateRef.current;
    if (dup) {
      dup.offset = computeDupOffset(dup.base, world, theme.gridSchematic);
      draw();
      return;
    }
    const cut = cutRef.current;
    if (cut) {
      cut.current = world;
      const st = store.getState();
      cut.flagged = wiresCrossedBy(
        [cut.start, cut.current],
        st.activeCircuit().wires.filter((w) => resolveWireEnd(w.a) && resolveWireEnd(w.b)),
        (end) => resolveWireEnd(end)!,
      );
      draw();
      return;
    }
    const lasso = lassoRef.current;
    if (lasso) {
      lasso.current = world;
      draw();
      return;
    }
    const fd = freeEndDragRef.current;
    if (fd) {
      const grid = theme.gridSchematic;
      const pos = { x: Math.round(world.x / grid) * grid, y: Math.round(world.y / grid) * grid };
      fd.moved = fd.moved || pos.x !== fd.pos.x || pos.y !== fd.pos.y;
      fd.pos = pos;
      draw();
      return;
    }
    const bd = busLabelDragRef.current;
    if (bd) {
      // Resolved against the SAME routes the scene draws, so the label tracks
      // the visible path even where it detours around an obstacle.
      const pts = computeRoutes().get(bd.wireId);
      if (pts) {
        const t = tAlongPolyline(pts, world);
        bd.moved = bd.moved || Math.abs(t - bd.t) > 1e-6;
        bd.t = t;
        draw();
      }
      return;
    }
    const wd = wireDragRef.current;
    if (wd) {
      const grid = theme.gridSchematic;
      if (wd.mode === 'corner') {
        // M4.3: true KiCad corner drag -- the vertex follows the cursor on
        // both axes; endpoints are untouched, each adjacent leg re-elbows.
        const target = {
          x: Math.round(world.x / grid) * grid,
          y: Math.round(world.y / grid) * grid,
        };
        const full = dragCorner(wd.displayPts, wd.cornerIdx, target);
        wd.bends = full.slice(1, -1);
        const orig = wd.displayPts[wd.cornerIdx]!;
        wd.moved = wd.moved || target.x !== orig.x || target.y !== orig.y;
        draw();
        return;
      }
      // Segment drag slides perpendicular to itself only (KiCad); the
      // along-axis drag component is ignored.
      const primaryRaw = wd.axis === 'h' ? world.y - wd.startWorld.y : world.x - wd.startWorld.x;
      const primary = Math.round(primaryRaw / grid) * grid;
      const [o0, o1] = wd.orig;
      wd.bends[wd.bi0] =
        wd.axis === 'h' ? { x: o0.x, y: o0.y + primary } : { x: o0.x + primary, y: o0.y };
      wd.bends[wd.bi0 + 1] =
        wd.axis === 'h' ? { x: o1.x, y: o1.y + primary } : { x: o1.x + primary, y: o1.y };
      wd.bends.length = wd.origBends.length;
      for (let k = 0; k < wd.origBends.length; k++)
        if (k !== wd.bi0 && k !== wd.bi0 + 1) wd.bends[k] = wd.origBends[k]!;
      wd.moved = wd.moved || primary !== 0;
      draw();
      return;
    }
    const drag = dragRef.current;
    if (drag) {
      drag.dx += world.x - drag.last.x;
      drag.dy += world.y - drag.last.y;
      drag.last = world;
      draw();
      return;
    }
    if (tool.kind === 'place') {
      // Translucent ghost of the pending component follows the snapped cursor.
      const g = theme.gridSchematic;
      const pose = ghostPoseRef.current;
      ghostRef.current.update({
        id: '__ghost',
        kind: tool.componentKind,
        // Tag glyphs (probe/busdisplay) render label ?? id -- keep the
        // internal ghost id off the canvas.
        ...(tool.componentKind === 'probe' || tool.componentKind === 'busdisplay'
          ? { label: tool.componentKind }
          : {}),
        pos: { x: Math.round(world.x / g) * g, y: Math.round(world.y / g) * g },
        rot: pose.rot,
        mirror: pose.mirror,
        ...(tool.params ? { params: tool.params } : {}),
        // P0.6 (M4.2): the actual root cause of the ghost's ChipDef-resolve
        // throw -- a "My chips" ghost never carried `defId` at all (not a
        // chipLib-timing race), so `isChipInstance` was always true with no
        // def to resolve. `geometryInput`/`resolveComponentPins` now degrade
        // to a placeholder box regardless, but this restores the ghost's
        // actual pins/box whenever the def *is* resolvable.
        ...(tool.defId ? { defId: tool.defId } : {}),
      });
      draw();
      return;
    }
    if (tool.kind === 'wire' || wiringRef.current) {
      const st = store.getState();
      const circuit = st.activeCircuit();
      const targets = collectPinTargets(circuit.components, circuit.wires, theme, st.chipLib);
      const from = wiringRef.current;
      const snap = from
        ? isFreeStart(from) || isOnWireStart(from)
          ? nearestFree(targets, world, hitScale(theme))
          : nearestCompatiblePin(
              targets,
              world,
              { width: from.width, dir: from.dir },
              hitScale(theme),
              (t) => labelExempt(circuit.components, circuit.wires, from.componentId, t),
            )
        : nearestFree(targets, world, hitScale(theme));
      setHoverPin(snap ? snap.worldPos : from ? world : undefined);
      return;
    }
    if (tool.kind === 'select') {
      // Track the hovered item so Del/R/M can act on it without a selection.
      // Junction before wire (matching onPointerDown): a junction always sits
      // on its wires' routes, so wire-first made Ctrl+X on a dot unreachable.
      hoverItemRef.current =
        topComponentAt(world)?.id ?? junctionAt(world)?.id ?? wireAt(world)?.wire.id ?? null;
      // Hover is a ref, so nothing repaints on its own: the peer-label
      // highlight needs an explicit draw, but only when the hovered LABEL
      // actually changes -- redrawing on every mouse move would be a
      // per-frame full repaint for a highlight almost nobody is looking at.
      const hoveredLabelName = (() => {
        const id = hoverItemRef.current;
        if (!id) return null;
        const c = store
          .getState()
          .activeCircuit()
          .components.find((x) => x.id === id);
        return c?.kind === 'netlabel' ? (c.label ?? '').trim() || null : null;
      })();
      if (hoveredLabelName !== hoverLabelNameRef.current) {
        hoverLabelNameRef.current = hoveredLabelName;
        draw();
      }
      // Schematic wire hover -> waveform track highlight (panel open + powered).
      const st = store.getState();
      if (st.waveformOpen && st.powered && activeTab.kind === 'board') {
        const hitWire = wireAt(world)?.wire;
        let trackPath: string | null = null;
        if (hitWire) {
          const end = [hitWire.a, hitWire.b].find((x) => x.kind === 'pin');
          const net = end && end.kind === 'pin' ? st.netOfPin(end.component, end.pin) : undefined;
          if (net !== undefined) {
            for (const c of st.board.components) {
              const pin = TRACK_PIN[c.kind];
              if (pin && st.netOfPin(c.id, pin) === net) {
                trackPath = `main/${c.label || c.id}`;
                break;
              }
            }
          }
        }
        st.setHoverTrack(trackPath);
      }
    }
  };

  const onPointerUp = (e?: React.PointerEvent) => {
    if (e && e.pointerType === 'touch') {
      window.clearTimeout(longPressTimer.current);
      reduceGesture(gestureRef.current, { kind: 'up', id: e.pointerId, t: e.timeStamp });
      // One finger lifted: end the pinch rather than reinterpreting the
      // remaining finger's position as a drag from where the pinch started.
      if (gestureRef.current.points.length < 2) pinchRef.current = null;
      // A hover cue has no way to expire on touch: the finger lifts and no
      // further move ever arrives to move or clear it, so the pin ghost sat
      // there for good. With a wire still in flight it is not hover at all --
      // it shows where that wire will land -- so it stays.
      if (!wiringRef.current) setHoverPin(undefined);
    }
    panRef.current = null;
    if (heldButtonsRef.current.size > 0) {
      const st = store.getState();
      for (const id of heldButtonsRef.current) st.setButtonHeld(id, false, prefix);
      heldButtonsRef.current.clear();
      // setButtonHeld's rev bump drives the redraw effect; see the matching
      // note in onPointerDown.
      return;
    }
    if (mode === 'bubble') {
      onBubblePointerUp();
      return;
    }
    const cut = cutRef.current;
    if (cut) {
      cutRef.current = null;
      store.getState().deleteWires(cut.flagged);
      draw();
      return;
    }
    const lasso = lassoRef.current;
    if (lasso) {
      lassoRef.current = null;
      const ids = idsInRect(rectFromPoints(lasso.start, lasso.current));
      const st = store.getState();
      st.setSelection(new Set([...lasso.base, ...ids]));
      // What you do with a selection is move it, and under the lasso tool that
      // drag would draw another marquee. A drag that drew one hands the tool
      // back; a tap that drew nothing keeps it armed, so a mis-tap does not
      // disarm it.
      const drew = lasso.start.x !== lasso.current.x || lasso.start.y !== lasso.current.y;
      if (drew && st.tool.kind === 'lasso') st.setTool({ kind: 'select' });
      draw();
      return;
    }
    const fd = freeEndDragRef.current;
    if (fd) {
      freeEndDragRef.current = null;
      if (fd.moved) {
        // Landing on a pin converts the end in place; junction/wire-body
        // landings materialize inside the store (same rules as drawing).
        const st = store.getState();
        const theme = themeRef.current!;
        const circuit = st.activeCircuit();
        const pin = nearestFree(
          collectPinTargets(circuit.components, circuit.wires, theme, st.chipLib),
          fd.pos,
          hitScale(theme),
        );
        st.moveFreeEnd(fd.wireId, fd.end, fd.pos, {
          grid: theme.gridSchematic,
          resolveEnd: resolveWireEnd,
          ...(pin ? { pinEnd: { kind: 'pin', component: pin.componentId, pin: pin.pinName } } : {}),
        });
      } else draw();
      return;
    }
    const bd = busLabelDragRef.current;
    if (bd) {
      busLabelDragRef.current = null;
      if (bd.moved) store.getState().setBusLabelT(bd.wireId, bd.t);
      else draw();
      return;
    }
    const wd = wireDragRef.current;
    if (wd) {
      wireDragRef.current = null;
      if (wd.moved) {
        // M4.3: normalize against the wire's real (fixed) endpoints on
        // commit for both modes -- drops a bend that ended up collinear/
        // coincident with a neighbor or an endpoint (e.g. a corner dragged
        // back onto a straight line).
        const [endA, endB]: [Vec2, Vec2] =
          wd.mode === 'corner'
            ? [wd.displayPts[0]!, wd.displayPts[wd.displayPts.length - 1]!]
            : [wd.pinA, wd.pinB];
        const normalized = normalizeBends([endA, ...wd.bends, endB]).slice(1, -1);
        store.getState().setWirePoints(wd.wireId, normalized);
      } else draw();
      return;
    }
    const drag = dragRef.current;
    if (drag) {
      const grid = themeRef.current!.gridSchematic;
      const dx = Math.round(drag.dx / grid) * grid;
      const dy = Math.round(drag.dy / grid) * grid;
      const sel = drag.ids;
      const detach = drag.detach;
      dragRef.current = null;
      if (dx || dy) {
        if (detach) {
          const st = store.getState();
          const ends: { wireId: string; end: 'a' | 'b'; pos: Vec2 }[] = [];
          for (const w of st.activeCircuit().wires) {
            if (w.a.kind === 'pin' && sel.has(w.a.component)) {
              const p = resolveWireEnd(w.a);
              if (p) ends.push({ wireId: w.id, end: 'a', pos: p });
            }
            if (w.b.kind === 'pin' && sel.has(w.b.component)) {
              const p = resolveWireEnd(w.b);
              if (p) ends.push({ wireId: w.id, end: 'b', pos: p });
            }
          }
          st.moveSelectionDetached(dx, dy, ends);
        } else if (!trySpliceOnDrag(sel, dx, dy)) {
          // Bug B: dragging an existing unwired 1-in/1-out component onto a
          // wire splices it in, one undo step, in place of a plain move.
          store.getState().moveSelection(dx, dy, resolveWireEnd);
        }
      } else draw();
    }
  };

  // Resolve which DIP-bank cell a click landed on, in the component's local
  // space (worldToLocal handles rot/mirror); width-1 toggles always toggle
  // bit 0 (dipCellIndexAt only applies to the width>1 glyph).
  const dipBankBitAt = (c: Component, world: Vec2): number => {
    const width = Number(c.params?.['width'] ?? 1);
    if (width <= 1) return 0;
    const theme = themeRef.current!;
    const params = (c.params as Record<string, ParamValue>) ?? {};
    const local = buildLocalGeometry(
      { kind: c.kind, params, pins: primitivePins(c.kind, params) },
      theme,
    );
    const placement = { pos: c.pos, rot: c.rot, mirror: c.mirror };
    const localPt = worldToLocal(world, local.bounds, placement);
    const l = dipBankLayout(theme.gridSchematic, width, ['y']);
    return dipCellIndexAt(l, localPt.y) ?? 0;
  };

  const onCanvasClick = (e: React.MouseEvent) => {
    // Click a switch to drive it while powered. Ports are ChipDef
    // boundary pins, not sources -- they never respond to a click (P0.3:
    // reverted click-to-toggle, see toggleInput's comment). `button` is
    // momentary and handled in onPointerDown/Up instead (press-and-hold).
    if (mode === 'bubble') return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const world = screenToWorld(viewportRef.current, {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
    const c = topComponentAt(world);
    // A tap selects. View-only needs it to name what you are looking at, and
    // touch editing needs it because a bare finger drag now pans rather than
    // starting a selection drag -- so tapping is the only way to pick the
    // handle that a subsequent drag moves. It selects any handle, not just a
    // component: tapping a wire used to clear the selection, which left no way
    // to pick one up at all.
    if ((viewOnlyRef.current || coarseRef.current) && !panMovedRef.current) {
      const id = handleIdAt(world);
      store.getState().setSelection(id ? new Set([id]) : new Set());
      draw();
    }
    if (!powered) return;
    if (c && c.kind === 'toggle') {
      store.getState().toggleInput(c.id, dipBankBitAt(c, world), prefix);
    }
  };

  // The button's click target is its circular cap, not the square housing
  // around it -- resolve to local space the same way dipBankBitAt does.
  const buttonHit = (c: Component, world: Vec2): boolean => {
    const theme = themeRef.current!;
    const params = (c.params as Record<string, ParamValue>) ?? {};
    const local = buildLocalGeometry(
      { kind: c.kind, params, pins: primitivePins(c.kind, params) },
      theme,
    );
    const placement = { pos: c.pos, rot: c.rot, mirror: c.mirror };
    const localPt = worldToLocal(world, local.bounds, placement);
    const cap = buttonCapCircle(buttonLayout(theme.gridSchematic, 'y'));
    return Math.hypot(localPt.x - cap.cx, localPt.y - cap.cy) <= cap.r;
  };

  // A component's own bounds in screen space at popup-open time, for the
  // clamp-into-canvas layout effect below.
  const anchorFromBounds = (bounds: Rect): PopupAnchor => {
    const tl = worldToScreen(viewportRef.current, { x: bounds.x, y: bounds.y });
    const br = worldToScreen(viewportRef.current, {
      x: bounds.x + bounds.w,
      y: bounds.y + bounds.h,
    });
    return { compLeft: tl.x, compTop: tl.y, compRight: br.x, compBottom: br.y };
  };

  const onCanvasDoubleClick = (e: React.MouseEvent) =>
    openParamsAt(e.clientX, e.clientY, e.shiftKey);

  // Double-tap is not available to us -- iOS reserves it for zoom -- so on
  // touch this is reached by a long press instead. One body, so the parameter
  // overlay behaves identically whichever way it was opened.
  const openParamsAt = (clientX: number, clientY: number, shift: boolean) => {
    if (mode === 'bubble' || viewOnlyRef.current) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const world = screenToWorld(viewportRef.current, {
      x: clientX - rect.left,
      y: clientY - rect.top,
    });
    const c = topComponentAt(world);
    if (!c) return;
    // Parameter edits are topology-affecting board edits -- never pop up
    // while powered (the live sim would be edited out from under itself).
    if (c.kind === 'clock' && !powered) {
      // Clock param editor (closes the deferred M6 clock-rate item): shown in
      // ns, stored as integer ps; commits as a board edit (one undo step).
      const theme = themeRef.current!;
      const bounds = symbolBounds(c, theme).bounds;
      const screen = worldToScreen(viewportRef.current, { x: bounds.x, y: bounds.y + bounds.h });
      setClockEdit({
        id: c.id,
        screen,
        anchor: anchorFromBounds(bounds),
        name: c.label ?? '',
        periodNs: Number(c.params?.['periodPs'] ?? 10_000) / 1000,
        dutyPct: Number(c.params?.['dutyPercent'] ?? 50),
        phaseNs: Number(c.params?.['phasePs'] ?? 0) / 1000,
      });
      return;
    }
    // Task 1: opening a chip instance's internals moves to Shift+double-
    // click -- plain double-click is now the uniform param/name overlay for
    // every kind, chip instances included (their own n-bit pinView params).
    if (c.kind === 'chip' && c.defId && shift) {
      const st = store.getState();
      const def = st.chipLib.get(c.defId);
      if (!def) return;
      const label = c.label || c.id;
      const nextPrefix = `${prefix}${label}:${def.name}/`;
      const parentLabel =
        activeTab.kind === 'board' ? st.board.name || 'Board' : activeTab.breadcrumb;
      st.openDefTab(c.defId, nextPrefix, `${parentLabel} ▸ ${label}: ${def.name}`);
      return;
    }
    if (
      !powered &&
      (c.kind === 'chip' ||
        c.kind === 'toggle' ||
        c.kind === 'constant' ||
        c.kind === 'decoder' ||
        c.kind === 'encoder' ||
        c.kind === 'mux' ||
        c.kind === 'demux' ||
        VARIABLE_ARITY_GATES.has(c.kind) ||
        WIDTH_LABEL_KINDS.has(c.kind))
    ) {
      const theme = themeRef.current!;
      const bounds = symbolBounds(c, theme).bounds;
      const screen = worldToScreen(viewportRef.current, { x: bounds.x, y: bounds.y + bounds.h });
      const width = Number(c.params?.['width'] ?? 1);
      // Every kind reaching this branch is name-able (Task 1a) -- the branch's
      // own condition list above is the actual gate on which kinds get an
      // overlay at all.
      const labelable = true;
      const noWidthField = c.kind === 'decoder' || c.kind === 'encoder' || c.kind === 'chip';
      // Task 6: a multi-selection containing the double-clicked component
      // batches -- the shown/applied fields are the intersection of every
      // selected component's own descriptor-key set (paramSpecs.ts), empty
      // intersection falls back to today's single-component full field set.
      let batchIds = [c.id];
      let batchKeys: ReadonlySet<string> | undefined;
      if (selection.size > 1 && selection.has(c.id)) {
        const circuit = store.getState().activeCircuit();
        const selComps = [...selection]
          .map((id) => circuit.components.find((x) => x.id === id))
          .filter((x): x is Component => !!x);
        const keySets = selComps.map((sc) => paramKeysFor(sc.kind, (sc.params ?? {}) as Params));
        const intersection = keySets.reduce(
          (acc, s) => new Set([...acc].filter((k) => s.has(k))),
          keySets[0] ?? new Set<string>(),
        );
        if (intersection.size > 0) {
          batchIds = selComps.map((sc) => sc.id);
          batchKeys = intersection;
        }
      }
      setParamEdit({
        id: c.id,
        kind: c.kind,
        screen,
        anchor: anchorFromBounds(bounds),
        ids: batchIds,
        ...(batchKeys ? { batchKeys } : {}),
        focusedField: null,
        ...(labelable
          ? { name: c.label ?? (c.kind === 'inport' || c.kind === 'outport' ? c.id : '') }
          : {}),
        ...(noWidthField ? {} : { width }),
        ...(c.kind === 'toggle' ? { initial: Number(c.params?.['initial'] ?? 0) } : {}),
        ...(c.kind === 'constant' ? { valueText: String(Number(c.params?.['value'] ?? 0)) } : {}),
        ...(c.kind === 'decoder'
          ? {
              inputs: Number(c.params?.['addressBits'] ?? 2),
              hasEnable: Boolean(c.params?.['hasEnable'] ?? false),
            }
          : {}),
        ...(c.kind === 'encoder' ? { inputs: Number(c.params?.['addressBits'] ?? 2) } : {}),
        ...(c.kind === 'mux'
          ? {
              inputs: Number(c.params?.['selectBits'] ?? 2),
              hasEnable: Boolean(c.params?.['hasEnable'] ?? false),
              selSide: c.params?.['selSide'] === 'top' ? 'top' : 'bottom',
            }
          : {}),
        // demux reuses the `inputs` overlay field for its own `selectBits`
        // param (same 1..4 numeric UI as mux) -- mapped back at commit.
        ...(c.kind === 'demux'
          ? {
              inputs: Number(c.params?.['selectBits'] ?? 2),
              hasEnable: Boolean(c.params?.['hasEnable'] ?? false),
              selSide: c.params?.['selSide'] === 'top' ? 'top' : 'bottom',
            }
          : {}),
        ...(VARIABLE_ARITY_GATES.has(c.kind)
          ? { inputs: Number(c.params?.['inputs'] ?? 2), swapKind: c.kind }
          : {}),
        // Seeded from the primitive's own actual pins() shape, not a
        // hardcoded per-kind default (pinViewUI.ts), so it's always accurate
        // regardless of what arity/width/inputs the overlay's other fields
        // still hold from a previous edit.
        pinView: currentPinView(c.kind, c.params ?? {}),
      });
      return;
    }
    // netlabel joins the plain-rename set: its name IS its function (same
    // text joins nets), and it has no width of its own to edit.
    const renameKinds = new Set(['button', 'netlabel']);
    if (!powered && renameKinds.has(c.kind)) {
      // Ports aren't chip instances, so double-click is free for an
      // inline rename here (chip instances keep "open internals" below).
      // button has no width param, so it keeps the plain rename overlay;
      // input/output/toggle/probe/busdisplay/led moved to the width+label
      // paramEdit overlay above.
      const theme = themeRef.current!;
      const def = c.defId ? store.getState().chipLib.get(c.defId) : undefined;
      const bounds = symbolBounds(c, theme, def).bounds;
      const screen = worldToScreen(viewportRef.current, { x: bounds.x, y: bounds.y });
      setRenaming({ id: c.id, screen, value: c.label ?? '' });
      return;
    }
  };

  // Maps the overlay's own flat fields back onto the per-kind param shape
  // pinViewGroupsFor expects, so its group list reflects arity/width/size
  // edits made earlier in the same open overlay, not just the value the
  // component had when the overlay opened.
  const paramEditPinViewParams = (
    pe: NonNullable<typeof paramEdit>,
  ): Record<string, ParamValue> => {
    const p: Record<string, ParamValue> = {};
    if (pe.width !== undefined) p['width'] = pe.width;
    if (pe.inputs !== undefined) {
      const key =
        pe.kind === 'mux' || pe.kind === 'demux'
          ? 'selectBits'
          : pe.kind === 'decoder' || pe.kind === 'encoder'
            ? 'addressBits'
            : 'inputs';
      p[key] = pe.inputs;
    }
    return p;
  };

  // Task 6: a field renders (and applies to the batch) only when this isn't
  // a batch at all (`batchKeys` undefined -- today's single-component shape)
  // or when the shared descriptor-key intersection actually contains it.
  const paramEditFieldVisible = (pe: NonNullable<typeof paramEdit>, key: string): boolean =>
    !pe.batchKeys || pe.batchKeys.has(key);

  // Decision 5: highlight every selected component sharing a field while
  // that field has focus.
  const paramEditFocusHandlers = (
    set: typeof setParamEdit,
    key: string,
  ): { onFocus: () => void; onBlur: () => void } => ({
    onFocus: () => set((cur) => (cur ? { ...cur, focusedField: key } : cur)),
    onBlur: () => set((cur) => (cur ? { ...cur, focusedField: null } : cur)),
  });

  // Maps a batchable param key back to the overlay's own flat field that
  // holds its raw (double-clicked-component-shaped) entered value --
  // gate's `inputs`, mux/demux's `selectBits`, and decoder/encoder's
  // `addressBits` all share the same `inputs` overlay slot (the overlay
  // renders one size control either way; the actual param key each writes
  // to is what keeps their identities distinct for batching).
  const paramEditRawFieldValue = (
    pe: NonNullable<typeof paramEdit>,
    key: string,
  ): ParamValue | undefined => {
    switch (key) {
      case 'width':
        return pe.width;
      case 'inputs':
      case 'selectBits':
      case 'addressBits':
        return pe.inputs;
      case 'hasEnable':
        return pe.hasEnable;
      case 'selSide':
        return pe.selSide;
      case 'initial':
        return pe.initial;
      case 'value':
        return parseConstantValue(pe.valueText ?? '0') ?? undefined;
      default:
        return undefined;
    }
  };

  // Batch specs for every OTHER selected component sharing `paramEdit`'s
  // descriptor-key intersection -- each key's raw value goes through
  // `clampParamValue` against THAT component's own kind/domain (decision 2:
  // "component whose own domain accepts it," everything else silently
  // skipped). Name/pinView never batch (decisions 1/4), so this never
  // touches either.
  const paramEditBatchSpecs = (
    pe: NonNullable<typeof paramEdit>,
  ): { id: string; params: Record<string, ParamValue> }[] => {
    if (!pe.batchKeys) return [];
    const circuit = store.getState().activeCircuit();
    const specs: { id: string; params: Record<string, ParamValue> }[] = [];
    for (const otherId of pe.ids) {
      if (otherId === pe.id) continue;
      const otherComp = circuit.components.find((c) => c.id === otherId);
      if (!otherComp) continue;
      const otherParams: Record<string, ParamValue> = {};
      for (const key of pe.batchKeys) {
        const raw = paramEditRawFieldValue(pe, key);
        if (raw === undefined) continue;
        const v = clampParamValue(otherComp.kind, key, raw);
        if (v !== null) otherParams[key] = v;
      }
      if (Object.keys(otherParams).length > 0) specs.push({ id: otherId, params: otherParams });
    }
    return specs;
  };

  // Width/param overlay commit (clock precedent): clamps width 1..32,
  // decoder/encoder addressBits and mux/demux selectBits 1..4, validates
  // constant value; warn-flashes and keeps the overlay open on any invalid
  // entry instead of silently no-op'ing.
  const commitParamEdit = () => {
    if (!paramEdit) return;
    const flash = () => setParamEdit({ ...paramEdit, flash: true });
    if (paramEdit.kind === 'chip') {
      // A chip instance has no primitive registration (getPrimitive('chip')
      // throws), so it can never go through setComponentParamsBatch's
      // pin-diff plan -- name-only, via the same rename path renameComponent
      // uses (also derives every net the instance owns, Task 1b).
      const ok = store.getState().renameComponent(paramEdit.id, paramEdit.name ?? '');
      if (ok) setParamEdit(null);
      else flash();
      return;
    }
    if (VARIABLE_ARITY_GATES.has(paramEdit.kind)) {
      // Arity + width commit together via setComponentParams -- one undo
      // step, dropping wires to any pin the new arity removes;
      // setGateInputCount/the +/- keyboard shortcut still handle arity
      // alone via the same underlying pin-diff logic.
      const n = paramEdit.inputs ?? 2;
      if (!Number.isFinite(n)) return flash();
      if (paramEdit.width === undefined || !Number.isFinite(paramEdit.width)) return flash();
      const ok = store.getState().setComponentParamsBatch([
        {
          id: paramEdit.id,
          params: {
            inputs: clampInt(n, 2, 8),
            width: clampInt(paramEdit.width, 1, MAX_WIDTH),
            pinView: serializePinView(paramEdit.pinView),
          },
          ...(paramEdit.name !== undefined ? { label: paramEdit.name } : {}),
          ...(paramEdit.swapKind && paramEdit.swapKind !== paramEdit.kind
            ? { kind: paramEdit.swapKind }
            : {}),
        },
        ...paramEditBatchSpecs(paramEdit),
      ]);
      if (ok) setParamEdit(null);
      else flash();
      return;
    }
    const params: Record<string, number | boolean | string> = {};
    if (paramEdit.kind === 'decoder') {
      if (paramEdit.inputs === undefined || !Number.isFinite(paramEdit.inputs)) return flash();
      params['addressBits'] = clampInt(paramEdit.inputs, 1, 4);
      params['hasEnable'] = !!paramEdit.hasEnable;
      params['pinView'] = serializePinView(paramEdit.pinView);
    } else if (paramEdit.kind === 'encoder') {
      if (paramEdit.inputs === undefined || !Number.isFinite(paramEdit.inputs)) return flash();
      params['addressBits'] = clampInt(paramEdit.inputs, 1, 4);
      params['pinView'] = serializePinView(paramEdit.pinView);
    } else if (paramEdit.kind === 'mux' || paramEdit.kind === 'demux') {
      if (paramEdit.inputs === undefined || !Number.isFinite(paramEdit.inputs)) return flash();
      if (paramEdit.width === undefined || !Number.isFinite(paramEdit.width)) return flash();
      params['selectBits'] = clampInt(paramEdit.inputs, 1, 4);
      params['width'] = clampInt(paramEdit.width, 1, MAX_WIDTH);
      params['hasEnable'] = !!paramEdit.hasEnable;
      params['selSide'] = paramEdit.selSide === 'top' ? 'top' : 'bottom';
      params['pinView'] = serializePinView(paramEdit.pinView);
    } else if (paramEdit.kind === 'constant') {
      const parsed = parseConstantValue(paramEdit.valueText ?? '0');
      if (parsed === null) return flash();
      if (paramEdit.width === undefined || !Number.isFinite(paramEdit.width)) return flash();
      params['width'] = clampInt(paramEdit.width, 1, MAX_WIDTH);
      params['value'] = parsed;
    } else {
      if (paramEdit.width === undefined || !Number.isFinite(paramEdit.width)) return flash();
      const width = clampInt(paramEdit.width, 1, MAX_WIDTH);
      params['width'] = width;
      params['pinView'] = serializePinView(paramEdit.pinView);
      if (paramEdit.kind === 'toggle') {
        const initial = paramEdit.initial ?? 0;
        if (!Number.isFinite(initial)) return flash();
        params['initial'] = clampInt(initial, 0, width >= 32 ? 0xffffffff : (1 << width) - 1);
      }
    }
    const ok = store.getState().setComponentParamsBatch([
      {
        id: paramEdit.id,
        params,
        ...(paramEdit.name !== undefined ? { label: paramEdit.name } : {}),
      },
      ...paramEditBatchSpecs(paramEdit),
    ]);
    if (ok) setParamEdit(null);
    else flash();
  };

  // Effect below registers once per open/close, so it calls through this
  // ref rather than closing over a stale paramEdit snapshot (drawRef precedent).
  const commitParamEditRef = useRef(commitParamEdit);
  commitParamEditRef.current = commitParamEdit;

  // Click outside the open param popup commits it, same rule as Enter (a
  // flash on invalid input keeps it open) -- a stray click shouldn't discard.
  const paramEditOpen = !!paramEdit;
  useEffect(() => {
    if (!paramEditOpen) return;
    const onDocPointerDown = (e: PointerEvent) => {
      if (paramEditBoxRef.current && !paramEditBoxRef.current.contains(e.target as Node)) {
        commitParamEditRef.current();
      }
    };
    document.addEventListener('pointerdown', onDocPointerDown, true);
    return () => document.removeEventListener('pointerdown', onDocPointerDown, true);
  }, [paramEditOpen]);

  // Once the popup has actually rendered (real size known -- content height
  // varies by kind/field values, so this can't be computed at open time),
  // flip/clamp it into the canvas if the default below-left anchor would
  // have placed it outside. Runs once per open (keyed on id), not on every
  // field edit, so it doesn't jitter while the user is still typing.
  useLayoutEffect(() => {
    if (!paramEdit || !paramEditBoxRef.current || !canvasRef.current) return;
    const popupRect = paramEditBoxRef.current.getBoundingClientRect();
    const canvasRect = canvasRef.current.getBoundingClientRect();
    const { x, y } = clampPopupToCanvas(
      paramEdit.anchor,
      { w: popupRect.width, h: popupRect.height },
      { w: canvasRect.width, h: canvasRect.height },
    );
    if (x !== paramEdit.screen.x || y !== paramEdit.screen.y) {
      setParamEdit((cur) => (cur ? { ...cur, screen: { x, y } } : cur));
    }
  }, [paramEdit?.id]);

  useLayoutEffect(() => {
    if (!clockEdit || !clockEditBoxRef.current || !canvasRef.current) return;
    const popupRect = clockEditBoxRef.current.getBoundingClientRect();
    const canvasRect = canvasRef.current.getBoundingClientRect();
    const { x, y } = clampPopupToCanvas(
      clockEdit.anchor,
      { w: popupRect.width, h: popupRect.height },
      { w: canvasRect.width, h: canvasRect.height },
    );
    if (x !== clockEdit.screen.x || y !== clockEdit.screen.y) {
      setClockEdit((cur) => (cur ? { ...cur, screen: { x, y } } : cur));
    }
  }, [clockEdit?.id]);

  // --- Menu bar contribution -------------------------------------------------
  // Rebuilt whenever the state these handlers read changes: a menu item is a
  // closure, and a stale one acts on a stale value. The commands themselves are
  // the same ones the keys and the toolbar call -- nothing is reimplemented here.
  const circuitMenus = useMemo<Menu[]>(() => {
    const st = () => store.getState();
    const sel = () => st().selection;
    const pickers = filePickersSupported();
    // What the selection can actually accept. A command that is offered and
    // then does nothing is worse than one that is absent: on touch the action
    // bar drops whatever is disabled, so this is also what keeps a tap on an
    // AND gate from offering it a bubble conversion.
    const selected = st()
      .activeCircuit()
      .components.filter((c) => selection.has(c.id));
    const convertibleSelected = selected.some(
      (c) => (c.kind === 'buf' || c.kind === 'not') && Number(c.params?.['width'] ?? 1) <= 1,
    );
    const groupedSelected = selected.some((c) => c.group);
    return [
      {
        // Only the two commands that need the canvas: Import lands at the
        // current view's centre, Package reads the live selection. The rest of
        // File comes from the shell's document layer and merges in above.
        id: 'file',
        items: [
          {
            id: 'import',
            label: 'Import circuit...',
            disabled: !pickers,
            run: () => void fileImport(),
          },
          { id: 'package', label: 'Package as chip...', run: () => setPackaging(true) },
        ],
      },
      {
        id: 'edit',
        items: [
          { id: 'undo', label: 'Undo', shortcut: SHORTCUTS.undo, run: () => st().undo() },
          { id: 'redo', label: 'Redo', shortcut: SHORTCUTS.redo, run: () => st().redo() },
          { separator: true },
          {
            id: 'copy',
            label: 'Copy',
            shortcut: SHORTCUTS.copy,
            disabled: selection.size === 0,
            run: copySelection,
          },
          {
            id: 'paste',
            label: 'Paste',
            shortcut: SHORTCUTS.paste,
            disabled: !clipboardRef.current,
            run: pasteClipboard,
          },
          { separator: true },
          {
            id: 'delete',
            label: 'Delete',
            shortcut: SHORTCUTS.delete,
            disabled: selection.size === 0,
            run: () => st().deleteSelection(undefined, resolveWireEnd),
          },
          {
            id: 'deleteHeal',
            label: 'Delete and reconnect',
            shortcut: SHORTCUTS.deleteHeal,
            // Offered only where healing is possible: everywhere else it was
            // a plain Delete wearing a second name, which on the touch action
            // bar meant two identical-looking buttons.
            disabled: !canHealSelection(st().activeCircuit(), selection),
            run: () => st().deleteWithHeal(undefined, resolveWireEnd),
          },
          { separator: true },
          // Rotate and mirror were keyboard-only, which made them invisible to
          // anyone not already holding the shortcut list -- and unreachable
          // entirely by finger. They run the same handlers the keys do, so the
          // action bar can render these commands rather than grow a copy.
          {
            id: 'duplicate',
            label: 'Duplicate',
            shortcut: SHORTCUTS.duplicate,
            disabled: selection.size === 0,
            run: () => startDuplicate(sel()),
          },
          {
            id: 'rotate',
            label: 'Rotate',
            shortcut: SHORTCUTS.rotate,
            disabled: selection.size === 0,
            run: () => rotateSelectionIndividually(sel()),
          },
          {
            id: 'rotateGroup',
            label: 'Rotate group',
            shortcut: SHORTCUTS.rotateGroup,
            disabled: selection.size < 2,
            run: () => applyGroupRotateFromSelection(sel()),
          },
          {
            id: 'mirror',
            label: 'Mirror',
            shortcut: SHORTCUTS.mirror,
            disabled: selection.size === 0,
            run: () => st().mirrorSelection(sel()),
          },
          {
            id: 'convertBubble',
            label: 'Bubble ⇄ NOT gate',
            shortcut: SHORTCUTS.convertBubble,
            // The bare-marker glyph is a 1-bit buf/not convention; everything
            // else refuses the conversion. Offering it on an AND gate is an
            // offer the command cannot keep.
            disabled: !convertibleSelected,
            run: () => st().convertBubble(sel(), convertReanchor, bubbleGeom()),
          },
          { separator: true },
          {
            id: 'connect',
            label: 'Connect selected',
            shortcut: SHORTCUTS.smartConnect,
            disabled: selection.size < 2,
            run: proposeSmartConnect,
          },
          { separator: true },
          {
            id: 'group',
            label: 'Group',
            shortcut: SHORTCUTS.group,
            disabled: selection.size === 0,
            run: () => void st().groupSelection(),
          },
          {
            id: 'ungroup',
            label: 'Ungroup',
            shortcut: SHORTCUTS.ungroup,
            disabled: !groupedSelected,
            run: () => st().ungroupSelection(),
          },
          { separator: true },
          ...ALIGN_ITEMS.map(([mode, label]) => ({
            id: `align-${mode}`,
            label,
            disabled: selection.size < 2,
            run: () => applyAlignFromSelection(sel(), mode),
          })),
          ...DISTRIBUTE_ITEMS.map(([axis, label]) => ({
            id: `distribute-${axis}`,
            label,
            // Evenly spacing two things is just leaving them where they are.
            disabled: selection.size < 3,
            run: () => applyDistributeFromSelection(sel(), axis),
          })),
          ...PACK_ITEMS.map(([axis, label]) => ({
            id: `pack-${axis}`,
            label,
            disabled: selection.size < 2,
            run: () => applyPackFromSelection(sel(), axis),
          })),
          {
            id: 'tidyWiring',
            label: selection.size > 0 ? 'Tidy wiring in selection' : 'Tidy wiring',
            run: () => tidyWiring(sel()),
          },
        ],
      },
      {
        id: 'view',
        items: [
          { id: 'fit', label: 'Zoom to fit', shortcut: 'Home', run: fitView },
          {
            id: 'viewOnly',
            label: 'View only (no editing)',
            checked: viewOnly,
            run: () => setViewOnly((v) => !v),
          },
          { separator: true },
          {
            id: 'analyze',
            label: 'Analyze drawer',
            checked: analyzeOpen,
            run: () => (analyzeOpen ? closeAnalyze() : tryOpenAnalyze()),
          },
          {
            id: 'waveform',
            label: 'Waveform panel',
            checked: waveformOpen,
            run: () => st().setWaveformOpen(!waveformOpen),
          },
        ],
      },
      {
        id: 'simulate',
        items: [
          {
            id: 'power',
            label: powered ? 'Power off' : 'Power on',
            shortcut: SHORTCUTS.power,
            run: () => st().power(),
          },
          {
            id: 'run',
            label: running ? 'Pause' : 'Run',
            disabled: !powered,
            run: () => st().toggleRun(),
          },
          {
            id: 'step',
            label: 'Step to next event',
            shortcut: SHORTCUTS.step,
            disabled: !canStep,
            run: () => st().step(),
          },
          { separator: true },
          {
            id: 'timing',
            label: 'Datasheet timing',
            checked: timing.mode === 'datasheet',
            run: () => st().setTiming({ mode: timing.mode === 'ideal' ? 'datasheet' : 'ideal' }),
          },
          {
            id: 'sta',
            label: 'Run static timing analysis',
            disabled: timing.mode !== 'datasheet',
            run: () => st().runSta(),
          },
          { separator: true },
          {
            id: 'bubble',
            label: 'Bubble-push mode',
            shortcut: SHORTCUTS.bubbleMode,
            checked: mode === 'bubble',
            run: () => (mode === 'bubble' ? st().exitBubbleMode() : st().enterBubbleMode()),
          },
        ],
      },
    ];
    // `rev` so the heal test re-runs when the wires around a selected junction
    // change without the selection itself changing.
  }, [
    selection,
    rev,
    analyzeOpen,
    waveformOpen,
    powered,
    running,
    canStep,
    timing,
    mode,
    viewOnly,
  ]);
  useContributeMenus('circuit', circuitMenus);

  const selectedComponent =
    viewOnly && selection.size === 1
      ? store
          .getState()
          .activeCircuit()
          .components.find((c) => selection.has(c.id))
      : undefined;

  if (viewOnly)
    return (
      <div className="circuit-editor circuit-editor--view-only">
        <div className="circuit-toolbar">
          <div className="tool-group">
            <ToolBtn
              icon="power"
              active={powered}
              title={`Compile and settle; all nets start at X${key('Space')}`}
              onClick={() => store.getState().power()}
            >
              {powered ? 'Power off' : 'Power on'}
            </ToolBtn>
            <ToolBtn
              icon={running ? 'pause' : 'run'}
              active={running}
              disabled={!powered}
              title="Free-run clocks"
              onClick={() => store.getState().toggleRun()}
            >
              {running ? 'Pause ⏸' : 'Run ▸'}
            </ToolBtn>
            <ToolBtn
              icon="analyze"
              active={analyzeOpen}
              title="Truth table + K-map drawer for the board"
              onClick={() => (analyzeOpen ? closeAnalyze() : tryOpenAnalyze())}
            >
              Analyze
            </ToolBtn>
            <ToolBtn icon="fit" title={`Fit the board to the view${key('Home')}`} onClick={fitView}>
              Fit
            </ToolBtn>
            {compact && examplesCmd && !examplesCmd.disabled ? (
              <ToolBtn icon="open" title="Open a bundled example board" onClick={examplesCmd.run}>
                Examples
              </ToolBtn>
            ) : null}
          </div>
          {/* Never leave someone poking at a canvas wondering why nothing
              happens; this is also the way back to editing. */}
          <button type="button" className="tool-btn" onClick={() => setViewOnly(false)}>
            <span className="tool-btn__label">Leave view-only</span>
          </button>
        </div>
        <div className="circuit-body">
          <div className="circuit-canvas-wrap" ref={containerRef}>
            <canvas
              ref={canvasRef}
              className="circuit-canvas"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onClick={onCanvasClick}
            />
            {error && <div className="circuit-error">{error}</div>}
          </div>
        </div>
        {selectedComponent && (
          <div className="circuit-inspector">
            <b>{selectedComponent.label ?? selectedComponent.id}</b>
            <span className="hint">{selectedComponent.kind}</span>
            {powered && <span className="hint">{press} a switch to drive it</span>}
          </div>
        )}
      </div>
    );

  return (
    <div className="circuit-editor">
      <div className="circuit-toolbar">
        {mode === 'bubble' && (
          <>
            <div className="tool-group">
              <ToolBtn
                icon="bubble"
                active
                title="Leave bubble-push mode and unlock editing (B)"
                onClick={() => store.getState().exitBubbleMode()}
              >
                Bubble push
              </ToolBtn>
              <span className="bubble-mode-badge">(circuit locked)</span>
            </div>
            <div className="tool-group">
              <ToolBtn
                icon="doubleNot"
                active={bubblePairMode}
                title={`Insert a ¬¬ pair on a wire (${press} one${coarse ? '' : ', or Tab to it and press Enter'})`}
                onClick={() => store.getState().setBubblePairMode(!bubblePairMode)}
              >
                Insert ¬¬
              </ToolBtn>
              <button
                type="button"
                className="tool-btn"
                title={`Undo${key('Ctrl+Z')}`}
                onClick={() => store.getState().undo()}
              >
                <ToolIcon name="undo" />
                <span className="tool-btn__label">Undo</span>
              </button>
              <button
                type="button"
                className="tool-btn"
                title={`Redo${key('Ctrl+Shift+Z')}`}
                onClick={() => store.getState().redo()}
              >
                <ToolIcon name="redo" />
                <span className="tool-btn__label">Redo</span>
              </button>
            </div>
            <div className="tool-group">
              <button
                type="button"
                className="tool-btn"
                title="Exit bubble-push mode and open the Analyze drawer (B exits only)"
                onClick={() => {
                  store.getState().exitBubbleMode();
                  tryOpenAnalyze();
                }}
              >
                <ToolIcon name="analyze" />
                <span className="tool-btn__label">Analyze ⟶</span>
              </button>
            </div>
            {bubblePreview && !bubblePreview.result.legal && (
              <span className="circuit-error">
                not equivalent: {bubblePreview.result.diffRows.length} truth-table row
                {bubblePreview.result.diffRows.length === 1 ? '' : 's'} differ
              </span>
            )}
          </>
        )}
        {mode !== 'bubble' && (
          <>
            <div className="tool-group">
              {/* Undo and redo were reachable only by Ctrl+Z and the Edit menu
                  outside bubble mode, which made them invisible on a phone and
                  easy to miss on a desktop. */}
              <ToolBtn
                icon="undo"
                quick
                title={`Undo${key('Ctrl+Z')}`}
                onClick={() => store.getState().undo()}
              >
                Undo
              </ToolBtn>
              <ToolBtn
                icon="redo"
                quick
                title={`Redo${key('Ctrl+Shift+Z')}`}
                onClick={() => store.getState().redo()}
              >
                Redo
              </ToolBtn>
              {/* An empty canvas is a dead end on a phone, where File is a
                  poor first reach; same command the menu runs. */}
              {compact && examplesCmd && !examplesCmd.disabled ? (
                <ToolBtn icon="open" title="Open a bundled example board" onClick={examplesCmd.run}>
                  Examples
                </ToolBtn>
              ) : null}
              <ToolBtn
                icon="select"
                active={tool.kind === 'select'}
                title={`Select and move${key('Esc')}`}
                onClick={() => store.getState().setTool({ kind: 'select' })}
              >
                Select
              </ToolBtn>

              <ToolBtn
                icon="lasso"
                active={tool.kind === 'lasso'}
                title={`Lasso: drag a marquee to select${key('L')}`}
                onClick={() => store.getState().setTool({ kind: 'lasso' })}
              >
                Lasso
              </ToolBtn>
              {/* A wire in flight leaves a ghost that only Esc or a press
                  outside the canvas clears, and a phone has neither to hand.
                  The wire button becomes that wire's own cancel while it is
                  being drawn. */}
              <ToolBtn
                icon={wiring ? 'cancel' : 'wire'}
                active={tool.kind === 'wire'}
                title={wiring ? 'Discard this wire' : `Draw wires${key('W')}`}
                onClick={() =>
                  wiring ? discardWire() : store.getState().setTool({ kind: 'wire' })
                }
              >
                {wiring ? 'Cancel' : 'Wire'}
              </ToolBtn>
              <ToolBtn
                icon="junction"
                active={tool.kind === 'junction'}
                title={`Place a junction${key('J')}`}
                onClick={() => store.getState().setTool({ kind: 'junction' })}
              >
                Junction
              </ToolBtn>
              <ToolBtn
                icon="cut"
                active={tool.kind === 'cut'}
                title="Freehand-slash to delete crossed wires (C)"
                onClick={() => store.getState().setTool({ kind: 'cut' })}
              >
                Cut
              </ToolBtn>
              <ToolBtn
                icon="connect"
                disabled={selection.size < 2}
                title={`Connect the selected parts${key('F')}. Suggests wires; ${press} the board${coarse ? '' : ' or press Enter'} to accept.`}
                onClick={proposeSmartConnect}
              >
                Connect
              </ToolBtn>
            </div>
            <div className="tool-group">
              <button
                type="button"
                className="tool-btn"
                title="Save the active circuit (or selection) as a reusable chip"
                onClick={() => setPackaging(true)}
              >
                <ToolIcon name="package" />
                <span className="tool-btn__label">Package as chip…</span>
              </button>
              <ToolBtn
                icon="bubble"
                title="Bubble-push mode: De Morgan pushes on a locked circuit (B)"
                onClick={() => store.getState().enterBubbleMode()}
              >
                Bubble push
              </ToolBtn>
              <ToolBtn
                icon="analyze"
                active={analyzeOpen}
                title="Truth table + K-map drawer for the board"
                onClick={() => (analyzeOpen ? closeAnalyze() : tryOpenAnalyze())}
              >
                Analyze
              </ToolBtn>
            </div>
            <div className="tool-group">
              <ToolBtn
                icon="power"
                quick
                active={powered}
                title={`Compile and settle; all nets start at X${key('Space')}`}
                onClick={() => store.getState().power()}
              >
                {powered ? 'Power off' : 'Power on'}
              </ToolBtn>
              <ToolBtn
                icon={running ? 'pause' : 'run'}
                quick
                active={running}
                disabled={!powered}
                title="Free-run clocks"
                onClick={() => store.getState().toggleRun()}
              >
                {running ? 'Pause ⏸' : 'Run ▸'}
              </ToolBtn>
              <button
                type="button"
                className="tool-btn"
                disabled={!canStep}
                title={`Advance to the next scheduled event${key('.')}`}
                onClick={() => store.getState().step()}
              >
                <ToolIcon name="step" />
                <span className="tool-btn__label">Step Δ</span>
              </button>
              <span className="sim-status">
                {powered ? (running ? 'running' : 'settled, paused') : 'off'}
                {simTime !== null && ` · t = ${(simTime / 1000).toFixed(1)} ns`}
              </span>
            </div>
            <div className="tool-group">
              <ToolBtn
                icon="timing"
                active={timing.mode === 'datasheet'}
                onClick={() =>
                  store
                    .getState()
                    .setTiming({ mode: timing.mode === 'ideal' ? 'datasheet' : 'ideal' })
                }
              >
                {timing.mode === 'datasheet' ? `Datasheet (${timing.datasheet})` : 'Ideal'}
              </ToolBtn>
              {timing.mode === 'datasheet' && (
                <button
                  type="button"
                  className="tool-btn"
                  onClick={() =>
                    store
                      .getState()
                      .setTiming({ datasheet: timing.datasheet === 'typ' ? 'max' : 'typ' })
                  }
                >
                  {timing.datasheet}
                </button>
              )}
              <ToolBtn
                icon="sta"
                active={!!staReport}
                title="Static timing: critical/short path overlay + slack report (datasheet mode)"
                onClick={() =>
                  staReport ? store.getState().clearSta() : store.getState().runSta()
                }
              >
                STA
              </ToolBtn>
            </div>
          </>
        )}
        {error && <span className="circuit-error">{error}</span>}
      </div>

      {tabs.length > 1 && (
        <div className="circuit-tabs">
          {tabs.map((t) => (
            <span
              key={t.id}
              className={`circuit-tab${t.id === activeTabId ? ' circuit-tab--active' : ''}`}
            >
              <button
                type="button"
                className="circuit-tab__label"
                onClick={() => store.getState().setActiveTab(t.id)}
              >
                {t.kind === 'board' ? store.getState().board.name || 'Board' : t.breadcrumb}
              </button>
              {t.kind === 'def' && (
                <button
                  type="button"
                  className="circuit-tab__close"
                  title="Close tab"
                  onClick={() => store.getState().closeTab(t.id)}
                >
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {/* A press anywhere outside the canvas abandons a half-drawn wire. Esc
          did this and nothing else did, which left a touchscreen with a ghost
          it could not put down. Capture, so the press still does whatever it
          was for. */}
      <div
        className="circuit-body"
        onPointerDownCapture={(e) => {
          if (!wiringRef.current) return;
          if (e.target instanceof Element && e.target.closest('canvas')) return;
          cancelPending();
        }}
      >
        <PaletteRail paletteRef={paletteRef} width={paletteW} />
        <div
          className="circuit-palette__resize"
          title={`Drag to resize the palette; double-${press} to fit the longest name`}
          onPointerDown={(e) => {
            paletteResizeRef.current = {
              startX: e.clientX,
              startW: paletteRef.current?.clientWidth ?? PALETTE_MIN_W,
            };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const r = paletteResizeRef.current;
            if (!r) return;
            const max = Math.max(PALETTE_MIN_W, paletteFitWidth());
            setPaletteW(Math.min(max, Math.max(PALETTE_MIN_W, r.startW + (e.clientX - r.startX))));
          }}
          onPointerUp={() => {
            paletteResizeRef.current = null;
          }}
          onDoubleClick={() => setPaletteW(paletteFitWidth())}
        />
        <div className="circuit-canvas-wrap" ref={containerRef}>
          <canvas
            ref={canvasRef}
            className="circuit-canvas"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onClick={onCanvasClick}
            onDoubleClick={onCanvasDoubleClick}
          />
          {renaming && (
            <input
              key={renaming.id}
              className={`circuit-pin-rename${renaming.flash ? ' circuit-pin-rename--warn' : ''}`}
              autoFocus
              value={renaming.value}
              style={{ left: renaming.screen.x, top: renaming.screen.y }}
              onChange={(e) => setRenaming({ ...renaming, value: e.target.value, flash: false })}
              onBlur={() => {
                // A rejected rename (duplicate label on another net) keeps the
                // overlay open with a warn flash instead of silently closing.
                if (store.getState().renameComponent(renaming.id, renaming.value))
                  setRenaming(null);
                else setRenaming({ ...renaming, flash: true });
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') {
                  if (store.getState().renameComponent(renaming.id, renaming.value))
                    setRenaming(null);
                  else setRenaming({ ...renaming, flash: true });
                } else if (e.key === 'Escape') {
                  setRenaming(null);
                }
              }}
            />
          )}
          {/* A pending suggestion, as chrome. The wheel cycles the pairing and
              Enter accepts it; neither exists on a touchscreen, and on a
              desktop neither is written on anything. */}
          {connectPairs > 0 && (
            <div className="connect-cycle" role="toolbar" aria-label="Suggested connection">
              <button
                type="button"
                className="tool-btn"
                title="Previous pairing"
                onClick={() => cycleSmartConnect(-1)}
              >
                <span className="tool-btn__label">&#8249;</span>
              </button>
              <span className="connect-cycle__count">
                {connectPairs === 1 ? '1 wire' : `${connectPairs} wires`}
              </span>
              <button
                type="button"
                className="tool-btn"
                title="Next pairing"
                onClick={() => cycleSmartConnect(1)}
              >
                <span className="tool-btn__label">&#8250;</span>
              </button>
              <button
                type="button"
                className="tool-btn"
                title={`Accept the suggested wires${key('Enter')}`}
                onClick={commitSmartConnect}
              >
                <span className="tool-btn__label">Accept</span>
              </button>
              <button
                type="button"
                className="tool-btn"
                title={`Discard the suggestion${key('Esc')}`}
                onClick={() => {
                  setSmartConnect(null);
                  drawRef.current();
                }}
              >
                <span className="tool-btn__label">Cancel</span>
              </button>
            </div>
          )}

          {/* Mobile only: power, run, undo and redo must never scroll out of
              reach, and the toolbar is a scrolling row. Floating over the
              canvas costs no layout height. */}
          {compact && (
            <div className="circuit-quick" role="toolbar" aria-label="Quick actions">
              <ToolBtn
                icon="power"
                active={powered}
                title={`${powered ? 'Power off' : 'Power on'}${key('Space')}`}
                onClick={() => store.getState().power()}
              >
                {powered ? 'Power off' : 'Power on'}
              </ToolBtn>
              <ToolBtn
                icon={running ? 'pause' : 'run'}
                active={running}
                disabled={!powered}
                title={running ? 'Pause' : 'Run'}
                onClick={() => store.getState().toggleRun()}
              >
                {running ? 'Pause' : 'Run'}
              </ToolBtn>
              <ToolBtn icon="undo" title="Undo" onClick={() => store.getState().undo()}>
                Undo
              </ToolBtn>
              <ToolBtn icon="redo" title="Redo" onClick={() => store.getState().redo()}>
                Redo
              </ToolBtn>
            </div>
          )}
          {/* A pending suggestion has its own controls, and the selection that
              raised it is still set, so both bars showed at once with the
              suggestion sitting on top of the one that started it. */}
          {/* Nothing that edits the board is offered while it is powered. Tapping
              a switch to drive it selected it too, so Delete and the rest
              appeared over a board that cannot be edited at all. */}
          <SelectionActionBar
            visible={coarse && selection.size > 0 && connectPairs === 0 && !powered}
          />
          {staReport &&
            activeTab.kind === 'board' &&
            (() => {
              const data = buildStaOverlay(
                store.getState().board,
                staReport.compiled,
                staReport.report,
                selection,
              );
              return data ? (
                <StaCard
                  path={data.path}
                  sequential={staReport.report.sequential}
                  onClose={() => store.getState().clearSta()}
                />
              ) : null;
            })()}
          {clockEdit && (
            <div
              ref={clockEditBoxRef}
              className="circuit-clock-edit"
              style={{ left: clockEdit.screen.x, top: clockEdit.screen.y }}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') {
                  // Name + params commit as ONE undo step; a rejected name
                  // (duplicate on another net) keeps the overlay open, warn-flashed.
                  const ok = store.getState().setComponentParams(
                    clockEdit.id,
                    {
                      periodPs: Math.max(2, Math.round(clockEdit.periodNs * 1000)),
                      dutyPercent: Math.min(99, Math.max(1, Math.round(clockEdit.dutyPct))),
                      phasePs: Math.max(0, Math.round(clockEdit.phaseNs * 1000)),
                    },
                    clockEdit.name,
                  );
                  if (ok) setClockEdit(null);
                  else setClockEdit({ ...clockEdit, flash: true });
                } else if (e.key === 'Escape') setClockEdit(null);
              }}
            >
              <label>
                name
                <input
                  type="text"
                  className={clockEdit.flash ? 'circuit-pin-rename--warn' : undefined}
                  value={clockEdit.name}
                  placeholder={clockEdit.id}
                  onChange={(e) =>
                    setClockEdit({ ...clockEdit, name: e.target.value, flash: false })
                  }
                />
              </label>
              <label>
                period
                <input
                  autoFocus
                  type="number"
                  min={0.002}
                  step={1}
                  value={clockEdit.periodNs}
                  onChange={(e) =>
                    setClockEdit({ ...clockEdit, periodNs: Number(e.target.value) || 0 })
                  }
                />
                ns
              </label>
              <label>
                duty
                <input
                  type="number"
                  min={1}
                  max={99}
                  value={clockEdit.dutyPct}
                  onChange={(e) =>
                    setClockEdit({ ...clockEdit, dutyPct: Number(e.target.value) || 50 })
                  }
                />
                %
              </label>
              <label>
                phase
                <input
                  type="number"
                  min={0}
                  value={clockEdit.phaseNs}
                  onChange={(e) =>
                    setClockEdit({ ...clockEdit, phaseNs: Number(e.target.value) || 0 })
                  }
                />
                ns
              </label>
              <span className="circuit-clock-edit__hint">Enter saves · Esc cancels</span>
            </div>
          )}
          {paramEdit && (
            <div
              ref={paramEditBoxRef}
              className="circuit-param-edit"
              style={{ left: paramEdit.screen.x, top: paramEdit.screen.y }}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') commitParamEdit();
                else if (e.key === 'Escape') setParamEdit(null);
              }}
            >
              {paramEdit.name !== undefined && (
                <label>
                  name
                  <textarea
                    autoFocus
                    rows={paramEdit.name.split('\n').length}
                    className={`circuit-param-edit__name${
                      paramEdit.flash ? ' circuit-pin-rename--warn' : ''
                    }`}
                    value={paramEdit.name}
                    placeholder={paramEdit.id}
                    onChange={(e) => {
                      const value = e.target.value;
                      setParamEdit((cur) => (cur ? { ...cur, name: value, flash: false } : cur));
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter') return;
                      // Shift+Enter is the newline; plain Enter keeps its
                      // meaning everywhere else in the editor and commits, so
                      // it must not also leave a newline in the field.
                      if (e.shiftKey && CAPTION_KINDS.has(paramEdit.kind)) e.stopPropagation();
                      else e.preventDefault();
                    }}
                  />
                </label>
              )}
              {paramEdit.width !== undefined && paramEditFieldVisible(paramEdit, 'width') && (
                <label>
                  width
                  <input
                    autoFocus={paramEdit.name === undefined}
                    type="number"
                    min={1}
                    max={MAX_WIDTH}
                    className={paramEdit.flash ? 'circuit-pin-rename--warn' : undefined}
                    value={paramEdit.width}
                    onChange={(e) => {
                      const width = Number(e.target.value);
                      setParamEdit((cur) => (cur ? { ...cur, width, flash: false } : cur));
                    }}
                    {...paramEditFocusHandlers(setParamEdit, 'width')}
                  />
                  bits
                </label>
              )}
              {paramEdit.kind === 'toggle' && paramEditFieldVisible(paramEdit, 'initial') && (
                <label>
                  initial
                  <input
                    type="number"
                    min={0}
                    value={paramEdit.initial ?? 0}
                    onChange={(e) => {
                      const initial = Number(e.target.value);
                      setParamEdit((cur) => (cur ? { ...cur, initial, flash: false } : cur));
                    }}
                    {...paramEditFocusHandlers(setParamEdit, 'initial')}
                  />
                </label>
              )}
              {paramEdit.kind === 'constant' && paramEditFieldVisible(paramEdit, 'value') && (
                <label>
                  value
                  <input
                    type="text"
                    className={paramEdit.flash ? 'circuit-pin-rename--warn' : undefined}
                    value={paramEdit.valueText ?? '0'}
                    placeholder="decimal or 0x hex"
                    onChange={(e) => {
                      const valueText = e.target.value;
                      setParamEdit((cur) => (cur ? { ...cur, valueText, flash: false } : cur));
                    }}
                    {...paramEditFocusHandlers(setParamEdit, 'value')}
                  />
                </label>
              )}
              {paramEdit.kind === 'decoder' && (
                <>
                  {paramEditFieldVisible(paramEdit, 'addressBits') && (
                    <label>
                      address bits
                      <input
                        autoFocus
                        type="number"
                        min={1}
                        max={4}
                        className={paramEdit.flash ? 'circuit-pin-rename--warn' : undefined}
                        value={paramEdit.inputs ?? 2}
                        onChange={(e) => {
                          const inputs = Number(e.target.value);
                          setParamEdit((cur) => (cur ? { ...cur, inputs, flash: false } : cur));
                        }}
                        {...paramEditFocusHandlers(setParamEdit, 'addressBits')}
                      />
                    </label>
                  )}
                  {paramEditFieldVisible(paramEdit, 'hasEnable') && (
                    <label>
                      enable pin
                      <input
                        type="checkbox"
                        checked={!!paramEdit.hasEnable}
                        onChange={(e) => {
                          const hasEnable = e.target.checked;
                          setParamEdit((cur) => (cur ? { ...cur, hasEnable } : cur));
                        }}
                        {...paramEditFocusHandlers(setParamEdit, 'hasEnable')}
                      />
                    </label>
                  )}
                </>
              )}
              {paramEdit.kind === 'encoder' && paramEditFieldVisible(paramEdit, 'addressBits') && (
                <label>
                  address bits
                  <input
                    autoFocus
                    type="number"
                    min={1}
                    max={4}
                    className={paramEdit.flash ? 'circuit-pin-rename--warn' : undefined}
                    value={paramEdit.inputs ?? 2}
                    onChange={(e) => {
                      const inputs = Number(e.target.value);
                      setParamEdit((cur) => (cur ? { ...cur, inputs, flash: false } : cur));
                    }}
                    {...paramEditFocusHandlers(setParamEdit, 'addressBits')}
                  />
                </label>
              )}
              {(paramEdit.kind === 'mux' || paramEdit.kind === 'demux') && (
                <>
                  {paramEditFieldVisible(paramEdit, 'selectBits') && (
                    <label>
                      select bits
                      <input
                        autoFocus
                        type="number"
                        min={1}
                        max={4}
                        className={paramEdit.flash ? 'circuit-pin-rename--warn' : undefined}
                        value={paramEdit.inputs ?? 2}
                        onChange={(e) => {
                          const inputs = Number(e.target.value);
                          setParamEdit((cur) => (cur ? { ...cur, inputs, flash: false } : cur));
                        }}
                        {...paramEditFocusHandlers(setParamEdit, 'selectBits')}
                      />
                    </label>
                  )}
                  {paramEditFieldVisible(paramEdit, 'hasEnable') && (
                    <label>
                      enable pin
                      <input
                        type="checkbox"
                        checked={!!paramEdit.hasEnable}
                        onChange={(e) => {
                          const hasEnable = e.target.checked;
                          setParamEdit((cur) => (cur ? { ...cur, hasEnable } : cur));
                        }}
                        {...paramEditFocusHandlers(setParamEdit, 'hasEnable')}
                      />
                    </label>
                  )}
                  {paramEditFieldVisible(paramEdit, 'selSide') && (
                    <label>
                      select pins
                      <select
                        value={paramEdit.selSide === 'top' ? 'top' : 'bottom'}
                        onChange={(e) => {
                          const selSide = e.target.value === 'top' ? 'top' : 'bottom';
                          setParamEdit((cur) => (cur ? { ...cur, selSide } : cur));
                        }}
                        {...paramEditFocusHandlers(setParamEdit, 'selSide')}
                      >
                        <option value="bottom">bottom</option>
                        <option value="top">top</option>
                      </select>
                    </label>
                  )}
                </>
              )}
              {VARIABLE_ARITY_GATES.has(paramEdit.kind) && paramEdit.swapKind !== undefined && (
                <label>
                  gate
                  <select
                    className="select"
                    value={paramEdit.swapKind}
                    onChange={(e) => {
                      const swapKind = e.target.value;
                      setParamEdit((cur) => (cur ? { ...cur, swapKind, flash: false } : cur));
                    }}
                  >
                    {SWAPPABLE_GATE_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {k.toUpperCase()}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {VARIABLE_ARITY_GATES.has(paramEdit.kind) &&
                paramEditFieldVisible(paramEdit, 'inputs') && (
                  <label>
                    inputs
                    <input
                      autoFocus={paramEdit.name === undefined}
                      type="number"
                      min={2}
                      max={8}
                      className={paramEdit.flash ? 'circuit-pin-rename--warn' : undefined}
                      value={paramEdit.inputs ?? 2}
                      onChange={(e) => {
                        const inputs = Number(e.target.value);
                        setParamEdit((cur) => (cur ? { ...cur, inputs, flash: false } : cur));
                      }}
                      {...paramEditFocusHandlers(setParamEdit, 'inputs')}
                    />
                  </label>
                )}
              {/* One checkbox per pinView-capable group (gate letters/y,
                  mux/demux's select/data-or-per-line groups, decoder's
                  sel/outputs, encoder's inputs/y, toggle/led/probe's y/a) --
                  candidates come from pinViewGroupsFor against the overlay's
                  own live field values, so the list tracks arity/width/size
                  edits made earlier in this same open overlay. Uses the
                  functional setState form throughout (not a captured
                  `paramEdit` spread): toggling several checkboxes in one
                  popup session fires several onChange calls back-to-back,
                  and a stale closure over `paramEdit` would silently drop
                  all but the last one. */}
              {pinViewGroupsFor(paramEdit.kind, paramEditPinViewParams(paramEdit)).length > 0 && (
                <div className="circuit-param-edit__pinview">
                  {pinViewGroupsFor(paramEdit.kind, paramEditPinViewParams(paramEdit)).map(
                    (grp) => (
                      <label key={grp.key}>
                        {grp.label}: single bus pin
                        <input
                          type="checkbox"
                          checked={(paramEdit.pinView ?? {})[grp.key] === 'collapsed'}
                          onChange={(e) => {
                            const state = e.target.checked ? 'collapsed' : 'expanded';
                            setParamEdit((cur) =>
                              cur ? { ...cur, pinView: { ...cur.pinView, [grp.key]: state } } : cur,
                            );
                          }}
                        />
                      </label>
                    ),
                  )}
                </div>
              )}
              <span className="circuit-param-edit__hint">Enter saves · Esc cancels</span>
            </div>
          )}
        </div>
      </div>

      <WaveformPanel />

      {packaging && (
        <PackageDialog
          source={store.getState().activeCircuit()}
          selection={selection}
          chipLib={chipLib}
          onClose={() => setPackaging(false)}
        />
      )}
      <LabelConflictDialog />
      <CloseTabDialog />
      {precisePicker && (
        <SmartConnectPicker
          targetId={precisePicker.targetId}
          onClose={() => setPrecisePicker(null)}
        />
      )}
    </div>
  );
}

function ToolBtn(props: {
  active?: boolean;
  disabled?: boolean;
  title?: string;
  icon?: IconName;
  /** Also carried by the mobile quick panel; CSS hides this copy on compact
   *  so the same control is not offered twice. */
  quick?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="tool-btn"
      data-quick={props.quick ? '' : undefined}
      aria-pressed={props.active}
      disabled={props.disabled}
      title={props.title}
      onClick={props.onClick}
    >
      {props.icon && <ToolIcon name={props.icon} />}
      <span className="tool-btn__label">{props.children}</span>
    </button>
  );
}

// First wiring click: nearest free pin of any direction.
function nearestFree(
  targets: PinTarget[],
  cursor: Vec2,
  scale: number,
  baseRadius = LOOSE_HIT_RADIUS,
): PinTarget | null {
  const radius = baseRadius * scale;
  let best: PinTarget | null = null;
  let bestDist = Infinity;
  for (const t of targets) {
    if (!t.free) continue;
    const d = Math.hypot(t.worldPos.x - cursor.x, t.worldPos.y - cursor.y);
    if (d < radius && d < bestDist) {
      best = t;
      bestDist = d;
    }
  }
  return best;
}

// Any pin at all near the cursor, ignoring direction/width/occupancy --
// distinguishes "clicked on an incompatible pin" (nothing should happen, the
// pin isn't a valid completion target) from "clicked on empty space" (P1.6's
// add-a-bend fallback), which `nearestCompatiblePin`'s own filtering can't
// tell apart on its own since an incompatible pin just doesn't show up there.
function nearestAnyPin(targets: PinTarget[], cursor: Vec2, scale: number): PinTarget | undefined {
  const radius = LOOSE_HIT_RADIUS * scale;
  let best: PinTarget | undefined;
  let bestDist = Infinity;
  for (const t of targets) {
    const d = Math.hypot(t.worldPos.x - cursor.x, t.worldPos.y - cursor.y);
    if (d < radius && d < bestDist) {
      best = t;
      bestDist = d;
    }
  }
  return best;
}
