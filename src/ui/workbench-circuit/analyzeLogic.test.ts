import { describe, expect, it } from 'vitest';
import * as bv from '../../core/value/busValue';
import type { TruthTable } from '../../core/boolean/truthTable';
import {
  bitChar,
  buildVarNames,
  isCircled,
  outputDisplay,
  outputIndexOf,
  revealColors,
  revealResetKey,
  splitTerminalPath,
  unknownRows,
  withBit,
} from './analyzeLogic';

function table(inputPaths: string[], cells: string): TruthTable {
  const rows = [...cells].map((c) => [c === '?' ? bv.allX(1) : bv.known(c === '1' ? 1 : 0, 1)]);
  return { inputPaths, outputPaths: ['Y'], rows };
}

describe('outputIndexOf', () => {
  const paths = ['main/Y1', 'main/Y2', 'main/Y3'];

  it('follows the output by path when an earlier one is deleted', () => {
    expect(outputIndexOf(paths, 'main/Y3')).toBe(2);
    expect(outputIndexOf(['main/Y2', 'main/Y3'], 'main/Y3')).toBe(1);
  });

  it('falls back to the first output when the path is gone or unset', () => {
    expect(outputIndexOf(paths, 'main/gone')).toBe(0);
    expect(outputIndexOf(paths, null)).toBe(0);
    expect(outputIndexOf([], 'main/Y1')).toBe(0);
  });
});

describe('revealResetKey', () => {
  const t = table(['A', 'B'], '0110');

  it('is stable while the same function stays on screen', () => {
    expect(revealResetKey('board', 'main/Y', t)).toBe(
      revealResetKey('board', 'main/Y', table(['A', 'B'], '0110')),
    );
  });

  it('changes with the output, the table contents, the inputs and the source', () => {
    const key = revealResetKey('board', 'main/Y', t);
    expect(revealResetKey('board', 'main/Z', t)).not.toBe(key);
    expect(revealResetKey('board', 'main/Y', table(['A', 'B'], '0111'))).not.toBe(key);
    expect(revealResetKey('board', 'main/Y', table(['B', 'A'], '0110'))).not.toBe(key);
    expect(revealResetKey('typed', 'main/Y', t)).not.toBe(key);
  });
});

describe('unknown rows', () => {
  it('counts X/Z rows and draws them as a dash', () => {
    const t = table(['A', 'B'], '01??');
    expect(unknownRows(t)).toBe(2);
    expect(unknownRows(t, new Set([2]))).toBe(1);
    expect(bitChar(t, 2, 0)).toBe('–');
    expect(bitChar(t, 1, 0, new Set([1]))).toBe('X');
  });
});

describe('revealColors', () => {
  it('never takes a user circle colour while a free one remains', () => {
    const user = [
      { minterms: [1], color: 0 },
      { minterms: [5], color: 2 },
    ];
    expect(revealColors(user, [[3], [6], [7]]).map((c) => c.color)).toEqual([1, 3, 4]);
  });

  it('gives a group identical to a user circle that circle colour, one inset in', () => {
    const user = [{ minterms: [1, 3], color: 5 }];
    expect(revealColors(user, [[1, 3]])).toEqual([{ color: 5, inset: 1 }]);
  });

  it('treats a wrapped user colour as the palette slot it draws in', () => {
    const user = [{ minterms: [1], color: 8 }];
    expect(revealColors(user, [[2]])[0]!.color).toBe(1);
  });

  it('reuses colours only once the palette is spent', () => {
    const user = [0, 1, 2, 3, 4, 5, 6].map((c) => ({ minterms: [c], color: c }));
    const got = revealColors(user, [[10], [11]], 8).map((c) => c.color);
    expect(got).toEqual([7, 0]);
  });
});

describe('isCircled', () => {
  it('spots a group that is already circled', () => {
    expect(isCircled([{ minterms: [1, 3] }], [1, 3])).toBe(true);
    expect(isCircled([{ minterms: [1, 3] }], [1])).toBe(false);
  });
});

describe('outputDisplay', () => {
  it('renames an output labelled with one of its inputs, so it never reads D = D', () => {
    expect(outputDisplay('D', ['A', 'B', 'C', 'D'])).toEqual({ name: 'Y', caption: 'D' });
  });

  it('renames an output labelled with an expression over its inputs', () => {
    expect(outputDisplay("A'B + C", ['A', 'B', 'C'])).toEqual({ name: 'Y', caption: "A'B + C" });
    expect(outputDisplay('[sw 1]', ['sw 1'])).toEqual({ name: 'Y', caption: '[sw 1]' });
  });

  it('takes the next free letter when Y is an input', () => {
    expect(outputDisplay('Y', ['X', 'Y'])).toEqual({ name: 'Z', caption: 'Y' });
  });

  it('keeps an ordinary name', () => {
    expect(outputDisplay('Cout', ['A', 'B', 'Cin'])).toEqual({ name: 'Cout', caption: null });
    expect(outputDisplay('Y', ['A', 'B'])).toEqual({ name: 'Y', caption: null });
    expect(outputDisplay('LED 1', ['A'])).toEqual({ name: 'LED 1', caption: null });
  });
});

describe('splitTerminalPath', () => {
  it('strips the pin and the bus bit, keeping the bit apart', () => {
    expect(splitTerminalPath('main/Q.a[2]')).toEqual({ base: 'main/Q', bit: 2 });
    expect(splitTerminalPath('main/led3[1]')).toEqual({ base: 'main/led3', bit: 1 });
    expect(splitTerminalPath('main/g/X.y')).toEqual({ base: 'main/g/X' });
    expect(withBit('Q', 2)).toBe('Q[2]');
    expect(withBit('Q', undefined)).toBe('Q');
  });
});

describe('buildVarNames', () => {
  it('numbers a repeated name so each input stays its own variable', () => {
    expect(buildVarNames(['A', 'A', 'B'])).toEqual(['A', 'A2', 'B']);
    expect(buildVarNames(['A', 'A', 'A2'])).toEqual(['A', 'A3', 'A2']);
    expect(buildVarNames(['sw1', 'sw1'])).toEqual(['sw1', 'sw1_2']);
  });

  it('drops bus brackets, which a variable name cannot hold', () => {
    expect(buildVarNames(['Q[1]', 'Q[0]'])).toEqual(['Q1', 'Q0']);
  });
});
