import { describe, expect, it } from 'vitest';
import type { Circuit, Component, Wire, WireEnd } from '../model/types';
import { connectedPins, netPins, netWireIds } from './netGraph';

describe('connectedPins', () => {
  it('finds a directly wired pin', () => {
    const circuit: Circuit = {
      components: [],
      junctions: [],
      wires: [
        {
          id: 'w1',
          a: { kind: 'pin', component: 'a', pin: 'y' },
          b: { kind: 'pin', component: 'b', pin: 'x' },
          points: [],
        },
      ],
    };
    expect(connectedPins(circuit, { component: 'a', pin: 'y' })).toEqual([
      { component: 'b', pin: 'x' },
    ]);
  });

  it('crosses a junction to reach a transitively-connected pin', () => {
    const circuit: Circuit = {
      components: [],
      junctions: [{ id: 'j1', pos: { x: 0, y: 0 } }],
      wires: [
        {
          id: 'w1',
          a: { kind: 'pin', component: 'a', pin: 'y' },
          b: { kind: 'junction', junction: 'j1' },
          points: [],
        },
        {
          id: 'w2',
          a: { kind: 'junction', junction: 'j1' },
          b: { kind: 'pin', component: 'b', pin: 'x' },
          points: [],
        },
      ],
    };
    expect(connectedPins(circuit, { component: 'a', pin: 'y' })).toEqual([
      { component: 'b', pin: 'x' },
    ]);
  });

  it('never crosses a tap end -- a tap is its own net boundary', () => {
    const circuit: Circuit = {
      components: [],
      junctions: [],
      wires: [
        {
          id: 'wbus',
          a: { kind: 'pin', component: 'c', pin: 'y' },
          b: { kind: 'pin', component: 'o', pin: 'a' },
          points: [],
        },
        {
          id: 'wtap',
          a: { kind: 'pin', component: 'p', pin: 'a' },
          b: { kind: 'tap', wire: 'wbus', range: { hi: 0, lo: 0 }, pos: { x: 0, y: 0 } },
          points: [],
        },
      ],
    };
    // The bus's own pins never see the tap's stub pin, and vice versa --
    // resolving a tap's slice is compile.ts's job, not a plain net walk.
    expect(connectedPins(circuit, { component: 'c', pin: 'y' })).toEqual([
      { component: 'o', pin: 'a' },
    ]);
    expect(connectedPins(circuit, { component: 'p', pin: 'a' })).toEqual([]);
  });
});

describe('netPins', () => {
  it('starts from a non-pin end (junction/free) and still finds the reachable pins', () => {
    // Mirrors a wire split off the middle of a bus and dropped with a free
    // end (no pin at all on that wire) -- the rendering-width lookup this
    // fixes needs to walk from the junction/free end, not a pin.
    const circuit: Circuit = {
      components: [],
      junctions: [{ id: 'j1', pos: { x: 0, y: 0 } }],
      wires: [
        {
          id: 'w1',
          a: { kind: 'pin', component: 'c', pin: 'y' },
          b: { kind: 'junction', junction: 'j1' },
          points: [],
        },
        {
          id: 'w2',
          a: { kind: 'junction', junction: 'j1' },
          b: { kind: 'pin', component: 'o', pin: 'a' },
          points: [],
        },
        {
          id: 'w3',
          a: { kind: 'junction', junction: 'j1' },
          b: { kind: 'free', pos: { x: 5, y: 5 } },
          points: [],
        },
      ],
    };
    const found = netPins(circuit, { kind: 'free', pos: { x: 5, y: 5 } });
    expect(found).toEqual(
      expect.arrayContaining([
        { component: 'c', pin: 'y' },
        { component: 'o', pin: 'a' },
      ]),
    );
    expect(found).toHaveLength(2);
  });
});

describe('netWireIds', () => {
  it('collects every wire crossing through a chain of junctions, for a junction-click highlight', () => {
    const circuit: Circuit = {
      components: [],
      junctions: [
        { id: 'j1', pos: { x: 0, y: 0 } },
        { id: 'j2', pos: { x: 10, y: 0 } },
      ],
      wires: [
        {
          id: 'w1',
          a: { kind: 'pin', component: 'a', pin: 'y' },
          b: { kind: 'junction', junction: 'j1' },
          points: [],
        },
        {
          id: 'w2',
          a: { kind: 'junction', junction: 'j1' },
          b: { kind: 'pin', component: 'b', pin: 'x' },
          points: [],
        },
        {
          id: 'w3',
          a: { kind: 'junction', junction: 'j1' },
          b: { kind: 'junction', junction: 'j2' },
          points: [],
        },
        {
          id: 'w4',
          a: { kind: 'junction', junction: 'j2' },
          b: { kind: 'pin', component: 'c', pin: 'z' },
          points: [],
        },
      ],
    };
    const ids = netWireIds(circuit, { kind: 'junction', junction: 'j1' });
    expect(ids).toEqual(new Set(['w1', 'w2', 'w3', 'w4']));
  });

  it('is empty when the start end has no wires at all', () => {
    const circuit: Circuit = {
      components: [],
      junctions: [{ id: 'j1', pos: { x: 0, y: 0 } }],
      wires: [],
    };
    expect(netWireIds(circuit, { kind: 'junction', junction: 'j1' })).toEqual(new Set());
  });
});

describe('net labels join by name, not by wire', () => {
  const label = (id: string, name: string): Component => ({
    id,
    kind: 'netlabel',
    pos: { x: 0, y: 0 },
    label: name,
  });
  const w = (id: string, a: WireEnd, b: WireEnd): Wire => ({ id, a, b, points: [] });
  const p = (component: string, pin: string): WireEnd => ({ kind: 'pin', component, pin });

  const circuit = (labels: Component[]): Circuit => ({
    components: [
      { id: 'sw', kind: 'toggle', pos: { x: 0, y: 0 } },
      { id: 'g', kind: 'buf', pos: { x: 0, y: 0 } },
      ...labels,
    ],
    wires: [w('w1', p('sw', 'y'), p('L1', 'a')), w('w2', p('L2', 'a'), p('g', 'a'))],
    junctions: [],
  });

  it('connectedPins crosses a name join', () => {
    const c = circuit([label('L1', 'CLK'), label('L2', 'CLK')]);
    const reached = connectedPins(c, { component: 'sw', pin: 'y' });
    expect(reached).toContainEqual({ component: 'g', pin: 'a' });
  });

  it('does not cross when the names differ', () => {
    const c = circuit([label('L1', 'CLK'), label('L2', 'RST')]);
    const reached = connectedPins(c, { component: 'sw', pin: 'y' });
    expect(reached).not.toContainEqual({ component: 'g', pin: 'a' });
  });

  it('does not cross an unnamed label', () => {
    const c = circuit([label('L1', ''), label('L2', '')]);
    expect(connectedPins(c, { component: 'sw', pin: 'y' })).not.toContainEqual({
      component: 'g',
      pin: 'a',
    });
  });

  it('is case-sensitive, matching compile and KiCad', () => {
    const c = circuit([label('L1', 'clk'), label('L2', 'CLK')]);
    expect(connectedPins(c, { component: 'sw', pin: 'y' })).not.toContainEqual({
      component: 'g',
      pin: 'a',
    });
  });

  it('reaches the wires on the far side of a join', () => {
    const c = circuit([label('L1', 'CLK'), label('L2', 'CLK')]);
    expect(netWireIds(c, p('sw', 'y'))).toEqual(new Set(['w1', 'w2']));
  });

  it('joins three labels sharing one name, not just a pair', () => {
    const c: Circuit = {
      components: [
        { id: 'sw', kind: 'toggle', pos: { x: 0, y: 0 } },
        { id: 'g', kind: 'buf', pos: { x: 0, y: 0 } },
        { id: 'h', kind: 'buf', pos: { x: 0, y: 0 } },
        label('L1', 'CLK'),
        label('L2', 'CLK'),
        label('L3', 'CLK'),
      ],
      wires: [
        w('w1', p('sw', 'y'), p('L1', 'a')),
        w('w2', p('L2', 'a'), p('g', 'a')),
        w('w3', p('L3', 'a'), p('h', 'a')),
      ],
      junctions: [],
    };
    const reached = connectedPins(c, { component: 'sw', pin: 'y' });
    expect(reached).toContainEqual({ component: 'g', pin: 'a' });
    expect(reached).toContainEqual({ component: 'h', pin: 'a' });
  });
});
