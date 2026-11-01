import { describe, expect, it } from 'vitest';
import * as bv from '../value/busValue';
import { CompileError, compile } from './compile';
import type { ChipLibrary, Wire } from './types';
import { board, chipDef, comp, pin, tapWire, wire } from './testFixtures';
import { BIDIR } from './bidirFixture';
import { Simulator } from '../sim/kernel';
import { idealDelay, pinNamesOf } from '../sim/delay';
import { trackList } from '../timing/traceView';
import { resolveOutputNet } from '../boolean/truthTable';
import { analyzeTiming, TimingError } from '../timing/sta';

const noLib: ChipLibrary = new Map();

const settle = (b: ReturnType<typeof board>, path: string): bv.BusValue => {
  const sim = new Simulator(compile(b, noLib), idealDelay);
  sim.powerOn();
  return sim.netValueByPath(path);
};

/** A bidir and a tristate sharing the net probed as BUS. */
function sharedBus(bidir: { d: number; en: number }, tri: { a: number; en: number }) {
  return board({
    components: [
      comp('bd', 'constant', { value: bidir.d }),
      comp('be', 'constant', { value: bidir.en }),
      comp('U1', BIDIR, undefined, 'U1'),
      comp('ta', 'constant', { value: tri.a }),
      comp('te', 'constant', { value: tri.en }),
      comp('T1', 'tristate'),
      comp('pb', 'probe', undefined, 'BUS'),
    ],
    wires: [
      wire('w1', ['bd', 'y'], ['U1', 'd']),
      wire('w2', ['be', 'y'], ['U1', 'en']),
      wire('w3', ['ta', 'y'], ['T1', 'a']),
      wire('w4', ['te', 'y'], ['T1', 'en']),
      wire('w5', ['U1', 'p'], ['T1', 'y']),
      wire('w6', ['U1', 'p'], ['pb', 'a']),
    ],
  });
}

describe('inout pins', () => {
  it('resolve to the same slots in every pin-name-to-slot table', () => {
    const b = sharedBus({ d: 1, en: 1 }, { a: 0, en: 0 });
    const c = compile(b, noLib);
    const bus = c.pathToNet.get('main/BUS')!;
    const prim = c.primitives[c.componentToPrimitive.get('main/U1')!]!;

    const names = pinNamesOf(prim);
    expect(names).toEqual({ ins: ['d', 'p', 'en'], outs: ['p', 'r'] });
    expect(prim.inputs).toHaveLength(names.ins.length);
    expect(prim.outputs).toHaveLength(names.outs.length);
    expect(prim.inputs[names.ins.indexOf('p')]).toBe(bus);
    expect(prim.outputs[names.outs.indexOf('p')]).toBe(bus);

    expect(resolveOutputNet(c, 'main/U1.p')).toBe(bus);
    expect(resolveOutputNet(c, 'main/U1.en')).toBe(prim.inputs[2]);
    const tracks = trackList(b, c);
    expect(tracks.find((t) => t.path === 'main/U1.p')?.net).toBe(bus);
    expect(tracks.find((t) => t.path === 'main/U1.r')?.net).toBe(prim.outputs[1]);
  });

  it('share a net with a three-state output', () => {
    expect(() => compile(sharedBus({ d: 1, en: 1 }, { a: 0, en: 0 }), noLib)).not.toThrow();
  });

  it('share a net with one plain output and refuse a second, naming the plain pins', () => {
    const one = board({
      components: [comp('U1', BIDIR, undefined, 'U1'), comp('g', 'not')],
      wires: [wire('w1', ['U1', 'p'], ['g', 'y'])],
    });
    expect(() => compile(one, noLib)).not.toThrow();
    const two = board({
      components: [comp('U1', BIDIR, undefined, 'U1'), comp('g', 'not'), comp('h', 'not')],
      wires: [wire('w1', ['U1', 'p'], ['g', 'y']), wire('w2', ['U1', 'p'], ['h', 'y'])],
    });
    expect(() => compile(two, noLib)).toThrow(
      /pins main\/g\.y and main\/h\.y drive the same wire; a net takes at most one output that cannot float/,
    );
  });

  it('refuse a plain output beside a tap that drives the same bus', () => {
    const b = board({
      components: [
        comp('c', 'constant', { width: 2, value: 0 }),
        comp('g', 'not'),
        comp('pr', 'probe', { width: 2 }),
      ],
      wires: [
        wire('wb', ['c', 'y'], ['pr', 'a']),
        tapWire('wt', ['g', 'y'], 'wb', { hi: 0, lo: 0 }),
      ],
    });
    expect(() => compile(b, noLib)).toThrow(/drive the same wire/);
  });

  it('resolve a shared bus: one driver wins, agreement keeps the value, conflict is X', () => {
    expect(settle(sharedBus({ d: 1, en: 1 }, { a: 0, en: 0 }), 'main/BUS')).toEqual(bv.known(1, 1));
    expect(settle(sharedBus({ d: 1, en: 0 }, { a: 0, en: 1 }), 'main/BUS')).toEqual(bv.known(0, 1));
    expect(settle(sharedBus({ d: 1, en: 1 }, { a: 1, en: 1 }), 'main/BUS')).toEqual(bv.known(1, 1));
    expect(settle(sharedBus({ d: 1, en: 1 }, { a: 0, en: 1 }), 'main/BUS')).toEqual(bv.allX(1));
    expect(settle(sharedBus({ d: 1, en: 0 }, { a: 0, en: 0 }), 'main/BUS')).toEqual(bv.allZ(1));
  });

  it('read back what the bus resolves to, not only their own drive', () => {
    const b = sharedBus({ d: 1, en: 0 }, { a: 0, en: 1 });
    b.components.push(comp('pr', 'probe', undefined, 'READ'));
    b.wires.push(wire('w7', ['U1', 'r'], ['pr', 'a']));
    expect(settle(b, 'main/READ')).toEqual(bv.known(0, 1));
  });

  it('refuse a tap whose stub end is an inout pin', () => {
    const b = board({
      components: [
        comp('c', 'constant', { width: 4, value: 5 }),
        comp('o', 'outport', { width: 4 }),
        comp('U1', BIDIR),
      ],
      wires: [
        wire('wbus', ['c', 'y'], ['o', 'a']),
        tapWire('wt', ['U1', 'p'], 'wbus', { hi: 0, lo: 0 }),
      ],
    });
    expect(() => compile(b, noLib)).toThrow(CompileError);
    expect(() => compile(b, noLib)).toThrow(/a tap cannot end on a bidirectional pin/);
  });

  it('refuse a tap whose stub end is a chip pin declared inout', () => {
    const def = chipDef({
      id: 'io-chip',
      name: 'io',
      pins: [pin('io', 'inout', 'P', 0)],
      components: [comp('P', 'outport', { width: 1 })],
    });
    const b = board({
      components: [
        comp('c', 'constant', { width: 4, value: 5 }),
        comp('o', 'outport', { width: 4 }),
        { ...comp('X', 'chip'), defId: 'io-chip' },
      ],
      wires: [
        wire('wbus', ['c', 'y'], ['o', 'a']),
        tapWire('wt', ['X', 'io'], 'wbus', { hi: 0, lo: 0 }),
      ],
    });
    expect(() => compile(b, new Map([[def.id, def]]))).toThrow(
      /a tap cannot end on a bidirectional pin/,
    );
  });

  it('let a tap read a bus whose pin end is an inout pin', () => {
    const freeBus: Wire = {
      id: 'wbus',
      a: { kind: 'pin', component: 'U1', pin: 'p' },
      b: { kind: 'free', pos: { x: 9, y: 0 } },
      points: [],
    };
    const b = board({
      components: [
        comp('d', 'constant', { width: 4, value: 0b0110 }),
        comp('e', 'constant', { value: 1 }),
        comp('U1', BIDIR, { width: 4 }),
        comp('p', 'probe', { width: 2 }, 'MID'),
      ],
      wires: [
        wire('w1', ['d', 'y'], ['U1', 'd']),
        wire('w2', ['e', 'y'], ['U1', 'en']),
        freeBus,
        tapWire('wt', ['p', 'a'], 'wbus', { hi: 2, lo: 1 }),
      ],
    });
    expect(settle(b, 'main/MID')).toEqual(bv.known(0b11, 2));
  });

  it('give STA no self-edge from an inout pin to itself, so no false cycle', () => {
    const b = board({
      components: [
        comp('t', 'toggle'),
        comp('e', 'constant', { value: 1 }),
        comp('U1', BIDIR, undefined, 'U1'),
        comp('l', 'led', undefined, 'LP'),
      ],
      wires: [
        wire('w1', ['t', 'y'], ['U1', 'd']),
        wire('w2', ['e', 'y'], ['U1', 'en']),
        wire('w3', ['U1', 'p'], ['l', 'a']),
      ],
    });
    const report = analyzeTiming(compile(b, noLib), { column: 'typ' });
    const lp = report.endpoints.find((e) => e.endpoint === 'main/LP');
    expect(lp?.critical.map((h) => h.path)).toEqual(['main/U1']);
  });

  it('still report a gate wired to its own input as a cycle', () => {
    const b = board({
      components: [comp('g', 'not')],
      wires: [wire('w1', ['g', 'y'], ['g', 'a'])],
    });
    expect(() => analyzeTiming(compile(b, noLib), { column: 'typ' })).toThrow(TimingError);
  });
});
