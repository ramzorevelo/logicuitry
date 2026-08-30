import { describe, expect, it } from 'vitest';
import {
  LONG_PRESS_MS,
  TAP_SLOP,
  initialGestureState,
  reduceGesture,
  type GestureState,
  type Intent,
} from './touchGestures';

const down = (s: GestureState, id: number, x: number, y: number, t = 0) =>
  reduceGesture(s, { kind: 'down', point: { id, x, y }, t });
const move = (s: GestureState, id: number, x: number, y: number, t = 0) =>
  reduceGesture(s, { kind: 'move', point: { id, x, y }, t });
const up = (s: GestureState, id: number, t = 0) => reduceGesture(s, { kind: 'up', id, t });
const tick = (s: GestureState, t: number) => reduceGesture(s, { kind: 'tick', t });

describe('reduceGesture', () => {
  it('a still finger lifted quickly is a tap', () => {
    const s = initialGestureState();
    down(s, 1, 100, 100, 0);
    move(s, 1, 102, 101, 50);
    expect(up(s, 1, 120)).toEqual({ kind: 'tap', x: 102, y: 101 });
  });

  it('a finger past the slop pans, and then is not a tap', () => {
    const s = initialGestureState();
    down(s, 1, 100, 100, 0);
    expect(move(s, 1, 100 + TAP_SLOP, 100, 10).kind).toBe('none');
    const panned = move(s, 1, 140, 100, 20);
    expect(panned).toEqual({ kind: 'pan', dx: 140 - (100 + TAP_SLOP), dy: 0 });
    expect(up(s, 1, 30).kind).toBe('none');
  });

  it('holding still reports a long press exactly once', () => {
    const s = initialGestureState();
    down(s, 1, 10, 20, 0);
    expect(tick(s, LONG_PRESS_MS - 1).kind).toBe('none');
    expect(tick(s, LONG_PRESS_MS)).toEqual({ kind: 'longPress', x: 10, y: 20 });
    expect(tick(s, LONG_PRESS_MS + 500).kind).toBe('none');
    // Already consumed as a long press, so the lift is not also a tap.
    expect(up(s, 1, LONG_PRESS_MS + 600).kind).toBe('none');
  });

  it('moving cancels a pending long press', () => {
    const s = initialGestureState();
    down(s, 1, 10, 20, 0);
    move(s, 1, 60, 20, 10);
    expect(tick(s, LONG_PRESS_MS + 100).kind).toBe('none');
  });

  it('two fingers report their separation and midpoint', () => {
    const s = initialGestureState();
    down(s, 1, 0, 0, 0);
    down(s, 2, 100, 0, 0);
    const i = move(s, 2, 200, 0, 10) as Extract<Intent, { kind: 'pinch' }>;
    expect(i.kind).toBe('pinch');
    expect(i.dist).toBeCloseTo(200);
    expect(i.cx).toBe(100);
  });

  it('a two-finger drag moves the midpoint as well as the separation', () => {
    const s = initialGestureState();
    down(s, 1, 0, 0, 0);
    down(s, 2, 100, 0, 0);
    const i = move(s, 1, 50, 0, 10) as Extract<Intent, { kind: 'pinch' }>;
    expect(i.dist).toBeCloseTo(50);
    expect(i.cx).toBeCloseTo(75);
  });

  // The bug the old inline code had to handle explicitly: lifting one finger
  // must not let the survivor be read as a drag from where the pinch began.
  it('lifting one finger ends the pinch without panning', () => {
    const s = initialGestureState();
    down(s, 1, 0, 0, 0);
    down(s, 2, 100, 0, 0);
    move(s, 2, 200, 0, 10);
    expect(up(s, 2, 20).kind).toBe('none');
    // The survivor resumes panning, and because a pan is reported as the
    // delta since the LAST move rather than since the press, the board does
    // not jump by however far the pinch travelled.
    expect(move(s, 1, 30, 0, 30)).toEqual({ kind: 'pan', dx: 30, dy: 0 });
  });

  it('lifting one of two fingers is never a tap', () => {
    const s = initialGestureState();
    down(s, 1, 0, 0, 0);
    down(s, 2, 100, 0, 0);
    expect(up(s, 2, 10).kind).toBe('none');
  });

  it('a cancel drops everything, so a lost pointer cannot strand a pinch', () => {
    const s = initialGestureState();
    down(s, 1, 0, 0, 0);
    down(s, 2, 100, 0, 0);
    reduceGesture(s, { kind: 'cancel' });
    expect(s.points).toHaveLength(0);
    expect(s.pinch).toBeNull();
  });

  it('ignores events for a pointer it never saw', () => {
    const s = initialGestureState();
    expect(move(s, 99, 5, 5, 0).kind).toBe('none');
    expect(up(s, 99, 0).kind).toBe('none');
  });

  it('a slow press that never moves is not a tap on lift', () => {
    const s = initialGestureState();
    down(s, 1, 10, 10, 0);
    expect(up(s, 1, LONG_PRESS_MS + 1).kind).toBe('none');
  });
});
