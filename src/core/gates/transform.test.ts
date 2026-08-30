import { describe, expect, it } from 'vitest';
import type { Board, Component, Wire } from '../model/types';
import {
  absorbInverterIntoDriver,
  annihilatePair,
  materializeInputBubble,
  mergeInversionsUpstream,
  mergeInversionsUpstreamNaive,
  pushInputsForward,
  pushOutputAcrossFanout,
  pushOutputBackward,
  insertBubblePair,
  splitDoubleInverter,
} from './transform';
import {
  getInputBubbles,
  getOutputBubble,
  normalizeGateComponent,
  withInputBubble,
  withOutputBubble,
} from './bubbleModel';
import { isEquivalent } from './verify';

function wire(id: string, ca: string, pa: string, cb: string, pb: string): Wire {
  return {
    id,
    a: { kind: 'pin', component: ca, pin: pa },
    b: { kind: 'pin', component: cb, pin: pb },
    points: [],
  };
}

function board(components: Component[], wires: Wire[]): Board {
  return {
    format: 'lcir.board',
    formatVersion: 5,
    id: 'b',
    name: 'b',
    components,
    wires,
    junctions: [],
    probes: [],
    view: { x: 0, y: 0, zoom: 1 },
    timing: { mode: 'ideal', datasheet: 'typ' },
  };
}

const lib = new Map();

// in1,in2 -> AND(+bubble=NAND) -> out
function nandBoard(): Board {
  const g1 = withOutputBubble({ id: 'g1', kind: 'and', pos: { x: 0, y: 0 } }, true);
  return board(
    [
      { id: 'in1', kind: 'inport', pos: { x: 0, y: 0 }, label: 'in1' },
      { id: 'in2', kind: 'inport', pos: { x: 0, y: 0 }, label: 'in2' },
      g1,
      { id: 'out', kind: 'outport', pos: { x: 0, y: 0 }, label: 'out' },
    ],
    [
      {
        id: 'w1',
        a: { kind: 'pin', component: 'in1', pin: 'y' },
        b: { kind: 'pin', component: 'g1', pin: 'a' },
        points: [],
      },
      {
        id: 'w2',
        a: { kind: 'pin', component: 'in2', pin: 'y' },
        b: { kind: 'pin', component: 'g1', pin: 'b' },
        points: [],
      },
      {
        id: 'w3',
        a: { kind: 'pin', component: 'g1', pin: 'y' },
        b: { kind: 'pin', component: 'out', pin: 'a' },
        points: [],
      },
    ],
  );
}

describe('pushOutputBackward', () => {
  it('dualizes the gate and bubbles every input; stays equivalent', () => {
    const b = nandBoard();
    const next = pushOutputBackward(b, 'g1');
    expect(next).not.toBeNull();
    const g1 = next!.components.find((c) => c.id === 'g1')!;
    expect(g1.kind).toBe('or'); // AND dualizes to OR
    expect(getOutputBubble(g1)).toBe(false);
    expect(getInputBubbles(g1)).toEqual(new Set(['a', 'b']));
    expect(isEquivalent(b, next!, lib)).toBe(true);
  });

  it('is a failed drag (returns null, unchanged) when there is no output bubble', () => {
    const b = nandBoard();
    const plainAnd = board(
      b.components.map((c) => {
        if (c.id !== 'g1') return c;
        return { ...c, params: { ...c.params, outputBubble: false } };
      }),
      b.wires,
    );
    expect(pushOutputBackward(plainAnd, 'g1')).toBeNull();
  });
});

describe('pushInputsForward', () => {
  it('is the inverse of pushOutputBackward and stays equivalent', () => {
    const b = nandBoard();
    const pushed = pushOutputBackward(b, 'g1')!;
    const back = pushInputsForward(pushed, 'g1');
    expect(back).not.toBeNull();
    const g1 = back!.components.find((c) => c.id === 'g1')!;
    expect(g1.kind).toBe('and');
    expect(getOutputBubble(g1)).toBe(true);
    expect(getInputBubbles(g1).size).toBe(0);
    expect(isEquivalent(b, back!, lib)).toBe(true);
  });

  it('is a failed drag when siblings lack a bubble (only one input bubbled)', () => {
    const b = nandBoard();
    const pushed = pushOutputBackward(b, 'g1')!;
    // clear just one sibling's bubble to simulate a partial state
    const partial = board(
      pushed.components.map((c) => {
        if (c.id !== 'g1') return c;
        return { ...c, params: { ...c.params, inputBubbles: 'a' } };
      }),
      pushed.wires,
    );
    expect(pushInputsForward(partial, 'g1')).toBeNull();
  });
});

describe('pushOutputAcrossFanout', () => {
  it('duplicates onto every fan-out branch and stays equivalent', () => {
    const g1 = withOutputBubble({ id: 'g1', kind: 'and', pos: { x: 0, y: 0 } }, true);
    const g2: Component = { id: 'g2', kind: 'and', pos: { x: 1, y: 0 } };
    const g3: Component = { id: 'g3', kind: 'or', pos: { x: 1, y: 1 } };
    const b = board(
      [
        { id: 'in1', kind: 'inport', pos: { x: 0, y: 0 }, label: 'in1' },
        { id: 'in2', kind: 'inport', pos: { x: 0, y: 0 }, label: 'in2' },
        { id: 'in3', kind: 'inport', pos: { x: 0, y: 0 }, label: 'in3' },
        { id: 'in4', kind: 'inport', pos: { x: 0, y: 0 }, label: 'in4' },
        g1,
        g2,
        g3,
        { id: 'out1', kind: 'outport', pos: { x: 0, y: 0 }, label: 'out1' },
        { id: 'out2', kind: 'outport', pos: { x: 0, y: 0 }, label: 'out2' },
      ],
      [
        {
          id: 'w1',
          a: { kind: 'pin', component: 'in1', pin: 'y' },
          b: { kind: 'pin', component: 'g1', pin: 'a' },
          points: [],
        },
        {
          id: 'w2',
          a: { kind: 'pin', component: 'in2', pin: 'y' },
          b: { kind: 'pin', component: 'g1', pin: 'b' },
          points: [],
        },
        // fan-out: g1.y feeds both g2.a and g3.a
        {
          id: 'w3',
          a: { kind: 'pin', component: 'g1', pin: 'y' },
          b: { kind: 'pin', component: 'g2', pin: 'a' },
          points: [],
        },
        {
          id: 'w4',
          a: { kind: 'pin', component: 'g1', pin: 'y' },
          b: { kind: 'pin', component: 'g3', pin: 'a' },
          points: [],
        },
        {
          id: 'w5',
          a: { kind: 'pin', component: 'in3', pin: 'y' },
          b: { kind: 'pin', component: 'g2', pin: 'b' },
          points: [],
        },
        {
          id: 'w6',
          a: { kind: 'pin', component: 'in4', pin: 'y' },
          b: { kind: 'pin', component: 'g3', pin: 'b' },
          points: [],
        },
        {
          id: 'w7',
          a: { kind: 'pin', component: 'g2', pin: 'y' },
          b: { kind: 'pin', component: 'out1', pin: 'a' },
          points: [],
        },
        {
          id: 'w8',
          a: { kind: 'pin', component: 'g3', pin: 'y' },
          b: { kind: 'pin', component: 'out2', pin: 'a' },
          points: [],
        },
      ],
    );
    const next = pushOutputAcrossFanout(b, 'g1');
    expect(next).not.toBeNull();
    const ng1 = next!.components.find((c) => c.id === 'g1')!;
    expect(getOutputBubble(ng1)).toBe(false);
    const ng2 = next!.components.find((c) => c.id === 'g2')!;
    const ng3 = next!.components.find((c) => c.id === 'g3')!;
    expect(getInputBubbles(ng2)).toEqual(new Set(['a']));
    expect(getInputBubbles(ng3)).toEqual(new Set(['a']));
    expect(isEquivalent(b, next!, lib)).toBe(true);
  });
});

describe('pushOutputAcrossFanout source cleanup (no bare BUF left behind)', () => {
  // in1 -> NOT(n1) -> g1.a, in2 -> g1.b, g1 -> out
  function notIntoGateBoard(): Board {
    const n1 = withOutputBubble({ id: 'n1', kind: 'buf', pos: { x: 8, y: 0 } }, true);
    return board(
      [
        { id: 'in1', kind: 'inport', pos: { x: 0, y: 0 }, label: 'in1' },
        { id: 'in2', kind: 'inport', pos: { x: 0, y: 8 }, label: 'in2' },
        n1,
        { id: 'g1', kind: 'and', pos: { x: 16, y: 0 } },
        { id: 'out', kind: 'outport', pos: { x: 24, y: 0 }, label: 'out' },
      ],
      [
        {
          id: 'w1',
          a: { kind: 'pin', component: 'in1', pin: 'y' },
          b: { kind: 'pin', component: 'n1', pin: 'a' },
          points: [],
        },
        {
          id: 'w2',
          a: { kind: 'pin', component: 'n1', pin: 'y' },
          b: { kind: 'pin', component: 'g1', pin: 'a' },
          points: [],
        },
        {
          id: 'w3',
          a: { kind: 'pin', component: 'in2', pin: 'y' },
          b: { kind: 'pin', component: 'g1', pin: 'b' },
          points: [],
        },
        {
          id: 'w4',
          a: { kind: 'pin', component: 'g1', pin: 'y' },
          b: { kind: 'pin', component: 'out', pin: 'a' },
          points: [],
        },
      ],
    );
  }

  it('single consumer: NOT deletes with heal, bubble lands on the gate input', () => {
    const b = notIntoGateBoard();
    const next = pushOutputAcrossFanout(b, 'n1');
    expect(next).not.toBeNull();
    expect(next!.components.some((c) => c.id === 'n1')).toBe(false);
    const g1 = next!.components.find((c) => c.id === 'g1')!;
    expect(getInputBubbles(g1)).toEqual(new Set(['a']));
    const healed = next!.wires.find(
      (w) =>
        w.a.kind === 'pin' &&
        w.b.kind === 'pin' &&
        ((w.a.component === 'in1' && w.b.component === 'g1' && w.b.pin === 'a') ||
          (w.b.component === 'in1' && w.a.component === 'g1' && w.a.pin === 'a')),
    );
    expect(healed).toBeDefined();
    expect(isEquivalent(b, next!, lib)).toBe(true);
  });

  it('fan-out: NOT collapses to exactly one junction, all branches conduct', () => {
    const base = notIntoGateBoard();
    const b = board(
      [...base.components, { id: 'g2', kind: 'or', pos: { x: 16, y: 16 } }],
      [
        ...base.wires,
        {
          id: 'w5',
          a: { kind: 'pin', component: 'n1', pin: 'y' },
          b: { kind: 'pin', component: 'g2', pin: 'a' },
          points: [],
        },
        {
          id: 'w6',
          a: { kind: 'pin', component: 'in2', pin: 'y' },
          b: { kind: 'pin', component: 'g2', pin: 'b' },
          points: [],
        },
      ],
    );
    const next = pushOutputAcrossFanout(b, 'n1');
    expect(next).not.toBeNull();
    expect(next!.components.some((c) => c.id === 'n1')).toBe(false);
    expect(next!.junctions).toHaveLength(1);
    const jid = next!.junctions[0]!.id;
    const jWires = next!.wires.filter(
      (w) =>
        (w.a.kind === 'junction' && w.a.junction === jid) ||
        (w.b.kind === 'junction' && w.b.junction === jid),
    );
    expect(jWires).toHaveLength(3); // in-wire + both branches
    expect(getInputBubbles(next!.components.find((c) => c.id === 'g1')!)).toEqual(new Set(['a']));
    expect(getInputBubbles(next!.components.find((c) => c.id === 'g2')!)).toEqual(new Set(['a']));
    expect(isEquivalent(b, next!, lib)).toBe(true);
  });

  it('a NAND away-push keeps its AND body (no cleanup of a real gate)', () => {
    const b = nandBoard();
    const next = pushOutputAcrossFanout(b, 'g1');
    expect(next).not.toBeNull();
    const g1 = next!.components.find((c) => c.id === 'g1')!;
    expect(g1.kind).toBe('and');
    expect(getOutputBubble(g1)).toBe(false);
    expect(isEquivalent(b, next!, lib)).toBe(true);
  });

  it('never touches a pre-existing user BUF elsewhere on the board', () => {
    const base = notIntoGateBoard();
    const b = board(
      [
        ...base.components,
        { id: 'userbuf', kind: 'buf', pos: { x: 40, y: 40 } },
        { id: 'in3', kind: 'inport', pos: { x: 32, y: 40 }, label: 'in3' },
        { id: 'out2', kind: 'outport', pos: { x: 48, y: 40 }, label: 'out2' },
      ],
      [
        ...base.wires,
        {
          id: 'w7',
          a: { kind: 'pin', component: 'in3', pin: 'y' },
          b: { kind: 'pin', component: 'userbuf', pin: 'a' },
          points: [],
        },
        {
          id: 'w8',
          a: { kind: 'pin', component: 'userbuf', pin: 'y' },
          b: { kind: 'pin', component: 'out2', pin: 'a' },
          points: [],
        },
      ],
    );
    const next = pushOutputAcrossFanout(b, 'n1');
    expect(next).not.toBeNull();
    expect(next!.components.some((c) => c.id === 'userbuf')).toBe(true);
    expect(isEquivalent(b, next!, lib)).toBe(true);
  });
});

describe('spliced NOT rides the wire route (geom.routeWire)', () => {
  it('anchors on the horizontal leg nearest the driver, not the diagonal endpoint midpoint', () => {
    const b = nandBoard();
    // The g1->out wire renders as an L: horizontal leg y=0, then down to out.
    const route = [
      { x: 0, y: 0 },
      { x: 32, y: 0 },
      { x: 32, y: 16 },
    ];
    const mids: { x: number; y: number }[] = [];
    const next = pushOutputAcrossFanout(b, 'g1', {
      grid: 8,
      routeWire: (id) => (id === 'w3' ? route : undefined),
      anchorNot: (mid) => {
        mids.push(mid);
        return mid;
      },
    });
    expect(next).not.toBeNull();
    // Midpoint of the horizontal leg (0,0)-(32,0), never of the L's endpoints.
    expect(mids).toEqual([{ x: 16, y: 0 }]);
  });
});

describe('pushOutputAcrossFanout last-hop stop (identity relocation rejected)', () => {
  it('a lone NOT feeding only a board output never relocates', () => {
    const n1 = withOutputBubble({ id: 'n1', kind: 'buf', pos: { x: 8, y: 0 } }, true);
    const b = board(
      [
        { id: 'in1', kind: 'inport', pos: { x: 0, y: 0 }, label: 'in1' },
        n1,
        { id: 'out', kind: 'outport', pos: { x: 16, y: 0 }, label: 'out' },
      ],
      [
        {
          id: 'w1',
          a: { kind: 'pin', component: 'in1', pin: 'y' },
          b: { kind: 'pin', component: 'n1', pin: 'a' },
          points: [],
        },
        {
          id: 'w2',
          a: { kind: 'pin', component: 'n1', pin: 'y' },
          b: { kind: 'pin', component: 'out', pin: 'a' },
          points: [],
        },
      ],
    );
    const before = JSON.stringify(b);
    expect(pushOutputAcrossFanout(b, 'n1')).toBeNull();
    expect(JSON.stringify(b)).toBe(before);
  });

  it('a lone NOT fanning to 2+ non-gate consumers duplicates per branch (owner rule 2026-07-17)', () => {
    const n1 = withOutputBubble({ id: 'n1', kind: 'buf', pos: { x: 8, y: 8 } }, true);
    const b = board(
      [
        { id: 'in1', kind: 'inport', pos: { x: 0, y: 8 }, label: 'in1' },
        n1,
        { id: 'led1', kind: 'led', pos: { x: 24, y: 0 } },
        { id: 'led2', kind: 'led', pos: { x: 24, y: 16 } },
      ],
      [
        wire('w1', 'in1', 'y', 'n1', 'a'),
        wire('w2', 'n1', 'y', 'led1', 'a'),
        wire('w3', 'n1', 'y', 'led2', 'a'),
      ],
    );
    const next = pushOutputAcrossFanout(b, 'n1');
    expect(next).not.toBeNull();
    // n1 gone (collapsed to a junction), one spliced NOT per LED branch.
    expect(next!.components.find((c) => c.id === 'n1')).toBeUndefined();
    expect(next!.components.filter((c) => c.kind === 'buf').length).toBe(2);
    expect(next!.junctions.length).toBe(1);
  });

  it('a NAND feeding a non-gate still away-pushes (AND + spliced NOT)', () => {
    const b = nandBoard();
    const next = pushOutputAcrossFanout(b, 'g1');
    expect(next).not.toBeNull();
    const g1 = next!.components.find((c) => c.id === 'g1')!;
    expect(g1.kind).toBe('and');
    expect(getOutputBubble(g1)).toBe(false);
    expect(next!.components.length).toBe(b.components.length + 1); // spliced NOT
    expect(isEquivalent(b, next!, lib)).toBe(true);
  });

  it('mixed fan-out (gate + non-gate) still relocates onto both branches', () => {
    const n1 = withOutputBubble({ id: 'n1', kind: 'buf', pos: { x: 8, y: 0 } }, true);
    const b = board(
      [
        { id: 'in1', kind: 'inport', pos: { x: 0, y: 0 }, label: 'in1' },
        { id: 'in2', kind: 'inport', pos: { x: 0, y: 8 }, label: 'in2' },
        n1,
        { id: 'g1', kind: 'and', pos: { x: 16, y: 0 } },
        { id: 'out1', kind: 'outport', pos: { x: 24, y: 0 }, label: 'out1' },
        { id: 'out2', kind: 'outport', pos: { x: 24, y: 8 }, label: 'out2' },
      ],
      [
        {
          id: 'w1',
          a: { kind: 'pin', component: 'in1', pin: 'y' },
          b: { kind: 'pin', component: 'n1', pin: 'a' },
          points: [],
        },
        {
          id: 'w2',
          a: { kind: 'pin', component: 'n1', pin: 'y' },
          b: { kind: 'pin', component: 'g1', pin: 'a' },
          points: [],
        },
        {
          id: 'w3',
          a: { kind: 'pin', component: 'in2', pin: 'y' },
          b: { kind: 'pin', component: 'g1', pin: 'b' },
          points: [],
        },
        {
          id: 'w4',
          a: { kind: 'pin', component: 'g1', pin: 'y' },
          b: { kind: 'pin', component: 'out1', pin: 'a' },
          points: [],
        },
        {
          id: 'w5',
          a: { kind: 'pin', component: 'n1', pin: 'y' },
          b: { kind: 'pin', component: 'out2', pin: 'a' },
          points: [],
        },
      ],
    );
    const next = pushOutputAcrossFanout(b, 'n1');
    expect(next).not.toBeNull();
    expect(next!.components.some((c) => c.id === 'n1')).toBe(false);
    expect(getInputBubbles(next!.components.find((c) => c.id === 'g1')!)).toEqual(new Set(['a']));
    // The non-gate branch got its own spliced NOT.
    expect(next!.components.filter((c) => c.kind === 'buf' && getOutputBubble(c)).length).toBe(1);
    expect(isEquivalent(b, next!, lib)).toBe(true);
  });
});

describe('pushOutputAcrossFanout splices on the consumer last-hop wire (junction paths)', () => {
  it('NAND through a junction to a gate and an LED: bubble + spliced NOT', () => {
    const g1 = withOutputBubble({ id: 'g1', kind: 'and', pos: { x: 8, y: 0 } }, true);
    const b: Board = {
      ...board(
        [
          { id: 'in1', kind: 'inport', pos: { x: 0, y: 0 }, label: 'in1' },
          { id: 'in2', kind: 'inport', pos: { x: 0, y: 8 }, label: 'in2' },
          { id: 'in3', kind: 'inport', pos: { x: 0, y: 16 }, label: 'in3' },
          g1,
          { id: 'g2', kind: 'or', pos: { x: 24, y: 0 } },
          { id: 'led1', kind: 'led', pos: { x: 24, y: 16 } },
          { id: 'out', kind: 'outport', pos: { x: 32, y: 0 }, label: 'out' },
        ],
        [
          {
            id: 'w1',
            a: { kind: 'pin', component: 'in1', pin: 'y' },
            b: { kind: 'pin', component: 'g1', pin: 'a' },
            points: [],
          },
          {
            id: 'w2',
            a: { kind: 'pin', component: 'in2', pin: 'y' },
            b: { kind: 'pin', component: 'g1', pin: 'b' },
            points: [],
          },
          {
            id: 'w3',
            a: { kind: 'pin', component: 'g1', pin: 'y' },
            b: { kind: 'junction', junction: 'j1' },
            points: [],
          },
          {
            id: 'w4',
            a: { kind: 'junction', junction: 'j1' },
            b: { kind: 'pin', component: 'g2', pin: 'a' },
            points: [],
          },
          {
            id: 'w5',
            a: { kind: 'junction', junction: 'j1' },
            b: { kind: 'pin', component: 'led1', pin: 'a' },
            points: [],
          },
          {
            id: 'w6',
            a: { kind: 'pin', component: 'in3', pin: 'y' },
            b: { kind: 'pin', component: 'g2', pin: 'b' },
            points: [],
          },
          {
            id: 'w7',
            a: { kind: 'pin', component: 'g2', pin: 'y' },
            b: { kind: 'pin', component: 'out', pin: 'a' },
            points: [],
          },
        ],
      ),
      junctions: [{ id: 'j1', pos: { x: 16, y: 0 } }],
    };
    const next = pushOutputAcrossFanout(b, 'g1');
    expect(next).not.toBeNull();
    expect(getInputBubbles(next!.components.find((c) => c.id === 'g2')!)).toEqual(new Set(['a']));
    // The LED branch got a NOT spliced into its own last-hop wire (w5).
    const nots = next!.components.filter(
      (c) => c.kind === 'buf' && getOutputBubble(c) && c.id !== 'g1',
    );
    expect(nots).toHaveLength(1);
    const notIn = next!.wires.find(
      (w) =>
        (w.a.kind === 'pin' && w.a.component === nots[0]!.id && w.a.pin === 'a') ||
        (w.b.kind === 'pin' && w.b.component === nots[0]!.id && w.b.pin === 'a'),
    )!;
    const upstream =
      notIn.a.kind === 'pin' && notIn.a.component === nots[0]!.id ? notIn.b : notIn.a;
    expect(upstream.kind).toBe('junction');
    expect(isEquivalent(b, next!, lib)).toBe(true);
  });
});

describe('annihilatePair (explicit, never automatic)', () => {
  // Owner repro: A -> NOT -> NOR.a, B -> NOR.b, NOR -> out. Pushing the NOR's
  // output bubble backward leaves the NOT's output bubble FACING the new
  // input bubble on 'a' -- they must NOT cancel until asked to.
  function notNorBoard(): Board {
    const n1 = withOutputBubble({ id: 'n1', kind: 'buf', pos: { x: 1, y: 0 } }, true);
    const g1 = withOutputBubble({ id: 'g1', kind: 'or', pos: { x: 2, y: 0 } }, true);
    return board(
      [
        { id: 'inA', kind: 'inport', pos: { x: 0, y: 0 }, label: 'inA' },
        { id: 'inB', kind: 'inport', pos: { x: 0, y: 1 }, label: 'inB' },
        n1,
        g1,
        { id: 'out', kind: 'outport', pos: { x: 3, y: 0 }, label: 'out' },
      ],
      [
        {
          id: 'w1',
          a: { kind: 'pin', component: 'inA', pin: 'y' },
          b: { kind: 'pin', component: 'n1', pin: 'a' },
          points: [],
        },
        {
          id: 'w2',
          a: { kind: 'pin', component: 'n1', pin: 'y' },
          b: { kind: 'pin', component: 'g1', pin: 'a' },
          points: [],
        },
        {
          id: 'w3',
          a: { kind: 'pin', component: 'inB', pin: 'y' },
          b: { kind: 'pin', component: 'g1', pin: 'b' },
          points: [],
        },
        {
          id: 'w4',
          a: { kind: 'pin', component: 'g1', pin: 'y' },
          b: { kind: 'pin', component: 'out', pin: 'a' },
          points: [],
        },
      ],
    );
  }

  it('pushes no longer auto-cancel a facing bubble pair', () => {
    const b = notNorBoard();
    const pushed = pushOutputBackward(b, 'g1')!;
    const n1 = pushed.components.find((c) => c.id === 'n1')!;
    const g1 = pushed.components.find((c) => c.id === 'g1')!;
    expect(getOutputBubble(n1)).toBe(true); // NOT keeps its bubble
    expect(getInputBubbles(g1)).toEqual(new Set(['a', 'b'])); // both new bubbles stay
    expect(isEquivalent(b, pushed, lib)).toBe(true);
    // The reverse push is still available -- the state wasn't destroyed.
    expect(pushInputsForward(pushed, 'g1')).not.toBeNull();
  });

  it('explicitly cancels a NOT-vs-input-bubble pair and heals the NOT away', () => {
    const b = notNorBoard();
    const pushed = pushOutputBackward(b, 'g1')!;
    const next = annihilatePair(pushed, 'n1', { component: 'g1', pin: 'a' });
    expect(next).not.toBeNull();
    expect(next!.components.some((c) => c.id === 'n1')).toBe(false); // healed away, not a bare buf
    const g1 = next!.components.find((c) => c.id === 'g1')!;
    expect(getInputBubbles(g1)).toEqual(new Set(['b']));
    // inA now feeds g1.a directly through the healed wire.
    const healed = next!.wires.find(
      (w) =>
        (w.a.kind === 'pin' &&
          w.a.component === 'inA' &&
          w.b.kind === 'pin' &&
          w.b.component === 'g1' &&
          w.b.pin === 'a') ||
        (w.b.kind === 'pin' &&
          w.b.component === 'inA' &&
          w.a.kind === 'pin' &&
          w.a.component === 'g1' &&
          w.a.pin === 'a'),
    );
    expect(healed).toBeDefined();
    expect(isEquivalent(b, next!, lib)).toBe(true);
  });

  it('cancels two inline markers in series, removing both with heal', () => {
    const b = nandBoard();
    const withPair = insertBubblePair(b, 'w3', { x: 0, y: 0 })!;
    const next = annihilatePair(withPair, 'w3__pair0', { component: 'w3__pair1', pin: 'a' });
    expect(next).not.toBeNull();
    expect(next!.components.some((c) => c.id === 'w3__pair0')).toBe(false);
    expect(next!.components.some((c) => c.id === 'w3__pair1')).toBe(false);
    expect(isEquivalent(b, next!, lib)).toBe(true);
  });

  it('returns null when nothing cancels (no facing bubble)', () => {
    const b = notNorBoard(); // g1 has an output bubble, but its input a has none yet
    expect(annihilatePair(b, 'n1', { component: 'g1', pin: 'b' })).toBeNull();
    expect(annihilatePair(b, 'g1', { component: 'out', pin: 'a' })).toBeNull();
  });
});

describe('absorbInverterIntoDriver', () => {
  // in1,in2 -> OR(g1) -> NOT(n1) -> out (the owner's split-NOR shape)
  function orNotBoard(): Board {
    const n1 = withOutputBubble({ id: 'n1', kind: 'buf', pos: { x: 16, y: 0 } }, true);
    return board(
      [
        { id: 'in1', kind: 'inport', pos: { x: 0, y: 0 }, label: 'in1' },
        { id: 'in2', kind: 'inport', pos: { x: 0, y: 8 }, label: 'in2' },
        { id: 'g1', kind: 'or', pos: { x: 8, y: 0 } },
        n1,
        { id: 'out', kind: 'outport', pos: { x: 24, y: 0 }, label: 'out' },
      ],
      [
        {
          id: 'w1',
          a: { kind: 'pin', component: 'in1', pin: 'y' },
          b: { kind: 'pin', component: 'g1', pin: 'a' },
          points: [],
        },
        {
          id: 'w2',
          a: { kind: 'pin', component: 'in2', pin: 'y' },
          b: { kind: 'pin', component: 'g1', pin: 'b' },
          points: [],
        },
        {
          id: 'w3',
          a: { kind: 'pin', component: 'g1', pin: 'y' },
          b: { kind: 'pin', component: 'n1', pin: 'a' },
          points: [],
        },
        {
          id: 'w4',
          a: { kind: 'pin', component: 'n1', pin: 'y' },
          b: { kind: 'pin', component: 'out', pin: 'a' },
          points: [],
        },
      ],
    );
  }

  it('re-forms the NOR: OR gains the bubble, NOT deletes with heal', () => {
    const b = orNotBoard();
    const next = absorbInverterIntoDriver(b, 'n1');
    expect(next).not.toBeNull();
    const g1 = next!.components.find((c) => c.id === 'g1')!;
    expect(g1.kind).toBe('or');
    expect(getOutputBubble(g1)).toBe(true);
    expect(next!.components.some((c) => c.id === 'n1')).toBe(false);
    const healed = next!.wires.find(
      (w) =>
        w.a.kind === 'pin' &&
        w.b.kind === 'pin' &&
        ((w.a.component === 'g1' && w.b.component === 'out') ||
          (w.b.component === 'g1' && w.a.component === 'out')),
    );
    expect(healed).toBeDefined();
    expect(isEquivalent(b, next!, lib)).toBe(true);
  });

  it('accepts the BUF-with-input-bubble inverter form too', () => {
    const base = orNotBoard();
    const b = board(
      base.components.map((c) =>
        c.id === 'n1' ? { ...c, params: { outputBubble: false, inputBubbles: 'a' } } : c,
      ),
      base.wires,
    );
    const next = absorbInverterIntoDriver(b, 'n1');
    expect(next).not.toBeNull();
    expect(getOutputBubble(next!.components.find((c) => c.id === 'g1')!)).toBe(true);
    expect(next!.components.some((c) => c.id === 'n1')).toBe(false);
    expect(isEquivalent(b, next!, lib)).toBe(true);
  });

  it('driver already bubbled: the two inversions annihilate', () => {
    const base = orNotBoard();
    const b = board(
      base.components.map((c) => (c.id === 'g1' ? withOutputBubble(c, true) : c)),
      base.wires,
    );
    const next = absorbInverterIntoDriver(b, 'n1');
    expect(next).not.toBeNull();
    const g1 = next!.components.find((c) => c.id === 'g1')!;
    expect(getOutputBubble(g1)).toBe(false);
    expect(next!.components.some((c) => c.id === 'n1')).toBe(false);
    expect(isEquivalent(b, next!, lib)).toBe(true);
  });

  it('refuses when the inverter is not the sole consumer of its driver', () => {
    const base = orNotBoard();
    const b = board(
      [...base.components, { id: 'led1', kind: 'led', pos: { x: 16, y: 16 } }],
      [
        ...base.wires,
        {
          id: 'w5',
          a: { kind: 'pin', component: 'g1', pin: 'y' },
          b: { kind: 'pin', component: 'led1', pin: 'a' },
          points: [],
        },
      ],
    );
    expect(absorbInverterIntoDriver(b, 'n1')).toBeNull();
  });

  it('refuses a non-inverter component', () => {
    const b = orNotBoard();
    expect(absorbInverterIntoDriver(b, 'g1')).toBeNull();
  });
});

describe('mergeInversionsUpstream', () => {
  // in1 -> NOT(n1) fanning out to both inputs of two NANDs (4 consumer pins).
  function notIntoTwoNands(): Board {
    const n1 = withOutputBubble({ id: 'n1', kind: 'buf', pos: { x: 8, y: 8 } }, true);
    const g1 = withOutputBubble({ id: 'g1', kind: 'and', pos: { x: 24, y: 0 } }, true);
    const g2 = withOutputBubble({ id: 'g2', kind: 'and', pos: { x: 24, y: 16 } }, true);
    const wires: Wire[] = [
      {
        id: 'w0',
        a: { kind: 'pin', component: 'in1', pin: 'y' },
        b: { kind: 'pin', component: 'n1', pin: 'a' },
        points: [],
      },
    ];
    let n = 1;
    for (const [comp, pin] of [
      ['g1', 'a'],
      ['g1', 'b'],
      ['g2', 'a'],
      ['g2', 'b'],
    ] as const) {
      wires.push({
        id: `w${n++}`,
        a: { kind: 'pin', component: 'n1', pin: 'y' },
        b: { kind: 'pin', component: comp, pin },
        points: [],
      });
    }
    wires.push(
      {
        id: 'w9',
        a: { kind: 'pin', component: 'g1', pin: 'y' },
        b: { kind: 'pin', component: 'out1', pin: 'a' },
        points: [],
      },
      {
        id: 'w10',
        a: { kind: 'pin', component: 'g2', pin: 'y' },
        b: { kind: 'pin', component: 'out2', pin: 'a' },
        points: [],
      },
    );
    return board(
      [
        { id: 'in1', kind: 'inport', pos: { x: 0, y: 8 }, label: 'in1' },
        n1,
        g1,
        g2,
        { id: 'out1', kind: 'outport', pos: { x: 32, y: 0 }, label: 'out1' },
        { id: 'out2', kind: 'outport', pos: { x: 32, y: 16 }, label: 'out2' },
      ],
      wires,
    );
  }

  it('round-trips the owner repro: 4 bubbles + junction merge back into one NOT', () => {
    const b = notIntoTwoNands();
    const pushed = pushOutputAcrossFanout(b, 'n1')!;
    expect(pushed).not.toBeNull();
    expect(pushed.junctions).toHaveLength(1); // NOT collapsed to a junction
    expect(pushed.components.some((c) => c.id === 'n1')).toBe(false);
    expect(isEquivalent(b, pushed, lib)).toBe(true);

    const merged = mergeInversionsUpstream(pushed, { component: 'g1', pin: 'a' });
    expect(merged).not.toBeNull();
    // All four input bubbles gone, one NOT re-formed, junction kept.
    for (const id of ['g1', 'g2'])
      expect(getInputBubbles(merged!.components.find((c) => c.id === id)!).size).toBe(0);
    const nots = merged!.components.filter((c) => c.kind === 'buf' && getOutputBubble(c));
    expect(nots).toHaveLength(1);
    expect(merged!.junctions).toHaveLength(1);
    expect(isEquivalent(b, merged!, lib)).toBe(true);
  });

  it('flips an unmatched sibling branch instead of rejecting (owner rule 2026-07-17)', () => {
    const b = notIntoTwoNands();
    const pushed = pushOutputAcrossFanout(b, 'n1')!;
    // Clear one of the four bubbles: the merge must flip that branch back
    // on (gains a bubble) while consuming the other three, staying legal.
    const partial = board(
      pushed.components.map((c) =>
        c.id === 'g2' ? { ...c, params: { ...c.params, inputBubbles: 'a' } } : c,
      ),
      pushed.wires,
    );
    const partialBoard: Board = { ...partial, junctions: pushed.junctions };
    const merged = mergeInversionsUpstream(partialBoard, { component: 'g1', pin: 'a' });
    expect(merged).not.toBeNull();
    expect(isEquivalent(partialBoard, merged!, lib)).toBe(true);
    const g1 = merged!.components.find((c) => c.id === 'g1')!;
    const g2 = merged!.components.find((c) => c.id === 'g2')!;
    expect(getInputBubbles(g1).size).toBe(0);
    expect(getInputBubbles(g2).has('b')).toBe(true);
    expect(getInputBubbles(g2).has('a')).toBe(false);
    // The naive ghost (consume dragged only, no sibling flips) stays broken.
    const naive = mergeInversionsUpstreamNaive(partialBoard, { component: 'g1', pin: 'a' });
    expect(naive).not.toBeNull();
    expect(isEquivalent(partialBoard, naive!, lib)).toBe(false);
  });

  it('cancels into an already-inverted driver, flipping every branch', () => {
    // nand1 fans out to g1.a (bubbled) and g2.a (plain): pulling g1's bubble
    // back clears the NAND to AND, consumes g1.a, and bubbles g2.a.
    const nand = withOutputBubble({ id: 'nd', kind: 'and', pos: { x: 8, y: 8 } }, true);
    const b: Board = {
      ...board(
        [
          { id: 'ia', kind: 'inport', pos: { x: 0, y: 0 }, label: 'ia' },
          { id: 'ib', kind: 'inport', pos: { x: 0, y: 16 }, label: 'ib' },
          { id: 'ic', kind: 'inport', pos: { x: 0, y: 32 }, label: 'ic' },
          nand,
          withInputBubble({ id: 'g1', kind: 'and', pos: { x: 24, y: 0 } }, 'a', true),
          { id: 'g2', kind: 'and', pos: { x: 24, y: 16 } },
          { id: 'o1', kind: 'outport', pos: { x: 40, y: 0 }, label: 'o1' },
          { id: 'o2', kind: 'outport', pos: { x: 40, y: 16 }, label: 'o2' },
        ],
        [
          wire('wa', 'ia', 'y', 'nd', 'a'),
          wire('wb', 'ib', 'y', 'nd', 'b'),
          {
            id: 'wj',
            a: { kind: 'pin', component: 'nd', pin: 'y' },
            b: { kind: 'junction', junction: 'j1' },
            points: [],
          },
          {
            id: 'wj1',
            a: { kind: 'junction', junction: 'j1' },
            b: { kind: 'pin', component: 'g1', pin: 'a' },
            points: [],
          },
          {
            id: 'wj2',
            a: { kind: 'junction', junction: 'j1' },
            b: { kind: 'pin', component: 'g2', pin: 'a' },
            points: [],
          },
          wire('wc', 'ic', 'y', 'g1', 'b'),
          {
            id: 'wc2',
            a: { kind: 'pin', component: 'ic', pin: 'y' },
            b: { kind: 'pin', component: 'g2', pin: 'b' },
            points: [],
          },
          wire('wo1', 'g1', 'y', 'o1', 'a'),
          wire('wo2', 'g2', 'y', 'o2', 'a'),
        ],
      ),
      junctions: [{ id: 'j1', pos: { x: 20, y: 8 } }],
    };
    const merged = mergeInversionsUpstream(b, { component: 'g1', pin: 'a' });
    expect(merged).not.toBeNull();
    expect(isEquivalent(b, merged!, lib)).toBe(true);
    const nd = merged!.components.find((c) => c.id === 'nd')!;
    expect(getOutputBubble(normalizeGateComponent(nd))).toBe(false);
    expect(getInputBubbles(merged!.components.find((c) => c.id === 'g1')!).has('a')).toBe(false);
    expect(getInputBubbles(merged!.components.find((c) => c.id === 'g2')!).has('a')).toBe(true);
    // Cancel case: no new NOT spliced.
    expect(merged!.components.filter((c) => c.kind === 'buf').length).toBe(0);
  });

  it('merges standalone-NOT branches (fan-out to LEDs through a junction)', () => {
    // Split state built directly: in1 -> j1, j1 -> NOT -> led on each branch.
    const na = withOutputBubble({ id: 'na', kind: 'buf', pos: { x: 16, y: 0 } }, true);
    const nb = withOutputBubble({ id: 'nb', kind: 'buf', pos: { x: 16, y: 16 } }, true);
    const b: Board = {
      ...board(
        [
          { id: 'in1', kind: 'inport', pos: { x: 0, y: 8 }, label: 'in1' },
          na,
          nb,
          { id: 'led1', kind: 'led', pos: { x: 24, y: 0 } },
          { id: 'led2', kind: 'led', pos: { x: 24, y: 16 } },
        ],
        [
          {
            id: 'w0',
            a: { kind: 'pin', component: 'in1', pin: 'y' },
            b: { kind: 'junction', junction: 'j1' },
            points: [],
          },
          {
            id: 'w1',
            a: { kind: 'junction', junction: 'j1' },
            b: { kind: 'pin', component: 'na', pin: 'a' },
            points: [],
          },
          {
            id: 'w2',
            a: { kind: 'junction', junction: 'j1' },
            b: { kind: 'pin', component: 'nb', pin: 'a' },
            points: [],
          },
          {
            id: 'w3',
            a: { kind: 'pin', component: 'na', pin: 'y' },
            b: { kind: 'pin', component: 'led1', pin: 'a' },
            points: [],
          },
          {
            id: 'w4',
            a: { kind: 'pin', component: 'nb', pin: 'y' },
            b: { kind: 'pin', component: 'led2', pin: 'a' },
            points: [],
          },
        ],
      ),
      junctions: [{ id: 'j1', pos: { x: 8, y: 8 } }],
    };
    const merged = mergeInversionsUpstream(b, { inverter: 'na' });
    expect(merged).not.toBeNull();
    const nots = merged!.components.filter((c) => c.kind === 'buf' && getOutputBubble(c));
    expect(nots).toHaveLength(1);
    expect(merged!.components.some((c) => c.id === 'na' || c.id === 'nb')).toBe(false);
    expect(merged!.junctions).toHaveLength(1); // junction stays, now fans out inverted signal
    expect(isEquivalent(b, merged!, lib)).toBe(true);
  });
});

describe('insertBubblePair', () => {
  it('is always legal and equivalence-preserving (self-cancelling)', () => {
    const b = nandBoard();
    const next = insertBubblePair(b, 'w3', { x: 0, y: 0 });
    expect(next).not.toBeNull();
    expect(isEquivalent(b, next!, lib)).toBe(true);
  });
});

describe('annihilatePair fan-out guard', () => {
  it('refuses to cancel a bubbled driver against one branch of its fan-out', () => {
    // NOT n1 fans out to g1.a (bubbled) and g2.a (bubbled): cancelling n1
    // against g1 alone would strand g2's inversion.
    const n1 = withOutputBubble({ id: 'n1', kind: 'buf', pos: { x: 8, y: 8 } }, true);
    const b = board(
      [
        { id: 'in1', kind: 'inport', pos: { x: 0, y: 8 }, label: 'in1' },
        { id: 'in2', kind: 'inport', pos: { x: 0, y: 24 }, label: 'in2' },
        n1,
        withInputBubble({ id: 'g1', kind: 'and', pos: { x: 24, y: 0 } }, 'a', true),
        withInputBubble({ id: 'g2', kind: 'and', pos: { x: 24, y: 16 } }, 'a', true),
        { id: 'o1', kind: 'outport', pos: { x: 40, y: 0 }, label: 'o1' },
        { id: 'o2', kind: 'outport', pos: { x: 40, y: 16 }, label: 'o2' },
      ],
      [
        wire('w1', 'in1', 'y', 'n1', 'a'),
        wire('w2', 'n1', 'y', 'g1', 'a'),
        wire('w3', 'n1', 'y', 'g2', 'a'),
        wire('w4', 'in2', 'y', 'g1', 'b'),
        wire('w5', 'in2', 'y', 'g2', 'b'),
        wire('w6', 'g1', 'y', 'o1', 'a'),
        wire('w7', 'g2', 'y', 'o2', 'a'),
      ],
    );
    expect(annihilatePair(b, 'n1', { component: 'g1', pin: 'a' })).toBeNull();
    // The whole-net merge is the legal gesture there instead.
    const merged = mergeInversionsUpstream(b, { component: 'g1', pin: 'a' });
    expect(merged).not.toBeNull();
    expect(isEquivalent(b, merged!, lib)).toBe(true);
    // Both bubbles consumed, n1 cancelled and healed away.
    expect(merged!.components.find((c) => c.id === 'n1')).toBeUndefined();
    expect(getInputBubbles(merged!.components.find((c) => c.id === 'g1')!).size).toBe(0);
    expect(getInputBubbles(merged!.components.find((c) => c.id === 'g2')!).size).toBe(0);
  });
});

describe('materializeInputBubble', () => {
  it('re-materializes a gate input bubble as a NOT on its own wire', () => {
    const b = board(
      [
        { id: 'in1', kind: 'inport', pos: { x: 0, y: 0 }, label: 'in1' },
        { id: 'in2', kind: 'inport', pos: { x: 0, y: 16 }, label: 'in2' },
        withInputBubble({ id: 'g1', kind: 'and', pos: { x: 16, y: 0 } }, 'a', true),
        { id: 'out', kind: 'outport', pos: { x: 32, y: 0 }, label: 'out' },
      ],
      [
        wire('w1', 'in1', 'y', 'g1', 'a'),
        wire('w2', 'in2', 'y', 'g1', 'b'),
        wire('w3', 'g1', 'y', 'out', 'a'),
      ],
    );
    const next = materializeInputBubble(b, { component: 'g1', pin: 'a' });
    expect(next).not.toBeNull();
    expect(isEquivalent(b, next!, lib)).toBe(true);
    expect(getInputBubbles(next!.components.find((c) => c.id === 'g1')!).size).toBe(0);
    const nots = next!.components.filter((c) => c.kind === 'buf');
    expect(nots.length).toBe(1);
    expect(getOutputBubble(nots[0]!)).toBe(true);
  });

  it("refuses a BUF's own input bubble (already a standalone inverter)", () => {
    const bufIB = withInputBubble({ id: 'n1', kind: 'buf', pos: { x: 8, y: 0 } }, 'a', true);
    const b = board(
      [
        { id: 'in1', kind: 'inport', pos: { x: 0, y: 0 }, label: 'in1' },
        bufIB,
        { id: 'out', kind: 'outport', pos: { x: 16, y: 0 }, label: 'out' },
      ],
      [wire('w1', 'in1', 'y', 'n1', 'a'), wire('w2', 'n1', 'y', 'out', 'a')],
    );
    expect(materializeInputBubble(b, { component: 'n1', pin: 'a' })).toBeNull();
  });
});

describe('mergeInversionsUpstream cleanup and identity', () => {
  it('heals a consumed BUF-with-input-bubble branch (no bare BUF left)', () => {
    const bufIB = withInputBubble({ id: 'nb', kind: 'buf', pos: { x: 16, y: 16 } }, 'a', true);
    const b = board(
      [
        { id: 'in1', kind: 'inport', pos: { x: 0, y: 8 }, label: 'in1' },
        withInputBubble({ id: 'g1', kind: 'and', pos: { x: 16, y: 0 } }, 'a', true),
        bufIB,
        { id: 'in2', kind: 'inport', pos: { x: 0, y: 24 }, label: 'in2' },
        { id: 'o1', kind: 'outport', pos: { x: 32, y: 0 }, label: 'o1' },
        { id: 'o2', kind: 'outport', pos: { x: 32, y: 16 }, label: 'o2' },
      ],
      [
        wire('w1', 'in1', 'y', 'g1', 'a'),
        wire('w2', 'in1', 'y', 'nb', 'a'),
        wire('w3', 'in2', 'y', 'g1', 'b'),
        wire('w4', 'g1', 'y', 'o1', 'a'),
        wire('w5', 'nb', 'y', 'o2', 'a'),
      ],
    );
    const merged = mergeInversionsUpstream(b, { component: 'nb', pin: 'a' });
    expect(merged).not.toBeNull();
    expect(isEquivalent(b, merged!, lib)).toBe(true);
    // nb consumed and healed away; only the one new merge NOT remains a buf.
    expect(merged!.components.find((c) => c.id === 'nb')).toBeUndefined();
    const bufs = merged!.components.filter((c) => c.kind === 'buf');
    expect(bufs.length).toBe(1);
    expect(getOutputBubble(bufs[0]!)).toBe(true);
  });

  it('rejects a pure relocation (lone inverter toward an uninverted driver)', () => {
    const n1 = withOutputBubble({ id: 'n1', kind: 'buf', pos: { x: 8, y: 0 } }, true);
    const b = board(
      [
        { id: 'in1', kind: 'inport', pos: { x: 0, y: 0 }, label: 'in1' },
        n1,
        { id: 'out', kind: 'outport', pos: { x: 16, y: 0 }, label: 'out' },
      ],
      [wire('w1', 'in1', 'y', 'n1', 'a'), wire('w2', 'n1', 'y', 'out', 'a')],
    );
    expect(mergeInversionsUpstream(b, { inverter: 'n1' })).toBeNull();
  });
});

describe('owner repro: NOT driving both inputs of one AND, one pre-bubbled', () => {
  function mixedBoard(): Board {
    const n1 = withOutputBubble({ id: 'n1', kind: 'buf', pos: { x: 8, y: 8 } }, true);
    return board(
      [
        { id: 'in1', kind: 'inport', pos: { x: 0, y: 8 }, label: 'in1' },
        n1,
        withInputBubble({ id: 'g1', kind: 'and', pos: { x: 24, y: 0 } }, 'b', true),
        { id: 'out', kind: 'outport', pos: { x: 40, y: 0 }, label: 'out' },
      ],
      [
        wire('w1', 'in1', 'y', 'n1', 'a'),
        wire('w2', 'n1', 'y', 'g1', 'a'),
        wire('w3', 'n1', 'y', 'g1', 'b'),
        wire('w4', 'g1', 'y', 'out', 'a'),
      ],
    );
  }

  it('forward push flips both pins and removes the NOT (junction at old pin)', () => {
    const b = mixedBoard();
    const next = pushOutputAcrossFanout(b, 'n1');
    expect(next).not.toBeNull();
    expect(isEquivalent(b, next!, lib)).toBe(true);
    const g1 = next!.components.find((c) => c.id === 'g1')!;
    expect(getInputBubbles(g1)).toEqual(new Set(['a']));
    expect(next!.components.find((c) => c.id === 'n1')).toBeUndefined();
  });

  it('backward merge (dragging the bubbled pin) cancels into the NOT and removes it', () => {
    const b = mixedBoard();
    const merged = mergeInversionsUpstream(b, { component: 'g1', pin: 'b' });
    expect(merged).not.toBeNull();
    expect(isEquivalent(b, merged!, lib)).toBe(true);
    const g1 = merged!.components.find((c) => c.id === 'g1')!;
    expect(getInputBubbles(g1)).toEqual(new Set(['a']));
    expect(merged!.components.find((c) => c.id === 'n1')).toBeUndefined();
  });
});

describe('owner repro variant: same board through a junction', () => {
  function mixedJunctionBoard(): Board {
    const n1 = withOutputBubble({ id: 'n1', kind: 'buf', pos: { x: 8, y: 8 } }, true);
    return {
      ...board(
        [
          { id: 'in1', kind: 'inport', pos: { x: 0, y: 8 }, label: 'in1' },
          n1,
          withInputBubble({ id: 'g1', kind: 'and', pos: { x: 24, y: 0 } }, 'b', true),
          { id: 'out', kind: 'outport', pos: { x: 40, y: 0 }, label: 'out' },
        ],
        [
          wire('w1', 'in1', 'y', 'n1', 'a'),
          {
            id: 'w2',
            a: { kind: 'pin', component: 'n1', pin: 'y' },
            b: { kind: 'junction', junction: 'j1' },
            points: [],
          },
          {
            id: 'w3',
            a: { kind: 'junction', junction: 'j1' },
            b: { kind: 'pin', component: 'g1', pin: 'a' },
            points: [],
          },
          {
            id: 'w4',
            a: { kind: 'junction', junction: 'j1' },
            b: { kind: 'pin', component: 'g1', pin: 'b' },
            points: [],
          },
          wire('w5', 'g1', 'y', 'out', 'a'),
        ],
      ),
      junctions: [{ id: 'j1', pos: { x: 20, y: 8 } }],
    };
  }

  it('forward push removes the NOT (junction kept)', () => {
    const b = mixedJunctionBoard();
    const next = pushOutputAcrossFanout(b, 'n1');
    expect(next).not.toBeNull();
    expect(isEquivalent(b, next!, lib)).toBe(true);
    expect(getInputBubbles(next!.components.find((c) => c.id === 'g1')!)).toEqual(new Set(['a']));
    expect(next!.components.find((c) => c.id === 'n1')).toBeUndefined();
  });

  it('backward merge cancels into the NOT and removes it', () => {
    const b = mixedJunctionBoard();
    const merged = mergeInversionsUpstream(b, { component: 'g1', pin: 'b' });
    expect(merged).not.toBeNull();
    expect(isEquivalent(b, merged!, lib)).toBe(true);
    expect(merged!.components.find((c) => c.id === 'n1')).toBeUndefined();
  });
});

describe('input-bubble-form inverter as driver (owner repro 2026-07-17b)', () => {
  it('merge cancels into an input-bubble BUF driver instead of splicing a new NOT', () => {
    // switch -> n1 (buf, bubble on its own input) -> g1.a and g1.b, b bubbled.
    const n1 = withInputBubble({ id: 'n1', kind: 'buf', pos: { x: 8, y: 8 } }, 'a', true);
    const b = board(
      [
        { id: 'in1', kind: 'inport', pos: { x: 0, y: 8 }, label: 'in1' },
        n1,
        withInputBubble({ id: 'g1', kind: 'and', pos: { x: 24, y: 0 } }, 'b', true),
        { id: 'out', kind: 'outport', pos: { x: 40, y: 0 }, label: 'out' },
      ],
      [
        wire('w1', 'in1', 'y', 'n1', 'a'),
        wire('w2', 'n1', 'y', 'g1', 'a'),
        wire('w3', 'n1', 'y', 'g1', 'b'),
        wire('w4', 'g1', 'y', 'out', 'a'),
      ],
    );
    const merged = mergeInversionsUpstream(b, { component: 'g1', pin: 'b' });
    expect(merged).not.toBeNull();
    expect(isEquivalent(b, merged!, lib)).toBe(true);
    expect(getInputBubbles(merged!.components.find((c) => c.id === 'g1')!)).toEqual(new Set(['a']));
    // The inversion cancelled into n1; no inverter of any form remains.
    expect(merged!.components.find((c) => c.id === 'n1')).toBeUndefined();
    expect(merged!.components.filter((c) => c.kind === 'buf').length).toBe(0);
  });

  it('rejects relocating an input-bubble BUF toward its uninverted driver (identity)', () => {
    const n1 = withInputBubble({ id: 'n1', kind: 'buf', pos: { x: 8, y: 0 } }, 'a', true);
    const b = board(
      [
        { id: 'in1', kind: 'inport', pos: { x: 0, y: 0 }, label: 'in1' },
        n1,
        { id: 'out', kind: 'outport', pos: { x: 16, y: 0 }, label: 'out' },
      ],
      [wire('w1', 'in1', 'y', 'n1', 'a'), wire('w2', 'n1', 'y', 'out', 'a')],
    );
    expect(mergeInversionsUpstream(b, { component: 'n1', pin: 'a' })).toBeNull();
    expect(mergeInversionsUpstream(b, { inverter: 'n1' })).toBeNull();
  });
});

describe('input-bubble-form inverter pushes forward like a NOT (owner 2026-07-17c)', () => {
  it('relocates its inversion across fan-out and cleans itself up', () => {
    const n1 = withInputBubble({ id: 'n1', kind: 'buf', pos: { x: 8, y: 8 } }, 'a', true);
    const b = board(
      [
        { id: 'in1', kind: 'inport', pos: { x: 0, y: 8 }, label: 'in1' },
        { id: 'in2', kind: 'inport', pos: { x: 0, y: 24 }, label: 'in2' },
        n1,
        { id: 'g1', kind: 'and', pos: { x: 24, y: 0 } },
        { id: 'g2', kind: 'and', pos: { x: 24, y: 16 } },
        { id: 'o1', kind: 'outport', pos: { x: 40, y: 0 }, label: 'o1' },
        { id: 'o2', kind: 'outport', pos: { x: 40, y: 16 }, label: 'o2' },
      ],
      [
        wire('w1', 'in1', 'y', 'n1', 'a'),
        wire('w2', 'n1', 'y', 'g1', 'a'),
        wire('w3', 'n1', 'y', 'g2', 'a'),
        wire('w4', 'in2', 'y', 'g1', 'b'),
        wire('w5', 'in2', 'y', 'g2', 'b'),
        wire('w6', 'g1', 'y', 'o1', 'a'),
        wire('w7', 'g2', 'y', 'o2', 'a'),
      ],
    );
    const next = pushOutputAcrossFanout(b, 'n1');
    expect(next).not.toBeNull();
    expect(isEquivalent(b, next!, lib)).toBe(true);
    expect(getInputBubbles(next!.components.find((c) => c.id === 'g1')!)).toEqual(new Set(['a']));
    expect(getInputBubbles(next!.components.find((c) => c.id === 'g2')!)).toEqual(new Set(['a']));
    expect(next!.components.find((c) => c.id === 'n1')).toBeUndefined();
  });

  it('still rejects the single non-gate consumer identity in input form', () => {
    const n1 = withInputBubble({ id: 'n1', kind: 'buf', pos: { x: 8, y: 0 } }, 'a', true);
    const b = board(
      [
        { id: 'in1', kind: 'inport', pos: { x: 0, y: 0 }, label: 'in1' },
        n1,
        { id: 'led1', kind: 'led', pos: { x: 16, y: 0 } },
      ],
      [wire('w1', 'in1', 'y', 'n1', 'a'), wire('w2', 'n1', 'y', 'led1', 'a')],
    );
    expect(pushOutputAcrossFanout(b, 'n1')).toBeNull();
  });
});

describe('push onto a downstream inverter (owner 2026-07-17c)', () => {
  function chain(consumerParams: (c: Component) => Component): Board {
    const n0 = withOutputBubble({ id: 'n0', kind: 'buf', pos: { x: 8, y: 0 } }, true);
    const n1 = consumerParams({ id: 'n1', kind: 'buf', pos: { x: 24, y: 0 } });
    return board(
      [
        { id: 'in1', kind: 'inport', pos: { x: 0, y: 0 }, label: 'in1' },
        n0,
        n1,
        { id: 'out', kind: 'outport', pos: { x: 40, y: 0 }, label: 'out' },
      ],
      [
        wire('w1', 'in1', 'y', 'n0', 'a'),
        wire('w2', 'n0', 'y', 'n1', 'a'),
        wire('w3', 'n1', 'y', 'out', 'a'),
      ],
    );
  }

  it('cancels a BUF-with-input-bubble consumer whole (no BUF left)', () => {
    const b = chain((c) => withInputBubble(c, 'a', true));
    const next = pushOutputAcrossFanout(b, 'n0');
    expect(next).not.toBeNull();
    expect(isEquivalent(b, next!, lib)).toBe(true);
    expect(next!.components.filter((c) => c.kind === 'buf').length).toBe(0);
  });

  it('a NOT consumer gains an input bubble (draggable ¬¬, no auto-cancel)', () => {
    const b = chain((c) => withOutputBubble(c, true));
    const next = pushOutputAcrossFanout(b, 'n0');
    expect(next).not.toBeNull();
    expect(isEquivalent(b, next!, lib)).toBe(true);
    const n1 = next!.components.find((c) => c.id === 'n1')!;
    expect(getOutputBubble(n1)).toBe(true);
    expect(getInputBubbles(n1)).toEqual(new Set(['a']));
    expect(next!.components.find((c) => c.id === 'n0')).toBeUndefined();
  });
});

describe('splitDoubleInverter (N on a ¬¬ buf)', () => {
  it('splits into two chained bare markers, equivalence kept', () => {
    const dbl = withInputBubble(
      withOutputBubble({ id: 'n1', kind: 'buf', pos: { x: 8, y: 0 } }, true),
      'a',
      true,
    );
    const b = board(
      [
        { id: 'in1', kind: 'inport', pos: { x: 0, y: 0 }, label: 'in1' },
        dbl,
        { id: 'out', kind: 'outport', pos: { x: 24, y: 0 }, label: 'out' },
      ],
      [wire('w1', 'in1', 'y', 'n1', 'a'), wire('w2', 'n1', 'y', 'out', 'a')],
    );
    const next = splitDoubleInverter(b, 'n1');
    expect(next).not.toBeNull();
    expect(isEquivalent(b, next!, lib)).toBe(true);
    expect(next!.components.find((c) => c.id === 'n1')).toBeUndefined();
    const markers = next!.components.filter(
      (c) => c.kind === 'buf' && c.params?.['bubbleOnly'] === true,
    );
    expect(markers.length).toBe(2);
    for (const m of markers) {
      expect(getOutputBubble(m)).toBe(true);
      expect(getInputBubbles(m).size).toBe(0);
    }
  });

  it('refuses a single-inversion buf', () => {
    const n1 = withOutputBubble({ id: 'n1', kind: 'buf', pos: { x: 8, y: 0 } }, true);
    const b = board(
      [
        { id: 'in1', kind: 'inport', pos: { x: 0, y: 0 }, label: 'in1' },
        n1,
        { id: 'out', kind: 'outport', pos: { x: 16, y: 0 }, label: 'out' },
      ],
      [wire('w1', 'in1', 'y', 'n1', 'a'), wire('w2', 'n1', 'y', 'out', 'a')],
    );
    expect(splitDoubleInverter(b, 'n1')).toBeNull();
  });
});

describe('immediate cancellation rule (owner 2026-07-17d)', () => {
  const chainBoard = (mk1: (c: Component) => Component, mk2: (c: Component) => Component): Board =>
    board(
      [
        { id: 'in1', kind: 'inport', pos: { x: 0, y: 0 }, label: 'in1' },
        mk1({ id: 'n1', kind: 'buf', pos: { x: 8, y: 0 } }),
        mk2({ id: 'n2', kind: 'buf', pos: { x: 24, y: 0 } }),
        { id: 'out', kind: 'outport', pos: { x: 40, y: 0 }, label: 'out' },
      ],
      [
        wire('w1', 'in1', 'y', 'n1', 'a'),
        wire('w2', 'n1', 'y', 'n2', 'a'),
        wire('w3', 'n2', 'y', 'out', 'a'),
      ],
    );
  const asNot = (c: Component) => withOutputBubble(c, true);
  const asInputForm = (c: Component) => withInputBubble(c, 'a', true);
  const asMarker = (c: Component) => ({
    ...withOutputBubble(c, true),
    params: { ...c.params, outputBubble: true, bubbleOnly: true },
  });

  it('pushOutputBackward through a double-bubbled buf cancels it whole', () => {
    const dbl = withInputBubble(
      withOutputBubble({ id: 'n1', kind: 'buf', pos: { x: 8, y: 0 } }, true),
      'a',
      true,
    );
    const b = board(
      [
        { id: 'in1', kind: 'inport', pos: { x: 0, y: 0 }, label: 'in1' },
        dbl,
        { id: 'out', kind: 'outport', pos: { x: 16, y: 0 }, label: 'out' },
      ],
      [wire('w1', 'in1', 'y', 'n1', 'a'), wire('w2', 'n1', 'y', 'out', 'a')],
    );
    const back = pushOutputBackward(b, 'n1');
    expect(back).not.toBeNull();
    expect(isEquivalent(b, back!, lib)).toBe(true);
    expect(back!.components.find((c) => c.id === 'n1')).toBeUndefined();
    const fwd = pushInputsForward(b, 'n1');
    expect(fwd).not.toBeNull();
    expect(fwd!.components.find((c) => c.id === 'n1')).toBeUndefined();
  });

  it('absorb into a NOT driver removes BOTH inverters (no BUF left)', () => {
    const b = chainBoard(asNot, asNot);
    const next = absorbInverterIntoDriver(b, 'n2');
    expect(next).not.toBeNull();
    expect(isEquivalent(b, next!, lib)).toBe(true);
    expect(next!.components.filter((c) => c.kind === 'buf').length).toBe(0);
  });

  it('absorb into an input-form buf driver removes both too', () => {
    const b = chainBoard(asInputForm, asNot);
    const next = absorbInverterIntoDriver(b, 'n2');
    expect(next).not.toBeNull();
    expect(isEquivalent(b, next!, lib)).toBe(true);
    expect(next!.components.filter((c) => c.kind === 'buf').length).toBe(0);
  });

  it('absorb of a marker into a marker driver cancels the pair', () => {
    const b = chainBoard(asMarker, asMarker);
    const next = absorbInverterIntoDriver(b, 'n2');
    expect(next).not.toBeNull();
    expect(isEquivalent(b, next!, lib)).toBe(true);
    expect(next!.components.filter((c) => c.kind === 'buf').length).toBe(0);
  });

  it('forward push onto a bare marker cancels it whole (no staged ¬¬)', () => {
    const b = chainBoard(asNot, asMarker);
    const next = pushOutputAcrossFanout(b, 'n1');
    expect(next).not.toBeNull();
    expect(isEquivalent(b, next!, lib)).toBe(true);
    expect(next!.components.filter((c) => c.kind === 'buf').length).toBe(0);
  });

  it('forward push onto a full NOT still stages the visible ¬¬ (the one exception)', () => {
    const b = chainBoard(asNot, asNot);
    const next = pushOutputAcrossFanout(b, 'n1');
    expect(next).not.toBeNull();
    expect(isEquivalent(b, next!, lib)).toBe(true);
    const n2 = next!.components.find((c) => c.id === 'n2')!;
    expect(getOutputBubble(n2)).toBe(true);
    expect(getInputBubbles(n2)).toEqual(new Set(['a']));
  });
});

// M6.6 follow-up: width>1 gates keep their data-bit lanes (Phase 2) but
// refuse the bubble-push interaction individually -- never a whole-board
// block (that lives at the UI/store entry point, not here).
describe('width>1 gates refuse bubble-push per-gate', () => {
  it('pushOutputBackward refuses directly on a wide gate', () => {
    const b = nandBoard();
    const wide: Board = {
      ...b,
      components: b.components.map((c) =>
        c.id === 'g1' ? { ...c, params: { ...c.params, width: 4 } } : c,
      ),
    };
    expect(pushOutputBackward(wide, 'g1')).toBeNull();
    // The same move on the 1-bit original still works (not a global break).
    expect(pushOutputBackward(b, 'g1')).not.toBeNull();
  });

  it('pushOutputAcrossFanout refuses when the wide gate is the consumer', () => {
    // out2 is a second gate consumer of g1's output; widen it to 4 bits.
    const g1 = withOutputBubble({ id: 'g1', kind: 'and', pos: { x: 0, y: 0 } }, true);
    const g2: Component = { id: 'g2', kind: 'buf', pos: { x: 0, y: 0 }, params: { width: 4 } };
    const b = board(
      [
        { id: 'in1', kind: 'inport', pos: { x: 0, y: 0 }, label: 'in1' },
        { id: 'in2', kind: 'inport', pos: { x: 0, y: 0 }, label: 'in2' },
        g1,
        g2,
      ],
      [
        wire('w1', 'in1', 'y', 'g1', 'a'),
        wire('w2', 'in2', 'y', 'g1', 'b'),
        wire('w3', 'g1', 'y', 'g2', 'a'),
      ],
    );
    expect(pushOutputAcrossFanout(b, 'g1')).toBeNull();
  });

  it('absorbInverterIntoDriver refuses when the driver is wide', () => {
    const driver: Component = { id: 'g1', kind: 'and', pos: { x: 0, y: 0 }, params: { width: 4 } };
    const inv = withOutputBubble({ id: 'n1', kind: 'buf', pos: { x: 0, y: 0 } }, true);
    const b = board(
      [
        { id: 'in1', kind: 'inport', pos: { x: 0, y: 0 }, label: 'in1' },
        { id: 'in2', kind: 'inport', pos: { x: 0, y: 0 }, label: 'in2' },
        driver,
        inv,
        { id: 'out', kind: 'outport', pos: { x: 0, y: 0 }, label: 'out' },
      ],
      [
        wire('w1', 'in1', 'y', 'g1', 'a'),
        wire('w2', 'in2', 'y', 'g1', 'b'),
        wire('w3', 'g1', 'y', 'n1', 'a'),
        wire('w4', 'n1', 'y', 'out', 'a'),
      ],
    );
    expect(absorbInverterIntoDriver(b, 'n1')).toBeNull();
  });
});
