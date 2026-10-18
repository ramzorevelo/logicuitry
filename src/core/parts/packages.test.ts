import { describe, expect, it } from 'vitest';
import { compile } from '../model/compile';
import type { ChipDef, ChipLibrary } from '../model/types';
import { datasheetDelay } from '../sim/delay';
import { getPrimitive } from '../sim/primitives/registry';
import { timingShape } from '../timing/shape';
import * as bv from '../value/busValue';
import { arcFigure } from './arcs';
import {
  buildPackageChipDef,
  builtinChipLibrary,
  isBuiltinChipDef,
  isBuiltinChipId,
  packageCore,
  packageEntries,
  partCore,
  type PackageCore,
  type PackageEntry,
} from './packages';
import { getPart, propagationNs, typPublished } from './partsDb';
import { run } from './testHarness';

/**
 * The input -> output arcs a datasheet times for this core. A combinational
 * core times every pair. A clocked one times its clock to every output, its
 * through arcs, and each async input to the stored outputs; a sampled input
 * has no arc to Q, and a clock inhibit clocks the part through the clock path.
 */
function timedArcs(core: PackageCore): [string, string][] {
  const params = core.params ?? {};
  const pins = getPrimitive(core.kind).pins(params);
  const ins = pins.filter((p) => p.dir === 'in').map((p) => p.name);
  const outs = pins.filter((p) => p.dir === 'out').map((p) => p.name);
  const shape = timingShape(core.kind, params);
  if (!shape) return outs.flatMap((o) => ins.map((i): [string, string] => [i, o]));
  const arcs: [string, string][] = [];
  const stored = outs.filter((o) => o !== 'tc');
  for (const [pin, timing] of shape.pins) {
    if (timing === 'clock') arcs.push(...outs.map((o): [string, string] => [pin, o]));
    if (timing === 'arrival' && pin !== 'inh')
      arcs.push(...stored.map((o): [string, string] => [pin, o]));
  }
  arcs.push(...shape.through.map((t): [string, string] => [t.from, t.to]));
  return arcs;
}

const goldens = import.meta.glob('./chips/*.chip.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>;

const lib: ChipLibrary = builtinChipLibrary();

describe('74-series package pinouts', () => {
  it('every entry is datasheet-verified and cites its source', () => {
    for (const e of packageEntries()) {
      expect(e.verified, e.part).toBe(true);
      expect(e.source.length, e.part).toBeGreaterThan(0);
    }
  });

  it('numbers pins 1..N with exactly one VCC and one GND', () => {
    for (const e of packageEntries()) {
      const width = Number(e.package.replace(/\D/g, ''));
      expect(
        e.pins.map((p) => p.pin).sort((a, b) => a - b),
        e.part,
      ).toEqual(Array.from({ length: width }, (_, i) => i + 1));
      expect(e.pins.filter((p) => p.fn === 'vcc').length, e.part).toBe(1);
      expect(e.pins.filter((p) => p.fn === 'gnd').length, e.part).toBe(1);
    }
  });

  it("the '47 and '48 are pin-identical, as both datasheets have them", () => {
    const names = (part: string) =>
      packageEntries()
        .find((e) => e.part === part)!
        .pins.map((p) => `${p.pin}:${p.name}`);
    expect(names('74LS47')).toEqual(names('74LS48'));
  });
});

describe('generated ChipDefs', () => {
  it('match the committed goldens', () => {
    for (const e of packageEntries()) {
      expect(buildPackageChipDef(e), e.part).toEqual(goldens[`./chips/${e.part}.chip.json`]);
    }
  });

  it('expose one boundary pin per package pin, in pin order', () => {
    for (const e of packageEntries()) {
      const def = lib.get(e.part)!;
      expect(
        def.pins.map((p) => p.name),
        e.part,
      ).toEqual([...e.pins].sort((a, b) => a.pin - b.pin).map((p) => p.name));
      expect(def.appearance?.package, e.part).toBe(e.package);
    }
  });

  it('bind every boundary pin to a port component that exists', () => {
    for (const e of packageEntries()) {
      const def = lib.get(e.part)!;
      for (const pin of def.pins) {
        const port = def.components.find((c) => c.id === pin.boundComponent);
        expect(port, `${e.part} ${pin.name}`).toBeDefined();
        expect(port!.kind).toBe(pin.dir === 'out' ? 'outport' : 'inport');
      }
    }
  });

  it('compiles every part without error', () => {
    for (const e of packageEntries())
      expect(() => compile(lib.get(e.part)!, lib), e.part).not.toThrow();
  });
});

describe('power gating', () => {
  it('floats every output to Z with no rails wired', () => {
    const v = run('74LS08', { '1A': true, '1B': true, VCC: null, GND: null });
    expect(v('1Y')).toBe('Z');
  });

  it('floats every output when only GND is wired', () => {
    const v = run('74LS08', { '1A': true, '1B': true, GND: false, VCC: null });
    expect(v('1Y')).toBe('Z');
  });

  it('drives the gate once both rails are wired', () => {
    const v = run('74LS08', { '1A': true, '1B': true, VCC: true, GND: false });
    expect(v('1Y')).toBe('1');
  });

  it('floats again when VCC is pulled low', () => {
    const v = run('74LS08', { '1A': true, '1B': true, VCC: false, GND: false });
    expect(v('1Y')).toBe('Z');
  });
});

describe('gate packages', () => {
  const cases: [string, string, string, boolean, boolean, string][] = [
    ['74LS00', '1A', '1B', true, true, '0'],
    ['74LS00', '1A', '1B', true, false, '1'],
    ['74LS02', '1A', '1B', false, false, '1'],
    ['74LS02', '1A', '1B', true, false, '0'],
    ['74LS08', '1A', '1B', true, false, '0'],
    ['74LS32', '1A', '1B', true, false, '1'],
    ['74LS86', '1A', '1B', true, true, '0'],
    ['74LS86', '1A', '1B', true, false, '1'],
  ];
  for (const [part, a, b, va, vb, want] of cases) {
    it(`${part} ${a}=${Number(va)} ${b}=${Number(vb)} -> ${want}`, () => {
      const v = run(part, { [a]: va, [b]: vb, VCC: true, GND: false });
      expect(v('1Y')).toBe(want);
    });
  }

  it('74LS04 inverts', () => {
    expect(run('74LS04', { '1A': true, VCC: true, GND: false })('1Y')).toBe('0');
    expect(run('74LS04', { '1A': false, VCC: true, GND: false })('1Y')).toBe('1');
  });

  it('drives each of a quad package four gates independently', () => {
    const v = run('74LS08', {
      '1A': true,
      '1B': true,
      '2A': true,
      '2B': false,
      VCC: true,
      GND: false,
    });
    expect(v('1Y')).toBe('1');
    expect(v('2Y')).toBe('0');
  });
});

describe('parts DB timing for the display decoders', () => {
  for (const part of ['74LS47', '74LS48']) {
    it(`${part} publishes a max column only`, () => {
      const entry = getPart(part)!;
      expect(entry.paths!['a_to_seg']!.tplh!.typ).toBeUndefined();
      expect(typPublished(part)).toBe(false);
      // Asking for typ falls back to the published max rather than inventing one.
      expect(propagationNs(part, 'lh', 'typ')).toBe(100);
      expect(propagationNs(part, 'lh', 'max')).toBe(100);
    });
  }

  it('still reports a real typ for a part that publishes one', () => {
    expect(typPublished('74LS00')).toBe(true);
    expect(propagationNs('74LS00', 'lh', 'typ')).toBe(9);
  });
});

/** A package that exists only here, so the generator is tested ahead of the parts that need it. */
function fixture(
  pins: PackageEntry['pins'],
  core: PackageCore,
  over: Partial<PackageEntry> = {},
): { entry: PackageEntry; def: ChipDef; lib: ChipLibrary } {
  const entry: PackageEntry = {
    part: 'FIXTURE',
    package: `DIP${pins.length}`,
    device: 'generator fixture',
    primitive: 'fixture',
    gates: 2,
    verified: false,
    source: 'none',
    pins,
    ...over,
  };
  const def = buildPackageChipDef(entry, core);
  return { entry, def, lib: new Map([[def.id, def]]) };
}

/** Two 2:1 muxes sharing one select and one enable, the shape of a '157. */
const dualMux = () =>
  fixture(
    [
      { pin: 1, name: 'S', gate: 'all', fn: 's0' },
      { pin: 2, name: '1A', gate: 1, fn: 'd0' },
      { pin: 3, name: '1B', gate: 1, fn: 'd1' },
      { pin: 4, name: '1Y', gate: 1, fn: 'y' },
      { pin: 5, name: 'NC', fn: 'nc' },
      { pin: 6, name: 'GND', fn: 'gnd' },
      { pin: 7, name: '2Y', gate: 2, fn: 'y' },
      { pin: 8, name: '2B', gate: 2, fn: 'd1' },
      { pin: 9, name: '2A', gate: 2, fn: 'd0' },
      { pin: 10, name: 'G', gate: [1, 2], fn: 'en' },
      { pin: 11, name: 'NC2', fn: 'nc' },
      { pin: 12, name: 'VCC', fn: 'vcc' },
    ],
    { kind: 'mux', params: { selectBits: 1, hasEnable: true } },
  );

const wiresFrom = (def: ChipDef, port: string) =>
  def.wires.filter((w) => w.a.kind === 'pin' && w.a.component === port);

describe('generator: shared pins', () => {
  it('wires one port to every section it serves', () => {
    const { def } = dualMux();
    for (const [port, fn] of [
      ['p1', 's0'],
      ['p10', 'en'],
    ] as const) {
      const targets = wiresFrom(def, port).map((w) => (w.b.kind === 'pin' ? w.b : null));
      expect(targets).toEqual([
        { kind: 'pin', component: 'u1', pin: fn },
        { kind: 'pin', component: 'u2', pin: fn },
      ]);
    }
    expect(wiresFrom(def, 'p2')).toHaveLength(1);
  });

  it('takes pin direction and role from the core primitive, not from the name', () => {
    const { def } = dualMux();
    const pin = (name: string) => def.pins.find((p) => p.name === name)!;
    expect(pin('1Y').dir).toBe('out');
    expect(pin('1A').dir).toBe('in');
    expect(pin('S').role).toBe('select');
    expect(pin('G').role).toBe('enable');
    expect(pin('NC').dir).toBe('in');
    expect(wiresFrom(def, 'p5')).toHaveLength(0);
  });

  it('one select steers both sections', () => {
    const drive = { '1A': true, '1B': false, '2A': false, '2B': true, G: true, VCC: true };
    const { lib: fx } = dualMux();
    const a = run('FIXTURE', { ...drive, S: false, GND: false }, fx);
    expect([a('1Y'), a('2Y')]).toEqual(['1', '0']);
    const b = run('FIXTURE', { ...drive, S: true, GND: false }, fx);
    expect([b('1Y'), b('2Y')]).toEqual(['0', '1']);
  });

  it('refuses a pinout the core cannot carry', () => {
    const core: PackageCore = { kind: 'mux', params: { selectBits: 1 } };
    const power = [
      { pin: 3, name: 'GND', fn: 'gnd' },
      { pin: 4, name: 'VCC', fn: 'vcc' },
    ];
    const build =
      (pins: PackageEntry['pins'], c = core) =>
      () =>
        fixture(pins, c, { gates: 1 });
    expect(build([{ pin: 1, name: 'X', gate: 1, fn: 'strobe' }, ...power])).toThrow(
      /no pin 'strobe'/,
    );
    expect(
      build([{ pin: 1, name: 'A', gate: 1, fn: 'a' }, ...power], {
        kind: 'decoder',
        params: { addressBits: 3 },
      }),
    ).toThrow(/is a bus/);
    expect(() => fixture([{ pin: 1, name: 'Y', gate: 'all', fn: 'y' }, ...power], core)).toThrow(
      /exactly one section/,
    );
  });
});

describe('generator: output enable', () => {
  const gated = () =>
    fixture(
      [
        { pin: 1, name: '/OE', fn: 'oe' },
        { pin: 2, name: '1A', gate: 1, fn: 'a' },
        { pin: 3, name: '1B', gate: 1, fn: 'b' },
        { pin: 4, name: '1Y', gate: 1, fn: 'y' },
        { pin: 5, name: 'GND', fn: 'gnd' },
        { pin: 6, name: '2Y', gate: 2, fn: 'y' },
        { pin: 7, name: '2A', gate: 2, fn: 'a' },
        { pin: 8, name: '2B', gate: 2, fn: 'b' },
        { pin: 9, name: 'NC', fn: 'nc' },
        { pin: 10, name: 'VCC', fn: 'vcc' },
      ],
      { kind: 'and' },
    );
  const ins = { '1A': true, '1B': true, '2A': true, '2B': false };

  it('builds the term once and feeds it to every output buffer', () => {
    const { def } = gated();
    expect(def.components.filter((c) => c.id.startsWith('oe_')).map((c) => c.id)).toEqual([
      'oe_inv',
      'oe_ok',
    ]);
    const enables = def.wires.filter((w) => w.b.kind === 'pin' && w.b.pin === 'en');
    expect(enables).toHaveLength(2);
    for (const w of enables) expect(w.a).toEqual({ kind: 'pin', component: 'oe_ok', pin: 'y' });
    expect(def.pins.find((p) => p.name === '/OE')!.role).toBe('enable');
  });

  it('drives when /OE is low, floats when it is high or the chip is unpowered', () => {
    const { lib: fx } = gated();
    const on = run('FIXTURE', { ...ins, '/OE': false, VCC: true, GND: false }, fx);
    expect([on('1Y'), on('2Y')]).toEqual(['1', '0']);
    const off = run('FIXTURE', { ...ins, '/OE': true, VCC: true, GND: false }, fx);
    expect([off('1Y'), off('2Y')]).toEqual(['Z', 'Z']);
    const dead = run('FIXTURE', { ...ins, '/OE': false, VCC: null, GND: null }, fx);
    expect(dead('1Y')).toBe('Z');
  });

  it('an unwired /OE leaves the outputs unknown, like any floating input', () => {
    const { lib: fx } = gated();
    const v = run('FIXTURE', { ...ins, '/OE': null, VCC: true, GND: false }, fx);
    expect(v('1Y')).toBe('X');
  });

  it('adds no enable term to a part without the pin', () => {
    expect(lib.get('74LS00')!.components.some((c) => c.id.startsWith('oe_'))).toBe(false);
  });
});

describe('generator: part binding', () => {
  it('every core primitive of a shipped part compiles bound to that part', () => {
    for (const e of packageEntries()) {
      const c = compile(lib.get(e.part)!, lib);
      const cores = c.primitives.filter(
        (p) => p.kind === packageCore(e).kind && !p.params['delay'],
      );
      expect(cores.length, e.part).toBe(e.gates);
      for (const p of cores) expect(p.part, e.part).toBe(e.part);
    }
  });

  it('names the part where the primitive would default to another', () => {
    const pins = [
      { pin: 1, name: 'A', gate: 1, fn: 'a0' },
      { pin: 2, name: 'B', gate: 1, fn: 'a1' },
      { pin: 3, name: 'GND', fn: 'gnd' },
      { pin: 4, name: 'Y0', gate: 1, fn: 'y0' },
      { pin: 5, name: 'Y1', gate: 1, fn: 'y1' },
      { pin: 6, name: 'VCC', fn: 'vcc' },
    ];
    const core: PackageCore = {
      kind: 'decoder',
      params: { addressBits: 2, pinView: 'a=expanded' },
    };
    const { def } = fixture(pins, core, { part: '74LS139', gates: 1 });
    expect(def.components.find((c) => c.id === 'u1')!.params!['part']).toBe('74LS139');
    const same = fixture(pins, core, { part: '74LS138', gates: 1 });
    expect(same.def.components.find((c) => c.id === 'u1')!.params!['part']).toBeUndefined();
  });
});

describe('generator: faithful cores', () => {
  const power = (gnd: number, vcc: number) => [
    { pin: gnd, name: 'GND', fn: 'gnd' },
    { pin: vcc, name: 'VCC', fn: 'vcc' },
  ];
  // Not the datasheet pinouts: just enough pins to build a section of each part.
  const half139 = (): PackageEntry => ({
    ...dualMux().entry,
    part: '74LS139',
    gates: 1,
    pins: [
      { pin: 1, name: '/G', gate: 1, fn: 'enl0' },
      { pin: 2, name: 'A', gate: 1, fn: 'a0' },
      { pin: 3, name: 'B', gate: 1, fn: 'a1' },
      { pin: 4, name: '/Y0', gate: 1, fn: 'y0' },
      ...power(5, 6),
    ],
  });
  const stub154 = (): PackageEntry => ({
    ...dualMux().entry,
    part: '74LS154',
    package: 'DIP24W',
    gates: 1,
    pins: [
      { pin: 1, name: '/Y0', gate: 1, fn: 'y0' },
      { pin: 2, name: 'A', gate: 1, fn: 'a0' },
      { pin: 3, name: '/G1', gate: 1, fn: 'enl0' },
      ...power(4, 5),
    ],
  });
  const corePrim = (entry: PackageEntry) => {
    const def = buildPackageChipDef(entry);
    const c = compile(def, new Map([[def.id, def]]));
    return c.primitives.find((p) => p.kind === 'decoder')!;
  };

  it("a '139 section takes '139 timing and a '154 takes '154 timing", () => {
    const typ = datasheetDelay('typ');
    const fall = (entry: PackageEntry) =>
      typ.delayPs(corePrim(entry), 0, bv.known(1, 1), bv.known(0, 1));
    expect(corePrim(half139()).part).toBe('74LS139');
    expect(corePrim(stub154()).part).toBe('74LS154');
    // Slowest falling arc into a Y: '139 select 25 ns, '154 select 30 ns; the
    // decoder's default '138 would have answered 20 ns for both.
    expect(fall(half139())).toBe(25_000);
    expect(fall(stub154())).toBe(30_000);
  });

  it('carries the wide package name through to the def', () => {
    expect(buildPackageChipDef(stub154()).appearance?.package).toBe('DIP24W');
  });

  it('prints an active-low output low when selected', () => {
    const def = buildPackageChipDef(half139());
    const fx: ChipLibrary = new Map([[def.id, def]]);
    const sel = run('74LS139', { '/G': false, A: false, B: false, VCC: true, GND: false }, fx);
    expect(sel('/Y0')).toBe('0');
    const off = run('74LS139', { '/G': true, A: false, B: false, VCC: true, GND: false }, fx);
    expect(off('/Y0')).toBe('1');
  });

  it('every arc of a shipped part with per-arc rows is published, none falls back', () => {
    for (const e of packageEntries()) {
      if (!getPart(e.part)?.paths) continue;
      const core = packageCore(e);
      for (const [inp, out] of timedArcs(core))
        expect(arcFigure(e.part, inp, out), `${e.part} ${inp}->${out}`).toBeDefined();
    }
  });

  it('a clocked part times its clock, through and async arcs, never a sampled pin', () => {
    const arcs = (part: string) => timedArcs(partCore(part)!).map(([i, o]) => `${i}->${o}`);
    expect(arcs('74LS161')).toContain('clr->q0');
    expect(arcs('74LS161')).toContain('ent->tc');
    expect(arcs('74LS163')).not.toContain('clr->q0');
    expect(arcs('74LS163').some((a) => /^(d\d|load|enp)->/.test(a))).toBe(false);
    expect(arcs('74LS165')).toContain('d7->so');
    expect(arcs('74LS165').some((a) => a.startsWith('inh->'))).toBe(false);
  });
});

describe('built-in identity', () => {
  it('is the def object, so a user chip under a part number is not built in', () => {
    const builtin = lib.get('74LS00')!;
    expect(isBuiltinChipDef(builtin)).toBe(true);
    expect(isBuiltinChipDef({ ...builtin })).toBe(false);
    expect(isBuiltinChipId('74LS00')).toBe(true);
    expect(isBuiltinChipId('my-adder')).toBe(false);
  });
});
