import { describe, expect, it } from 'vitest';
import * as bv from '../core/value/busValue';
import type { Track } from '../core/timing/traceView';
import {
  chevronRect,
  formatTimePs,
  laneOriginPath,
  layoutWaveform,
  tickStepPs,
  waveformOrderKey,
} from './waveform';

function track(path: string, width = 1): Track {
  return {
    path,
    label: path,
    kind: 'probe',
    net: 0,
    width,
    segments: [{ t0: 0, t1: 100, value: bv.known(0, width), mixed: false, label: '0' }],
    bands: [],
    times: [],
    values: [],
  };
}

describe('laneOriginPath (Task 5 chevron)', () => {
  it('resolves a derived lane path back to its bus track path', () => {
    expect(laneOriginPath('main/a#0')).toBe('main/a');
    expect(laneOriginPath('main/a#3')).toBe('main/a');
  });

  it('is null for a plain (non-lane) path', () => {
    expect(laneOriginPath('main/a')).toBeNull();
    expect(laneOriginPath('main/g1.y0')).toBeNull(); // multi-output separator is '.', not '#'
  });
});

describe('waveformOrderKey (chevron expand must not reset user reorder)', () => {
  const board = ['g1', 'a', 'b']; // board/compile order

  it('an untouched track sorts by board order, appended after every explicit one', () => {
    const key = (p: string) => waveformOrderKey(p, board, []);
    expect(key('g1')).toBeLessThan(key('a'));
    expect(key('a')).toBeLessThan(key('b'));
  });

  it('a real track keeps its explicit trackOrder position over board order', () => {
    const order = ['a', 'b', 'g1']; // user dragged a,b above g1
    const key = (p: string) => waveformOrderKey(p, board, order);
    expect(key('a')).toBeLessThan(key('b'));
    expect(key('b')).toBeLessThan(key('g1'));
  });

  it("expanding a reordered track's lanes inherits ITS position, not board order (the reported bug)", () => {
    const order = ['a', 'b', 'g1']; // user order: a, b, g1
    const key = (p: string) => waveformOrderKey(p, board, order);
    // Expand 'a': its lanes must stay between a's own slot and 'b', not
    // jump to where 'a' sits in board order (before g1).
    expect(key('a#0')).toBeGreaterThanOrEqual(key('a'));
    expect(key('a#0')).toBeLessThan(key('b'));
    expect(key('a#1')).toBeGreaterThan(key('a#0'));
    expect(key('a#1')).toBeLessThan(key('b'));
    expect(key('g1')).toBeGreaterThan(key('a#1'));
  });

  it('lane bit order is preserved (bit 0 first) within one expanded group', () => {
    const key = (p: string) => waveformOrderKey(p, board, []);
    expect(key('a#0')).toBeLessThan(key('a#1'));
    expect(key('a#1')).toBeLessThan(key('a#2'));
  });

  it("an individually-dragged lane row's own trackOrder entry wins over inheriting its parent's slot", () => {
    const order = ['a#1', 'a', 'a#0']; // user dragged a#1 above the group
    const key = (p: string) => waveformOrderKey(p, board, order);
    expect(key('a#1')).toBeLessThan(key('a'));
    expect(key('a')).toBeLessThan(key('a#0'));
  });

  it('the folder (origin) row always sorts strictly before every one of its own lane children', () => {
    const key = (p: string) => waveformOrderKey(p, board, []);
    expect(key('a')).toBeLessThan(key('a#0'));
    const order = ['a', 'b', 'g1'];
    const key2 = (p: string) => waveformOrderKey(p, board, order);
    expect(key2('a')).toBeLessThan(key2('a#0'));
  });
});

describe('chevronRect', () => {
  it('sits inside the row rect, vertically centered', () => {
    const r = chevronRect({ x: 120, y: 40, w: 500, h: 30 });
    expect(r.y + r.h / 2).toBeCloseTo(40 + 15);
    expect(r.x).toBeGreaterThanOrEqual(0);
  });
});

describe('formatTimePs', () => {
  it('picks ps/ns/us with trimmed decimals', () => {
    expect(formatTimePs(0)).toBe('0 ps');
    expect(formatTimePs(999)).toBe('999 ps');
    expect(formatTimePs(1_000)).toBe('1 ns');
    expect(formatTimePs(1_200)).toBe('1.2 ns');
    expect(formatTimePs(25_000)).toBe('25 ns');
    expect(formatTimePs(1_500_000)).toBe('1.5 us');
  });
});

describe('tickStepPs', () => {
  it('chooses 1/2/5 steps bounded by maxTicks', () => {
    expect(tickStepPs(100_000, 10)).toBe(10_000);
    expect(tickStepPs(100_000, 7)).toBe(20_000);
    expect(tickStepPs(100_000, 3)).toBe(50_000);
    expect(tickStepPs(0, 10)).toBe(1);
  });
});

describe('layoutWaveform', () => {
  it('places rows and projects time <-> x round-trip', () => {
    const layout = layoutWaveform([track('a'), track('b')], { t0: 0, t1: 1000 }, 620, {
      rowH: 30,
      rowGap: 10,
      labelW: 120,
      axisH: 20,
      levelPad: 6,
      topPad: 12,
      tickSpacing: 90,
    });
    expect(layout.rows[0]!.rect).toEqual({ x: 120, y: 12, w: 500, h: 30 });
    expect(layout.rows[1]!.rect.y).toBe(52);
    expect(layout.plot.y).toBe(12);
    expect(layout.height).toBe(12 + 30 + 10 + 30 + 20);
    expect(layout.timeToX(0)).toBe(120);
    expect(layout.timeToX(1000)).toBe(620);
    expect(layout.xToTime(layout.timeToX(437))).toBeCloseTo(437, 6);
    expect(layout.rows[0]!.high).toBe(18);
    expect(layout.rows[0]!.low).toBe(36);
  });

  it('emits ticks inside the window with formatted labels', () => {
    const layout = layoutWaveform([track('a')], { t0: 0, t1: 100_000 }, 1020);
    expect(layout.ticks.length).toBeGreaterThan(2);
    expect(layout.ticks[0]!.t).toBe(0);
    for (const tick of layout.ticks) {
      expect(tick.t).toBeGreaterThanOrEqual(0);
      expect(tick.t).toBeLessThanOrEqual(100_000);
      expect(tick.label).toMatch(/ps|ns|us/);
    }
  });
});
