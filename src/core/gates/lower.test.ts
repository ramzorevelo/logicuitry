import { describe, expect, it } from 'vitest';
import { compile } from '../model/compile';
import { evaluateNets } from '../boolean/evaluate';
import * as bv from '../value/busValue';
import type { Board, Component, Wire } from '../model/types';
import { lowerCircuit } from './lower';
import { withInputBubble, withOutputBubble } from './bubbleModel';

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

function evalBoard(b: Board, a: 0 | 1, bb: 0 | 1): bv.BusValue {
  const compiled = compile(lowerCircuit(b), lib);
  // Ports are pure labels: address their nets via the compile alias.
  const aNet = compiled.pathToNet.get('main/in1.y')!;
  const bNet = compiled.pathToNet.get('main/in2.y')!;
  const driven = new Map([
    [aNet, bv.known(a, 1)],
    [bNet, bv.known(bb, 1)],
  ]);
  const result = evaluateNets(compiled, driven);
  return result.get(compiled.pathToNet.get('main/out.a')!)!;
}

describe('lowerCircuit', () => {
  it('composes and+outputBubble to a literal nand primitive', () => {
    const and = withOutputBubble({ id: 'g1', kind: 'and', pos: { x: 0, y: 0 } }, true);
    const b = board(
      [
        { id: 'in1', kind: 'inport', pos: { x: 0, y: 0 }, label: 'in1' },
        { id: 'in2', kind: 'inport', pos: { x: 0, y: 0 }, label: 'in2' },
        and,
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
    const lowered = lowerCircuit(b);
    expect(lowered.components.find((c) => c.id === 'g1')!.kind).toBe('nand');
    // 1 AND 1 = 1; NAND(1,1) = 0
    expect(evalBoard(b, 1, 1)).toEqual(bv.known(0, 1));
  });

  it('splices a real not primitive for a flagged input bubble', () => {
    let g1: Component = { id: 'g1', kind: 'or', pos: { x: 0, y: 0 } };
    g1 = withInputBubble(g1, 'a', true);
    const b = board(
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
    // OR(NOT(a), b): a=1,b=0 -> OR(0,0) = 0
    expect(evalBoard(b, 1, 0)).toEqual(bv.known(0, 1));
    // a=0,b=0 -> OR(1,0) = 1
    expect(evalBoard(b, 0, 0)).toEqual(bv.known(1, 1));
  });
});
