import { describe, expect, it } from 'vitest';
import * as bv from '../value/busValue';
import type { ChipLibrary } from '../model/types';
import { board, comp, wire } from '../model/testFixtures';
import { BidirectionalPinError } from '../boolean/truthTable';
import { analysisTablesOf, boardDiffRows, truthTableOf } from './verify';
import { gateExpressions } from './subexpr';

const noLib: ChipLibrary = new Map();

/** SW -> G1 -> tristate -> transceiver -> LB, plus an unrelated SW2 -> LC. */
function transceiverBoard() {
  return board({
    components: [
      comp('SW', 'toggle', undefined, 'SW'),
      comp('G1', 'not', undefined, 'G1'),
      comp('en', 'constant', { value: 1 }),
      comp('U', 'tristate', undefined, 'U'),
      comp('T', 'transceiver', { width: 1 }, 'T'),
      comp('LB', 'led', undefined, 'LB'),
      comp('SW2', 'toggle', undefined, 'SW2'),
      comp('LC', 'led', undefined, 'LC'),
    ],
    wires: [
      wire('w1', ['SW', 'y'], ['G1', 'a']),
      wire('w2', ['G1', 'y'], ['U', 'a']),
      wire('w3', ['en', 'y'], ['U', 'en']),
      wire('w4', ['U', 'y'], ['T', 'a']),
      wire('w5', ['en', 'y'], ['T', 'dir']),
      wire('w6', ['en', 'y'], ['T', 'oe']),
      wire('w7', ['T', 'b'], ['LB', 'a']),
      wire('w8', ['SW2', 'y'], ['LC', 'a']),
    ],
  });
}

/** Two tristates share BUS into an LED: a 2:1 mux built from three-state buffers. */
function sharedBusBoard() {
  return board({
    components: [
      comp('A', 'toggle', undefined, 'A'),
      comp('B', 'toggle', undefined, 'B'),
      comp('S', 'toggle', undefined, 'S'),
      comp('N', 'not', undefined, 'N'),
      comp('U1', 'tristate', undefined, 'U1'),
      comp('U2', 'tristate', undefined, 'U2'),
      comp('L', 'led', undefined, 'L'),
    ],
    wires: [
      wire('w1', ['A', 'y'], ['U1', 'a']),
      wire('w2', ['B', 'y'], ['U2', 'a']),
      wire('w3', ['S', 'y'], ['U1', 'en']),
      wire('w4', ['S', 'y'], ['N', 'a']),
      wire('w5', ['N', 'y'], ['U2', 'en']),
      wire('w6', ['U1', 'y'], ['U2', 'y']),
      wire('w7', ['U1', 'y'], ['L', 'a']),
    ],
  });
}

describe('Analyze, bubble verify and sub-expressions on bidirectional pins', () => {
  it('Analyze refuses every output of a board with a transceiver, naming why', () => {
    const outputs = analysisTablesOf(transceiverBoard(), noLib);
    expect(outputs.map((o) => o.error)).toEqual([
      'The board has a bus transceiver or other bidirectional pin, so LB has no truth table',
      'The board has a bus transceiver or other bidirectional pin, so LC has no truth table',
    ]);
    expect(outputs.every((o) => o.table === null)).toBe(true);
  });

  it('bubble verify refuses it as bidirectional, not as a cycle', () => {
    const b = transceiverBoard();
    expect(() => truthTableOf(b, noLib)).toThrow(BidirectionalPinError);
    expect(() => boardDiffRows(b, b, noLib)).toThrow(/main\/T has a bidirectional pin/);
    expect(() => boardDiffRows(b, b, noLib)).not.toThrow(/cycle or unresolved driver/);
  });

  it('sub-expressions leave the nets a transceiver drives unlabelled and label the rest', () => {
    const { pins, outputs } = gateExpressions(transceiverBoard(), noLib);
    expect(pins.get('G1.y')).toEqual({ kind: 'not', a: { kind: 'var', name: 'SW' } });
    expect(outputs.has('main/LB')).toBe(false);
    expect(outputs.get('main/LC')).toEqual({ kind: 'var', name: 'SW2' });
  });

  it('resolves a bus shared by three-state outputs the way the kernel does', () => {
    const [out] = analysisTablesOf(sharedBusBoard(), noLib);
    const table = out!.table!;
    const n = table.inputPaths.length;
    const bit = (row: number, path: string) =>
      (row >> (n - 1 - table.inputPaths.indexOf(path))) & 1;
    table.rows.forEach((cols, row) => {
      const want = bit(row, 'main/S') ? bit(row, 'main/A') : bit(row, 'main/B');
      expect(cols[0], `row ${row}`).toEqual(bv.known(want, 1));
    });
    const b = sharedBusBoard();
    expect(boardDiffRows(b, b, noLib)).toEqual([]);
  });

  it('still analyzes a lone tristate, Z rows included', () => {
    const b = sharedBusBoard();
    b.wires = b.wires.filter((w) => w.id !== 'w6');
    const [out] = analysisTablesOf(b, noLib);
    expect(out?.error).toBeNull();
    expect(out?.table?.rows).toHaveLength(4);
  });
});
