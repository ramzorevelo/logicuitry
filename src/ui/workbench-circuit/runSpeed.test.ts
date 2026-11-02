import { describe, expect, it } from 'vitest';
import { DEFAULT_RUN_SPEED } from '../../core/model/types';
import { frameAdvance, MAX_FRAME_MS, RUN_SPEED_PRESETS, runSpeedLabel } from './runSpeed';

describe('run speed presets', () => {
  it('labels each preset as sim time per second, the last as real time', () => {
    expect(RUN_SPEED_PRESETS.map((p) => p.label)).toEqual([
      '25 ns/s',
      '1 µs/s',
      '100 µs/s',
      '10 ms/s',
      'Real time',
    ]);
    expect(RUN_SPEED_PRESETS[0]!.ps).toBe(DEFAULT_RUN_SPEED);
  });

  it('labels a speed from a file that is not a preset', () => {
    expect(runSpeedLabel(2_000_000)).toBe('2 µs/s');
  });
});

describe('frameAdvance', () => {
  it('paces by wall time, so a faster screen does not run faster', () => {
    let at60 = 0;
    let carry = 0;
    for (let i = 0; i < 60; i++) ({ ps: at60, carry } = add(at60, 1000 / 60, carry));
    let at120 = 0;
    carry = 0;
    for (let i = 0; i < 120; i++) ({ ps: at120, carry } = add(at120, 1000 / 120, carry));
    expect(at60).toBe(DEFAULT_RUN_SPEED);
    expect(at120).toBe(DEFAULT_RUN_SPEED);

    function add(total: number, dt: number, c: number) {
      const step = frameAdvance(DEFAULT_RUN_SPEED, dt, c);
      return { ps: total + step.ps, carry: step.carry };
    }
  });

  it('caps a long gap, so a tab coming back does not jump', () => {
    expect(frameAdvance(1_000_000, 60_000, 0).ps).toBe((1_000_000 * MAX_FRAME_MS) / 1000);
  });

  it('always advances whole picoseconds', () => {
    const { ps, carry } = frameAdvance(25_000, 16.7, 0);
    expect(Number.isInteger(ps)).toBe(true);
    expect(carry).toBeGreaterThanOrEqual(0);
    expect(carry).toBeLessThan(1);
  });
});
