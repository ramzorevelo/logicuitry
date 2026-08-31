import * as bv from '../../value/busValue';
import { expandPin, parsePinView, pinViewOf, reindexPins, splitBus } from './busPins';
import type { EvalResult, Params, PrimitivePin, PrimitiveSpec } from './types';
import { intParam, widthParam } from './types';

// Lane expand for a primitive's single wide pin (mirrors stimulus.ts's onePinLane).
function onePinLane(name: string, dir: 'in' | 'out', params: Params): PrimitivePin[] {
  const w = widthParam(params);
  const view = parsePinView(params);
  const base: PrimitivePin = { name, dir, width: w, role: 'data', order: 0 };
  const expanded = w > 1 && pinViewOf(view, name, 'collapsed') === 'expanded';
  return reindexPins(expanded ? expandPin(base, w) : [base]);
}

/** LSB-first split sizes from params.splits, e.g. "1,1,1,1" or "4,4". */
export function splitSizes(params: Params): number[] {
  const raw = params['splits'];
  const sizes =
    typeof raw === 'string'
      ? raw.split(',').map((s) => Number.parseInt(s.trim(), 10))
      : [widthParam(params)];
  const total = sizes.reduce((a, b) => a + b, 0);
  if (sizes.some((s) => !Number.isInteger(s) || s < 1) || total !== widthParam(params))
    throw new RangeError(`splits '${String(raw)}' do not sum to width ${widthParam(params)}`);
  return sizes;
}

/** Settable source; drives X until the user assigns a value. */
export const inputPin: PrimitiveSpec = {
  kind: 'inport',
  pins: (params) => onePinLane('y', 'out', params),
  init: (params) => ({ value: bv.allX(widthParam(params)) }),
  evaluate: (ctx) => {
    const w = widthParam(ctx.params);
    const value = (ctx.state as { value: bv.BusValue }).value;
    const view = parsePinView(ctx.params);
    const expanded = w > 1 && pinViewOf(view, 'y', 'collapsed') === 'expanded';
    return { outputs: expanded ? splitBus(value, w) : [value] };
  },
};

/** Pure observer; the UI and waveform read its net. */
export const outputPin: PrimitiveSpec = {
  kind: 'outport',
  pins: (params) => onePinLane('a', 'in', params),
  evaluate: (): EvalResult => ({ outputs: [] }),
};

/**
 * Local net label (KiCad's plain Label): names a net and joins every other
 * label of the same name in the same circuit. Neither a driver nor a sink,
 * its one pin is `passive` and takes the width of whatever net it lands on.
 * `compile` never emits a primitive for it (it resolves to a net alias, like
 * a port); this spec exists so the glyph and wiring layers can still ask it
 * for its pin like any other kind.
 */
export const netLabel: PrimitiveSpec = {
  kind: 'netlabel',
  pins: () => [{ name: 'a', dir: 'passive', width: 1, role: 'data', order: 0 }],
  evaluate: (): EvalResult => ({ outputs: [] }),
};

export const constant: PrimitiveSpec = {
  kind: 'constant',
  pins: (params) => [{ name: 'y', dir: 'out', width: widthParam(params), role: 'data', order: 0 }],
  evaluate: (ctx) => ({
    outputs: [bv.known(intParam(ctx.params, 'value', 0), widthParam(ctx.params))],
  }),
};

/**
 * Power rail sources. A chip's VCC/GND pins are real inputs that must be wired
 * for it to drive anything, so the rails need a placeable symbol; each is a
 * fixed-value driver, which is `constant` with the value spelled out by the
 * glyph instead of a parameter.
 */
function rail(kind: string, level: 0 | 1): PrimitiveSpec {
  return {
    kind,
    pins: () => [{ name: 'p', dir: 'out', width: 1, role: 'data', order: 0 }],
    evaluate: () => ({ outputs: [bv.known(level, 1)] }),
  };
}
export const vccRail = rail('vcc', 1);
export const gndRail = rail('gnd', 0);

export const split: PrimitiveSpec = {
  kind: 'split',
  pins: (params) => {
    const outs: PrimitivePin[] = splitSizes(params).map((w, i) => ({
      name: `o${i}`,
      dir: 'out',
      width: w,
      role: 'data',
      order: i,
    }));
    return [{ name: 'bus', dir: 'in', width: widthParam(params), role: 'data', order: 0 }, ...outs];
  },
  evaluate(ctx): EvalResult {
    const sizes = splitSizes(ctx.params);
    let lo = 0;
    return {
      outputs: sizes.map((w) => {
        const part = bv.slice(ctx.inputs[0]!, lo, w);
        lo += w;
        return part;
      }),
    };
  },
};

export const merge: PrimitiveSpec = {
  kind: 'merge',
  pins: (params) => {
    const ins: PrimitivePin[] = splitSizes(params).map((w, i) => ({
      name: `i${i}`,
      dir: 'in',
      width: w,
      role: 'data',
      order: i,
    }));
    return [...ins, { name: 'bus', dir: 'out', width: widthParam(params), role: 'data', order: 0 }];
  },
  evaluate(ctx): EvalResult {
    const sizes = splitSizes(ctx.params);
    return {
      outputs: [bv.concat(sizes.map((w, i) => ({ value: ctx.inputs[i]!, width: w })))],
    };
  },
};

/**
 * Bus tap, read direction: slices [lo, lo+width) off a bus onto a sub-range net.
 * Compiler-synthesized only (a tap is a drawing convention, never placed); params
 * carry busWidth, lo, width.
 */
export const busTapRead: PrimitiveSpec = {
  kind: 'tapread',
  pins: (params) => [
    { name: 'bus', dir: 'in', width: intParam(params, 'busWidth', 1), role: 'data', order: 0 },
    { name: 'y', dir: 'out', width: intParam(params, 'width', 1), role: 'data', order: 0 },
  ],
  evaluate: (ctx): EvalResult => ({
    outputs: [
      bv.slice(ctx.inputs[0]!, intParam(ctx.params, 'lo', 0), intParam(ctx.params, 'width', 1)),
    ],
  }),
};

/**
 * Bus tap, drive direction: places a sub-range value onto a bus, floating (Z) the
 * untapped bits so several taps on one bus resolve per bit. Compiler-synthesized only.
 */
export const busTapDrive: PrimitiveSpec = {
  kind: 'tapdrive',
  pins: (params) => [
    { name: 'a', dir: 'in', width: intParam(params, 'width', 1), role: 'data', order: 0 },
    { name: 'bus', dir: 'out', width: intParam(params, 'busWidth', 1), role: 'data', order: 0 },
  ],
  evaluate(ctx): EvalResult {
    const width = intParam(ctx.params, 'width', 1);
    const lo = intParam(ctx.params, 'lo', 0);
    const busWidth = intParam(ctx.params, 'busWidth', 1);
    const a = bv.norm(ctx.inputs[0]!, width);
    const busMask = bv.widthMask(busWidth);
    const tapMask = ((bv.widthMask(width) << lo) & busMask) >>> 0;
    const untapped = (~tapMask & busMask) >>> 0;
    return {
      outputs: [
        bv.norm(
          {
            v: ((a.v << lo) & tapMask) >>> 0,
            x: ((a.x << lo) & tapMask) >>> 0,
            z: (((a.z << lo) & tapMask) | untapped) >>> 0,
          },
          busWidth,
        ),
      ],
    };
  },
};

/** Connectivity only: compile unions same-name tunnel nets and drops the component. */
export const tunnel: PrimitiveSpec = {
  kind: 'tunnel',
  pins: (params) => [{ name: 'p', dir: 'in', width: widthParam(params), role: 'data', order: 0 }],
  evaluate: () => ({ outputs: [] }),
};

/** Weak drivers: compile records a per-net pull; the kernel applies it to Z bits. */
function pull(kind: string): PrimitiveSpec {
  return {
    kind,
    pins: (params) => [{ name: 'p', dir: 'in', width: widthParam(params), role: 'data', order: 0 }],
    evaluate: () => ({ outputs: [] }),
  };
}
export const pullUp = pull('pullup');
export const pullDown = pull('pulldown');
