import { describe, expect, it } from 'vitest';
import type { Board, Component, Wire } from '../model/types';
import { analysisTablesOf } from './verify';

const lib = new Map();

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

const pin = (component: string, pinName: string): Wire['a'] => ({
  kind: 'pin',
  component,
  pin: pinName,
});
let w = 0;
const wire = (a: Wire['a'], b: Wire['b']): Wire => ({ id: `w${w++}`, a, b, points: [] });

describe('analysisTablesOf', () => {
  it('two independent cones: each output sees only its own inputs', () => {
    const b = board(
      [
        { id: 'in1', kind: 'inport', pos: { x: 0, y: 0 }, label: 'A' },
        { id: 'in2', kind: 'inport', pos: { x: 0, y: 1 }, label: 'B' },
        { id: 'n1', kind: 'not', pos: { x: 1, y: 0 } },
        { id: 'out1', kind: 'outport', pos: { x: 2, y: 0 }, label: 'Y' },
        { id: 'out2', kind: 'outport', pos: { x: 2, y: 1 }, label: 'Z' },
      ],
      [
        wire(pin('in1', 'y'), pin('n1', 'a')),
        wire(pin('n1', 'y'), pin('out1', 'a')),
        wire(pin('in2', 'y'), pin('out2', 'a')),
      ],
    );
    const tables = analysisTablesOf(b, lib);
    expect(tables.map((t) => t.outputPath)).toEqual(['main/Y.a', 'main/Z.a']);
    expect(tables[0]!.table!.inputPaths).toEqual(['main/A.y']);
    expect(tables[1]!.table!.inputPaths).toEqual(['main/B.y']);
    // NOT cone really inverts.
    expect(tables[0]!.table!.rows[0]![0]!.v & 1).toBe(1);
    expect(tables[0]!.table!.rows[1]![0]!.v & 1).toBe(0);
  });

  it('dedups a switch wired to an In port into one input, preferring the labeled side', () => {
    const b = board(
      [
        { id: 'sw1', kind: 'toggle', pos: { x: 0, y: 0 } },
        { id: 'in1', kind: 'inport', pos: { x: 0, y: 1 }, label: 'A' },
        { id: 'n1', kind: 'not', pos: { x: 1, y: 0 } },
        { id: 'out1', kind: 'outport', pos: { x: 2, y: 0 }, label: 'Y' },
      ],
      [
        wire(pin('sw1', 'y'), pin('in1', 'y')),
        wire(pin('in1', 'y'), pin('n1', 'a')),
        wire(pin('n1', 'y'), pin('out1', 'a')),
      ],
    );
    const tables = analysisTablesOf(b, lib);
    expect(tables).toHaveLength(1);
    expect(tables[0]!.table!.inputPaths).toEqual(['main/A.y']);
  });

  it('dedups an LED sharing the Out port net into one output', () => {
    const b = board(
      [
        { id: 'in1', kind: 'inport', pos: { x: 0, y: 0 }, label: 'A' },
        { id: 'out1', kind: 'outport', pos: { x: 2, y: 0 }, label: 'Y' },
        { id: 'led1', kind: 'led', pos: { x: 2, y: 1 } },
      ],
      [wire(pin('in1', 'y'), pin('out1', 'a')), wire(pin('in1', 'y'), pin('led1', 'a'))],
    );
    const tables = analysisTablesOf(b, lib);
    expect(tables).toHaveLength(1);
    expect(tables[0]!.outputPath).toBe('main/Y.a');
  });

  it('reports an error for an output no input reaches', () => {
    const b = board(
      [
        { id: 'in1', kind: 'inport', pos: { x: 0, y: 0 }, label: 'A' },
        { id: 'led2', kind: 'led', pos: { x: 3, y: 3 } },
        { id: 'out1', kind: 'outport', pos: { x: 2, y: 0 }, label: 'Y' },
      ],
      [wire(pin('in1', 'y'), pin('out1', 'a'))],
    );
    const tables = analysisTablesOf(b, lib);
    const led = tables.find((t) => t.outputPath === 'main/led2');
    expect(led!.table).toBeNull();
    expect(led!.error).toBeTruthy();
  });

  it('M6.6: a width>1 terminal expands into one per-bit-lane table, MSB first', () => {
    const b = board(
      [
        { id: 'sw3', kind: 'toggle', pos: { x: 0, y: 0 }, label: 'sw3', params: { width: 4 } },
        { id: 'in1', kind: 'inport', pos: { x: 0, y: 1 }, label: 'A' },
        { id: 'n1', kind: 'not', pos: { x: 1, y: 0 } },
        { id: 'out1', kind: 'outport', pos: { x: 2, y: 0 }, label: 'Y' },
        { id: 'out4', kind: 'outport', pos: { x: 2, y: 1 }, label: 'W', params: { width: 4 } },
      ],
      [
        wire(pin('in1', 'y'), pin('n1', 'a')),
        wire(pin('n1', 'y'), pin('out1', 'a')),
        wire(pin('sw3', 'y'), pin('out4', 'a')),
      ],
    );
    const tables = analysisTablesOf(b, lib);
    // The 1-bit A->NOT->Y cone stays a single table; the 4-bit sw3->out4 cone
    // becomes 4 independent per-bit tables, MSB first, each seeing only the
    // matching bit of sw3 (a direct wire is lane-preserving with no gate in
    // between).
    expect(tables.map((t) => t.outputPath)).toEqual([
      'main/Y.a',
      'main/W.a[3]',
      'main/W.a[2]',
      'main/W.a[1]',
      'main/W.a[0]',
    ]);
    expect(tables[1]!.table!.inputPaths).toEqual(['main/sw3[3]']);
    expect(tables[4]!.table!.inputPaths).toEqual(['main/sw3[0]']);
  });
});
