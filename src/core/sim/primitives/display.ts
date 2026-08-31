import type { PrimitivePin, PrimitiveSpec } from './types';
import { widthParam, type Params } from './types';

const SEGMENT_NAMES = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

/**
 * Which drive level lights a segment. `cathode` (the default, and every board
 * written before the '47/'48 landed) lights on 1, matching a common-cathode
 * display driven by a 74LS48. `anode` lights on 0 and stays dark on Z, which is
 * what an open-collector 74LS47 does to a common-anode display.
 */
export type SevenSegCommon = 'cathode' | 'anode';

export function sevenSegCommon(params: Params): SevenSegCommon {
  return params['common'] === 'anode' ? 'anode' : 'cathode';
}

/**
 * Whether a segment driven to `state` is lit. A common-cathode display lights
 * on a driven 1; a common-anode one lights on a driven 0 and stays dark on the
 * Z an open-collector '47 leaves behind. Pairing a '47 with a cathode display
 * therefore lights nothing, which is the mistake the two parts exist to teach.
 */
export function segmentLit(state: string | undefined, common: SevenSegCommon): boolean {
  return state === (common === 'anode' ? '0' : '1');
}

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
