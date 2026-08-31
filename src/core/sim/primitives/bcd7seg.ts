import * as bv from '../../value/busValue';
import type { EvalContext, EvalResult, Params, PrimitivePin, PrimitiveSpec } from './types';
import { boolParam } from './types';

export const SEGMENT_LETTERS = ['a', 'b', 'c', 'd', 'e', 'f', 'g'] as const;
export const ADDRESS_PINS = ['a0', 'a1', 'a2', 'a3'] as const;

/**
 * Which segments light for each 4-bit code, MSB-first as `abcdefg`. Both parts
 * display the same shapes -- only the drive level differs -- so one table
 * serves both. Codes 10..14 are the datasheet's deliberate non-digit glyphs and
 * 15 is blank; 6 has no `a` and 9 no `d`, which is the '47/'48 house style and
 * not a transcription slip.
 */
const SEGMENTS: readonly string[] = [
  '1111110', // 0
  '0110000', // 1
  '1101101', // 2
  '1111001', // 3
  '0110011', // 4
  '1011011', // 5
  '0011111', // 6
  '1110000', // 7
  '1111111', // 8
  '1110011', // 9
  '0001101', // 10
  '0011001', // 11
  '0100011', // 12
  '1001011', // 13
  '0001111', // 14
  '0000000', // 15
];

const BLANK = '0000000';
const ALL_LIT = '1111111';

/** True when the pin is a known logic 1. An unwired active-low control reads Z,
 *  which is the datasheet's "open or held HIGH" case, hence Z counting as high. */
function isHigh(b: bv.BusValue): boolean {
  if (b.z & 1) return true;
  return !(b.x & 1) && (b.v & 1) === 1;
}

function isLow(b: bv.BusValue): boolean {
  return !(b.z & 1) && !(b.x & 1) && (b.v & 1) === 0;
}

/**
 * BCD to seven-segment decoder, the shared core of the 74LS47 and 74LS48.
 *
 * `activeLow` picks the part: the '47 is open-collector and active-low, so a lit
 * segment is a driven 0 and a dark one is genuinely high-impedance, which is
 * what a common-anode display's own supply pulls up. The '48 has internal
 * pull-ups and drives a lit segment high, for a common-cathode display.
 */
export const bcd7seg: PrimitiveSpec = {
  kind: 'bcd7seg',
  pins: () => {
    const pins: PrimitivePin[] = [];
    ADDRESS_PINS.forEach((name, i) =>
      pins.push({ name, dir: 'in', width: 1, role: 'data', order: i }),
    );
    // SPEC: pin 4 is really a bidirectional wired-AND blanking input / ripple-
    // blanking output, which PinDir cannot express. Modelled as the blanking
    // input alone; multi-digit ripple-blank cascade is past Harris ch.1-3.
    pins.push({ name: 'lt', dir: 'in', width: 1, role: 'enable', order: 4 });
    pins.push({ name: 'bi', dir: 'in', width: 1, role: 'enable', order: 5 });
    // SPEC: /RBI's own truth-table row is modelled; it does not cascade either.
    pins.push({ name: 'rbi', dir: 'in', width: 1, role: 'enable', order: 6 });
    SEGMENT_LETTERS.forEach((letter, i) =>
      pins.push({
        name: `seg_${letter}`,
        dir: 'out',
        width: 1,
        role: 'data',
        order: i,
        label: letter,
      }),
    );
    return pins;
  },
  evaluate(ctx: EvalContext): EvalResult {
    const activeLow = boolParam(ctx.params, 'activeLow', false);
    const [a0, a1, a2, a3, lt, bi, rbi] = ctx.inputs as readonly bv.BusValue[];
    const addr = [a0!, a1!, a2!, a3!];

    const drive = (pattern: string): EvalResult => ({
      outputs: SEGMENT_LETTERS.map((_, i) => {
        const lit = pattern[i] === '1';
        if (!activeLow) return bv.known(lit ? 1 : 0, 1);
        return lit ? bv.known(0, 1) : bv.allZ(1);
      }),
    });
    const unknown = (): EvalResult => ({ outputs: SEGMENT_LETTERS.map(() => bv.allX(1)) });

    // Row order is the datasheet's own precedence: /BI overrides everything,
    // then /LT, then the /RBI zero-blank, then the plain decode.
    if (isLow(bi!)) return drive(BLANK);
    if (isLow(lt!)) return drive(ALL_LIT);
    if (!isHigh(bi!) || !isHigh(lt!)) return unknown();

    if (addr.every(isLow)) {
      if (isLow(rbi!)) return drive(BLANK);
      if (!isHigh(rbi!)) return unknown();
    }
    if (!addr.every((b) => isLow(b) || isHigh(b))) return unknown();

    let code = 0;
    addr.forEach((b, i) => {
      if (isHigh(b)) code |= 1 << i;
    });
    return drive(SEGMENTS[code]!);
  },
  defaultPart: (params: Params) => (boolParam(params, 'activeLow', false) ? '74LS47' : '74LS48'),
};
