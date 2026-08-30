// 4-state bus values. Bit i: z -> Z, else x -> X, else v.
// Lanes are uint32; every op re-masks to width and keeps values canonical
// (Z bits clear x/v, X bits clear v) so equality is plain lane comparison.

export const MAX_WIDTH = 32;

export interface BusValue {
  v: number;
  x: number;
  z: number;
}

export function widthMask(width: number): number {
  assertWidth(width);
  return width === 32 ? 0xffffffff : ((1 << width) - 1) >>> 0;
}

export function assertWidth(width: number): void {
  if (!Number.isInteger(width) || width < 1 || width > MAX_WIDTH)
    throw new RangeError(`bus width ${width} outside 1..${MAX_WIDTH}`);
}

export function norm(bv: BusValue, width: number): BusValue {
  const m = widthMask(width);
  const z = (bv.z & m) >>> 0;
  const x = (bv.x & m & ~z) >>> 0;
  const v = (bv.v & m & ~z & ~x) >>> 0;
  return { v, x, z };
}

export function known(value: number, width: number): BusValue {
  return norm({ v: value, x: 0, z: 0 }, width);
}

export function allX(width: number): BusValue {
  return { v: 0, x: widthMask(width), z: 0 };
}

export function allZ(width: number): BusValue {
  return { v: 0, x: 0, z: widthMask(width) };
}

export function equal(a: BusValue, b: BusValue): boolean {
  return a.v === b.v && a.x === b.x && a.z === b.z;
}

export function isFullyKnown(bv: BusValue, width: number): boolean {
  return ((bv.x | bv.z) & widthMask(width)) === 0;
}

/** MSB-left string over '01XZ'. */
export function toString(bv: BusValue, width: number): string {
  let s = '';
  for (let i = width - 1; i >= 0; i--) {
    const bit = 1 << i;
    s += bv.z & bit ? 'Z' : bv.x & bit ? 'X' : bv.v & bit ? '1' : '0';
  }
  return s;
}

export function fromString(s: string): BusValue {
  let v = 0,
    x = 0,
    z = 0;
  for (const ch of s) {
    v = (v << 1) >>> 0;
    x = (x << 1) >>> 0;
    z = (z << 1) >>> 0;
    if (ch === '1') v |= 1;
    else if (ch === 'X') x |= 1;
    else if (ch === 'Z') z |= 1;
    else if (ch !== '0') throw new Error(`bad bus literal char '${ch}'`);
  }
  return { v, x, z };
}

// Gate-input convention: a floating (Z) input reads as unknown (X), the real
// breadboard failure mode.
interface Lanes {
  one: number;
  zero: number;
}
function lanes(bv: BusValue, m: number): Lanes {
  const unknown = (bv.x | bv.z) & m;
  return { one: bv.v & ~unknown & m, zero: ~bv.v & ~unknown & m };
}

export function and(inputs: BusValue[], width: number): BusValue {
  const m = widthMask(width);
  let one = m,
    zero = 0;
  for (const bv of inputs) {
    const l = lanes(bv, m);
    one &= l.one; // 1 only if all known-1
    zero |= l.zero; // 0 dominates
  }
  zero &= ~one & m;
  return { v: one >>> 0, x: (m & ~one & ~zero) >>> 0, z: 0 };
}

export function or(inputs: BusValue[], width: number): BusValue {
  const m = widthMask(width);
  let one = 0,
    zero = m;
  for (const bv of inputs) {
    const l = lanes(bv, m);
    one |= l.one; // 1 dominates
    zero &= l.zero;
  }
  return { v: one >>> 0, x: (m & ~one & ~zero) >>> 0, z: 0 };
}

export function xor(inputs: BusValue[], width: number): BusValue {
  const m = widthMask(width);
  let parity = 0,
    knownAll = m;
  for (const bv of inputs) {
    knownAll &= ~(bv.x | bv.z);
    parity ^= bv.v;
  }
  knownAll &= m;
  return { v: (parity & knownAll) >>> 0, x: (m & ~knownAll) >>> 0, z: 0 };
}

export function not(input: BusValue, width: number): BusValue {
  const m = widthMask(width);
  const unknown = (input.x | input.z) & m;
  return { v: (~input.v & ~unknown & m) >>> 0, x: unknown >>> 0, z: 0 };
}

export function buf(input: BusValue, width: number): BusValue {
  const m = widthMask(width);
  const unknown = (input.x | input.z) & m;
  return { v: (input.v & ~unknown & m) >>> 0, x: unknown >>> 0, z: 0 };
}

export function invert(bv: BusValue, width: number): BusValue {
  return not(bv, width);
}

/**
 * Wired resolution of multiple drivers on one net: Z yields, agreeing known
 * values pass, any disagreement or X among drivers → X (bus contention).
 */
export function resolve(drivers: BusValue[], width: number): BusValue {
  const m = widthMask(width);
  let z = m,
    v = 0,
    x = 0,
    seen = 0; // bits already driven by someone
  for (const d of drivers) {
    const driving = ~d.z & m;
    const conflict = seen & driving & ((v ^ d.v) | x | d.x);
    x = ((x | (d.x & driving) | conflict) & m) >>> 0;
    v = ((v & seen) | (d.v & driving & ~seen)) >>> 0;
    seen = (seen | driving) >>> 0;
    z &= d.z;
  }
  z = (z & m) >>> 0;
  x = (x & ~z) >>> 0;
  v = (v & ~z & ~x & m) >>> 0;
  return { v, x, z };
}

/** Extract bits [lo, lo+width) into a width-wide value (splitter). */
export function slice(bv: BusValue, lo: number, width: number): BusValue {
  return norm({ v: bv.v >>> lo, x: bv.x >>> lo, z: bv.z >>> lo }, width);
}

/** Concatenate parts LSB-first into one bus (merger). */
export function concat(parts: { value: BusValue; width: number }[]): BusValue {
  let v = 0,
    x = 0,
    z = 0,
    shift = 0;
  for (const p of parts) {
    const q = norm(p.value, p.width);
    v = (v | (q.v << shift)) >>> 0;
    x = (x | (q.x << shift)) >>> 0;
    z = (z | (q.z << shift)) >>> 0;
    shift += p.width;
  }
  assertWidth(shift);
  return { v, x, z };
}
