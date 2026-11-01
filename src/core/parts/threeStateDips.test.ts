import { describe, expect, it } from 'vitest';
import { compile } from '../model/compile';
import { datasheetDelay, idealDelay, type DelayModel } from '../sim/delay';
import {
  buildPackageChipDef,
  builtinChipLibrary,
  getPackage,
  partCore,
  type PackageEntry,
} from './packages';
import { bench, run, type Drive } from './testHarness';

const lib = builtinChipLibrary();
const LS173 = getPackage('74LS173')!;
const LS245 = getPackage('74LS245')!;
const LS189 = getPackage('74LS189')!;
const powered = { VCC: true, GND: false } as const;
const unpowered = { VCC: null, GND: null } as const;
const outPins = (entry: PackageEntry) =>
  lib
    .get(entry.part)!
    .pins.filter((p) => p.dir !== 'in')
    .map((p) => p.name);
const read = (v: (pin: string) => string, pins: string[]) => pins.map(v).join('');
const MODELS: [string, DelayModel][] = [
  ['ideal', idealDelay],
  ['datasheet typ', datasheetDelay('typ')],
  ['datasheet max', datasheetDelay('max')],
];

describe('three-state DIPs: generated structure', () => {
  it('wire the core outputs straight to the ports, with no power buffers', () => {
    for (const entry of [LS173, LS245, LS189]) {
      const def = lib.get(entry.part)!;
      expect(
        def.components.some((c) => c.kind === 'tristate'),
        entry.part,
      ).toBe(false);
      const enable = partCore(entry.part)!.enablePin!;
      const fed = def.wires.filter((w) => w.b.kind === 'pin' && w.b.pin === enable);
      expect(fed.length, entry.part).toBe(entry.gates);
      for (const w of fed) expect(w.a).toEqual({ kind: 'pin', component: 'oe_ok', pin: 'y' });
    }
  });

  it("join the '173's M and N in one NOR beside the power gate", () => {
    const def = lib.get('74LS173')!;
    const inv = def.components.find((c) => c.id === 'oe_inv')!;
    expect(inv.kind).toBe('nor');
    expect(inv.params).toEqual({ delay: 'none', inputs: 2 });
    expect(def.components.filter((c) => c.id.startsWith('oe_'))).toHaveLength(2);
  });

  it("give the '245's A and B sides inout pins bound to output ports", () => {
    const def = lib.get('74LS245')!;
    for (const name of ['A1', 'A8', 'B1', 'B8']) {
      const pin = def.pins.find((p) => p.name === name)!;
      expect(pin.dir, name).toBe('inout');
      expect(def.components.find((c) => c.id === pin.boundComponent)!.kind).toBe('outport');
    }
    expect(def.pins.find((p) => p.name === 'DIR')!.dir).toBe('in');
  });

  it('compile with the part bound on every core', () => {
    for (const entry of [LS173, LS245, LS189]) {
      const c = compile(lib.get(entry.part)!, lib);
      const cores = c.primitives.filter((p) => p.kind === partCore(entry.part)!.kind);
      expect(cores.length, entry.part).toBe(entry.gates);
      for (const p of cores) expect(p.part).toBe(entry.part);
    }
  });

  it('refuse a floating core with no enable pin, and an enable pin on a plain core', () => {
    const { kind, params } = partCore('74LS173')!;
    expect(() => buildPackageChipDef(LS173, { kind, ...(params ? { params } : {}) })).toThrow(
      /floats its outputs/,
    );
    const plain = { kind: 'register' as const, params: { dualEnable: true }, enablePin: 'en' };
    expect(() => buildPackageChipDef(LS173, plain)).toThrow(/no output that floats/);
    const wiredEnable: PackageEntry = {
      ...LS189,
      pins: LS189.pins.map((p) => (p.name === '/WE' ? { ...p, fn: 'cs' } : p)),
    };
    expect(() => buildPackageChipDef(wiredEnable)).toThrow(/takes the enable term/);
  });
});

describe('three-state DIPs: unpowered', () => {
  const cases: [PackageEntry, Record<string, Drive>][] = [
    [LS173, { M: 'x', N: 'x', CLK: 'x', '/G1': 'x', '/G2': 'x', CLR: 'x' }],
    [LS245, { DIR: 'x', '/OE': 'x' }],
    [LS189, { '/CS': 'x', '/WE': 'x', A0: 'x' }],
  ];
  for (const [entry, controls] of cases) {
    it(`${entry.part} floats every output and inout pin with its controls at X`, () => {
      const pins = outPins(entry);
      const v = run(entry.part, { ...controls, ...unpowered }, lib);
      expect(read(v, pins)).toBe('Z'.repeat(pins.length));
      const groundOnly = run(entry.part, { ...controls, VCC: null, GND: false }, lib);
      expect(read(groundOnly, pins)).toBe('Z'.repeat(pins.length));
    });
  }

  it('74LS245 floats its far side unpowered while one side is driven', () => {
    const a = Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map((g) => [`A${g}`, g % 2 === 1]));
    const v = run('74LS245', { ...a, DIR: true, '/OE': false, ...unpowered }, lib);
    expect(read(v, ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8'])).toBe('ZZZZZZZZ');
    expect(read(v, ['A1', 'A2'])).toBe('10');
  });
});

describe('74LS173 through its package pins', () => {
  const Q = ['1Q', '2Q', '3Q', '4Q'];
  /** Loads 1D..4D = 1,0,1,1 with M, N, /G1, /G2 and CLR all low. */
  const loaded = (delay: DelayModel = idealDelay) => {
    const b = bench('74LS173', lib, delay);
    for (const [pin, level] of [
      ['1D', true],
      ['3D', true],
      ['4D', true],
    ] as const)
      b.set(pin, level);
    b.set('CLK', true);
    return b;
  };

  for (const [name, model] of MODELS) {
    it(`loads on a clock edge and drives Q with M and N low (${name})`, () => {
      const b = loaded(model);
      expect(Q.map(b.read).join('')).toBe('1011');
    });
  }

  it('M alone and N alone each float the outputs, keeping the stored word', () => {
    const b = loaded();
    b.set('M', true);
    expect(Q.map(b.read).join('')).toBe('ZZZZ');
    b.set('M', false);
    expect(Q.map(b.read).join('')).toBe('1011');
    b.set('N', true);
    expect(Q.map(b.read).join('')).toBe('ZZZZ');
    b.set('N', false);
    expect(Q.map(b.read).join('')).toBe('1011');
  });

  it('an unknown M gives X on the outputs while powered', () => {
    const v = run('74LS173', { M: 'x', N: false, CLR: true, ...powered }, lib);
    expect(Q.map(v).join('')).toBe('XXXX');
  });

  it('/G1 high or /G2 high holds the word across a clock edge', () => {
    for (const gate of ['/G1', '/G2']) {
      const b = loaded();
      b.set('CLK', false);
      b.set(gate, true);
      for (const pin of ['1D', '2D', '3D', '4D']) b.set(pin, false);
      b.set('CLK', true);
      expect(Q.map(b.read).join(''), gate).toBe('1011');
    }
  });

  it('CLR clears whatever the clock and enables do', () => {
    const b = loaded();
    b.set('/G1', true);
    b.set('CLR', true);
    expect(Q.map(b.read).join('')).toBe('0000');
  });
});

describe('74LS245 through its package pins', () => {
  const A = [1, 2, 3, 4, 5, 6, 7, 8].map((g) => `A${g}`);
  const B = [1, 2, 3, 4, 5, 6, 7, 8].map((g) => `B${g}`);
  const pattern = [true, false, true, true, false, false, true, false];
  const side = (names: string[]) => Object.fromEntries(names.map((n, i) => [n, pattern[i]!]));

  for (const [name, model] of MODELS) {
    it(`DIR high drives B from A, DIR low drives A from B (${name})`, () => {
      const ab = run('74LS245', { ...side(A), DIR: true, '/OE': false, ...powered }, lib, model);
      expect(read(ab, B)).toBe('10110010');
      expect(read(ab, A)).toBe('10110010');
      const ba = run('74LS245', { ...side(B), DIR: false, '/OE': false, ...powered }, lib, model);
      expect(read(ba, A)).toBe('10110010');
    });
  }

  it('/OE high floats both sides', () => {
    const idle = run('74LS245', { DIR: true, '/OE': true, ...powered }, lib);
    expect(read(idle, [...A, ...B])).toBe('Z'.repeat(16));
    const driven = run('74LS245', { ...side(A), DIR: true, '/OE': true, ...powered }, lib);
    expect(read(driven, B)).toBe('ZZZZZZZZ');
  });

  it('an unknown DIR while enabled gives X on both sides', () => {
    const v = run('74LS245', { DIR: 'x', '/OE': false, ...powered }, lib);
    expect(read(v, [...A, ...B])).toBe('X'.repeat(16));
  });
});

describe('74LS189 through its package pins', () => {
  const O = ['/O1', '/O2', '/O3', '/O4'];
  const address = (b: ReturnType<typeof bench>, n: number) =>
    ['A0', 'A1', 'A2', 'A3'].forEach((pin, i) => b.set(pin, ((n >> i) & 1) === 1));
  const data = (b: ReturnType<typeof bench>, bits: string) =>
    ['D1', 'D2', 'D3', 'D4'].forEach((pin, i) => b.set(pin, bits[i] === '1'));

  for (const [name, model] of MODELS) {
    it(`a write floats the pins, then a read gives the complement (${name})`, () => {
      const b = bench('74LS189', lib, model);
      b.set('/WE', true);
      address(b, 5);
      data(b, '1011');
      b.set('/WE', false);
      expect(O.map(b.read).join('')).toBe('ZZZZ');
      b.set('/WE', true);
      expect(O.map(b.read).join('')).toBe('0100');
    });
  }

  it('reads X from a cell never written, and Z when deselected', () => {
    const b = bench('74LS189', lib);
    b.set('/WE', true);
    address(b, 9);
    expect(O.map(b.read).join('')).toBe('XXXX');
    b.set('/CS', true);
    expect(O.map(b.read).join('')).toBe('ZZZZ');
  });

  it('keeps its cells while deselected and drives them again once selected', () => {
    const b = bench('74LS189', lib);
    b.set('/WE', true);
    address(b, 3);
    data(b, '0110');
    b.set('/WE', false);
    b.set('/WE', true);
    b.set('/CS', true);
    data(b, '1111');
    b.set('/WE', false);
    expect(O.map(b.read).join('')).toBe('ZZZZ');
    b.set('/WE', true);
    b.set('/CS', false);
    expect(O.map(b.read).join('')).toBe('1001');
  });
});
