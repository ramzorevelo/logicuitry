// Render and parse a BusValue across bases. Built on busValue so the workbench
// and the simulator agree on bit semantics. Assumes fully-known values (the
// Numbers workbench never carries X/Z); MSB is leftmost, matching the course.

import { assertWidth, known, toString, type BusValue } from '../value/busValue';
import type { Interpretation } from './types';

/** Unsigned magnitude as a JS number (width <= 32 fits the safe-integer range). */
export function toUnsigned(bv: BusValue, width: number): number {
  assertWidth(width);
  return width === 32 ? bv.v >>> 0 : bv.v & ((1 << width) - 1);
}

/** Signed value under two's complement: MSB carries weight -2^(width-1). */
export function toSigned(bv: BusValue, width: number): number {
  const u = toUnsigned(bv, width);
  return u >= 2 ** (width - 1) ? u - 2 ** width : u;
}

export function toDecimal(bv: BusValue, width: number, interp: Interpretation): number {
  return interp === 'twos' ? toSigned(bv, width) : toUnsigned(bv, width);
}

/** Wrap any signed/unsigned integer into a width-wide BusValue (mod 2^width). */
export function fromInt(value: number, width: number): BusValue {
  assertWidth(width);
  const span = 2 ** width;
  const wrapped = ((Math.trunc(value) % span) + span) % span;
  return known(wrapped, width);
}

export function renderBin(bv: BusValue, width: number): string {
  return toString(bv, width);
}

const HEX = '0123456789ABCDEF';

export function renderHex(bv: BusValue, width: number): string {
  const u = toUnsigned(bv, width);
  const digits = Math.ceil(width / 4);
  let s = '';
  for (let d = digits - 1; d >= 0; d--) s += HEX[(u >>> (d * 4)) & 0xf];
  return s;
}

export function renderOct(bv: BusValue, width: number): string {
  const u = toUnsigned(bv, width);
  const digits = Math.ceil(width / 3);
  let s = '';
  for (let d = digits - 1; d >= 0; d--) s += String((u >>> (d * 3)) & 0x7);
  return s;
}

export function renderDec(bv: BusValue, width: number, interp: Interpretation): string {
  return String(toDecimal(bv, width, interp));
}

export function parseBin(s: string, width: number): BusValue {
  return fromInt(Number.parseInt(s.replace(/[^01]/g, '') || '0', 2), width);
}

/**
 * parseBin for typed entry, where a short string is a partial number rather
 * than a whole word. Under two's complement its leading digit is a sign bit,
 * so `101` at 8 bits is -3 (11111101), not 5. Padding with zeros otherwise.
 * A full-width string is unaffected either way, so renderBin round-trips.
 */
export function parseBinTyped(s: string, width: number, interp: Interpretation): BusValue {
  const digits = s.replace(/[^01]/g, '');
  if (interp !== 'twos' || digits.length === 0 || digits.length >= width)
    return parseBin(digits, width);
  return parseBin(digits[0]!.repeat(width - digits.length) + digits, width);
}

export function parseHex(s: string, width: number): BusValue {
  return fromInt(Number.parseInt(s.replace(/[^0-9a-fA-F]/g, '') || '0', 16), width);
}

export function parseOct(s: string, width: number): BusValue {
  return fromInt(Number.parseInt(s.replace(/[^0-7]/g, '') || '0', 8), width);
}

export function parseDec(s: string, width: number): BusValue {
  const n = Number.parseInt(s.replace(/[^0-9-]/g, '') || '0', 10);
  return fromInt(Number.isNaN(n) ? 0 : n, width);
}
