// Which datasheet figure times one input-pin -> output-pin arc of a bound
// part. One table with two readers: static timing takes it per arc, the
// simulator takes, per output edge, the arc from the inputs that moved.

import {
  column,
  getPart,
  propagationNs,
  type ArcRow,
  type DatasheetColumn,
  type OutputEdge,
} from './partsDb';

export type ArcFigure = ArcRow;

/** Per-part input-pin -> output-pin arc to datasheet `paths` key. */
const PART_PATHS: Record<string, Record<string, string>> = {
  '74LS283': {
    'cin->cout': 'cin_to_cout',
    'cin->sum': 'cin_to_sum',
    'a->sum': 'ab_to_sum',
    'b->sum': 'ab_to_sum',
    'a->cout': 'ab_to_cout',
    'b->cout': 'ab_to_cout',
  },
  '74LS85': {
    'a->gt': 'ab_to_gt',
    'b->gt': 'ab_to_gt',
    'a->eq': 'ab_to_eq',
    'b->eq': 'ab_to_eq',
    'a->lt': 'ab_to_lt',
    'b->lt': 'ab_to_lt',
    'igt->gt': 'cascade_to_gt',
    'ieq->gt': 'cascade_to_gt',
    'ilt->gt': 'cascade_to_gt',
    'igt->eq': 'cascade_to_eq',
    'ieq->eq': 'cascade_to_eq',
    'ilt->eq': 'cascade_to_eq',
    'igt->lt': 'cascade_to_lt',
    'ieq->lt': 'cascade_to_lt',
    'ilt->lt': 'cascade_to_lt',
  },
  '74LS280': {
    'd->even': 'data_to_even',
    'd->odd': 'data_to_odd',
  },
  '74LS75': { 'd->qn': 'data_to_qn', 'en->qn': 'en_to_qn' },
  '74LS165': { 'd->son': 'data_to_qn' },
  '74LS175': { 'clr->qn': 'clr_to_qn' },
};

/** A lane-expanded bit (`a3`, `sum0`) times like the bus pin it came from: a per-part row is
 *  per bus, so a part timing one line differently from its neighbours cannot go in this table. */
const busPinName = (pin: string) => pin.replace(/\d+$/, '');

// SPEC: decoder/encoder have too many pins (y0..y15, i0..i15) to enumerate per
// PART_PATHS; every a/en/i<n> pin shares one arc regardless of index, so a
// prefix match stands in for an explicit table.
export function codecPathKey(inPin: string, outPin: string): string | undefined {
  if (outPin.startsWith('seg_')) {
    if (/^a\d$/.test(inPin)) return 'a_to_seg';
    // SPEC: the '47/'48 datasheets time one control input (RBI) to the
    // segments; LT and BI publish no row of their own and take that one.
    if (inPin === 'rbi' || inPin === 'lt' || inPin === 'bi') return 'rbi_to_seg';
  }
  if ((inPin === 'a' || /^a\d+$/.test(inPin)) && outPin.startsWith('y')) return 'sel_to_y';
  if (/^en([hl]\d)?$/.test(inPin) && outPin.startsWith('y')) return 'en_to_y';
  const codeOut = outPin === 'a' || /^a\d+$/.test(outPin);
  if (/^i\d*$/.test(inPin) && codeOut) return 'i_to_y';
  // The '148 group-select output is the block's `valid`: one row, two names.
  if (/^i\d*$/.test(inPin) && (outPin === 'valid' || outPin === 'gs')) return 'i_to_valid';
  if (/^i\d*$/.test(inPin) && outPin === 'eo') return 'i_to_eo';
  if (inPin === 'ei' && codeOut) return 'ei_to_y';
  if (inPin === 'ei' && (outPin === 'gs' || outPin === 'eo')) return `ei_to_${outPin}`;
  if (outPin === 'w') {
    if (/^d\d*$/.test(inPin)) return 'data_to_w';
    if (/^s\d*$/.test(inPin)) return 'sel_to_w';
    if (inPin === 'en') return 'en_to_w';
  }
  // mux (M6.5): individual d<n>/s<n> lines share one arc per class, same
  // reasoning as decoder/encoder's index-agnostic prefix match above.
  if (/^d\d*$/.test(inPin) && outPin === 'y') return 'data_to_y';
  if (/^s\d*$/.test(inPin) && outPin === 'y') return 'sel_to_y';
  // demux (M6.6): mirror image of mux, but the datasheet-real parts (74LS139/
  // 74LS138/74LS154) demux through their active-low strobe pin -- our 'd'
  // pin maps to that same en_to_y arc, not a separate data arc.
  if (inPin === 'd' && /^y\d*$/.test(outPin)) return 'en_to_y';
  if (/^s\d*$/.test(inPin) && /^y\d*$/.test(outPin)) return 'sel_to_y';
  // A shift register's serial outputs are its last stage, so they time as Q.
  const stored = /^q\d*$/.test(outPin) || ['qn', 'so', 'son'].includes(outPin);
  if (inPin === 'clk' && stored) return 'clk_to_q';
  if (inPin === 'clk' && outPin === 'tc') return 'clk_to_tc';
  if ((inPin === 'en' || inPin === 'ent') && outPin === 'tc') return 'ent_to_tc';
  if (inPin === 'clr' && stored) return 'clr_to_q';
  if (inPin === 'pre' && stored) return 'pre_to_q';
  if (inPin === 'load' && stored) return 'load_to_q';
  if (/^d\d*$/.test(inPin) && stored) return 'data_to_q';
  if (inPin === 'en' && stored) return 'en_to_q';
  return undefined;
}

export function arcPathKey(part: string, inPin: string, outPin: string): string | undefined {
  return (
    PART_PATHS[part]?.[`${busPinName(inPin)}->${busPinName(outPin)}`] ?? codecPathKey(inPin, outPin)
  );
}

/** The published figure for one arc; undefined when the part times no such arc. */
export function arcFigure(part: string, inPin: string, outPin: string): ArcFigure | undefined {
  const paths = getPart(part)?.paths;
  const key = arcPathKey(part, inPin, outPin);
  const fig = key ? paths?.[key] : undefined;
  // A collapsed 1-bit demux names its pins d and y, exactly as a collapsed mux
  // does; only the part tells them apart, and a demux times d as its strobe.
  if (!fig && inPin === 'd' && outPin === 'y') return paths?.['en_to_y'];
  return fig;
}

/** Slowest published arc from any of inPins to outPin, in ns; undefined when none is. */
export function arcPropagationNs(
  part: string,
  inPins: readonly string[],
  outPin: string,
  edge: OutputEdge,
  col: DatasheetColumn,
): number | undefined {
  let slowest = 0;
  for (const inPin of inPins) {
    const fig = arcFigure(part, inPin, outPin)?.[edge === 'lh' ? 'tplh' : 'tphl'];
    if (fig) slowest = Math.max(slowest, column(fig, col));
  }
  return slowest || undefined;
}

/**
 * Slowest arc ending at one output, in ns. A part with no per-arc rows (a
 * gate, or a flip-flop's clk->q fields) answers with its single figure.
 */
export function outputPropagationNs(
  part: string,
  inPins: readonly string[],
  outPin: string,
  edge: OutputEdge,
  col: DatasheetColumn,
): number | undefined {
  return arcPropagationNs(part, inPins, outPin, edge, col) ?? propagationNs(part, edge, col);
}
