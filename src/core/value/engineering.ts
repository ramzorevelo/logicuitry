const PREFIXES: readonly [number, string][] = [
  [9, 'G'],
  [6, 'M'],
  [3, 'k'],
  [0, ''],
  [-3, 'm'],
  [-6, 'µ'],
  [-9, 'n'],
  [-12, 'p'],
];

/** Powers of ten, applied to the digits as text so `8.2k` is exactly 8200. */
const EXPONENT: Readonly<Record<string, number>> = {
  p: -12,
  n: -9,
  u: -6,
  µ: -6,
  μ: -6,
  m: -3,
  k: 3,
  K: 3,
  M: 6,
  G: 9,
};

/**
 * `4.7 kΩ`, `100 nF`, `0.721 Hz`: `digits` significant digits under an SI
 * prefix. `minExp` keeps small values on a coarser prefix (Hz below 1 reads
 * as 0.721, not 721 mHz).
 */
export function formatEngineering(value: number, unit: string, minExp = -12, digits = 3): string {
  if (value === 0 || !Number.isFinite(value)) return `${value} ${unit}`;
  const abs = Math.abs(value);
  // Round first, so 999.96 becomes 1 k rather than 1000.
  const rounded = Number(abs.toPrecision(digits));
  const [exp, prefix] =
    PREFIXES.find(([e]) => e >= minExp && rounded >= 10 ** e * (1 - 1e-12)) ??
    PREFIXES.find(([e]) => e === minExp) ??
    PREFIXES[PREFIXES.length - 1]!;
  const mantissa = Number((rounded / 10 ** exp).toPrecision(digits));
  return `${value < 0 ? '-' : ''}${mantissa} ${prefix}${unit}`;
}

/**
 * Reads `4.7k`, `4k7`, `1M`, `100n`, `10u`, `2.2 µF`, `470` into a number; a
 * trailing unit (Ω, ohm, F) is ignored. NaN for anything else.
 */
export function parseEngineering(text: string): number {
  const s = text
    .trim()
    .replace(/\s+/g, '')
    .replace(/(ohms?|Ω|F)$/i, '');
  const infix = /^(\d+)([pnuµμmkKMG])(\d+)$/.exec(s);
  if (infix) return Number(`${infix[1]}.${infix[3]}e${EXPONENT[infix[2]!]}`);
  const plain = /^\d*\.?\d+(?:e[+-]?\d+)?$/.exec(s);
  if (plain) return Number(s);
  const m = /^(\d*\.?\d+)([pnuµμmkKMG])$/.exec(s);
  return m ? Number(`${m[1]}e${EXPONENT[m[2]!]}`) : Number.NaN;
}
