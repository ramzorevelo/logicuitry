// Standard value set for numkit golden/property tests: 0, all-ones, MSB-only,
// and a mixed pattern, across every supported width. Signed negatives fall out
// of all-ones (-1) and MSB-only (most-negative) under two's complement.

import { widthMask, type BusValue } from '../value/busValue';
import { fromInt } from './format';

export const WIDTHS = [4, 8, 12, 16, 24, 32] as const;

export interface NamedValue {
  name: string;
  bv: BusValue;
}

export function standardValues(width: number): NamedValue[] {
  return [
    { name: 'zero', bv: fromInt(0, width) },
    { name: 'all-ones', bv: fromInt(widthMask(width), width) },
    { name: 'msb-only', bv: fromInt(2 ** (width - 1), width) },
    { name: 'mixed', bv: fromInt(0b1010 * (width >= 8 ? 0b100001 : 1), width) },
  ];
}
