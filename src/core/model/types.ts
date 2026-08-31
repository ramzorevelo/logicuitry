// Hierarchy data model: chip definitions referenced by id, lightweight instances.

export type PinRole = 'data' | 'clock' | 'enable' | 'asyncSet' | 'asyncClear' | 'select';
/** `passive` is a net LABEL's pin: neither driver nor sink, it takes the
 *  direction and width of whatever net it is attached to. Only `netlabel` has
 *  one; every direction rule treats it as a wildcard rather than a default. */
export type PinDir = 'in' | 'out' | 'passive';

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
  | 'clock'
  | 'constant'
  | 'inport'
  | 'led'
  | 'probe'
  | 'busdisplay'
  | 'sevenseg'
  | 'sevenseghex'
  | 'outport'
  | 'netlabel'
  | 'mux'
  | 'demux'
  | 'decoder'
  | 'encoder'
  | 'bcd7seg'
  | 'dff'
  | 'dlatch'
  | 'register'
  | 'split'
  | 'merge'
  | 'tristate'
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
export type ChipInstance = Component & { kind: 'chip'; defId: string };

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
  formatVersion: 3;
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
  datasheet: 'typ' | 'max';
}

export interface Board extends Circuit {
  format: 'lcir.board';
  formatVersion: 5;
  id: string;
  name: string;
  /** Hierarchical net paths pinned to the waveform view. */
  probes: { path: string; label?: string }[];
  view: { x: number; y: number; zoom: number };
  timing: TimingSetting;
}

export interface LessonStep {
  type: string;
  /** Markdown rendered in the lesson side panel. */
  prose?: string;
  params?: Record<string, unknown>;
}

export interface Lesson {
  format: 'lcir.lesson';
  formatVersion: 1;
  id: string;
  title: string;
  workbench: 'numbers' | 'gates' | 'circuit' | 'devicelab';
  steps: LessonStep[];
}

export type ChipLibrary = ReadonlyMap<string, ChipDef>;
