import { describe, expect, it } from 'vitest';
import { printExpr } from '../boolean/expr';
import { board, comp, wire } from '../model/testFixtures';
import type { ChipLibrary, Component } from '../model/types';
import { builtinChipLibrary } from '../parts/packages';
import { gateExpressions, hasSubExpressions } from './subexpr';

const noLib: ChipLibrary = new Map();
const lib = builtinChipLibrary();

const pinsOf = (b: ReturnType<typeof board>, l = noLib): Record<string, string> =>
  Object.fromEntries([...gateExpressions(b, l).pins].map(([k, e]) => [k, printExpr(e)]));

const sw = (id: string, label: string): Component => comp(id, 'toggle', undefined, label);

describe('gateExpressions', () => {
  it('builds each gate output as written, never simplified', () => {
    // Y = (AB)' + A, drawn as NAND into OR: the OR keeps the NAND's bar.
    const b = board({
      components: [
        sw('a', 'A'),
        sw('b', 'B'),
        comp('g1', 'nand'),
        comp('g2', 'or'),
        comp('y', 'led', undefined, 'Y'),
      ],
      wires: [
        wire('w1', ['a', 'y'], ['g1', 'a']),
        wire('w2', ['b', 'y'], ['g1', 'b']),
        wire('w3', ['g1', 'y'], ['g2', 'a']),
        wire('w4', ['a', 'y'], ['g2', 'b']),
        wire('w5', ['g2', 'y'], ['y', 'a']),
      ],
    });
    expect(pinsOf(b)).toEqual({ 'g1.y': "(AB)'", 'g2.y': "(AB)' + A" });
    const out = gateExpressions(b, noLib).outputs;
    expect(printExpr(out.get('main/Y')!)).toBe("(AB)' + A");
  });

  it('names an unlabelled input by its id and folds a bubble into the gate', () => {
    const b = board({
      components: [comp('s1', 'toggle'), sw('b', 'B'), comp('g', 'and', { inputBubbles: 'a' })],
      wires: [wire('w1', ['s1', 'y'], ['g', 'a']), wire('w2', ['b', 'y'], ['g', 'b'])],
    });
    expect(pinsOf(b)).toEqual({ 'g.y': "s1'B" });
  });

  it('follows a net label and a constant', () => {
    const b = board({
      components: [
        sw('a', 'A'),
        comp('l1', 'netlabel', undefined, 'N'),
        comp('l2', 'netlabel', undefined, 'N'),
        comp('k', 'constant', { value: 1 }),
        comp('g', 'xor'),
      ],
      wires: [
        wire('w1', ['a', 'y'], ['l1', 'a']),
        wire('w2', ['l2', 'a'], ['g', 'a']),
        wire('w3', ['k', 'y'], ['g', 'b']),
      ],
    });
    expect(pinsOf(b)).toEqual({ 'g.y': 'A ⊕ 1' });
  });

  it('annotates a 74LS00 through to its DIP output pin', () => {
    const b = board({
      components: [sw('a', 'A'), sw('b', 'B'), { ...comp('u1', 'chip'), defId: '74LS00' }],
      wires: [wire('w1', ['a', 'y'], ['u1', '1A']), wire('w2', ['b', 'y'], ['u1', '1B'])],
    });
    expect(pinsOf(b, lib)['u1.1Y']).toBe("(AB)'");
  });

  it('treats any other chip output as a variable named for instance and pin', () => {
    const def = lib.get('74LS47')!;
    const outPin = def.pins.find((p) => p.id === 'pin-13')!;
    const b = board({
      components: [{ ...comp('u3', 'chip'), defId: '74LS47', label: 'U3' }, comp('g', 'not')],
      wires: [wire('w1', ['u3', outPin.name], ['g', 'a'])],
    });
    expect(pinsOf(b, lib)).toEqual({ 'g.y': "U3.13'" });
  });

  it('leaves a combinational loop and what reads it unlabelled', () => {
    const b = board({
      components: [sw('a', 'A'), comp('g1', 'nand'), comp('g2', 'nand'), comp('g3', 'not')],
      wires: [
        wire('w1', ['a', 'y'], ['g1', 'a']),
        wire('w2', ['g2', 'y'], ['g1', 'b']),
        wire('w3', ['g1', 'y'], ['g2', 'a']),
        wire('w4', ['a', 'y'], ['g2', 'b']),
        wire('w5', ['g1', 'y'], ['g3', 'a']),
      ],
    });
    expect(pinsOf(b)).toEqual({});
  });

  it('leaves a flip-flop output unlabelled', () => {
    const b = board({
      components: [comp('ff', 'dff'), comp('g', 'not')],
      wires: [wire('w1', ['ff', 'q'], ['g', 'a'])],
    });
    expect(pinsOf(b)).toEqual({});
    expect(hasSubExpressions(b, noLib)).toBe(false);
  });
});
