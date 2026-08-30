import { describe, expect, it } from 'vitest';
import {
  dragDirection,
  dragDirectionPoles,
  nearestArrowKey,
  oppositeArrow,
} from './bubbleGeometry';

describe('nearestArrowKey', () => {
  it('picks the cardinal direction closest to the vector', () => {
    expect(nearestArrowKey({ x: 0, y: 0 }, { x: 10, y: 0 })).toBe('ArrowRight');
    expect(nearestArrowKey({ x: 0, y: 0 }, { x: -10, y: 0 })).toBe('ArrowLeft');
    expect(nearestArrowKey({ x: 0, y: 0 }, { x: 0, y: 10 })).toBe('ArrowDown');
    expect(nearestArrowKey({ x: 0, y: 0 }, { x: 0, y: -10 })).toBe('ArrowUp');
  });

  it('returns undefined for coincident points', () => {
    expect(nearestArrowKey({ x: 5, y: 5 }, { x: 5, y: 5 })).toBeUndefined();
  });

  it('derives direction from actual position, not a hardcoded side', () => {
    // A gate rotated so its output pin sits above the body: toward is 'down'.
    expect(nearestArrowKey({ x: 100, y: 0 }, { x: 100, y: 50 })).toBe('ArrowDown');
  });
});

describe('oppositeArrow', () => {
  it('is involutive', () => {
    for (const k of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'] as const) {
      expect(oppositeArrow(oppositeArrow(k))).toBe(k);
    }
  });
});

describe('dragDirection', () => {
  const pin = { x: 0, y: 0 };
  const gate = { x: 100, y: 0 };

  it('classifies a cursor moving toward the gate', () => {
    expect(dragDirection(pin, gate, { x: 50, y: 0 })).toBe('toward');
  });

  it('classifies a cursor moving away from the gate', () => {
    expect(dragDirection(pin, gate, { x: -50, y: 0 })).toBe('away');
  });

  it('is ambiguous perpendicular to the toward axis', () => {
    expect(dragDirection(pin, gate, { x: 0, y: 50 })).toBe('none');
  });

  it('is none when the cursor has not moved', () => {
    expect(dragDirection(pin, gate, pin)).toBe('none');
  });
});

describe('dragDirectionPoles', () => {
  const pin = { x: 0, y: 0 };

  it('matches dragDirection with opposed poles', () => {
    const toward = { x: -100, y: 0 };
    const away = { x: 100, y: 0 };
    expect(dragDirectionPoles(pin, toward, away, { x: -50, y: 0 })).toBe('toward');
    expect(dragDirectionPoles(pin, toward, away, { x: 50, y: 0 })).toBe('away');
    expect(dragDirectionPoles(pin, toward, away, { x: 0, y: 50 })).toBe('none');
  });

  it('reads away when a misresolved toward pole sits on the consumer side', () => {
    // The owner-reported marker bug: the upstream pole heuristic (wire far
    // end / driver center through elbows) lands to the RIGHT, same side as
    // the consumer. A rightward drag must still be the forward push.
    const toward = { x: 100, y: 40 };
    const away = { x: 60, y: 0 };
    expect(dragDirectionPoles(pin, toward, away, { x: 30, y: 0 })).toBe('away');
  });

  it('still reads toward when the cursor heads only for the toward pole', () => {
    const toward = { x: 100, y: 40 };
    const away = { x: 60, y: 0 };
    expect(dragDirectionPoles(pin, toward, away, { x: 30, y: 30 })).toBe('toward');
  });

  it('falls back to single-pole reads without an away pole', () => {
    const toward = { x: -100, y: 0 };
    expect(dragDirectionPoles(pin, toward, undefined, { x: -50, y: 0 })).toBe('toward');
    expect(dragDirectionPoles(pin, toward, pin, { x: 50, y: 0 })).toBe('away');
  });
});
