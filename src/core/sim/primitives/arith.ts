import * as bv from '../../value/busValue';
import { listedPart } from '../../parts/partsDb';
import { assembleBus, expandPin, parsePinView, pinViewOf, reindexPins, splitBus } from './busPins';
import type { EvalContext, EvalResult, Params, PrimitivePin, PrimitiveSpec } from './types';
import { boolParam } from './types';

/** Fixed: a wider adder or comparator is built by chaining, which is the lab. */
export const ARITH_BITS = 4;
export const PARITY_INPUTS = 9;

/** One line in three-valued logic: 0, 1, or null for X and Z alike. */
type Bit = 0 | 1 | null;

function bitAt(value: bv.BusValue, i: number): Bit {
  if ((value.x | value.z) & (1 << i)) return null;
  return value.v & (1 << i) ? 1 : 0;
}

const toBus = (bit: Bit): bv.BusValue => (bit === null ? bv.allX(1) : bv.known(bit, 1));
const not3 = (a: Bit): Bit => (a === null ? null : a === 1 ? 0 : 1);
const and3 = (a: Bit, b: Bit): Bit => (a === 0 || b === 0 ? 0 : a === 1 && b === 1 ? 1 : null);
const xor3 = (a: Bit, b: Bit): Bit => (a === null || b === null ? null : a === b ? 0 : 1);
const or3 = (a: Bit, b: Bit): Bit => (a === 1 || b === 1 ? 1 : a === 0 && b === 0 ? 0 : null);

/** Two agreeing known inputs decide a carry whatever the third holds. */
function majority(a: Bit, b: Bit, c: Bit): Bit {
  const bits = [a, b, c];
  if (bits.filter((x) => x === 1).length >= 2) return 1;
  if (bits.filter((x) => x === 0).length >= 2) return 0;
  return null;
}

const isExpanded = (params: Params, name: string) =>
  pinViewOf(parsePinView(params), name, 'collapsed') === 'expanded';

function laneOrBus(name: string, dir: 'in' | 'out', params: Params): PrimitivePin[] {
  const base: PrimitivePin = { name, dir, width: ARITH_BITS, role: 'data', order: 0 };
  return isExpanded(params, name) ? expandPin(base, ARITH_BITS) : [base];
}

/** Reads one 4-bit operand from `inputs` at `cursor`, lane-expanded or not. */
function readOperand(
  inputs: readonly bv.BusValue[],
  cursor: number,
  expanded: boolean,
): { value: bv.BusValue; next: number } {
  if (!expanded) return { value: inputs[cursor]!, next: cursor + 1 };
  return {
    value: assembleBus(inputs.slice(cursor, cursor + ARITH_BITS)),
    next: cursor + ARITH_BITS,
  };
}

/**
 * 4-bit ripple adder, the '283's function. Rippled bit by bit in three-valued
 * logic so a carry the known bits decide stays known past an unknown one.
 */
export const adder: PrimitiveSpec = {
  kind: 'adder',
  pins: (params) =>
    reindexPins([
      ...laneOrBus('a', 'in', params),
      ...laneOrBus('b', 'in', params),
      { name: 'cin', dir: 'in', width: 1, role: 'data', order: 0 },
      ...laneOrBus('sum', 'out', params),
      { name: 'cout', dir: 'out', width: 1, role: 'data', order: 0 },
    ]),
  evaluate(ctx: EvalContext): EvalResult {
    const a = readOperand(ctx.inputs, 0, isExpanded(ctx.params, 'a'));
    const b = readOperand(ctx.inputs, a.next, isExpanded(ctx.params, 'b'));
    let carry = bitAt(ctx.inputs[b.next]!, 0);
    const sum = { v: 0, x: 0, z: 0 };
    for (let i = 0; i < ARITH_BITS; i++) {
      const ai = bitAt(a.value, i);
      const bi = bitAt(b.value, i);
      const s = xor3(xor3(ai, bi), carry);
      if (s === null) sum.x |= 1 << i;
      else sum.v |= s << i;
      carry = majority(ai, bi, carry);
    }
    const sumOut = isExpanded(ctx.params, 'sum') ? splitBus(sum, ARITH_BITS) : [sum];
    return { outputs: [...sumOut, toBus(carry)] };
  },
  defaultPart: '74LS283',
};

/**
 * A > B, A = B and A < B on the data alone, from bit 3 down in three-valued
 * logic: a known difference anywhere settles A = B to 0 even past an X bit.
 */
function compareMsbFirst(a: bv.BusValue, b: bv.BusValue): { gt: Bit; eq: Bit; lt: Bit } {
  let gt: Bit = 0;
  let lt: Bit = 0;
  let eqAbove: Bit = 1;
  for (let i = ARITH_BITS - 1; i >= 0; i--) {
    const ai = bitAt(a, i);
    const bi = bitAt(b, i);
    gt = or3(gt, and3(eqAbove, and3(ai, not3(bi))));
    lt = or3(lt, and3(eqAbove, and3(not3(ai), bi)));
    eqAbove = and3(eqAbove, not3(xor3(ai, bi)));
  }
  return { gt, eq: eqAbove, lt };
}

/**
 * 4-bit magnitude comparator, the '85's function. On equal data the cascade
 * inputs decide as the '85 table does, odd rows included:
 * eq = IEQ, gt = NOT IEQ AND NOT ILT, lt = NOT IEQ AND NOT IGT. Without
 * `hasCascade` the inputs are tied 0, 1, 0, so equal data reads eq.
 */
export const comparator: PrimitiveSpec = {
  kind: 'comparator',
  pins: (params) => {
    const cascade: PrimitivePin[] = boolParam(params, 'hasCascade', false)
      ? ['igt', 'ieq', 'ilt'].map((name) => ({ name, dir: 'in', width: 1, role: 'data', order: 0 }))
      : [];
    return reindexPins([
      ...laneOrBus('a', 'in', params),
      ...laneOrBus('b', 'in', params),
      ...cascade,
      { name: 'gt', dir: 'out', width: 1, role: 'data', order: 0 },
      { name: 'eq', dir: 'out', width: 1, role: 'data', order: 0 },
      { name: 'lt', dir: 'out', width: 1, role: 'data', order: 0 },
    ]);
  },
  evaluate(ctx: EvalContext): EvalResult {
    const a = readOperand(ctx.inputs, 0, isExpanded(ctx.params, 'a'));
    const b = readOperand(ctx.inputs, a.next, isExpanded(ctx.params, 'b'));
    const drive = (gt: Bit, eq: Bit, lt: Bit): EvalResult => ({
      outputs: [toBus(gt), toBus(eq), toBus(lt)],
    });
    const data = compareMsbFirst(a.value, b.value);
    const [igt, ieq, ilt]: Bit[] = boolParam(ctx.params, 'hasCascade', false)
      ? ctx.inputs.slice(b.next, b.next + 3).map((v) => bitAt(v, 0))
      : [0, 1, 0];
    return drive(
      or3(data.gt, and3(data.eq, and3(not3(ieq!), not3(ilt!)))),
      and3(data.eq, ieq!),
      or3(data.lt, and3(data.eq, and3(not3(ieq!), not3(igt!)))),
    );
  },
  defaultPart: () => listedPart('74LS85'),
};

/** Nine-input parity generator, the '280's function. Any unknown input gives X. */
export const parity: PrimitiveSpec = {
  kind: 'parity',
  pins: () =>
    reindexPins([
      ...Array.from(
        { length: PARITY_INPUTS },
        (_, i): PrimitivePin => ({ name: `d${i}`, dir: 'in', width: 1, role: 'data', order: 0 }),
      ),
      { name: 'even', dir: 'out', width: 1, role: 'data', order: 0 },
      { name: 'odd', dir: 'out', width: 1, role: 'data', order: 0 },
    ]),
  evaluate(ctx: EvalContext): EvalResult {
    let ones = 0;
    for (const input of ctx.inputs) {
      const bit = bitAt(input, 0);
      if (bit === null) return { outputs: [bv.allX(1), bv.allX(1)] };
      ones += bit;
    }
    const odd = ones % 2;
    return { outputs: [bv.known(1 - odd, 1), bv.known(odd, 1)] };
  },
  defaultPart: () => listedPart('74LS280'),
};
