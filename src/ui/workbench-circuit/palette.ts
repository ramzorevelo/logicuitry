// Placeable-component palette. Every kind here must have both a registered
// sim primitive and registered glyph geometry (asserted by palette.test.ts).

import type { ChipDef, ComponentKind, ParamValue } from '../../core/model/types';
import { getPackage } from '../../core/parts/packages';
import { COUNTER_DEFAULT_WIDTH } from '../../core/sim/primitives/counter';
import { SHIFTREG_DEFAULT_WIDTH } from '../../core/sim/primitives/shiftreg';
import { RAM_DEFAULT_ADDRESS_BITS, RAM_DEFAULT_WIDTH } from '../../core/sim/primitives/ram';
import { TIMER_DEFAULTS } from '../../core/sim/primitives/timer555';
import { PATTERN_DEFAULT_STEP_PS, PATTERN_DEFAULT_VALUES } from '../../core/sim/primitives/pattern';

export type PaletteGroup =
  | 'Inputs'
  | 'Gates'
  | 'Combinational'
  | 'Arithmetic'
  | 'Sequential'
  | 'Timers'
  | 'Outputs'
  | 'Wiring';

/** Built-in chip group. Not a PaletteGroup: its items are ChipDefs from the
 *  parts library, not primitives, so the rail renders it beside "My chips". */
export const PARTS_GROUP = '74 series';

/** Section order in the palette rail: the two panel-device groups sit together
 *  at the top, since a board is normally stimulus-first. */
export const PALETTE_GROUPS: PaletteGroup[] = [
  'Inputs',
  'Outputs',
  'Gates',
  'Combinational',
  'Arithmetic',
  'Sequential',
  'Timers',
  'Wiring',
];

export interface PaletteItem {
  kind: ComponentKind;
  label: string;
  group: PaletteGroup;
  params?: Record<string, ParamValue>;
  /** A built-in teaching chip placed as an instance (`kind: 'chip'`). */
  defId?: string;
}

export const PALETTE: PaletteItem[] = [
  { kind: 'toggle', label: 'Switch', group: 'Inputs' },
  { kind: 'button', label: 'Button', group: 'Inputs' },
  { kind: 'spdt', label: 'SPDT switch', group: 'Inputs' },
  { kind: 'clock', label: 'Clock', group: 'Inputs' },
  {
    kind: 'pattern',
    label: 'Pattern',
    group: 'Inputs',
    params: { width: 1, values: PATTERN_DEFAULT_VALUES, stepPs: PATTERN_DEFAULT_STEP_PS },
  },
  { kind: 'constant', label: 'Const 0', group: 'Inputs', params: { value: 0, width: 1 } },
  { kind: 'constant', label: 'Const 1', group: 'Inputs', params: { value: 1, width: 1 } },
  { kind: 'inport', label: 'In port', group: 'Inputs' },
  { kind: 'and', label: 'AND', group: 'Gates' },
  { kind: 'or', label: 'OR', group: 'Gates' },
  { kind: 'nand', label: 'NAND', group: 'Gates' },
  { kind: 'nor', label: 'NOR', group: 'Gates' },
  { kind: 'xor', label: 'XOR', group: 'Gates' },
  { kind: 'xnor', label: 'XNOR', group: 'Gates' },
  { kind: 'not', label: 'NOT', group: 'Gates' },
  { kind: 'buf', label: 'BUF', group: 'Gates' },
  { kind: 'mux', label: 'MUX', group: 'Combinational', params: { selectBits: 2 } },
  { kind: 'demux', label: 'DEMUX', group: 'Combinational', params: { selectBits: 2 } },
  { kind: 'decoder', label: 'Decoder', group: 'Combinational', params: { addressBits: 2 } },
  { kind: 'encoder', label: 'Encoder', group: 'Combinational', params: { addressBits: 2 } },
  { kind: 'chip', defId: 'half-adder', label: 'Half adder', group: 'Arithmetic' },
  { kind: 'chip', defId: 'full-adder', label: 'Full adder', group: 'Arithmetic' },
  { kind: 'adder', label: 'Adder', group: 'Arithmetic' },
  { kind: 'comparator', label: 'Comparator', group: 'Arithmetic' },
  { kind: 'srlatch', label: 'SR latch', group: 'Sequential' },
  { kind: 'dlatch', label: 'D latch', group: 'Sequential' },
  { kind: 'dff', label: 'DFF', group: 'Sequential' },
  { kind: 'register', label: 'Register', group: 'Sequential' },
  // Width explicit: +/_ read a missing width as 1.
  {
    kind: 'counter',
    label: 'Counter',
    group: 'Sequential',
    params: { width: COUNTER_DEFAULT_WIDTH },
  },
  {
    kind: 'shiftreg',
    label: 'Shift reg',
    group: 'Sequential',
    params: { width: SHIFTREG_DEFAULT_WIDTH },
  },
  {
    kind: 'ram',
    label: 'RAM',
    group: 'Sequential',
    params: { width: RAM_DEFAULT_WIDTH, addressBits: RAM_DEFAULT_ADDRESS_BITS },
  },
  {
    kind: 'timer555',
    label: '555 timer',
    group: 'Timers',
    params: { mode: 'astable', ...TIMER_DEFAULTS },
  },
  { kind: 'led', label: 'LED', group: 'Outputs' },
  { kind: 'led', label: 'LED array', group: 'Outputs', params: { width: 8 } },
  { kind: 'ledmatrix', label: 'LED matrix', group: 'Outputs', params: { rows: 8, cols: 8 } },
  { kind: 'probe', label: 'Probe', group: 'Outputs' },
  { kind: 'outport', label: 'Out port', group: 'Outputs' },
  // Two presets of one part: which rail the commons expect is a param the
  // overlay edits, and it is the choice a student makes at the bench.
  {
    kind: 'sevenseg',
    label: '7-seg (cathode)',
    group: 'Outputs',
    params: { common: 'cathode' },
  },
  { kind: 'sevenseg', label: '7-seg (anode)', group: 'Outputs', params: { common: 'anode' } },
  { kind: 'netlabel', label: 'Net label', group: 'Wiring' },
  { kind: 'vcc', label: 'VCC', group: 'Wiring' },
  { kind: 'gnd', label: 'GND', group: 'Wiring' },
  { kind: 'pullup', label: 'Pull-up', group: 'Wiring' },
  { kind: 'pulldown', label: 'Pull-down', group: 'Wiring' },
  { kind: 'transceiver', label: 'Bus transceiver', group: 'Wiring', params: { width: 8 } },
];

/** Built-in chips the rail lists in their own group, not under 74 series. */
export const PALETTE_CHIP_IDS: ReadonlySet<string> = new Set(
  PALETTE.flatMap((item) => (item.defId ? [item.defId] : [])),
);

/** 74 series sub-headings in rail order; each package's `group` names one. */
export const PART_SUBGROUPS = [
  'Gates',
  'Decoders and encoders',
  'Multiplexers',
  'Display',
  'Arithmetic',
  'Flip-flops and registers',
  'Counters and shift registers',
  'Bus',
  'Memory',
] as const;

export interface PartRow {
  sub: string;
  defs: ChipDef[];
}

/** The digits after the family letters, compared as a number: '74LS138'
 *  sorts after '74LS86'. */
function partNumber(id: string): number {
  return Number.parseInt(/\d+$/.exec(id)?.[0] ?? '', 10);
}

export function partCaption(def: ChipDef): string | undefined {
  return getPackage(def.id)?.caption;
}

/** Built-in parts under their sub-headings, part-number order within each.
 *  A part with no known sub-heading is dropped; palette.test.ts asserts none. */
export function partRows(defs: readonly ChipDef[]): PartRow[] {
  return PART_SUBGROUPS.map((sub) => ({
    sub,
    defs: defs
      .filter((d) => getPackage(d.id)?.group === sub)
      .sort((a, b) => partNumber(a.id) - partNumber(b.id)),
  })).filter((row) => row.defs.length > 0);
}

// Apostrophes go too: the course writes a part as '138.
const squash = (s: string) => s.toLowerCase().replace(/[\s._'’-]+/g, '');

/** Names a block is also called by, so Find reaches it under either. */
const FIND_ALIASES: Readonly<Record<string, readonly string[]>> = {
  DFF: ['D flip-flop'],
  'Shift reg': ['shift register'],
  RAM: ['memory'],
  MUX: ['multiplexer'],
  DEMUX: ['demultiplexer'],
  Switch: ['toggle'],
  Pattern: ['word generator', 'sequence'],
};

export function findAliases(label: string): readonly string[] {
  return FIND_ALIASES[label] ?? [];
}

/** '74ls138' as '74138': the family letters are dropped when a part is said or typed. */
const withoutFamily = (s: string) => s.replace(/^74[a-z]+(?=\d)/, '74');

/** Case- and spacing-insensitive substring match of the Find part field over an item's
 *  label, part number and caption, so `LS 138` and `7400` find their parts. An empty query
 *  matches everything. */
export function matchesFind(query: string, ...texts: (string | undefined)[]): boolean {
  const q = squash(query);
  if (q === '') return true;
  return texts.some((t) => {
    if (t === undefined) return false;
    const s = squash(t);
    return s.includes(q) || withoutFamily(s).includes(q);
  });
}
