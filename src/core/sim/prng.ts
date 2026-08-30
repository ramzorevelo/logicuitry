// The only sanctioned randomness in core: a seeded PRNG injected explicitly
// (metastability trials). Same seed -> identical sequence, always.

export type Prng = () => number;

/** mulberry32: tiny, fast, adequate statistical quality for teaching demos. */
export function mulberry32(seed: number): Prng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
