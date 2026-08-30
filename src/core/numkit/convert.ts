// Narrated base conversions. Each generator returns the ordered steps the
// Convert tab plays back one keypress at a time; the text is the teaching, the
// highlights drive the bit/digit emphasis. Pure and deterministic.

import type { BusValue } from '../value/busValue';
import { fromInt, renderBin, renderHex, renderOct, toSigned, toUnsigned } from './format';
import type { BitRef, Dec2BinMethod, Dec2HexMethod, NarrationStep, TwosMethod } from './types';

/** Placeholder standing in for a withheld answer under hide-answers mode. */
const BLANK = '▯';

function step(
  kind: NarrationStep['kind'],
  text: string,
  highlights: BitRef[],
  partial?: string,
  maskedText?: string,
): NarrationStep {
  const base: NarrationStep = { kind, text, highlights };
  if (partial !== undefined) base.partial = partial;
  if (maskedText !== undefined) base.maskedText = maskedText;
  return base;
}

const valueBit = (bit: number): BitRef => ({ row: 'value', bit });
const valueBits = (lo: number, hi: number): BitRef[] => {
  const refs: BitRef[] = [];
  for (let b = lo; b <= hi; b++) refs.push(valueBit(b));
  return refs;
};

/** Bits discovered so far, MSB-left, undiscovered shown as '.'. */
function partialBits(bits: (0 | 1 | null)[], width: number): string {
  let s = '';
  for (let i = width - 1; i >= 0; i--) s += bits[i] === null ? '.' : String(bits[i]);
  return s;
}

function bitAt(u: number, i: number): 0 | 1 {
  return ((u >>> i) & 1) as 0 | 1;
}

export function bin2dec(bv: BusValue, width: number, twos = false): NarrationStep[] {
  const steps: NarrationStep[] = [];
  let total = 0;
  for (let i = width - 1; i >= 0; i--) {
    if (bitAt(toUnsigned(bv, width), i) !== 1) continue;
    const negWeight = twos && i === width - 1;
    const mag = 2 ** i;
    total += negWeight ? -mag : mag;
    const verb = negWeight ? 'subtract' : 'add';
    // Running total lives in the badge only; prose states just the operation.
    steps.push(
      step('weight', `bit ${i} is 1 -> ${verb} 2^${i} = ${mag}`, [valueBit(i)], String(total)),
    );
  }
  steps.push(step('note', `${renderBin(bv, width)} =`, [], String(total)));
  return steps;
}

export function dec2bin(
  bv: BusValue,
  width: number,
  method: Dec2BinMethod = 'division',
): NarrationStep[] {
  const u = toUnsigned(bv, width);
  const discovered: (0 | 1 | null)[] = Array.from({ length: width }, () => null);
  const steps: NarrationStep[] = [];

  if (method === 'division') {
    let q = u;
    for (let k = 0; k < width; k++) {
      const r = (q & 1) as 0 | 1;
      const next = Math.floor(q / 2);
      discovered[k] = r;
      steps.push(
        step(
          'digit',
          `${q} / 2 = ${next} remainder ${r} -> bit ${k} = ${r}`,
          [valueBit(k)],
          partialBits(discovered, width),
          `${q} / 2 = ${BLANK} remainder ${BLANK} -> bit ${k} = ${BLANK}`,
        ),
      );
      q = next;
      if (q === 0) {
        for (let j = k + 1; j < width; j++) discovered[j] = 0;
        break;
      }
    }
  } else {
    // Shortcut method: jump straight to the next weight that fits, skip narrating ones that don't.
    // What's predicted each step is which weight is next, not just its value -- mask the bit/
    // weight identity itself, not only the outcome, or the answer leaks before the guess.
    let rem = u;
    for (let i = width - 1; i >= 0; i--) {
      const w = 2 ** i;
      const fits = w <= rem;
      discovered[i] = fits ? 1 : 0;
      if (!fits) continue;
      const remBefore = rem;
      rem -= w;
      steps.push(
        step(
          'weight',
          `2^${i} = ${w} <= ${remBefore} -> bit ${i} = 1, remainder ${rem}`,
          [valueBit(i)],
          partialBits(discovered, width),
          `2^${BLANK} <= ${remBefore} -> bit ${BLANK} = 1, remainder ${BLANK}`,
        ),
      );
    }
  }
  steps.push(step('note', `${u} =`, valueBits(0, width - 1), renderBin(bv, width)));
  return steps;
}

function groupConvert(
  bv: BusValue,
  width: number,
  groupBits: number,
  render: (bv: BusValue, width: number) => string,
): NarrationStep[] {
  const u = toUnsigned(bv, width);
  const digits = Math.ceil(width / groupBits);
  const full = render(bv, width);
  const steps: NarrationStep[] = [];
  for (let d = digits - 1; d >= 0; d--) {
    const lo = d * groupBits;
    const hi = Math.min(lo + groupBits - 1, width - 1);
    let bin = '';
    for (let b = hi; b >= lo; b--) bin += String(bitAt(u, b));
    const digit = full[digits - 1 - d]!;
    steps.push(
      step(
        'group',
        `bits ${hi}..${lo} = ${bin} -> ${digit}`,
        valueBits(lo, hi),
        full.slice(0, digits - d),
        `bits ${hi}..${lo} = ${bin} -> ${BLANK}`,
      ),
    );
  }
  steps.push(step('note', `${renderBin(bv, width)} =`, valueBits(0, width - 1), full));
  return steps;
}

export function bin2hex(bv: BusValue, width: number): NarrationStep[] {
  return groupConvert(bv, width, 4, renderHex);
}

export function bin2oct(bv: BusValue, width: number): NarrationStep[] {
  return groupConvert(bv, width, 3, renderOct);
}

function ungroup(
  bv: BusValue,
  width: number,
  groupBits: number,
  render: (bv: BusValue, width: number) => string,
): NarrationStep[] {
  const digitStr = render(bv, width);
  const u = toUnsigned(bv, width);
  const discovered: (0 | 1 | null)[] = Array.from({ length: width }, () => null);
  const steps: NarrationStep[] = [];
  for (let idx = 0; idx < digitStr.length; idx++) {
    const d = digitStr.length - 1 - idx; // group index from LSB
    const lo = d * groupBits;
    const hi = Math.min(lo + groupBits - 1, width - 1);
    let bin = '';
    for (let b = hi; b >= lo; b--) {
      discovered[b] = bitAt(u, b);
      bin += String(bitAt(u, b));
    }
    steps.push(
      step(
        'digit',
        `${digitStr[idx]} = ${bin} (bits ${hi}..${lo})`,
        valueBits(lo, hi),
        partialBits(discovered, width),
        `${digitStr[idx]} = ${BLANK} (bits ${hi}..${lo})`,
      ),
    );
  }
  steps.push(step('note', `${digitStr} =`, valueBits(0, width - 1), renderBin(bv, width)));
  return steps;
}

export function hex2bin(bv: BusValue, width: number): NarrationStep[] {
  return ungroup(bv, width, 4, renderHex);
}

export function oct2bin(bv: BusValue, width: number): NarrationStep[] {
  return ungroup(bv, width, 3, renderOct);
}

/** Encode a signed decimal as its width-bit two's-complement pattern. */
export function twosEncode(
  value: number,
  width: number,
  method: TwosMethod = 'invert-add',
): NarrationStep[] {
  const target = fromInt(value, width);
  const all = valueBits(0, width - 1);
  if (value >= 0) {
    return [
      step('note', `${value} >= 0: the pattern is just its binary`, all),
      step('note', `${value} =`, all, renderBin(target, width)),
    ];
  }
  if (method === 'alternative') {
    const span = 2 ** width;
    const diff = span + value;
    return [
      step(
        'note',
        `2^${width} - ${-value} = ${diff}`,
        all,
        undefined,
        `2^${width} - ${-value} = ${BLANK}`,
      ),
      step('note', `${diff} =`, all, renderBin(fromInt(diff, width), width)),
    ];
  }
  const mag = fromInt(-value, width);
  const magBin = renderBin(mag, width);
  const inverted = fromInt(~toUnsigned(mag, width), width);
  const invBin = renderBin(inverted, width);
  const finalBin = renderBin(target, width);
  return [
    step('note', `encode ${value}: start from |${value}| = ${-value}`, all, magBin),
    step('complement', `invert every bit (one's complement)`, all, invBin),
    step('add-one', `add 1: ${invBin} + 1`, all, finalBin),
  ];
}

/** Decode a width-bit two's-complement pattern to its signed decimal. */
export function twosDecode(
  bv: BusValue,
  width: number,
  method: TwosMethod = 'invert-add',
): NarrationStep[] {
  const all = valueBits(0, width - 1);
  const signed = toSigned(bv, width);
  if (bitAt(toUnsigned(bv, width), width - 1) === 0) {
    return [step('note', `MSB is 0: non-negative`, [valueBit(width - 1)], String(signed))];
  }
  if (method === 'alternative') {
    return bin2dec(bv, width, true);
  }
  const inverted = fromInt(~toUnsigned(bv, width), width);
  const magPlus = fromInt(toUnsigned(inverted, width) + 1, width);
  const mag = toUnsigned(magPlus, width);
  return [
    step('note', `MSB is 1: value is negative`, [valueBit(width - 1)]),
    step('complement', `invert the bits`, all, renderBin(inverted, width)),
    step('add-one', `add 1: ${renderBin(inverted, width)} + 1`, all, renderBin(magPlus, width)),
    step('digit', `convert the binary magnitude to decimal`, all, String(mag)),
    step('note', `add a negative sign`, [], String(signed)),
  ];
}

function bridge(text: string): NarrationStep {
  return step('note', text, []);
}

const HEX_DIGITS = '0123456789ABCDEF';

/** Digit-by-digit base-16 weighted sum (H&H Example 1.4 style: 2ED = 2*16^2 + E*16^1 + D*16^0). */
function hex2decWeighted(bv: BusValue, width: number): NarrationStep[] {
  const digits = renderHex(bv, width);
  const n = digits.length;
  let total = 0;
  const steps: NarrationStep[] = [];
  for (let i = 0; i < n; i++) {
    const place = n - 1 - i;
    const digit = digits[i]!;
    const contribution = Number.parseInt(digit, 16) * 16 ** place;
    total += contribution;
    const lo = place * 4;
    const hi = Math.min(lo + 3, width - 1);
    steps.push(
      step(
        'weight',
        `${digit} × 16^${place} = ${contribution}`,
        valueBits(lo, hi),
        String(total),
        `${digit} × 16^${place} = ${BLANK}`,
      ),
    );
  }
  steps.push(step('note', `0x${digits} =`, valueBits(0, width - 1), String(total)));
  return steps;
}

export function hex2dec(bv: BusValue, width: number, twos = false): NarrationStep[] {
  if (twos) {
    return [
      bridge('first expand each hex digit to 4 bits:'),
      ...hex2bin(bv, width),
      bridge('then take the weighted sum:'),
      ...bin2dec(bv, width, twos),
    ];
  }
  return hex2decWeighted(bv, width);
}

/** Digit-by-digit base-16 conversion, taught two ways like dec2bin. */
export function dec2hex(
  bv: BusValue,
  width: number,
  method: Dec2HexMethod = 'division',
): NarrationStep[] {
  const u = toUnsigned(bv, width);
  const digitCount = Math.ceil(width / 4);
  const discovered: (string | null)[] = Array.from({ length: digitCount }, () => null);
  const steps: NarrationStep[] = [];

  const partialDigits = (): string => {
    let s = '';
    for (let i = digitCount - 1; i >= 0; i--) s += discovered[i] ?? '.';
    return s;
  };

  if (method === 'division') {
    let q = u;
    for (let k = 0; k < digitCount; k++) {
      const r = q % 16;
      const next = Math.floor(q / 16);
      discovered[k] = HEX_DIGITS[r]!;
      steps.push(
        step(
          'digit',
          `${q} / 16 = ${next} remainder ${r} -> digit = ${HEX_DIGITS[r]}`,
          valueBits(k * 4, Math.min(k * 4 + 3, width - 1)),
          partialDigits(),
          `${q} / 16 = ${BLANK} remainder ${BLANK} -> digit = ${BLANK}`,
        ),
      );
      q = next;
      if (q === 0) {
        for (let j = k + 1; j < digitCount; j++) discovered[j] = '0';
        break;
      }
    }
  } else {
    let rem = u;
    for (let i = digitCount - 1; i >= 0; i--) {
      const w = 16 ** i;
      const d = Math.floor(rem / w);
      const before = rem;
      rem -= d * w;
      discovered[i] = HEX_DIGITS[d]!;
      steps.push(
        step(
          'weight',
          `16^${i} = ${w} into ${before} -> digit ${HEX_DIGITS[d]}, remainder ${rem}`,
          valueBits(i * 4, Math.min(i * 4 + 3, width - 1)),
          partialDigits(),
          `16^${i} = ${w} into ${before} -> digit ${BLANK}, remainder ${BLANK}`,
        ),
      );
    }
  }
  steps.push(step('note', `${u} =`, valueBits(0, width - 1), renderHex(bv, width)));
  return steps;
}
