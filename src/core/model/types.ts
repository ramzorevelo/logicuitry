// Hierarchy data model: chip definitions referenced by id, lightweight instances.

import type { DatasheetColumn, Vendor } from '../parts/partsDb';
import type { StimulusJson } from '../runner/stimulus';

export type PinRole = 'data' | 'clock' | 'enable' | 'asyncSet' | 'asyncClear' | 'select';
/** `passive` is a net LABEL's pin: neither driver nor sink, it takes the
 *  direction and width of whatever net it is attached to. Only `netlabel` has
 *  one; every direction rule treats it as a wildcard rather than a default.
 *  `inout` is a bidirectional pin: it drives its net (Z when idle) and reads
 *  the resolved value back, so it takes both an input and an output slot. */
export type PinDir = 'in' | 'out' | 'passive' | 'inout';

export interface Point {
  x: number;
  y: number;
}

/** Boundary pin of a ChipDef; realized by an internal input/output component. */
export interface PinDef {
  id: string;
  name: string;
  dir: PinDir;
  width: number;
  role: PinRole;
  /** Top-to-bottom position on the symbol; drives smart-connect ordering. */
  order: number;
  /** Id of the internal port component this pin binds to. */
  boundComponent: string;
}

export type ParamValue = string | number | boolean;

/** A placed element: a primitive, or a chip instance (kind === 'chip'). */
export type ComponentKind =
  | 'and'
  | 'or'
  | 'nand'
  | 'nor'
  | 'xor'
  | 'xnor'
  | 'not'
  | 'buf'
  | 'toggle'
  | 'button'
  | 'spdt'
  | 'clock'
  | 'pattern'
  | 'timer555'
  | 'constant'
  | 'inport'
  | 'led'
  | 'probe'
  | 'busdisplay'
  | 'sevenseg'
  | 'ledmatrix'
  | 'outport'
  | 'netlabel'
  | 'mux'
  | 'demux'
  | 'decoder'
  | 'encoder'
  | 'bcd7seg'
  | 'adder'
  | 'comparator'
  | 'parity'
  | 'dff'
  | 'dlatch'
  | 'register'
  | 'srlatch'
  | 'counter'
  | 'shiftreg'
  | 'ram'
  | 'split'
  | 'merge'
  | 'tristate'
  | 'transceiver'
  | 'tunnel'
  | 'tapdrive'
  | 'tapread'
  | 'pullup'
  | 'pulldown'
  | 'vcc'
  | 'gnd'
  | 'chip';

export interface Component {
  id: string;
  kind: ComponentKind;
  defId?: string;
  /** Group this component belongs to, by `Group.id`. Absent means the board
   *  itself, which is every component on every board written before groups
   *  existed. Membership is explicit rather than derived from the group's
   *  rectangle: a component dragged across a border must not change scope
   *  silently, because scope decides which nets join. */
  group?: string;
  pos: Point;
  rot?: 0 | 90 | 180 | 270;
  mirror?: boolean;
  label?: string;
  /** Hand-nudged offset of the drawn instance name from its computed
   *  placement, in the component's own local pre-rotation space (rotates and
   *  mirrors with the body for free). Absent means "use namePlacement's
   *  computed anchor" -- every existing board. */
  nameOffset?: Point;
  params?: Record<string, ParamValue>;
}

/** Instances carry no copied internals; edits to the def propagate by construction. */
export type ChipInstance = Component & {
  kind: 'chip';
  defId: string;
  /** Preload per RAM inside, keyed by its path below this instance (`u1`,
   *  `U4/u1`). Values only: the outermost instance's entry wins over anything
   *  stored in the def, so each placed copy can hold its own program. */
  contents?: Record<string, string>;
};

export function isChipInstance(c: Component): c is ChipInstance {
  return c.kind === 'chip';
}

/** Inclusive bit slice of a bus, MSB-first per the bit-ordering rule; hi === lo is one bit. */
export interface BitRange {
  hi: number;
  lo: number;
}

export type WireEnd =
  | { kind: 'pin'; component: string; pin: string }
  | { kind: 'junction'; junction: string }
  // Tap off a bus wire (drawing convention, not a splitter component): 'wire' is
  // the tapped bus wire's id, 'range' the sub-range compile slices out. 'pos' is
  // the click point along the bus's run, UI-only (compile resolves by wire+range).
  | { kind: 'tap'; wire: string; range: BitRange; pos: Point }
  // Dangling end on the grid (board formatVersion 2): contributes no
  // connection; the net still forms from the wire's other end.
  | { kind: 'free'; pos: Point };

/** Explicit junction dot; crossings never auto-join. */
export interface Junction {
  id: string;
  pos: Point;
}

/** A slot in the shared categorical palette, never a colour value: every
 *  theme authors its own colour per slot, so a group or wire stays legible
 *  whichever theme draws it. */
export const PALETTE_SLOTS = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8'] as const;
export type PaletteSlot = (typeof PALETTE_SLOTS)[number];

export function isPaletteSlot(value: unknown): value is PaletteSlot {
  return (PALETTE_SLOTS as readonly unknown[]).includes(value);
}

/** One orthogonal wire run between two ends; points = bend geometry. */
export interface Wire {
  id: string;
  a: WireEnd;
  b: WireEnd;
  points: Point[];
  /** Where a bus wire's width badge sits, as an arc-length fraction of the
   *  drawn route. A fraction, not a point, so it keeps its place when the
   *  route reshapes under a component drag. Absent = midpoint. */
  busLabelT?: number;
  /** Insulation colour, drawn as a sheath under the signal-coloured core, the
   *  way a breadboard is wired with colour-coded jumpers. Per wire, not per
   *  net. Drawing only: compile never reads it. */
  color?: PaletteSlot;
}

/** Shared circuit body of ChipDef and Board. */
export interface Circuit {
  components: Component[];
  wires: Wire[];
  junctions: Junction[];
  /** Named sub-circuits sharing one board. A group scopes net-label joining
   *  and label uniqueness, so two unconnected groups may each name a net `A`.
   *  Absent on every board written before groups existed. */
  groups?: Group[];
  /** Checks the author silenced, as check keys. Absent means none; undefined
   *  is allowed so an undo can clear it through a spread. */
  hiddenChecks?: string[] | undefined;
}

/** A bordered sub-circuit. The rectangle is drawn and hit-tested but carries
 *  no membership: `Component.group` does that. It is recomputed to enclose
 *  the members, so the border can never disagree with the scope. */
export interface Group {
  id: string;
  name: string;
  /** Enclosing group, by id. Absent means the group sits on the board. A
   *  component still belongs to exactly ONE group -- its innermost -- so
   *  nesting changes what a border encloses, never which scope a name is in:
   *  a name is local to its own group, not to its ancestors. */
  parent?: string;
  /** Frame colour. Absent draws the plain grey frame every group had before. */
  color?: PaletteSlot;
  /** Name drawn as a solid tab in the frame colour; needs `color`. */
  tab?: boolean;
}

export interface ChipAppearance {
  /** Body tint, a theme token NAME (render/theme.ts CHIP_TINTS), never a hex. */
  color?: string;
  /** Box outline colour, same token vocabulary as `color`. */
  borderColor?: string;
  widthUnits?: number;
  heightUnits?: number;
  /** Physical package ('DIP14', 'DIP16') when the def stands for a real part:
   *  it is drawn as that package with datasheet pin numbers instead of the
   *  generic in-left/out-right box. Absent on every user-packaged chip. */
  package?: string;
}

export interface ChipDef extends Circuit {
  format: 'lcir.chip';
  formatVersion: 8;
  id: string;
  name: string;
  version: number;
  pins: PinDef[];
  appearance?: ChipAppearance;
}

export type TimingMode = 'ideal' | 'datasheet';

export interface TimingSetting {
  mode: TimingMode;
  /** Which datasheet column drives delays in datasheet mode. */
  datasheet: DatasheetColumn;
  vendor: Vendor;
}

/** Run paces sim time against the wall clock, in sim ps per wall second. */
export const RUN_SPEEDS = [25_000, 1_000_000, 100_000_000, 10_000_000_000, 1_000_000_000_000];
export const DEFAULT_RUN_SPEED = RUN_SPEEDS[0]!;

export interface Board extends Circuit {
  format: 'lcir.board';
  formatVersion: 16;
  id: string;
  name: string;
  /** Hierarchical net paths pinned to the waveform view. */
  probes: { path: string; label?: string }[];
  view: { x: number; y: number; zoom: number };
  timing: TimingSetting;
  runSpeed: number;
  /** Absent means none; undefined is allowed so an undo can clear it through a spread. */
  sequence?: BoardSequence | undefined;
  /** Absent means none; undefined is allowed so an undo can clear it through a spread. */
  challenge?: Challenge | undefined;
  /** Transport copies of the user chips the board uses, resolved by id on load; never a second source of truth. */
  chips?: ChipDef[];
  /** Package part per gate shape, keyed `<gateKind>:<inputs>` (e.g. `and:2`), valued by part id (`74LS08`). */
  partChoices?: Record<string, string>;
}

/** A row of 0/1 inputs then 0/1 outputs, in column order; a null output is don't care. */
export type ChallengeTableRow = (0 | 1 | null)[];

export interface ChallengeTruthTable {
  inputs: string[];
  outputs: string[];
  rows: ChallengeTableRow[];
}

/** Each entry needs `count` of any part in `anyOf`. */
export interface ChallengeRequirement {
  anyOf: string[];
  count: number;
}

/** A brief, part constraints and behavior a board is checked against, names keyed by label. */
export interface Challenge {
  title: string;
  brief: string;
  /** Kinds ("nand", "led", "timer555") or chip part numbers ("74LS00"). Empty: any part. */
  allowed: string[];
  ics?: { min?: number; max?: number };
  maxGates?: number;
  required: ChallengeRequirement[];
  /** The board runner's file shape, names keyed by label. */
  tests?: StimulusJson;
  truthTable?: ChallengeTruthTable;
  /** Set on the first "Set challenge"; absent on a draft. */
  fingerprint?: string;
}

export type SequenceAdvance = { mode: 'key' } | { mode: 'clock'; clock: string };

/** One step of a board sequence. `expect` cells are null for don't care. */
export interface SequenceRow {
  set: number[];
  expect?: (number | null)[];
  note?: string;
}

/** Input rows played onto a board's own switches, by component id. */
export interface BoardSequence {
  inputs: string[];
  expect: string[];
  rows: SequenceRow[];
  advance: SequenceAdvance;
  hideExpected: boolean;
}

export type LessonStepKind = 'narrate' | 'predict' | 'widget';
export type LessonDockTab = 'waveform' | 'analyze' | 'checks' | 'sequence';

export type LessonAction =
  /** `set` is the row's input values when the lesson was written; absent on a migrated v1 row. */
  | { kind: 'row'; index: number; set?: number[]; when: 'open' | 'reveal' }
  | { kind: 'power'; on: boolean }
  | { kind: 'timing'; mode: TimingMode }
  | { kind: 'highlight'; components: string[] }
  | { kind: 'tab'; tab: LessonDockTab }
  /** One rise and fall of a top-level clock part, then settled; `when` as on a row. */
  | { kind: 'pulse'; clock: string; when: 'open' | 'reveal' };

export interface LessonChoice {
  text: string;
  right?: boolean;
}

export type NarrationPlacement = 'panel' | 'caption' | 'callout';

/** Where viewers read a step's prose; `part` is the component a callout points at. */
export interface LessonNarration {
  at: NarrationPlacement;
  part?: string;
}

/**
 * On-board note owned by one step, shown through step `until` (absolute,
 * 0-based; absent means the owning step only). Points are board coordinates,
 * the units of `Component.pos`. Ids are unique per lesson.
 */
export type LessonAnnotation =
  /** `offset` runs from the part to the bubble, so the callout follows the part. */
  | { kind: 'callout'; id: string; part: string; text: string; offset: Point; until?: number }
  | { kind: 'text'; id: string; at: Point; text: string; until?: number }
  | { kind: 'arrow'; id: string; from: Point; to: Point; until?: number };

export interface LessonStep {
  kind: LessonStepKind;
  /** Markdown subset; the question on a predict step. */
  prose: string;
  actions: LessonAction[];
  choices?: LessonChoice[];
  /** Markdown shown on reveal. */
  answer?: string;
  widget?: { id: string; params?: Record<string, unknown> };
  /** Speaker notes: the author's only, never shown to viewers. */
  notes?: string;
  /** One line under the board, for every viewer. */
  headline?: string;
  narr?: LessonNarration;
  annots?: LessonAnnotation[];
  /** Predict only: a student alone may reveal without picking a choice. */
  revealFreely?: boolean;
  /** Autoplay time on this step, seconds; absent means the reading-speed default. */
  seconds?: number;
}

export interface Lesson {
  format: 'lcir.lesson';
  formatVersion: 5;
  id: string;
  title: string;
  workbench: 'numbers' | 'gates' | 'circuit' | 'devicelab';
  /** The board's `Board.id`; absent on a lesson that names none (a migrated v1 file). */
  board?: string;
  steps: LessonStep[];
}

export type ChipLibrary = ReadonlyMap<string, ChipDef>;
