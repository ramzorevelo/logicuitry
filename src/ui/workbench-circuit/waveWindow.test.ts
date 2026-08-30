import { describe, expect, it } from 'vitest';
import { effectiveWindow } from './waveWindow';

const full = { t0: 0, t1: 1000 };

describe('effectiveWindow', () => {
  it('autofit yields null, so the view takes its own full span', () => {
    expect(effectiveWindow({ t0: 10, t1: 20 }, full, true, true)).toBeNull();
    expect(effectiveWindow({ t0: 10, t1: 20 }, full, true, false)).toBeNull();
  });

  it('autoscroll pins the right edge to the trace end and keeps the span', () => {
    const w = effectiveWindow({ t0: 100, t1: 300 }, full, false, true)!;
    expect(w).toEqual({ t0: 800, t1: 1000 });
    expect(w.t1 - w.t0).toBe(200);
  });

  it('the span never changes as the trace grows', () => {
    const frozen = { t0: 0, t1: 250 };
    const a = effectiveWindow(frozen, { t0: 0, t1: 400 }, false, true)!;
    const b = effectiveWindow(frozen, { t0: 0, t1: 9000 }, false, true)!;
    expect(a.t1 - a.t0).toBe(250);
    expect(b.t1 - b.t0).toBe(250);
    expect(b.t1).toBe(9000);
  });

  it('without autoscroll the window stays exactly where the user left it', () => {
    const frozen = { t0: 120, t1: 340 };
    expect(effectiveWindow(frozen, { t0: 0, t1: 400 }, false, false)).toBe(frozen);
    expect(effectiveWindow(frozen, { t0: 0, t1: 99999 }, false, false)).toBe(frozen);
  });

  it('never scrolls back past the oldest surviving record', () => {
    // Ring buffer wrapped: nothing exists before t=5000, and a window wider
    // than what survives must not claim the empty space to its left.
    const wrapped = { t0: 5000, t1: 5200 };
    expect(effectiveWindow({ t0: 0, t1: 4000 }, wrapped, false, true)).toEqual({
      t0: 5000,
      t1: 5200,
    });
  });

  it('a degenerate frozen span still yields a drawable window', () => {
    const w = effectiveWindow({ t0: 7, t1: 7 }, full, false, true)!;
    expect(w.t1 - w.t0).toBe(1);
  });
});
