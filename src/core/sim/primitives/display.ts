import type { PrimitivePin, PrimitiveSpec } from './types';
import { widthParam } from './types';

const SEGMENT_NAMES = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

/** Observer only; render layer lights segments from the connected net values. */
export const sevenseg: PrimitiveSpec = {
  kind: 'sevenseg',
  pins: () =>
    SEGMENT_NAMES.map(
      (name, i): PrimitivePin => ({ name, dir: 'in', width: 1, role: 'data', order: i }),
    ),
  evaluate: () => ({ outputs: [] }),
};

/** Observer only; render layer decodes the 4-bit value to a hex digit. */
export const sevenseghex: PrimitiveSpec = {
  kind: 'sevenseghex',
  pins: () => [{ name: 'value', dir: 'in', width: 4, role: 'data', order: 0 }],
  evaluate: () => ({ outputs: [] }),
};

/** Observer only; render layer shows the bus value in the chosen radix. */
export const busdisplay: PrimitiveSpec = {
  kind: 'busdisplay',
  pins: (params) => [
    { name: 'value', dir: 'in', width: widthParam(params), role: 'data', order: 0 },
  ],
  evaluate: () => ({ outputs: [] }),
};
