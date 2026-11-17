import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RUN_SPEED,
  type Board,
  type Component,
  type Wire,
  type WireEnd,
} from '../model/types';
import type { BusValue } from '../value/busValue';
import { firstCircuitProgress, type FirstCircuitSim } from './firstCircuit';

const pin = (component: string, p: string): WireEnd => ({ kind: 'pin', component, pin: p });
const wire = (id: string, a: WireEnd, b: WireEnd): Wire => ({ id, a, b, points: [] });
const comp = (id: string, kind: Component['kind'], params?: Component['params']): Component => ({
  id,
  kind,
  pos: { x: 0, y: 0 },
  ...(params ? { params } : {}),
});

function board(
  components: Component[],
  wires: Wire[] = [],
  junctions: Board['junctions'] = [],
): Board {
  return {
    format: 'lcir.board',
    formatVersion: 16,
    id: 't',
    name: 't',
    components,
    wires,
    junctions,
    probes: [],
    view: { x: 0, y: 0, zoom: 1 },
    timing: { mode: 'ideal', datasheet: 'typ', vendor: 'ti' },
    runSpeed: DEFAULT_RUN_SPEED,
  };
}

const PARTS = [
  comp('sw1', 'toggle'),
  comp('sw2', 'toggle'),
  comp('g1', 'and'),
  comp('led1', 'led'),
];
const WIRES = [
  wire('w1', pin('sw1', 'y'), pin('g1', 'a')),
  wire('w2', pin('sw2', 'y'), pin('g1', 'b')),
  wire('w3', pin('g1', 'y'), pin('led1', 'a')),
];

const ONE: BusValue = { v: 1, x: 0, z: 0 };
const ZERO: BusValue = { v: 0, x: 0, z: 0 };
const OFF: FirstCircuitSim = { powered: false, pinValue: () => undefined };

function on(values: Record<string, BusValue> = {}): FirstCircuitSim {
  return { powered: true, pinValue: (c, p) => values[`${c}.${p}`] ?? ZERO };
}

const wired = (b: Board) => firstCircuitProgress(b, OFF).done.wires;

describe('firstCircuitProgress', () => {
  it('starts at the switches on an empty board', () => {
    const p = firstCircuitProgress(board([]), OFF);
    expect(p.current).toBe('switches');
    expect(Object.values(p.done).some(Boolean)).toBe(false);
    expect(p.mustPowerOff).toBe(false);
  });

  it('ticks parts in any order', () => {
    const p = firstCircuitProgress(board([comp('led1', 'led'), comp('g1', 'and')]), OFF);
    expect(p.done).toMatchObject({ switches: false, gate: true, led: true });
    expect(p.current).toBe('switches');
  });

  it('waits for power once the circuit is wired', () => {
    const p = firstCircuitProgress(board(PARTS, WIRES), OFF);
    expect(p.done).toMatchObject({
      switches: true,
      gate: true,
      led: true,
      wires: true,
      power: false,
    });
    expect(p.current).toBe('power');
  });

  it('wants both switches high and the LED lit', () => {
    const b = board(PARTS, WIRES);
    expect(firstCircuitProgress(b, on()).current).toBe('lit');
    expect(firstCircuitProgress(b, on({ 'sw1.y': ONE, 'led1.a': ZERO })).current).toBe('lit');
    const lit = firstCircuitProgress(b, on({ 'sw1.y': ONE, 'sw2.y': ONE, 'led1.a': ONE }));
    expect(lit.done.lit).toBe(true);
    expect(lit.current).toBeNull();
  });

  it('does not count an X on the LED as lit', () => {
    const x: BusValue = { v: 0, x: 1, z: 0 };
    const p = firstCircuitProgress(
      board(PARTS, WIRES),
      on({ 'sw1.y': ONE, 'sw2.y': ONE, 'led1.a': x }),
    );
    expect(p.done.lit).toBe(false);
  });

  it('untick power and lit when power goes off', () => {
    const p = firstCircuitProgress(board(PARTS, WIRES), OFF);
    expect(p.done.power).toBe(false);
    expect(p.done.lit).toBe(false);
  });

  it('takes a tick back when a part is deleted', () => {
    const b = board(
      PARTS.filter((c) => c.id !== 'g1'),
      WIRES.slice(0, 1),
    );
    const p = firstCircuitProgress(b, OFF);
    expect(p.done.gate).toBe(false);
    expect(p.done.wires).toBe(false);
    expect(p.current).toBe('gate');
  });

  it('follows a net through a junction', () => {
    const b = board(
      PARTS,
      [
        wire('w1a', pin('sw1', 'y'), { kind: 'junction', junction: 'j1' }),
        wire('w1b', { kind: 'junction', junction: 'j1' }, pin('g1', 'a')),
        WIRES[1]!,
        WIRES[2]!,
      ],
      [{ id: 'j1', pos: { x: 0, y: 0 } }],
    );
    expect(wired(b)).toBe(true);
  });

  it('accepts any pair of switches among several', () => {
    const b = board([...PARTS, comp('sw3', 'toggle')], WIRES);
    expect(wired(b)).toBe(true);
  });

  it.each([
    ['a 74LS08 chip', comp('g1', 'chip', {})],
    ['a NAND', comp('g1', 'nand')],
    ['an AND with an output bubble', comp('g1', 'and', { outputBubble: true })],
    ['an AND with an input bubble', comp('g1', 'and', { inputBubbles: 'a' })],
    ['a 4-bit AND', comp('g1', 'and', { width: 4 })],
    ['a 3-input AND', comp('g1', 'and', { inputs: 3 })],
  ])('does not count %s as the gate', (_, gate) => {
    const b = board([...PARTS.filter((c) => c.id !== 'g1'), gate], WIRES);
    const p = firstCircuitProgress(b, OFF);
    expect(p.done.gate).toBe(false);
    expect(p.done.wires).toBe(false);
  });

  it.each([
    ['an LED array', comp('led1', 'led', { width: 8 })],
    ['an active-low LED', comp('led1', 'led', { activeLow: true })],
  ])('does not count %s as the LED', (_, led) => {
    const b = board([...PARTS.filter((c) => c.id !== 'led1'), led], WIRES);
    const p = firstCircuitProgress(b, OFF);
    expect(p.done.led).toBe(false);
    expect(p.done.wires).toBe(false);
  });

  it('does not count a button as a switch', () => {
    const b = board(
      [comp('sw1', 'toggle'), comp('sw2', 'button'), comp('g1', 'and'), comp('led1', 'led')],
      WIRES,
    );
    const p = firstCircuitProgress(b, OFF);
    expect(p.done.switches).toBe(false);
    expect(p.done.wires).toBe(false);
  });

  it('does not count a 4-bit switch', () => {
    const b = board([comp('sw1', 'toggle', { width: 4 }), ...PARTS.slice(1)], WIRES);
    expect(firstCircuitProgress(b, OFF).done.switches).toBe(false);
  });

  it('rejects two switches on the same input', () => {
    const b = board(PARTS, [WIRES[0]!, wire('w2', pin('sw2', 'y'), pin('g1', 'a')), WIRES[2]!]);
    expect(wired(b)).toBe(false);
  });

  it('rejects one switch feeding both inputs', () => {
    const b = board(PARTS, [WIRES[0]!, wire('w2', pin('sw1', 'y'), pin('g1', 'b')), WIRES[2]!]);
    expect(wired(b)).toBe(false);
  });

  it('rejects a switch on the AND output', () => {
    const b = board(PARTS, [...WIRES, wire('w4', pin('sw1', 'y'), pin('led1', 'a'))]);
    expect(wired(b)).toBe(false);
  });

  it('rejects the LED on a switch instead of the output', () => {
    const b = board(PARTS, [WIRES[0]!, WIRES[1]!, wire('w3', pin('sw2', 'y'), pin('led1', 'a'))]);
    expect(wired(b)).toBe(false);
  });

  it('does not tick power on an unwired board', () => {
    const p = firstCircuitProgress(board(PARTS, WIRES.slice(0, 2)), on());
    expect(p.done.power).toBe(false);
    expect(p.current).toBe('wires');
    expect(p.mustPowerOff).toBe(true);
  });

  it('never asks to power off once the circuit is built', () => {
    expect(firstCircuitProgress(board(PARTS, WIRES), on()).mustPowerOff).toBe(false);
  });
});
