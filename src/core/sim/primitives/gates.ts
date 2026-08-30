import * as bv from '../../value/busValue';
import { assembleBus, expandPin, pinViewOf, reindexPins, splitBus, parsePinView } from './busPins';
import type { EvalContext, EvalResult, Params, PrimitivePin, PrimitiveSpec } from './types';
import { intParam, widthParam } from './types';

// Width w = w independent 1-bit lanes, Y[i] = op of bit i of each input;
// arity stays orthogonal (more input pins, same lanes). Each lane pin (any
// input letter, or `y`) can individually expand into w 1-bit pins via
// `pinView` -- default stays a single wide pin per letter.
const INPUT_NAMES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

export function gateArity(params: Params): number {
  const n = intParam(params, 'inputs', 2);
  if (n < 2 || n > 8) throw new RangeError(`gate arity ${n} outside 2..8`);
  return n;
}

// How many raw sim pins a lane occupies (1 if collapsed or 1-bit, else w).
function laneSpan(width: number, expanded: boolean): number {
  return width > 1 && expanded ? width : 1;
}

function gatePins(params: Params): PrimitivePin[] {
  const w = widthParam(params);
  const view = parsePinView(params);
  const pins: PrimitivePin[] = [];
  for (const name of INPUT_NAMES.slice(0, gateArity(params))) {
    const base: PrimitivePin = { name, dir: 'in', width: w, role: 'data', order: 0 };
    const expanded = w > 1 && pinViewOf(view, name, 'collapsed') === 'expanded';
    pins.push(...(expanded ? expandPin(base, w) : [base]));
  }
  const yBase: PrimitivePin = { name: 'y', dir: 'out', width: w, role: 'data', order: 0 };
  const yExpanded = w > 1 && pinViewOf(view, 'y', 'collapsed') === 'expanded';
  pins.push(...(yExpanded ? expandPin(yBase, w) : [yBase]));
  return reindexPins(pins);
}

type NaryOp = (inputs: bv.BusValue[], width: number) => bv.BusValue;

export function naryGate(kind: string, op: NaryOp, defaultPart?: string): PrimitiveSpec {
  const spec: PrimitiveSpec = {
    kind,
    pins: gatePins,
    evaluate(ctx: EvalContext): EvalResult {
      const w = widthParam(ctx.params);
      const view = parsePinView(ctx.params);
      const arity = gateArity(ctx.params);
      const names = INPUT_NAMES.slice(0, arity);
      let cursor = 0;
      const lanes: bv.BusValue[] = names.map((name) => {
        const expanded = w > 1 && pinViewOf(view, name, 'collapsed') === 'expanded';
        const span = laneSpan(w, expanded);
        const raw = ctx.inputs.slice(cursor, cursor + span);
        cursor += span;
        return expanded ? assembleBus(raw) : raw[0]!;
      });
      const y = op(lanes, w);
      const yExpanded = w > 1 && pinViewOf(view, 'y', 'collapsed') === 'expanded';
      return { outputs: yExpanded ? splitBus(y, w) : [y] };
    },
  };
  if (defaultPart) spec.defaultPart = defaultPart;
  return spec;
}

export const nandGate = naryGate('nand', (ins, w) => bv.not(bv.and(ins, w), w), '74LS00');
export const andGate = naryGate('and', (ins, w) => bv.and(ins, w), '74LS08');
export const orGate = naryGate('or', (ins, w) => bv.or(ins, w), '74LS32');
export const norGate = naryGate('nor', (ins, w) => bv.not(bv.or(ins, w), w), '74LS02');
export const xorGate = naryGate('xor', (ins, w) => bv.xor(ins, w), '74LS86');
export const xnorGate = naryGate('xnor', (ins, w) => bv.not(bv.xor(ins, w), w));

const unaryPins = (params: Params): PrimitivePin[] => {
  const w = widthParam(params);
  const view = parsePinView(params);
  const aBase: PrimitivePin = { name: 'a', dir: 'in', width: w, role: 'data', order: 0 };
  const yBase: PrimitivePin = { name: 'y', dir: 'out', width: w, role: 'data', order: 0 };
  const aExpanded = w > 1 && pinViewOf(view, 'a', 'collapsed') === 'expanded';
  const yExpanded = w > 1 && pinViewOf(view, 'y', 'collapsed') === 'expanded';
  return reindexPins([
    ...(aExpanded ? expandPin(aBase, w) : [aBase]),
    ...(yExpanded ? expandPin(yBase, w) : [yBase]),
  ]);
};

type UnaryOp = (input: bv.BusValue, width: number) => bv.BusValue;

function unaryEvaluate(op: UnaryOp): (ctx: EvalContext) => EvalResult {
  return (ctx) => {
    const w = widthParam(ctx.params);
    const view = parsePinView(ctx.params);
    const aExpanded = w > 1 && pinViewOf(view, 'a', 'collapsed') === 'expanded';
    const a = aExpanded ? assembleBus(ctx.inputs.slice(0, laneSpan(w, aExpanded))) : ctx.inputs[0]!;
    const y = op(a, w);
    const yExpanded = w > 1 && pinViewOf(view, 'y', 'collapsed') === 'expanded';
    return { outputs: yExpanded ? splitBus(y, w) : [y] };
  };
}

export const bufGate: PrimitiveSpec = {
  kind: 'buf',
  pins: unaryPins,
  evaluate: unaryEvaluate(bv.buf),
};

export const notGate: PrimitiveSpec = {
  kind: 'not',
  pins: unaryPins,
  evaluate: unaryEvaluate(bv.not),
  defaultPart: '74LS04',
};

// Enable X/Z -> X out: the buffer may or may not be driving, so nothing is known.
export const tristateBuf: PrimitiveSpec = {
  kind: 'tristate',
  pins: () => [
    { name: 'a', dir: 'in', width: 1, role: 'data', order: 0 },
    { name: 'en', dir: 'in', width: 1, role: 'enable', order: 1 },
    { name: 'y', dir: 'out', width: 1, role: 'data', order: 0 },
  ],
  evaluate(ctx): EvalResult {
    const en = ctx.inputs[1]!;
    if (en.z & 1 || en.x & 1) return { outputs: [bv.allX(1)] };
    return { outputs: [en.v & 1 ? bv.buf(ctx.inputs[0]!, 1) : bv.allZ(1)] };
  },
};
