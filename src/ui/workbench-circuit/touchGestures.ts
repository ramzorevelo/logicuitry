// Touch gesture recognition for the circuit canvas, as a pure reducer.
//
// The one rule the whole grammar rests on (touch-editing spec): a bare finger
// drag is ALWAYS a pan. Editing starts from a handle -- something already
// selected, or an armed tool -- never from a naked drag, because a finger has
// no hover to disambiguate with and no modifier keys to qualify itself.
//
// Kept out of CircuitWorkbench.tsx deliberately: that file is already 4400
// lines, and a state machine buried in event handlers is one nothing can test.

/** Movement below this is a tap, not a drag: a finger never holds still. */
export const TAP_SLOP = 6;

/** Held longer than this is a long press: the touch stand-in for Shift, i.e.
 *  "the precise variant of this action". Android's own accessibility default,
 *  and the midpoint of the 300-500ms range real editors use. */
export const LONG_PRESS_MS = 500;

export interface TouchPoint {
  id: number;
  x: number;
  y: number;
}

export type GestureEvent =
  | { kind: 'down'; point: TouchPoint; t: number }
  | { kind: 'move'; point: TouchPoint; t: number }
  | { kind: 'up'; id: number; t: number }
  | { kind: 'cancel' }
  /** Driven by a timer, so a press that never moves still reports itself. */
  | { kind: 'tick'; t: number };

export type Intent =
  | { kind: 'none' }
  | { kind: 'pan'; dx: number; dy: number }
  /** Absolute geometry, not a delta: the caller anchors zoom against the
   *  viewport as it was when the gesture began, which is what stops a long
   *  pinch drifting. Deltas would force it to integrate instead. */
  | { kind: 'pinch'; dist: number; cx: number; cy: number }
  | { kind: 'tap'; x: number; y: number }
  | { kind: 'longPress'; x: number; y: number };

interface Active {
  id: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  t: number;
  moved: boolean;
  longFired: boolean;
}

export interface GestureState {
  /** Insertion-ordered, so "the first two fingers" is well defined. */
  points: Active[];
  pinch: { dist: number; cx: number; cy: number } | null;
}

export function initialGestureState(): GestureState {
  return { points: [], pinch: null };
}

const dist = (a: Active, b: Active) => Math.hypot(a.x - b.x, a.y - b.y);
const moveDist = (p: Active) => Math.hypot(p.x - p.startX, p.y - p.startY);

/**
 * Folds one event into the state and reports what it means.
 *
 * Mutates `state` in place: this sits directly under pointermove, which fires
 * at screen rate, and allocating a fresh state object per event is waste the
 * canvas cannot afford.
 */
export function reduceGesture(state: GestureState, e: GestureEvent): Intent {
  switch (e.kind) {
    case 'cancel':
      state.points = [];
      state.pinch = null;
      return { kind: 'none' };

    case 'down': {
      state.points.push({
        id: e.point.id,
        startX: e.point.x,
        startY: e.point.y,
        x: e.point.x,
        y: e.point.y,
        t: e.t,
        moved: false,
        longFired: false,
      });
      // Two fingers are never an editing gesture, so a pinch outranks whatever
      // the first finger was doing.
      if (state.points.length === 2) state.pinch = measurePinch(state);
      return { kind: 'none' };
    }

    case 'move': {
      const p = state.points.find((q) => q.id === e.point.id);
      if (!p) return { kind: 'none' };
      const prevX = p.x;
      const prevY = p.y;
      p.x = e.point.x;
      p.y = e.point.y;
      if (moveDist(p) > TAP_SLOP) p.moved = true;

      if (state.points.length >= 2 && state.pinch) {
        const now = measurePinch(state);
        state.pinch = now;
        return { kind: 'pinch', dist: now.dist, cx: now.cx, cy: now.cy };
      }
      // One finger past the slop: a pan, reported as a delta so the caller
      // never has to remember where the drag began.
      if (state.points.length === 1 && p.moved)
        return { kind: 'pan', dx: p.x - prevX, dy: p.y - prevY };
      return { kind: 'none' };
    }

    case 'up': {
      const i = state.points.findIndex((q) => q.id === e.id);
      if (i < 0) return { kind: 'none' };
      const [p] = state.points.splice(i, 1);
      // A lifted finger ends the pinch rather than letting the remaining one
      // be reinterpreted as a drag from where the pinch started.
      if (state.points.length < 2) state.pinch = null;
      if (!p) return { kind: 'none' };
      // A tap only counts if this was the only finger down: lifting one of two
      // is the end of a pinch, not a tap.
      if (!p.moved && !p.longFired && state.points.length === 0 && e.t - p.t < LONG_PRESS_MS)
        return { kind: 'tap', x: p.x, y: p.y };
      return { kind: 'none' };
    }

    case 'tick': {
      if (state.points.length !== 1) return { kind: 'none' };
      const p = state.points[0]!;
      if (p.moved || p.longFired || e.t - p.t < LONG_PRESS_MS) return { kind: 'none' };
      p.longFired = true;
      return { kind: 'longPress', x: p.x, y: p.y };
    }
  }
}

function measurePinch(state: GestureState): { dist: number; cx: number; cy: number } {
  const a = state.points[0]!;
  const b = state.points[1]!;
  return { dist: dist(a, b), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
}
