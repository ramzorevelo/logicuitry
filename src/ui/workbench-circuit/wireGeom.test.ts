import { describe, expect, it } from 'vitest';
import type { Vec2 } from '../../render/scene';
import type { Wire, WireEnd } from '../../core/model/types';
import {
  alignDeltas,
  computeWireRoutes,
  distributeDeltas,
  dragCorner,
  elbowCorner,
  groupRotate,
  groupRotateComponent,
  halfSnap,
  normalizeBends,
  orthogonalPolyline,
  packDeltas,
  pointAlongPolyline,
  polylineCrossesAny,
  polylineIntersectsRect,
  projectOntoSegment,
  rotateAboutPivot,
  rotatePointAround,
  rotatePointSnapped,
  routeAvoiding,
  routeOrthogonal,
  routeOverlapsWires,
  routeTwoElbow,
  segmentIntersectsRect,
  tAlongPolyline,
  segmentsIntersect,
  stretchWirePoints,
  wireDisplayPoints,
  wirePolyline,
  wiresCrossedBy,
} from './wireGeom';

const p = (x: number, y: number): Vec2 => ({ x, y });

describe('elbowCorner / routeOrthogonal', () => {
  it('picks the leading axis by flip', () => {
    expect(elbowCorner(p(0, 0), p(10, 20), false)).toEqual(p(10, 0));
    expect(elbowCorner(p(0, 0), p(10, 20), true)).toEqual(p(0, 20));
  });

  it('routes a single elbow through the corner', () => {
    expect(routeOrthogonal(p(0, 0), p(10, 20))).toEqual([p(0, 0), p(10, 0), p(10, 20)]);
    expect(routeOrthogonal(p(0, 0), p(10, 20), true)).toEqual([p(0, 0), p(0, 20), p(10, 20)]);
  });

  it('collapses to one segment when already axis-aligned', () => {
    expect(routeOrthogonal(p(0, 5), p(10, 5))).toEqual([p(0, 5), p(10, 5)]);
    expect(routeOrthogonal(p(3, 0), p(3, 9), true)).toEqual([p(3, 0), p(3, 9)]);
  });
});

describe('routeTwoElbow', () => {
  it('splits at the rounded x midpoint', () => {
    expect(routeTwoElbow(p(0, 0), p(11, 20))).toEqual([p(0, 0), p(6, 0), p(6, 20), p(11, 20)]);
  });

  it('degenerates to a straight segment when aligned', () => {
    expect(routeTwoElbow(p(0, 4), p(8, 4))).toEqual([p(0, 4), p(8, 4)]);
  });
});

describe('segmentsIntersect', () => {
  it('detects a proper crossing', () => {
    expect(segmentsIntersect(p(0, 0), p(10, 10), p(0, 10), p(10, 0))).toBe(true);
  });

  it('rejects disjoint segments', () => {
    expect(segmentsIntersect(p(0, 0), p(1, 1), p(5, 5), p(6, 6))).toBe(false);
  });

  it('treats a shared endpoint as no crossing', () => {
    expect(segmentsIntersect(p(0, 0), p(5, 5), p(5, 5), p(10, 0))).toBe(false);
  });

  it('treats collinear overlap as no crossing', () => {
    expect(segmentsIntersect(p(0, 0), p(10, 0), p(5, 0), p(15, 0))).toBe(false);
  });

  it('counts a T-touch (endpoint on the other interior) as a crossing', () => {
    expect(segmentsIntersect(p(0, 0), p(10, 0), p(5, 0), p(5, 8))).toBe(true);
  });
});

describe('projectOntoSegment', () => {
  it('projects onto the interior', () => {
    expect(projectOntoSegment(p(5, 3), p(0, 0), p(10, 0))).toEqual(p(5, 0));
  });

  it('clamps to the nearer endpoint', () => {
    expect(projectOntoSegment(p(-4, 2), p(0, 0), p(10, 0))).toEqual(p(0, 0));
    expect(projectOntoSegment(p(14, 2), p(0, 0), p(10, 0))).toEqual(p(10, 0));
  });

  it('handles a degenerate zero-length segment', () => {
    expect(projectOntoSegment(p(7, 7), p(3, 3), p(3, 3))).toEqual(p(3, 3));
  });
});

describe('wirePolyline / wiresCrossedBy', () => {
  const end = (component: string): WireEnd => ({ kind: 'pin', component, pin: 'y' });
  const pins: Record<string, Vec2> = {
    a: p(0, 0),
    b: p(20, 0),
    c: p(0, 10),
    d: p(20, 10),
  };
  const resolve = (e: WireEnd): Vec2 => {
    if (e.kind !== 'pin') throw new Error('unexpected end kind');
    return pins[e.component]!;
  };
  const w1: Wire = { id: 'w1', a: end('a'), b: end('b'), points: [p(10, 0), p(10, -8)] };
  const w2: Wire = { id: 'w2', a: end('c'), b: end('d'), points: [] };

  it('resolves ends around the bend points', () => {
    expect(wirePolyline(w1, resolve)).toEqual([p(0, 0), p(10, 0), p(10, -8), p(20, 0)]);
  });

  it('returns only wires the slash properly crosses', () => {
    expect(wiresCrossedBy([p(5, -5), p(5, 5)], [w1, w2], resolve)).toEqual(new Set(['w1']));
    expect(wiresCrossedBy([p(5, 5), p(5, 15)], [w1, w2], resolve)).toEqual(new Set(['w2']));
    expect(wiresCrossedBy([p(5, -5), p(5, 15)], [w1, w2], resolve)).toEqual(new Set(['w1', 'w2']));
    expect(wiresCrossedBy([p(30, -5), p(30, 15)], [w1, w2], resolve)).toEqual(new Set());
  });
});

describe('routeAvoiding', () => {
  it('routes straight through when no obstacle is in the way', () => {
    expect(routeAvoiding(p(0, 0), p(10, 10), [])).toEqual(routeOrthogonal(p(0, 0), p(10, 10)));
  });

  it('flips the elbow when the naive route crosses a body', () => {
    // Naive (flip=false) elbow goes (0,0)->(10,0)->(10,10); an obstacle
    // sitting on that first leg forces the flipped elbow instead.
    const obstacle = { x: 4, y: -2, w: 4, h: 4 };
    const naive = routeOrthogonal(p(0, 0), p(10, 10));
    const result = routeAvoiding(p(0, 0), p(10, 10), [obstacle]);
    expect(result).not.toEqual(naive);
    expect(result).toEqual(routeOrthogonal(p(0, 0), p(10, 10), true));
  });

  it('falls back to a two-elbow detour when both single-elbow options cross', () => {
    // One obstacle on each single-elbow route's vertical leg (x=10 and x=0);
    // neither touches the two-elbow route's legs (all at x=5, or y=0/y=10
    // outside each obstacle's y-band), so the Z-route is clear.
    const obstacles = [
      { x: 8, y: 4, w: 4, h: 4 }, // blocks flip=false's x=10 leg
      { x: -2, y: 4, w: 4, h: 4 }, // blocks flip=true's x=0 leg
    ];
    const result = routeAvoiding(p(0, 0), p(10, 10), obstacles);
    expect(result).toEqual(routeTwoElbow(p(0, 0), p(10, 10)));
  });

  it('routeOverlapsWires: a collinear span of positive length counts, a perpendicular crossing does not', () => {
    // Same-y overlapping horizontal segments.
    expect(routeOverlapsWires([p(0, 0), p(10, 0)], [[p(5, 0), p(15, 0)]])).toBe(true);
    // Touching at a single endpoint only -- zero-length span, not an overlap.
    expect(routeOverlapsWires([p(0, 0), p(10, 0)], [[p(10, 0), p(20, 0)]])).toBe(false);
    // A perpendicular crossing (a vertical wire through a horizontal one) is
    // a normal, unavoidable crossing -- must never read as an overlap.
    expect(routeOverlapsWires([p(0, 0), p(10, 0)], [[p(5, -5), p(5, 5)]])).toBe(false);
  });

  it('picks the flipped elbow to dodge a wire lying exactly on the naive straight route', () => {
    const existing = [p(0, 0), p(10, 0), p(10, 10)]; // == straight route a->b
    const result = routeAvoiding(p(0, 0), p(10, 10), [], [existing]);
    expect(result).toEqual(routeOrthogonal(p(0, 0), p(10, 10), true));
  });

  it('falls through to a mid-coordinate-shifted two-elbow when the plain detour also overlaps a wire', () => {
    // Same body obstacles as the two-elbow-fallback test above (block both
    // single-elbow options), plus an existing wire running straight down the
    // plain two-elbow's own midline (x=5) -- forces a shifted Z detour.
    const bodyObstacles = [
      { x: 8, y: 4, w: 4, h: 4 },
      { x: -2, y: 4, w: 4, h: 4 },
    ];
    const wireObstacles = [[p(5, -100), p(5, 100)]];
    const result = routeAvoiding(p(0, 0), p(10, 10), bodyObstacles, wireObstacles, 16);
    expect(result).not.toEqual(routeTwoElbow(p(0, 0), p(10, 10)));
    expect(result).toEqual([p(0, 0), p(21, 0), p(21, 10), p(10, 10)]);
    expect(routeOverlapsWires(result, wireObstacles)).toBe(false);
  });
});

describe('computeWireRoutes', () => {
  const free = (x: number, y: number): WireEnd => ({ kind: 'free', pos: p(x, y) });
  const resolve = (end: WireEnd): Vec2 | undefined => (end.kind === 'free' ? end.pos : undefined);

  it('routes a second wire around an identical-endpoint wire that came before it', () => {
    const w1: Wire = { id: 'w1', a: free(0, 0), b: free(10, 10), points: [] };
    const w2: Wire = { id: 'w2', a: free(0, 0), b: free(10, 10), points: [] };
    const routes = computeWireRoutes([w1, w2], resolve, new Map(), 16);
    expect(routes.get('w1')).toEqual(routeOrthogonal(p(0, 0), p(10, 10)));
    expect(routes.get('w2')).toEqual(routeOrthogonal(p(0, 0), p(10, 10), true));
    expect(routes.get('w2')).not.toEqual(routes.get('w1'));
  });

  it('a stored-points wire is an obstacle for later wires and keeps its own bends when nothing blocks them', () => {
    const w1: Wire = { id: 'w1', a: free(0, 0), b: free(10, 0), points: [p(5, 0), p(5, -8)] };
    const w2: Wire = { id: 'w2', a: free(0, 10), b: free(10, 10), points: [] };
    const routes = computeWireRoutes([w1, w2], resolve, new Map(), 16);
    expect(routes.get('w1')).toEqual(orthogonalPolyline(p(0, 0), [p(5, 0), p(5, -8)], p(10, 0)));
    // w2 is a plain horizontal segment far from w1's bend -- unaffected.
    expect(routes.get('w2')).toEqual([p(0, 10), p(10, 10)]);
  });

  // Task 6 follow-up (live-QA repro): a wire with a stored bend (left over
  // from an earlier drag, e.g. a short stub off a pin) permanently lost
  // obstacle avoidance -- moving a component far enough that the wire
  // should now detour around another body just drew straight through it,
  // since orthogonalPolyline re-elbows the STORED points with no obstacle
  // awareness at all. computeWireRoutes now falls back to a fresh
  // routeAvoiding detour whenever the stored-bend route would cross a body.
  it('falls back to routeAvoiding when the stored-bend route would now cut through a body', () => {
    // Naive elbow off the stub goes ...->(10,0)->(10,10); an obstacle on
    // that vertical leg forces the flipped elbow, same as routeAvoiding's
    // own "flips the elbow" case above -- the point here is that a STORED
    // bend must ALSO get this treatment, not just a from-scratch route.
    const obstacle = { x: 8, y: 4, w: 4, h: 4 };
    const boundsById = new Map([['obs', obstacle]]);
    const w1: Wire = { id: 'w1', a: free(0, 0), b: free(10, 10), points: [p(4, 0)] };
    const routes = computeWireRoutes([w1], resolve, boundsById, 16);
    const naive = orthogonalPolyline(p(0, 0), [p(4, 0)], p(10, 10));
    const chosen = routes.get('w1')!;
    expect(chosen).not.toEqual(naive);
    expect(polylineCrossesAny(chosen, [obstacle])).toBe(false);
  });

  it('keeps the stored-bend route when it happens to clear a nearby body', () => {
    const obstacle = { x: 100, y: 100, w: 16, h: 16 }; // nowhere near the wire
    const boundsById = new Map([['obs', obstacle]]);
    const w1: Wire = { id: 'w1', a: free(0, 0), b: free(10, 0), points: [p(5, 0), p(5, -8)] };
    const routes = computeWireRoutes([w1], resolve, boundsById, 16);
    expect(routes.get('w1')).toEqual(orthogonalPolyline(p(0, 0), [p(5, 0), p(5, -8)], p(10, 0)));
  });

  // A wire's own endpoint components are no longer excluded from the
  // obstacle list (the M4.5 `ownIds` exclusion, superseded here) -- a
  // dragged-past-its-own-pin body must now be routed around like any other
  // obstacle. Pin positions sit exactly on their component's bounds edge
  // (verified empirically against symbolBounds for gates/toggle/led/mux
  // before this fix), so the strict-inequality crossing test in
  // segmentCrossesRect already treats a normally-attached wire as tangent,
  // not crossing -- no deflation or endpoint exemption needed.
  describe('own-body obstacle (Task 5)', () => {
    const pinComp = (component: string, pin: string): WireEnd => ({ kind: 'pin', component, pin });
    const free = (x: number, y: number): WireEnd => ({ kind: 'free', pos: p(x, y) });

    it('driver dragged right past its own output pin reroutes around its body', () => {
      const resolve = (e: WireEnd): Vec2 | undefined =>
        e.kind === 'pin' ? p(164, 16) : e.kind === 'free' ? e.pos : undefined;
      const bounds = new Map([['d1', { x: 100, y: 0, w: 64, h: 32 }]]);
      const w: Wire = { id: 'w1', a: pinComp('d1', 'y'), b: free(80, 48), points: [] };
      const routes = computeWireRoutes([w], resolve, bounds, 16);
      // Naive flip=false's first leg sweeps y=16 (inside the body's height)
      // from x=164 back through the body to x=80 -- would cross; the vertical-
      // first flip=true leaves the pin tangent to the body's right edge and
      // clears it entirely.
      expect(routes.get('w1')).toEqual(routeOrthogonal(p(164, 16), p(80, 48), true));
    });

    it('receiver dragged left past its own input pin reroutes around its body', () => {
      const resolve = (e: WireEnd): Vec2 | undefined =>
        e.kind === 'pin' ? p(50, 16) : e.kind === 'free' ? e.pos : undefined;
      const bounds = new Map([['r1', { x: 50, y: 0, w: 64, h: 32 }]]);
      const w: Wire = { id: 'w1', a: free(120, 8), b: pinComp('r1', 'a'), points: [] };
      const routes = computeWireRoutes([w], resolve, bounds, 16);
      // Both single-elbow options cross here (driver's y and the pin's y are
      // both inside the body's height range), and the plain x-shifted
      // two-elbow variants re-enter the body on their return leg -- only a
      // y-shifted variant (this fix's addition) clears, at y=-4.
      expect(routes.get('w1')).toEqual([p(120, 8), p(120, -4), p(50, -4), p(50, 16)]);
    });

    it('unchanged: a wire leaving an output pin immediately vertical stays tangent to the body', () => {
      const resolve = (e: WireEnd): Vec2 | undefined =>
        e.kind === 'pin' ? p(64, 16) : e.kind === 'free' ? e.pos : undefined;
      const bounds = new Map([['d1', { x: 0, y: 0, w: 64, h: 32 }]]);
      const w: Wire = { id: 'w1', a: pinComp('d1', 'y'), b: free(64, 100), points: [] };
      const routes = computeWireRoutes([w], resolve, bounds, 16);
      expect(routes.get('w1')).toEqual([p(64, 16), p(64, 100)]);
    });

    it('unchanged: a wire leaving an input pin immediately vertical stays tangent to the body', () => {
      const resolve = (e: WireEnd): Vec2 | undefined =>
        e.kind === 'pin' ? p(50, 16) : e.kind === 'free' ? e.pos : undefined;
      const bounds = new Map([['r1', { x: 50, y: 0, w: 64, h: 32 }]]);
      const w: Wire = { id: 'w1', a: free(50, -40), b: pinComp('r1', 'a'), points: [] };
      const routes = computeWireRoutes([w], resolve, bounds, 16);
      expect(routes.get('w1')).toEqual([p(50, -40), p(50, 16)]);
    });
  });
});

describe('orthogonalPolyline', () => {
  it('routes straight (via routeOrthogonal) when there are no bend points', () => {
    expect(orthogonalPolyline(p(0, 0), [], p(10, 10))).toEqual(routeOrthogonal(p(0, 0), p(10, 10)));
  });

  it('leaves an already-orthogonal head/tail untouched', () => {
    const mid = [p(0, 10), p(10, 10)];
    expect(orthogonalPolyline(p(0, 0), mid, p(10, 0))).toEqual([
      p(0, 0),
      p(0, 10),
      p(10, 10),
      p(10, 0),
    ]);
  });

  it('inserts an elbow when an endpoint has moved off-axis from its stored bend (P2.1)', () => {
    // Endpoint a moved to (5,0); the stored first bend (0,10) is no longer
    // on-axis with it, so a new elbow must appear rather than a diagonal.
    const mid = [p(0, 10), p(10, 10)];
    const result = orthogonalPolyline(p(5, 0), mid, p(10, 0));
    for (let i = 0; i < result.length - 1; i++) {
      const a = result[i]!;
      const b = result[i + 1]!;
      expect(a.x === b.x || a.y === b.y).toBe(true); // every leg stays orthogonal
    }
    expect(result[0]).toEqual(p(5, 0));
    expect(result[result.length - 1]).toEqual(p(10, 0));
  });
});

describe('wireDisplayPoints', () => {
  it('matches routeAvoiding when there are no stored bends (what wireAt/idsInRect must hit-test against)', () => {
    const obstacle = { x: 4, y: -2, w: 4, h: 4 };
    expect(wireDisplayPoints(p(0, 0), p(10, 10), [], [obstacle])).toEqual(
      routeAvoiding(p(0, 0), p(10, 10), [obstacle]),
    );
  });

  it('matches orthogonalPolyline when there are stored bends', () => {
    const mid = [p(0, 10), p(10, 10)];
    expect(wireDisplayPoints(p(0, 0), p(10, 0), mid, [])).toEqual(
      orthogonalPolyline(p(0, 0), mid, p(10, 0)),
    );
  });
});

describe('segmentIntersectsRect / polylineIntersectsRect', () => {
  const rect = { x: 4, y: 4, w: 4, h: 4 }; // 4..8 in both axes

  it('is true when a segment passes through the rect', () => {
    expect(segmentIntersectsRect(p(0, 6), p(10, 6), rect)).toBe(true);
  });

  it('is true when a segment endpoint lands inside the rect', () => {
    expect(segmentIntersectsRect(p(6, 6), p(20, 6), rect)).toBe(true);
  });

  it('is false when the segment misses the rect entirely', () => {
    expect(segmentIntersectsRect(p(0, 0), p(20, 0), rect)).toBe(false);
  });

  it('an L-shaped polyline whose empty corner overlaps a rect is not a hit (bounding-box false positive)', () => {
    // Horizontal leg 0,0->10,0 then vertical leg 10,0->10,10: the rect sits
    // in the empty space between the two legs, inside the polyline's bbox
    // but touching neither actual segment.
    const pts = [p(0, 0), p(10, 0), p(10, 10)];
    const emptyCorner = { x: 2, y: 2, w: 4, h: 4 };
    expect(polylineIntersectsRect(pts, emptyCorner)).toBe(false);
  });

  it('the same polyline is a hit once the rect actually touches a leg', () => {
    const pts = [p(0, 0), p(10, 0), p(10, 10)];
    const onVerticalLeg = { x: 8, y: 4, w: 4, h: 4 };
    expect(polylineIntersectsRect(pts, onVerticalLeg)).toBe(true);
  });
});

describe('normalizeBends', () => {
  it('drops an interior point collinear and monotonic with both neighbors', () => {
    expect(normalizeBends([p(0, 0), p(5, 0), p(10, 0)])).toEqual([p(0, 0), p(10, 0)]);
  });

  it('drops an exact duplicate consecutive point', () => {
    expect(normalizeBends([p(0, 0), p(0, 0), p(5, 5)])).toEqual([p(0, 0), p(5, 5)]);
  });

  it('keeps a same-axis reversal (spike) intact -- not a redundant pass-through', () => {
    const spike = [p(0, 0), p(0, 10), p(0, 3)];
    expect(normalizeBends(spike)).toEqual(spike);
  });
});

describe('dragCorner', () => {
  // Owner sanity anchors: L-wire pin P=(0,100) -> corner C=(200,100) -> gate
  // G=(200,200) (G fixed, never moves).
  const P = p(0, 100);
  const C = p(200, 100);
  const G = p(200, 200);
  const displayPts = [P, C, G];

  it('dragging the corner right jogs at the far (gate) side, endpoints unmoved', () => {
    const result = dragCorner(displayPts, 1, p(240, 100));
    expect(result).toEqual([p(0, 100), p(240, 100), p(240, 200), p(200, 200)]);
    expect(result[0]).toEqual(P);
    expect(result[result.length - 1]).toEqual(G);
  });

  it('dragging the corner left shortens the P leg; P must not move', () => {
    const result = dragCorner(displayPts, 1, p(160, 100));
    expect(result).toEqual([p(0, 100), p(160, 100), p(160, 200), p(200, 200)]);
    expect(result[0]).toEqual(P);
  });

  it('drags a corner interior to a 2-bend wire, keeping the far endpoint fixed', () => {
    // U-shaped wire: A -> B1 -> B2 -> C. Dragging B1 re-elbows only the legs
    // touching it; B2 dissolves away once the new leg from B1 happens to run
    // straight through where B2 used to sit.
    const A = p(0, 0);
    const B1 = p(50, 0);
    const B2 = p(50, 50);
    const Cend = p(0, 50);
    const result = dragCorner([A, B1, B2, Cend], 1, p(80, 0));
    expect(result).toEqual([p(0, 0), p(80, 0), p(80, 50), p(0, 50)]);
    expect(result[0]).toEqual(A);
    expect(result[result.length - 1]).toEqual(Cend);
  });

  it('dissolves the corner entirely when dragged back onto the P-G line', () => {
    // A separate straight-line pair (G here shares P's y, unlike the L-wire
    // anchor case above) so dragging the corner onto that line really does
    // make the wire straight.
    const straightG = p(200, 100);
    const result = dragCorner([P, C, straightG], 1, p(50, 100));
    expect(result).toEqual([P, straightG]);
  });

  it('is a no-op for an endpoint index (never moves a real wire end)', () => {
    expect(dragCorner(displayPts, 0, p(999, 999))).toEqual(displayPts);
    expect(dragCorner(displayPts, 2, p(999, 999))).toEqual(displayPts);
  });
});

describe('stretchWirePoints', () => {
  it('rigidly translates every bend when both ends moved', () => {
    const result = stretchWirePoints([p(5, 0)], p(0, 0), p(10, 0), true, true, p(2, 3));
    expect(result).toEqual([p(7, 3)]);
  });

  it('follows a horizontal terminal leg in y when only the a-end moves', () => {
    const result = stretchWirePoints([p(5, 0)], p(0, 0), p(20, 0), true, false, p(0, 8));
    expect(result).toEqual([p(5, 8)]);
  });

  it('follows a vertical terminal leg in x when only the b-end moves', () => {
    const result = stretchWirePoints([p(0, 5)], p(0, 20), p(0, 20), false, true, p(7, 0));
    expect(result).toEqual([p(7, 5)]);
  });

  it('leaves an already-stale diagonal leg untouched (orthogonalPolyline is the fallback)', () => {
    const result = stretchWirePoints([p(3, 3)], p(0, 0), p(10, 10), true, false, p(5, 5));
    expect(result).toEqual([p(3, 3)]);
  });

  it('dissolves a bend that lands back on the endpoint after the move', () => {
    const result = stretchWirePoints([p(0, 10)], p(0, 0), p(20, 10), true, false, p(0, 10));
    expect(result).toEqual([]);
  });

  it('is a no-op for an already-auto-routed (empty-points) wire', () => {
    expect(stretchWirePoints([], p(0, 0), p(10, 0), true, false, p(5, 5))).toEqual([]);
  });
});

describe('rotatePointAround / rotatePointSnapped (Item 3, Shift+R)', () => {
  it('rotates +90 CW (screen y-down) about a pivot', () => {
    // A point directly right of the pivot moves to directly below it.
    expect(rotatePointAround(p(10, 0), p(0, 0))).toEqual(p(0, 10));
    // A point directly above the pivot moves to directly right of it.
    expect(rotatePointAround(p(0, -10), p(0, 0))).toEqual(p(10, 0));
  });

  it('is a no-op for the pivot itself', () => {
    expect(rotatePointAround(p(5, 5), p(5, 5))).toEqual(p(5, 5));
  });

  it('snaps the rotated result to grid', () => {
    // rotatePointAround(p(8,8), p(0,0)) = (-8, 8); already grid-aligned at 8,
    // so this exercises the snap path without landing on a -0 edge case.
    expect(rotatePointSnapped(p(8, 8), p(0, 0), 8)).toEqual(p(-8, 8));
  });
});

describe('groupRotateComponent (Item 3, Shift+R)', () => {
  it('keeps two components at the same relative offset after rotating together', () => {
    // Two 16x16 boxes side by side: a at (0,0), b at (16,0); union bbox
    // center (pivot) is (16,8).
    const pivot = p(16, 8);
    const ra = groupRotateComponent(
      { id: 'a', bounds: { x: 0, y: 0, w: 16, h: 16 }, rot: 0 },
      pivot,
      8,
    );
    const rb = groupRotateComponent(
      { id: 'b', bounds: { x: 16, y: 0, w: 16, h: 16 }, rot: 0 },
      pivot,
      8,
    );
    expect(ra.rot).toBe(90);
    expect(rb.rot).toBe(90);
    // a's old center (8,8) is 8 left of pivot -> rotates to 8 above it: (16,0).
    expect(ra.pos).toEqual({ x: 8, y: -8 });
    // b's old center (24,8) is 8 right of pivot -> rotates to 8 below it: (16,16).
    expect(rb.pos).toEqual({ x: 8, y: 8 });
  });

  it('wraps rot past 270 back to 0', () => {
    const r = groupRotateComponent(
      { id: 'a', bounds: { x: 0, y: 0, w: 8, h: 8 }, rot: 270 },
      p(4, 4),
      8,
    );
    expect(r.rot).toBe(0);
  });

  it('a shape whose w/h difference is an odd multiple of grid (e.g. a 2-input gate, 9Gx4G) still 4-cycles to its exact start, own-centre pivot recomputed fresh each turn', () => {
    const grid = 8;
    let bounds = { x: 0, y: 0, w: 9 * grid, h: 4 * grid };
    let rot: 0 | 90 | 180 | 270 = 0;
    for (let i = 0; i < 4; i++) {
      const pivot = {
        x: bounds.x + halfSnap(bounds.w, grid),
        y: bounds.y + halfSnap(bounds.h, grid),
      };
      const r = groupRotateComponent({ id: 'x', bounds, rot }, pivot, grid);
      bounds = { x: r.pos.x, y: r.pos.y, w: bounds.h, h: bounds.w };
      rot = r.rot;
    }
    expect(bounds).toEqual({ x: 0, y: 0, w: 9 * grid, h: 4 * grid });
    expect(rot).toBe(0);
  });

  it('a width-2 DIP-bank shape (3Gx4G, also odd-multiple mismatched) 4-cycles exactly too', () => {
    const grid = 8;
    let bounds = { x: 0, y: 0, w: 3 * grid, h: 4 * grid };
    let rot: 0 | 90 | 180 | 270 = 0;
    for (let i = 0; i < 4; i++) {
      const pivot = {
        x: bounds.x + halfSnap(bounds.w, grid),
        y: bounds.y + halfSnap(bounds.h, grid),
      };
      const r = groupRotateComponent({ id: 'x', bounds, rot }, pivot, grid);
      bounds = { x: r.pos.x, y: r.pos.y, w: bounds.h, h: bounds.w };
      rot = r.rot;
    }
    expect(bounds).toEqual({ x: 0, y: 0, w: 3 * grid, h: 4 * grid });
    expect(rot).toBe(0);
  });
});

describe('rotateAboutPivot (Task 8 follow-up: single-pin parts hinge on their own pin)', () => {
  it("rotates a shape's corners exactly about an arbitrary EXTERNAL pivot (not the body center)", () => {
    // 24x40 body at (0,0); pivot far outside the body, at (40,20) -- not
    // remotely close to the body's own center (12,20).
    const pivot = p(40, 20);
    const r = rotateAboutPivot({ id: 'x', bounds: { x: 0, y: 0, w: 24, h: 40 }, rot: 0 }, pivot);
    expect(r.rot).toBe(90);
    // Corners (0,0),(24,0),(0,40),(24,40) rotated about (40,20):
    // (0,0)->(60,-20); (24,0)->(60,4); (0,40)->(20,-20); (24,40)->(20,4).
    // min x=20, min y=-20.
    expect(r.pos).toEqual({ x: 20, y: -20 });
  });

  it('four turns about a fixed external pivot return to the exact start (true hinge behaviour)', () => {
    const pivot = p(40, 20);
    let bounds = { x: 0, y: 0, w: 24, h: 40 };
    let rot: 0 | 90 | 180 | 270 = 0;
    for (let i = 0; i < 4; i++) {
      const r = rotateAboutPivot({ id: 'x', bounds, rot }, pivot);
      bounds = { x: r.pos.x, y: r.pos.y, w: bounds.h, h: bounds.w };
      rot = r.rot;
    }
    expect(bounds).toEqual({ x: 0, y: 0, w: 24, h: 40 });
    expect(rot).toBe(0);
  });

  it('a shape whose w/h difference is an odd multiple of grid (2-input-gate-shaped) still hinges exactly on an external pivot', () => {
    const pivot = p(100, 50);
    let bounds = { x: 0, y: 0, w: 72, h: 32 };
    let rot: 0 | 90 | 180 | 270 = 0;
    for (let i = 0; i < 4; i++) {
      const r = rotateAboutPivot({ id: 'x', bounds, rot }, pivot);
      bounds = { x: r.pos.x, y: r.pos.y, w: bounds.h, h: bounds.w };
      rot = r.rot;
    }
    expect(bounds).toEqual({ x: 0, y: 0, w: 72, h: 32 });
    expect(rot).toBe(0);
  });
});

describe('halfSnap', () => {
  it('floors to the nearest grid multiple of half the dimension, consistently for both parities', () => {
    expect(halfSnap(16, 8)).toBe(8); // even multiple: exact half
    expect(halfSnap(24, 8)).toBe(8); // odd multiple (3G): floors down from 1.5G
    expect(halfSnap(32, 8)).toBe(16);
  });
});

describe('groupRotate (Task 5: correction pass cancels per-component drift)', () => {
  it('a single item returns to its exact center after four turns (no drift for n=1)', () => {
    const grid = 8;
    let bounds = { x: 96, y: 200, w: 24, h: 40 }; // 3Gx5G, e.g. a switch
    let rot: 0 | 90 | 180 | 270 = 0;
    for (let i = 0; i < 4; i++) {
      const pivot = { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 };
      const { items, correction } = groupRotate([{ id: 'x', bounds, rot }], pivot, grid);
      const r = items[0]!;
      const pos = { x: r.pos.x + correction.x, y: r.pos.y + correction.y };
      bounds = { x: pos.x, y: pos.y, w: bounds.h, h: bounds.w };
      rot = r.rot;
    }
    expect(bounds).toEqual({ x: 96, y: 200, w: 24, h: 40 });
    expect(rot).toBe(0);
  });

  // The live-QA follow-up: `Math.round`'s tie-breaking on a EXACTLY-half-grid
  // discrepancy flips direction depending on the sign being rounded, which
  // is what caused both Task 8's individual-rotate drift AND this group
  // scenario's residual (the pivot itself, re-derived from the evolving
  // union bbox each turn, was rounded the same asymmetric way). `halfSnap`
  // (always floors, so it's a consistent representative regardless of sign)
  // fixes both: this selection now returns to its EXACT starting
  // coordinates after four turns, not just its shape.
  it('a mixed-size selection (odd + even multiples of grid) 4-cycles back to its exact starting coordinates', () => {
    const grid = 8;
    // A 2-input AND (4Gx3G, even), a 4-bit DIP bank (3Gx5G, odd), an LED
    // (2Gx2G, even), a junction, and a free-free wire with a bend.
    const and_ = { pos: { x: 0, y: 0 }, rot: 0 as 0 | 90 | 180 | 270, w: 32, h: 24 };
    const dip = { pos: { x: 64, y: 0 }, rot: 0 as 0 | 90 | 180 | 270, w: 24, h: 40 };
    const led = { pos: { x: 0, y: 64 }, rot: 0 as 0 | 90 | 180 | 270, w: 16, h: 16 };
    let junction = { x: 40, y: 40 };
    let wire = { a: { x: 8, y: 8 }, points: [{ x: 24, y: 8 }], b: { x: 24, y: 24 } };

    const origAnd = { ...and_ };
    const origDip = { ...dip };
    const origLed = { ...led };
    const origJunction = { ...junction };
    const origWire = {
      a: { ...wire.a },
      points: wire.points.map((p) => ({ ...p })),
      b: { ...wire.b },
    };

    for (let i = 0; i < 4; i++) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      const grow = (pt: Vec2) => {
        minX = Math.min(minX, pt.x);
        minY = Math.min(minY, pt.y);
        maxX = Math.max(maxX, pt.x);
        maxY = Math.max(maxY, pt.y);
      };
      for (const c of [and_, dip, led]) {
        grow(c.pos);
        grow({ x: c.pos.x + c.w, y: c.pos.y + c.h });
      }
      grow(junction);
      grow(wire.a);
      grow(wire.b);
      for (const pt of wire.points) grow(pt);
      const pivot = {
        x: minX + halfSnap(maxX - minX, grid),
        y: minY + halfSnap(maxY - minY, grid),
      };

      const items = [
        {
          id: 'and',
          bounds: { x: and_.pos.x, y: and_.pos.y, w: and_.w, h: and_.h },
          rot: and_.rot,
        },
        { id: 'dip', bounds: { x: dip.pos.x, y: dip.pos.y, w: dip.w, h: dip.h }, rot: dip.rot },
        { id: 'led', bounds: { x: led.pos.x, y: led.pos.y, w: led.w, h: led.h }, rot: led.rot },
      ];
      const { items: results, correction } = groupRotate(items, pivot, grid);
      const byId = new Map(results.map((r) => [r.id, r]));
      const applyRot = (
        comp: { pos: Vec2; rot: 0 | 90 | 180 | 270; w: number; h: number },
        id: string,
      ) => {
        const r = byId.get(id)!;
        comp.pos = { x: r.pos.x + correction.x, y: r.pos.y + correction.y };
        const w = comp.h;
        const h = comp.w;
        comp.w = w;
        comp.h = h;
        comp.rot = r.rot;
      };
      applyRot(and_, 'and');
      applyRot(dip, 'dip');
      applyRot(led, 'led');

      const addCorrection = (pt: Vec2) => ({ x: pt.x + correction.x, y: pt.y + correction.y });
      junction = addCorrection(rotatePointSnapped(junction, pivot, grid));
      wire = {
        a: addCorrection(rotatePointAround(wire.a, pivot)),
        b: addCorrection(rotatePointAround(wire.b, pivot)),
        points: wire.points.map((pt) => addCorrection(rotatePointAround(pt, pivot))),
      };
    }

    expect(and_).toEqual(origAnd);
    expect(dip).toEqual(origDip);
    expect(led).toEqual(origLed);
    expect(junction).toEqual(origJunction);
    expect(wire).toEqual(origWire);
  });
});

describe('alignDeltas', () => {
  const rect = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

  it('returns no deltas for fewer than 2 items', () => {
    expect(alignDeltas([{ id: 'a', bounds: rect(0, 0, 10, 10) }], 'left', 8)).toEqual(new Map());
  });

  it('aligns left edges to the leftmost item', () => {
    const items = [
      { id: 'a', bounds: rect(0, 0, 8, 8) },
      { id: 'b', bounds: rect(24, 8, 8, 8) },
      { id: 'c', bounds: rect(16, 16, 8, 8) },
    ];
    const d = alignDeltas(items, 'left', 8);
    expect(d.get('a')).toEqual({ x: 0, y: 0 });
    expect(d.get('b')).toEqual({ x: -24, y: 0 });
    expect(d.get('c')).toEqual({ x: -16, y: 0 });
  });

  it('aligns right edges to the rightmost item', () => {
    const items = [
      { id: 'a', bounds: rect(0, 0, 8, 8) },
      { id: 'b', bounds: rect(24, 0, 16, 8) },
    ];
    const d = alignDeltas(items, 'right', 8);
    // a's right edge (8) -> target 40 (b's right edge): delta 32
    expect(d.get('a')).toEqual({ x: 32, y: 0 });
    expect(d.get('b')).toEqual({ x: 0, y: 0 });
  });

  it('aligns top/bottom edges symmetrically to left/right', () => {
    const items = [
      { id: 'a', bounds: rect(0, 0, 8, 8) },
      { id: 'b', bounds: rect(0, 32, 8, 16) },
    ];
    expect(alignDeltas(items, 'top', 8).get('b')).toEqual({ x: 0, y: -32 });
    expect(alignDeltas(items, 'bottom', 8).get('a')).toEqual({ x: 0, y: 40 });
  });

  it('aligns horizontal/vertical centers to the grid-snapped average', () => {
    const items = [
      { id: 'a', bounds: rect(0, 0, 8, 8) }, // center x = 4
      { id: 'b', bounds: rect(24, 0, 8, 8) }, // center x = 28
    ];
    // average center = 16, already a grid multiple of 8
    const d = alignDeltas(items, 'centerX', 8);
    expect(d.get('a')).toEqual({ x: 12, y: 0 });
    expect(d.get('b')).toEqual({ x: -12, y: 0 });
  });
});

describe('distributeDeltas', () => {
  const rect = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

  it('returns no deltas for fewer than 3 items', () => {
    const items = [
      { id: 'a', bounds: rect(0, 0, 8, 8) },
      { id: 'b', bounds: rect(40, 0, 8, 8) },
    ];
    expect(distributeDeltas(items, 'x', 8)).toEqual(new Map());
  });

  it('equalizes gaps along x, pinning the two extreme items', () => {
    // a: [0,8), b: [16,24), c: [64,72) far right -- total span 0..72, total
    // size 24, gap = (72-24)/2 = 24, so b should land at 0 + 8 + 24 = 32
    const items = [
      { id: 'a', bounds: rect(0, 0, 8, 8) },
      { id: 'b', bounds: rect(16, 0, 8, 8) },
      { id: 'c', bounds: rect(64, 0, 8, 8) },
    ];
    const d = distributeDeltas(items, 'x', 8);
    expect(d.get('a')).toEqual({ x: 0, y: 0 });
    expect(d.get('c')).toEqual({ x: 0, y: 0 });
    expect(d.get('b')).toEqual({ x: 16, y: 0 });
  });

  it('is order-independent (sorts by position first)', () => {
    const items = [
      { id: 'c', bounds: rect(64, 0, 8, 8) },
      { id: 'a', bounds: rect(0, 0, 8, 8) },
      { id: 'b', bounds: rect(16, 0, 8, 8) },
    ];
    const d = distributeDeltas(items, 'x', 8);
    expect(d.get('b')).toEqual({ x: 16, y: 0 });
  });

  it('distributes along y using height instead of width', () => {
    const items = [
      { id: 'a', bounds: rect(0, 0, 8, 8) },
      { id: 'b', bounds: rect(0, 16, 8, 8) },
      { id: 'c', bounds: rect(0, 64, 8, 8) },
    ];
    const d = distributeDeltas(items, 'y', 8);
    expect(d.get('b')).toEqual({ x: 0, y: 16 });
  });
});

describe('packDeltas', () => {
  const rect = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

  it('returns no deltas for fewer than 2 items', () => {
    expect(packDeltas([{ id: 'a', bounds: rect(0, 0, 8, 8) }], 'x', 8)).toEqual(new Map());
  });

  it('butts items up against each other along x, pinning the leftmost', () => {
    const items = [
      { id: 'a', bounds: rect(0, 0, 8, 8) },
      { id: 'b', bounds: rect(40, 0, 16, 8) },
      { id: 'c', bounds: rect(80, 0, 8, 8) },
    ];
    const d = packDeltas(items, 'x', 8);
    expect(d.get('a')).toEqual({ x: 0, y: 0 });
    // b follows immediately after a's right edge (8)
    expect(d.get('b')).toEqual({ x: -32, y: 0 });
    // c follows immediately after b's new right edge (8 + 16 = 24)
    expect(d.get('c')).toEqual({ x: -56, y: 0 });
  });

  it('is order-independent (sorts by position first)', () => {
    const items = [
      { id: 'c', bounds: rect(80, 0, 8, 8) },
      { id: 'a', bounds: rect(0, 0, 8, 8) },
      { id: 'b', bounds: rect(40, 0, 16, 8) },
    ];
    const d = packDeltas(items, 'x', 8);
    expect(d.get('b')).toEqual({ x: -32, y: 0 });
    expect(d.get('c')).toEqual({ x: -56, y: 0 });
  });

  it('packs along y using height instead of width', () => {
    const items = [
      { id: 'a', bounds: rect(0, 0, 8, 16) },
      { id: 'b', bounds: rect(0, 48, 8, 8) },
    ];
    const d = packDeltas(items, 'y', 8);
    expect(d.get('a')).toEqual({ x: 0, y: 0 });
    // b follows immediately after a's bottom edge (16)
    expect(d.get('b')).toEqual({ x: 0, y: -32 });
  });
});

describe('pointAlongPolyline / tAlongPolyline', () => {
  // An L: 100 across then 100 down, so the corner is exactly the midpoint.
  const L: Vec2[] = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
  ];

  it('lands t=0.5 on the arc-length midpoint, not the endpoint midpoint', () => {
    expect(pointAlongPolyline(L, 0.5).pos).toEqual({ x: 100, y: 0 });
  });

  it('returns the segment the point sits on, for the badge axis', () => {
    expect(pointAlongPolyline(L, 0.25).segment).toEqual([L[0], L[1]]);
    expect(pointAlongPolyline(L, 0.75).segment).toEqual([L[1], L[2]]);
  });

  it('clamps out-of-range fractions to the ends', () => {
    expect(pointAlongPolyline(L, -1).pos).toEqual({ x: 0, y: 0 });
    expect(pointAlongPolyline(L, 2).pos).toEqual({ x: 100, y: 100 });
  });

  it('round-trips a point back to its own fraction', () => {
    for (const t of [0, 0.1, 0.5, 0.9, 1]) {
      expect(tAlongPolyline(L, pointAlongPolyline(L, t).pos)).toBeCloseTo(t, 6);
    }
  });

  it('projects a point off the line onto the nearest segment', () => {
    expect(tAlongPolyline(L, { x: 50, y: -30 })).toBeCloseTo(0.25, 6);
    expect(tAlongPolyline(L, { x: 140, y: 50 })).toBeCloseTo(0.75, 6);
  });

  it('is defined for a degenerate polyline rather than dividing by zero', () => {
    const dot: Vec2[] = [
      { x: 5, y: 5 },
      { x: 5, y: 5 },
    ];
    expect(pointAlongPolyline(dot, 0.5).pos).toEqual({ x: 5, y: 5 });
    expect(tAlongPolyline(dot, { x: 9, y: 9 })).toBe(0);
  });
});
