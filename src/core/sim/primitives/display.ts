import { onePinLane } from './busPins';
import type { PrimitivePin, PrimitiveSpec } from './types';
import { intParam, type Params } from './types';

export const SEGMENT_NAMES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp'];

/** The two common terminals, bonded to one another inside the package. */
export const COMMON_PINS = ['com1', 'com2'] as const;

/**
 * Package pin order, 1..10, of a single-digit 10-pin display (5161AS and every
 * part with its footprint): pins 1-5 run left to right along the bottom edge,
 * 6-10 right to left along the top, so the top reads `g f com2 a b`.
 */
const PACKAGE_PINS = ['e', 'd', 'com1', 'c', 'dp', 'b', 'a', 'com2', 'f', 'g'];

/** Both commons print `com` on the symbol: they are one node, the digit only
 *  distinguishes them for wiring, and the fourth character does not fit the
 *  pin pitch. */
const PIN_LABELS: Record<string, string> = { com1: 'com', com2: 'com' };

/** How many of `PACKAGE_PINS` sit on the bottom edge; the rest are the top. */
export const BOTTOM_PIN_COUNT = 5;

/**
 * Which display this is. `cathode` (the default, and every board written
 * before the '47/'48 landed) lights on a segment 1; `anode` lights on a
 * segment 0 and stays dark on Z, which is what an open-collector 74LS47 does.
 */
export type SevenSegCommon = 'cathode' | 'anode';

export function sevenSegCommon(params: Params): SevenSegCommon {
  return params['common'] === 'anode' ? 'anode' : 'cathode';
}

/**
 * Whether a segment is lit. Both terminals matter, exactly as on a real part:
 * a common-cathode display needs its common tied to GND (reading 0) and the
 * segment driven to 1; a common-anode one needs common at VCC (reading 1) and
 * the segment pulled to 0, staying dark on the Z an open-collector '47 leaves.
 * An unwired common leaves the whole display dark, which is the real behaviour
 * and the mistake worth teaching. The two commons are one net by the time this
 * runs, so either lead being wired is enough -- as on the bench.
 */
export function segmentLit(
  state: string | undefined,
  common: SevenSegCommon,
  commonState: string | undefined,
): boolean {
  const anode = common === 'anode';
  if (commonState !== (anode ? '1' : '0')) return false;
  return state === (anode ? '0' : '1');
}

/** Observer only; render layer lights segments from the connected net values. */
export const sevenseg: PrimitiveSpec = {
  kind: 'sevenseg',
  pins: () =>
    PACKAGE_PINS.map((name, i): PrimitivePin => {
      const label = PIN_LABELS[name];
      return { name, dir: 'in', width: 1, role: 'data', order: i, ...(label ? { label } : {}) };
    }),
  tiedPins: [COMMON_PINS],
  evaluate: () => ({ outputs: [] }),
};

/** Observer only; render layer shows the bus value in the chosen radix.
 *  Lane-expandable like the probe it sits beside: without that, expanding the
 *  pin driving a display had no bit-for-bit target to rewire onto and the
 *  wire was dropped. */
export const busdisplay: PrimitiveSpec = {
  kind: 'busdisplay',
  pins: (params) => onePinLane('value', 'in', params),
  evaluate: () => ({ outputs: [] }),
};

export const MATRIX_MIN = 2;
export const MATRIX_MAX = 8;

function matrixDim(params: Params, name: string): number {
  return Math.min(MATRIX_MAX, Math.max(MATRIX_MIN, intParam(params, name, 8)));
}

export function matrixRows(params: Params): number {
  return matrixDim(params, 'rows');
}

export function matrixCols(params: Params): number {
  return matrixDim(params, 'cols');
}

/**
 * Ordinary row-drive/column-sink wiring: current flows when the row is driven
 * high and the column is pulled low, so a dot lights on row 1 and column 0.
 * Lives beside `segmentLit` so the render layer is the only consumer.
 */
export function matrixDotLit(rowState: string | undefined, colState: string | undefined): boolean {
  return rowState === '1' && colState === '0';
}

/** Observer only; render layer lights dots from the connected net values. */
export const ledmatrix: PrimitiveSpec = {
  kind: 'ledmatrix',
  pins: (params) => {
    const rows = matrixRows(params);
    const cols = matrixCols(params);
    const pins: PrimitivePin[] = [];
    for (let r = 0; r < rows; r++)
      pins.push({ name: `r${r}`, dir: 'in', width: 1, role: 'data', order: pins.length });
    for (let c = 0; c < cols; c++)
      pins.push({ name: `c${c}`, dir: 'in', width: 1, role: 'data', order: pins.length });
    return pins;
  },
  evaluate: () => ({ outputs: [] }),
};
