import { describe, expect, it } from 'vitest';
import {
  attachAtHit,
  collapseJunctions,
  findWireHit,
  findWireHitsAt,
  freeEndAtHit,
  junctionNear,
  splitWireAtHit,
  type ResolveWireEnd,
} from './junctions';
import type { Circuit } from '../../core/model/types';

const resolve: ResolveWireEnd = (end) =>
  end.kind === 'pin' && end.component === 'a' ? { x: 0, y: 0 } : { x: 100, y: 0 };

function baseCircuit(): Circuit {
  return {
    components: [],
    junctions: [],
    wires: [
      {
        id: 'w1',
        a: { kind: 'pin', component: 'a', pin: 'y' },
        b: { kind: 'pin', component: 'b', pin: 'a' },
        points: [],
      },
    ],
  };
}

describe('findWireHit', () => {
  it('finds the nearest segment within the fat-click radius', () => {
    const hit = findWireHit(baseCircuit().wires, { x: 50, y: 1 }, 10, resolve);
    expect(hit).toBeDefined();
    expect(hit!.wire.id).toBe('w1');
    expect(hit!.snapped).toEqual({ x: 50, y: 0 });
  });

  it('misses a point far from any wire', () => {
    expect(findWireHit(baseCircuit().wires, { x: 500, y: 500 }, 10, resolve)).toBeUndefined();
  });
});

describe('junctionNear', () => {
  it('finds a junction within grid-snap tolerance, else undefined', () => {
    const junctions = [{ id: 'j1', pos: { x: 50, y: 0 } }];
    expect(junctionNear(junctions, { x: 51, y: 1 }, 10)?.id).toBe('j1');
    expect(junctionNear(junctions, { x: 90, y: 0 }, 10)).toBeUndefined();
  });
});

describe('splitWireAtHit', () => {
  it('splits a bend-free wire into two halves; caller pushes the shared junction', () => {
    const draft = baseCircuit();
    const hit = findWireHit(draft.wires, { x: 50, y: 1 }, 10, resolve)!;
    let n = 0;
    splitWireAtHit(draft, hit, 'j1', () => `w${n++}`);
    draft.junctions.push({ id: 'j1', pos: hit.snapped });
    expect(draft.junctions).toEqual([{ id: 'j1', pos: { x: 50, y: 0 } }]);
    expect(draft.wires).toHaveLength(2);
    const first = draft.wires.find((w) => w.a.kind === 'pin' && w.a.component === 'a')!;
    const second = draft.wires.find((w) => w.b.kind === 'pin' && w.b.component === 'b')!;
    expect(first.b).toEqual({ kind: 'junction', junction: 'j1' });
    expect(first.points).toEqual([]);
    expect(second.a).toEqual({ kind: 'junction', junction: 'j1' });
    expect(second.points).toEqual([]);
  });

  it('keeps bend points on the correct side of the split', () => {
    const draft = baseCircuit();
    draft.wires[0]!.points = [
      { x: 20, y: 0 },
      { x: 20, y: 40 },
      { x: 80, y: 40 },
    ];
    // resolveEnd still gives (0,0) -> (100,0); the wire's own polyline is
    // a -> (20,0) -> (20,40) -> (80,40) -> b, so hit near (20,20) lands on
    // the second segment (index 1).
    const hit = findWireHit(draft.wires, { x: 21, y: 20 }, 10, resolve)!;
    expect(hit.seg).toBe(1);
    let n = 0;
    splitWireAtHit(draft, hit, 'j1', () => `w${n++}`);
    const first = draft.wires.find((w) => w.a.kind === 'pin' && w.a.component === 'a')!;
    const second = draft.wires.find((w) => w.b.kind === 'pin' && w.b.component === 'b')!;
    expect(first.points).toEqual([{ x: 20, y: 0 }]);
    expect(second.points).toEqual([
      { x: 20, y: 40 },
      { x: 80, y: 40 },
    ]);
  });
});

describe('freeEndAtHit / attachAtHit', () => {
  function freeEndedCircuit(): Circuit {
    return {
      components: [],
      junctions: [],
      wires: [
        {
          id: 'w1',
          a: { kind: 'free', pos: { x: 0, y: 0 } },
          b: { kind: 'free', pos: { x: 100, y: 0 } },
          points: [],
        },
      ],
    };
  }

  it('identifies a free end sitting at the hit point', () => {
    const draft = freeEndedCircuit();
    const resolveFree: ResolveWireEnd = (end) => (end.kind === 'free' ? end.pos : undefined);
    const hit = findWireHit(draft.wires, { x: 2, y: 1 }, 10, resolveFree)!;
    expect(freeEndAtHit(hit, 10)).toBe('a');

    const hitB = findWireHit(draft.wires, { x: 98, y: 1 }, 10, resolveFree)!;
    expect(freeEndAtHit(hitB, 10)).toBe('b');

    // A hit in the middle of the wire isn't near either free end.
    const hitMid = findWireHit(draft.wires, { x: 50, y: 1 }, 10, resolveFree)!;
    expect(freeEndAtHit(hitMid, 10)).toBeUndefined();
  });

  it('converts a free end in place instead of splitting a zero-length stub', () => {
    const draft = freeEndedCircuit();
    const resolveFree: ResolveWireEnd = (end) => (end.kind === 'free' ? end.pos : undefined);
    const hit = findWireHit(draft.wires, { x: 1, y: 0 }, 10, resolveFree)!;
    let n = 0;
    attachAtHit(draft, hit, 'j1', 10, () => `w${n++}`);
    // No split: still exactly one wire, now junction-ended on 'a', no stray
    // zero-length stub wire introduced.
    expect(draft.wires).toHaveLength(1);
    expect(draft.wires[0]!.a).toEqual({ kind: 'junction', junction: 'j1' });
    expect(draft.wires[0]!.b).toEqual({ kind: 'free', pos: { x: 100, y: 0 } });
  });

  it('falls back to a real split when the hit is not at a free end', () => {
    const draft = baseCircuit();
    const hit = findWireHit(draft.wires, { x: 50, y: 1 }, 10, resolve)!;
    let n = 0;
    attachAtHit(draft, hit, 'j1', 10, () => `w${n++}`);
    expect(draft.wires).toHaveLength(2);
  });

  it('collinear free-end conversion on both sides collapses to a single wire via collapseJunctions', () => {
    // Two wires, each with a free end meeting at the same point: attaching a
    // junction on one via attachAtHit, then the other, should leave a 2-way
    // straight pass-through that collapseJunctions merges away.
    const draft: Circuit = {
      components: [],
      junctions: [],
      wires: [
        {
          id: 'w1',
          a: { kind: 'free', pos: { x: 0, y: 0 } },
          b: { kind: 'free', pos: { x: 50, y: 0 } },
          points: [],
        },
        {
          id: 'w2',
          a: { kind: 'free', pos: { x: 50, y: 0 } },
          b: { kind: 'free', pos: { x: 100, y: 0 } },
          points: [],
        },
      ],
    };
    const resolveFree: ResolveWireEnd = (end) => (end.kind === 'free' ? end.pos : undefined);
    let n = 0;
    const hit1 = findWireHit(
      draft.wires.filter((w) => w.id === 'w1'),
      { x: 49, y: 0 },
      10,
      resolveFree,
    )!;
    attachAtHit(draft, hit1, 'j1', 10, () => `w${n++}`);
    const hit2 = findWireHit(
      draft.wires.filter((w) => w.id === 'w2'),
      { x: 51, y: 0 },
      10,
      resolveFree,
    )!;
    attachAtHit(draft, hit2, 'j1', 10, () => `w${n++}`);
    draft.junctions.push({ id: 'j1', pos: { x: 50, y: 0 } });
    collapseJunctions(draft, () => `merged${n++}`, resolveFree);
    expect(draft.junctions).toEqual([]);
    expect(draft.wires).toHaveLength(1);
    expect(draft.wires[0]).toMatchObject({
      a: { kind: 'free', pos: { x: 0, y: 0 } },
      b: { kind: 'free', pos: { x: 100, y: 0 } },
    });
  });
});

describe('findWireHitsAt', () => {
  it('returns every distinct wire crossing pos, not just the nearest', () => {
    const draft: Circuit = {
      components: [],
      junctions: [],
      wires: [
        {
          id: 'h',
          a: { kind: 'pin', component: 'sw1', pin: 'y' },
          b: { kind: 'pin', component: 'g1', pin: 'a' },
          points: [],
        },
        {
          id: 'v',
          a: { kind: 'pin', component: 'sw2', pin: 'y' },
          b: { kind: 'pin', component: 'led1', pin: 'a' },
          points: [],
        },
      ],
    };
    const resolveCross: ResolveWireEnd = (end) => {
      if (end.kind !== 'pin') return undefined;
      if (end.component === 'sw1') return { x: 0, y: 40 };
      if (end.component === 'g1') return { x: 160, y: 40 };
      if (end.component === 'sw2') return { x: 80, y: 0 };
      return { x: 80, y: 80 };
    };
    const hits = findWireHitsAt(draft.wires, { x: 80, y: 40 }, 10, resolveCross);
    expect(hits).toHaveLength(2);
    expect(new Set(hits.map((h) => h.wire.id))).toEqual(new Set(['h', 'v']));
    // Both hits share one canonical junction point.
    expect(hits[0]!.snapped).toEqual(hits[1]!.snapped);
  });

  it('returns [] when nothing is close enough', () => {
    expect(findWireHitsAt(baseCircuit().wires, { x: 500, y: 500 }, 10, resolve)).toEqual([]);
  });
});

describe('collapseJunctions', () => {
  it('drops a junction referenced by zero wires', () => {
    const draft: Circuit = {
      components: [],
      wires: [],
      junctions: [{ id: 'j', pos: { x: 0, y: 0 } }],
    };
    collapseJunctions(draft, () => 'w');
    expect(draft.junctions).toEqual([]);
  });

  it('reduces a degree-1 junction to a free end on its lone wire', () => {
    const draft: Circuit = {
      components: [],
      junctions: [{ id: 'j', pos: { x: 10, y: 10 } }],
      wires: [
        {
          id: 'w1',
          a: { kind: 'pin', component: 'a', pin: 'y' },
          b: { kind: 'junction', junction: 'j' },
          points: [],
        },
      ],
    };
    collapseJunctions(draft, () => 'w');
    expect(draft.junctions).toEqual([]);
    expect(draft.wires[0]!.b).toEqual({ kind: 'free', pos: { x: 10, y: 10 } });
  });

  it('merges a straight degree-2 free-ended pass-through, leaves an L-bend alone', () => {
    const straight: Circuit = {
      components: [],
      junctions: [{ id: 'j', pos: { x: 40, y: 0 } }],
      wires: [
        {
          id: 'w1',
          a: { kind: 'free', pos: { x: 0, y: 0 } },
          b: { kind: 'junction', junction: 'j' },
          points: [],
        },
        {
          id: 'w2',
          a: { kind: 'junction', junction: 'j' },
          b: { kind: 'free', pos: { x: 80, y: 0 } },
          points: [],
        },
      ],
    };
    collapseJunctions(straight, () => 'merged');
    expect(straight.junctions).toEqual([]);
    expect(straight.wires).toHaveLength(1);
    expect(straight.wires[0]).toMatchObject({
      a: { kind: 'free', pos: { x: 0, y: 0 } },
      b: { kind: 'free', pos: { x: 80, y: 0 } },
    });

    const lBend: Circuit = {
      components: [],
      junctions: [{ id: 'j', pos: { x: 40, y: 0 } }],
      wires: [
        {
          id: 'w1',
          a: { kind: 'free', pos: { x: 0, y: 0 } },
          b: { kind: 'junction', junction: 'j' },
          points: [],
        },
        {
          id: 'w2',
          a: { kind: 'junction', junction: 'j' },
          b: { kind: 'free', pos: { x: 40, y: 40 } },
          points: [],
        },
      ],
    };
    collapseJunctions(lBend, () => 'merged');
    expect(lBend.junctions).toHaveLength(1); // real branch shape, left in place
    expect(lBend.wires).toHaveLength(2);
  });

  it('never collapses a genuine 3+-way branch', () => {
    const draft: Circuit = {
      components: [],
      junctions: [{ id: 'j', pos: { x: 40, y: 0 } }],
      wires: [
        {
          id: 'w1',
          a: { kind: 'free', pos: { x: 0, y: 0 } },
          b: { kind: 'junction', junction: 'j' },
          points: [],
        },
        {
          id: 'w2',
          a: { kind: 'junction', junction: 'j' },
          b: { kind: 'free', pos: { x: 80, y: 0 } },
          points: [],
        },
        {
          id: 'w3',
          a: { kind: 'junction', junction: 'j' },
          b: { kind: 'free', pos: { x: 40, y: 40 } },
          points: [],
        },
      ],
    };
    collapseJunctions(draft, () => 'merged');
    expect(draft.junctions).toHaveLength(1);
    expect(draft.wires).toHaveLength(3);
  });

  it('with a resolveEnd, also collapses a straight pin-ended pass-through', () => {
    const draft: Circuit = {
      components: [],
      junctions: [{ id: 'j', pos: { x: 40, y: 0 } }],
      wires: [
        {
          id: 'w1',
          a: { kind: 'pin', component: 'a', pin: 'y' },
          b: { kind: 'junction', junction: 'j' },
          points: [],
        },
        {
          id: 'w2',
          a: { kind: 'junction', junction: 'j' },
          b: { kind: 'pin', component: 'b', pin: 'a' },
          points: [],
        },
      ],
    };
    collapseJunctions(draft, () => 'merged', resolve); // resolve: a->(0,0), b->(100,0)
    expect(draft.junctions).toEqual([]);
    expect(draft.wires).toHaveLength(1);
  });
});
