import { describe, expect, it } from 'vitest';
import * as bv from '../../value/busValue';
import type { EvalContext, Params, PrimitiveSpec } from './types';
import { andGate, bufGate, norGate, orGate, xnorGate, xorGate } from './gates';
import { dlatch, register } from './sequential';

const s = (lit: string) => bv.fromString(lit);
const show = (value: bv.BusValue, w: number) => bv.toString(value, w);

function ctx(params: Params, inputs: bv.BusValue[], extra: Partial<EvalContext> = {}): EvalContext {
  return { params, state: undefined, inputs, prevInputs: inputs, time: 0, ...extra };
}

const out = (spec: PrimitiveSpec, c: EvalContext, i = 0) => spec.evaluate(c).outputs[i]!;

describe('gate specs: 4-state truth tables over 16 input pairs', () => {
  const pairs: [string, string][] = [];
  for (const a of '01XZ') for (const b of '01XZ') pairs.push([a, b]);
  const table = (spec: PrimitiveSpec) =>
    pairs.map(([a, b]) => show(out(spec, ctx({}, [s(a), s(b)])), 1)).join('');

  it('AND: 0 dominates', () => {
    expect(table(andGate)).toBe('0000' + '01XX' + '0XXX' + '0XXX');
  });
  it('OR: 1 dominates', () => {
    expect(table(orGate)).toBe('01XX' + '1111' + 'X1XX' + 'X1XX');
  });
  it('NOR: inverse of OR', () => {
    expect(table(norGate)).toBe('10XX' + '0000' + 'X0XX' + 'X0XX');
  });
  it('XOR: any unknown poisons', () => {
    expect(table(xorGate)).toBe('01XX' + '10XX' + 'XXXX' + 'XXXX');
  });
  it('XNOR: inverse of XOR', () => {
    expect(table(xnorGate)).toBe('10XX' + '01XX' + 'XXXX' + 'XXXX');
  });
  it('BUF: maps Z to X (default width 1 when params omit it)', () => {
    expect(show(out(bufGate, ctx({}, [s('0')])), 1)).toBe('0');
    expect(show(out(bufGate, ctx({}, [s('1')])), 1)).toBe('1');
    expect(show(out(bufGate, ctx({}, [s('X')])), 1)).toBe('X');
    expect(show(out(bufGate, ctx({}, [s('Z')])), 1)).toBe('X');
  });
});

describe('dlatch', () => {
  const p = { width: 4 };
  it('is transparent while en known 1', () => {
    const c = ctx(p, [s('1010'), s('1')], { state: { q: bv.allX(4) } });
    expect(show(out(dlatch, c), 4)).toBe('1010');
  });
  it('holds while en known 0', () => {
    const c = ctx(p, [s('0101'), s('0')], { state: { q: s('1010') } });
    expect(show(out(dlatch, c), 4)).toBe('1010');
  });
  it('goes all-X while en unknown', () => {
    const c = ctx(p, [s('1010'), s('X')], { state: { q: s('1010') } });
    expect(show(out(dlatch, c), 4)).toBe('XXXX');
  });
});

describe('register', () => {
  const p = { width: 4 };
  // pins: [d, clk, en]; d and en sampled from prevInputs at the edge.
  const edge = (
    prev: [string, string, string],
    cur: [string, string, string],
    state: bv.BusValue,
  ): EvalContext => ({
    params: p,
    state: { q: state },
    inputs: cur.map(s),
    prevInputs: prev.map(s),
    time: 0,
  });

  it('loads d on a clean rising edge with en 1', () => {
    const c = edge(['1010', '0', '1'], ['1010', '1', '1'], bv.allX(4));
    expect(show(out(register, c), 4)).toBe('1010');
  });
  it('holds on a rising edge with en 0', () => {
    const c = edge(['0101', '0', '0'], ['0101', '1', '0'], s('1010'));
    expect(show(out(register, c), 4)).toBe('1010');
  });
  it('goes all-X on an unknown edge', () => {
    const c = edge(['1010', 'X', '1'], ['1010', '1', '1'], s('1010'));
    expect(show(out(register, c), 4)).toBe('XXXX');
  });
});
