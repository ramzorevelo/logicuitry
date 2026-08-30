// Direction helpers shared by mouse-drag and keyboard-arrow bubble pushing:
// both paths
// resolve to the same toward-the-gate / away-along-the-wire classification,
// derived from a terminal's actual screen position, never hardcoded left/right.

import type { Vec2 } from '../../../render/scene';

export type ArrowKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';

const ARROW_VECTORS: Record<ArrowKey, Vec2> = {
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
};

const OPPOSITE: Record<ArrowKey, ArrowKey> = {
  ArrowUp: 'ArrowDown',
  ArrowDown: 'ArrowUp',
  ArrowLeft: 'ArrowRight',
  ArrowRight: 'ArrowLeft',
};

export function oppositeArrow(key: ArrowKey): ArrowKey {
  return OPPOSITE[key];
}

function normalize(v: Vec2): Vec2 {
  const len = Math.hypot(v.x, v.y);
  return len === 0 ? { x: 0, y: 0 } : { x: v.x / len, y: v.y / len };
}

/** The arrow key whose cardinal direction best matches the vector from
 *  `from` to `to`; undefined when the two points coincide (no direction). */
export function nearestArrowKey(from: Vec2, to: Vec2): ArrowKey | undefined {
  const dir = normalize({ x: to.x - from.x, y: to.y - from.y });
  if (dir.x === 0 && dir.y === 0) return undefined;
  let best: ArrowKey | undefined;
  let bestDot = -Infinity;
  for (const key of Object.keys(ARROW_VECTORS) as ArrowKey[]) {
    const v = ARROW_VECTORS[key];
    const dot = dir.x * v.x + dir.y * v.y;
    if (dot > bestDot) {
      bestDot = dot;
      best = key;
    }
  }
  return best;
}

/** Mouse-drag classification relative to a terminal->gate-center vector:
 *  'toward' when the cursor moved mostly toward the gate body (push through
 *  it), 'away' when mostly the opposite (fan-out relocation along the wire),
 *  'none' below a 0.5-cosine threshold (ambiguous drag, no preview yet). */
export function dragDirection(
  pinPos: Vec2,
  gateCenter: Vec2,
  cursor: Vec2,
): 'toward' | 'away' | 'none' {
  const toward = normalize({ x: gateCenter.x - pinPos.x, y: gateCenter.y - pinPos.y });
  const moved = normalize({ x: cursor.x - pinPos.x, y: cursor.y - pinPos.y });
  if ((toward.x === 0 && toward.y === 0) || (moved.x === 0 && moved.y === 0)) return 'none';
  const dot = toward.x * moved.x + toward.y * moved.y;
  if (dot > 0.5) return 'toward';
  if (dot < -0.5) return 'away';
  return 'none';
}

/** Two-pole variant for drags whose 'toward' pole is a remote, heuristic
 *  point (a bare marker's upstream driver resolved through elbowed wires or
 *  junctions can land on the WRONG side of the marker). The downstream pole
 *  is the drag target's own output wire, always well-defined, so when the
 *  cursor heads toward both poles the away read wins: a wrong 'away' merely
 *  previews the forward push, a wrong 'toward' is an instant cancel. */
export function dragDirectionPoles(
  pinPos: Vec2,
  towardPole: Vec2,
  awayPole: Vec2 | undefined,
  cursor: Vec2,
): 'toward' | 'away' | 'none' {
  if (!awayPole) return dragDirection(pinPos, towardPole, cursor);
  const away = normalize({ x: awayPole.x - pinPos.x, y: awayPole.y - pinPos.y });
  if (away.x === 0 && away.y === 0) return dragDirection(pinPos, towardPole, cursor);
  const moved = normalize({ x: cursor.x - pinPos.x, y: cursor.y - pinPos.y });
  if (moved.x === 0 && moved.y === 0) return 'none';
  const toward = normalize({ x: towardPole.x - pinPos.x, y: towardPole.y - pinPos.y });
  const dotA = away.x * moved.x + away.y * moved.y;
  const dotT = toward.x * moved.x + toward.y * moved.y;
  if (dotA > 0.5 && dotA >= dotT) return 'away';
  if (dotT > 0.5) return 'toward';
  return 'none';
}
