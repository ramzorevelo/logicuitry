import { describe, expect, it } from 'vitest';
import { compile } from '../model/compile';
import type { ChipLibrary, ComponentKind } from '../model/types';
import { board, comp, srLatchDef, wire } from '../model/testFixtures';
import { hasPrimitive, registerPrimitive } from '../sim/primitives/registry';
import * as bv from '../value/busValue';
import { builtinChipLibrary } from '../parts/packages';
import { codecPathKey } from '../parts/arcs';
import { analyzeTiming, outputDelayPs, TimingError } from './sta';

const noLib: ChipLibrary = new Map();

// Registered below rather than built in, so it is not in ComponentKind's
// closed set of shipped kinds -- the registry itself stays open.
const ADDER4 = 'adder4' as ComponentKind;

// Minimal 4-bit-adder stand-in so 74LS283 per-path figures are exercisable.
if (!hasPrimitive('adder4'))
  registerPrimitive({
    kind: 'adder4',
    defaultPart: '74LS283',
    pins: () => [
      { name: 'a', dir: 'in', width: 1, role: 'data', order: 0 },
      { name: 'b', dir: 'in', width: 1, role: 'data', order: 1 },
      { name: 'cin', dir: 'in', width: 1, role: 'data', order: 2 },
      { name: 'sum', dir: 'out', width: 1, role: 'data', order: 0 },
      { name: 'cout', dir: 'out', width: 1, role: 'data', order: 1 },
    ],
    evaluate: () => ({ outputs: [bv.allX(1), bv.allX(1)] }),
  });

describe('analyzeTiming combinational', () => {
  it('sums a 74LS00 chain hand-computed at typ and max', () => {
    // toggle -> nand x3 -> led; 74LS00 t_pd typ max(9,10)=10 ns, max col 15 ns.
    const b = board({
      components: [
        comp('t', 'toggle'),
        comp('n1', 'nand'),
        comp('n2', 'nand'),
        comp('n3', 'nand'),
        comp('l', 'led'),
      ],
      wires: [
        wire('w1', ['t', 'y'], ['n1', 'a']),
        wire('w2', ['t', 'y'], ['n1', 'b']),
        wire('w3', ['n1', 'y'], ['n2', 'a']),
        wire('w4', ['n1', 'y'], ['n2', 'b']),
        wire('w5', ['n2', 'y'], ['n3', 'a']),
        wire('w6', ['n2', 'y'], ['n3', 'b']),
        wire('w7', ['n3', 'y'], ['l', 'a']),
      ],
    });
    const c = compile(b, noLib);

    const typ = analyzeTiming(c, { column: 'typ' });
    expect(typ.worst?.endpoint).toBe('main/l');
    expect(typ.worst?.startpoint).toBe('main/t');
    expect(typ.worst?.totalTpdPs).toBe(30_000);
    // t_cd = min(round(.35*9), round(.35*10)) = 3 ns per hop.
    expect(typ.worst?.totalTcdPs).toBe(9_000);
    expect(typ.worst?.critical.map((h) => h.path)).toEqual(['main/n1', 'main/n2', 'main/n3']);
    expect(typ.worst?.estimated).toBe(true);

    const max = analyzeTiming(c, { column: 'max' });
    expect(max.worst?.totalTpdPs).toBe(45_000);
    expect(max.sequential).toBeNull();
  });

  it('uses 74LS283 per-path figures: carry chain beats ab_to_sum', () => {
    const b = board({
      components: [
        comp('c0', 'toggle'),
        comp('ta', 'toggle'),
        comp('a1', ADDER4),
        comp('a2', ADDER4),
        comp('a3', ADDER4),
        comp('l', 'led'),
      ],
      wires: [
        wire('w1', ['c0', 'y'], ['a1', 'cin']),
        wire('w2', ['ta', 'y'], ['a1', 'a']),
        wire('w3', ['a1', 'cout'], ['a2', 'cin']),
        wire('w4', ['a2', 'cout'], ['a3', 'cin']),
        wire('w5', ['a3', 'sum'], ['l', 'a']),
      ],
    });
    const r = analyzeTiming(compile(b, noLib), { column: 'typ' });
    // Critical: a1 ab_to_cout max(11,12)=12 + a2 cin_to_cout 11 + a3
    // cin_to_sum 16 = 39 ns down the carry chain, past a3's direct
    // ab_to_sum 15 ns arc (and past the cin launch, 11+11+16 = 38 ns).
    expect(r.worst?.totalTpdPs).toBe(39_000);
    expect(r.worst?.startpoint).toBe('main/ta');
    expect(r.worst?.critical.map((h) => h.tpdPs)).toEqual([12_000, 11_000, 16_000]);
    expect(r.worst?.critical.map((h) => h.path)).toEqual(['main/a1', 'main/a2', 'main/a3']);
  });

  it('falls back to 10 ns for an unbound part', () => {
    const b = board({
      components: [comp('t', 'toggle'), comp('g', 'xnor'), comp('l', 'led')],
      wires: [
        wire('w1', ['t', 'y'], ['g', 'a']),
        wire('w2', ['t', 'y'], ['g', 'b']),
        wire('w3', ['g', 'y'], ['l', 'a']),
      ],
    });
    const r = analyzeTiming(compile(b, noLib), { column: 'typ' });
    expect(r.worst?.totalTpdPs).toBe(10_000);
    expect(r.worst?.totalTcdPs).toBe(3_500);
  });

  it('refuses the SR latch combinational cycle naming its members', () => {
    const c = compile(srLatchDef(), noLib);
    expect(() => analyzeTiming(c, { column: 'typ' })).toThrowError(TimingError);
    try {
      analyzeTiming(c, { column: 'typ' });
    } catch (e) {
      const paths = (e as TimingError).cyclePaths;
      expect(paths).toContain('main/g1');
      expect(paths).toContain('main/g2');
    }
  });
});

describe('analyzeTiming sequential', () => {
  it('passes a registered cycle and reports H&H-style slack terms', () => {
    // clock -> dff, q -> not -> d: registered feedback, no comb cycle.
    const b = board({
      components: [comp('ck', 'clock'), comp('ff', 'dff'), comp('n1', 'not'), comp('l', 'led')],
      wires: [
        wire('w1', ['ck', 'y'], ['ff', 'clk']),
        wire('w2', ['ff', 'q'], ['n1', 'a']),
        wire('w3', ['n1', 'y'], ['ff', 'd']),
        wire('w4', ['ff', 'q'], ['l', 'a']),
      ],
    });
    const r = analyzeTiming(compile(b, noLib), { column: 'typ' });

    const ep = r.endpoints.find((e) => e.endpoint === 'main/ff.d');
    expect(ep?.critical.map((h) => h.path)).toEqual(['main/n1']);

    expect(r.sequential?.multiDomain).toBe(false);
    const p = r.sequential!.paths[0]!;
    expect(p.launch).toBe('main/ff');
    expect(p.capture).toBe('main/ff');
    // 74LS74 typ: t_pcq = max(13,25) = 25 ns, t_ccq = min(5,9) = 5 ns.
    expect(p.tpcqPs).toBe(25_000);
    expect(p.tccqPs).toBe(5_000);
    expect(p.tsetupPs).toBe(20_000);
    expect(p.tholdPs).toBe(5_000);
    expect(p.tpdCombPs).toBe(10_000);
    expect(p.tcdCombPs).toBe(3_000);
    // Tc default 10 ns: slack = 10 - (25 + 10 + 20 + 0) = -45 ns.
    expect(p.setupSlackPs).toBe(-45_000);
    expect(p.holdMarginPs).toBe(3_000);
    expect(r.sequential?.minPeriodPs).toBe(55_000);
  });

  it('applies skew from clock phasePs across two flops', () => {
    const b = board({
      components: [
        comp('ck1', 'clock', { periodPs: 40_000 }),
        comp('ck2', 'clock', { periodPs: 40_000, phasePs: 5_000 }),
        comp('f1', 'dff'),
        comp('f2', 'dff'),
      ],
      wires: [
        wire('w1', ['ck1', 'y'], ['f1', 'clk']),
        wire('w2', ['ck2', 'y'], ['f2', 'clk']),
        wire('w3', ['f1', 'q'], ['f2', 'd']),
      ],
    });
    const r = analyzeTiming(compile(b, noLib), { column: 'typ' });
    const p = r.sequential!.paths.find((x) => x.launch === 'main/f1' && x.capture === 'main/f2')!;
    expect(p.skewPs).toBe(5_000);
    expect(p.tpdCombPs).toBe(0);
    expect(p.setupSlackPs).toBe(40_000 - (25_000 + 0 + 20_000 + 5_000));
    expect(p.holdMarginPs).toBe(5_000 - (5_000 + 5_000));
  });

  it('skips cross-domain paths and flags multiDomain', () => {
    const b = board({
      components: [
        comp('ck1', 'clock', { periodPs: 40_000 }),
        comp('ck2', 'clock', { periodPs: 60_000 }),
        comp('f1', 'dff'),
        comp('f2', 'dff'),
      ],
      wires: [
        wire('w1', ['ck1', 'y'], ['f1', 'clk']),
        wire('w2', ['ck2', 'y'], ['f2', 'clk']),
        wire('w3', ['f1', 'q'], ['f2', 'd']),
      ],
    });
    const r = analyzeTiming(compile(b, noLib), { column: 'typ' });
    expect(r.sequential?.multiDomain).toBe(true);
    expect(r.sequential?.paths.some((x) => x.launch === 'main/f1' && x.capture === 'main/f2')).toBe(
      false,
    );
  });
});

describe('analyzeTiming: decoder/encoder 74LS138/148 arcs', () => {
  it('resolves sel_to_y and en_to_y for a decoder on the critical path', () => {
    const b = board({
      components: [
        comp('t', 'toggle', { width: 2 }),
        comp('d', 'decoder', { addressBits: 2, hasEnable: true }),
        comp('l', 'led'),
      ],
      wires: [wire('w1', ['t', 'y'], ['d', 'a']), wire('w2', ['d', 'y3'], ['l', 'a'])],
    });
    const c = compile(b, noLib);
    const typ = analyzeTiming(c, { column: 'typ' });
    expect(typ.worst?.startpoint).toBe('main/t');
    expect(typ.worst?.endpoint).toBe('main/l');
    // sel_to_y typ tplh/tphl = 21/20 -> tpd = max(21,20) = 21 ns.
    expect(typ.worst?.totalTpdPs).toBe(21_000);
    expect(typ.worst?.estimated).toBe(true);
  });

  it('resolves i_to_y and i_to_valid for an encoder', () => {
    const b = board({
      components: [
        comp('t0', 'toggle'),
        comp('e', 'encoder', { addressBits: 2 }),
        comp('l', 'led'),
      ],
      wires: [wire('w1', ['t0', 'y'], ['e', 'i3']), wire('w2', ['e', 'valid'], ['l', 'a'])],
    });
    const c = compile(b, noLib);
    const typ = analyzeTiming(c, { column: 'typ' });
    expect(typ.worst?.endpoint).toBe('main/l');
    // i_to_valid typ tplh/tphl = 35/9 -> tpd = max(35,9) = 35 ns.
    expect(typ.worst?.totalTpdPs).toBe(35_000);
  });
});

// sel_to_y is the naturally slowest arc for every mux size in this datasheet
// set (real chips: select timing beats data and strobe timing throughout),
// so it's what "worst" reports whether or not the select pins are the ones
// explicitly wired -- a dangling select bit still seeds a same-arc hop at
// t=0 (SPEC precedent: any unconnected input is a legitimate STA startpoint,
// same convention decoder/encoder's own tests rely on).
describe('analyzeTiming: mux (M6.5) per-size real part arcs', () => {
  it('selectBits=1 (74LS157) resolves sel_to_y', () => {
    const b = board({
      components: [comp('t', 'toggle'), comp('m', 'mux', { selectBits: 1 }), comp('l', 'led')],
      wires: [wire('w1', ['t', 'y'], ['m', 'd0']), wire('w2', ['m', 'y'], ['l', 'a'])],
    });
    const c = compile(b, noLib);
    const typ = analyzeTiming(c, { column: 'typ' });
    expect(typ.worst?.endpoint).toBe('main/l');
    // sel_to_y (74LS157) typ tplh/tphl = 15/18 -> tpd = max(15,18) = 18 ns.
    expect(typ.worst?.totalTpdPs).toBe(18_000);
    expect(typ.worst?.critical[0]?.part).toBe('74LS157');
  });

  it('selectBits=2 (74LS153) resolves sel_to_y', () => {
    const b = board({
      components: [comp('t', 'toggle'), comp('m', 'mux', { selectBits: 2 }), comp('l', 'led')],
      wires: [wire('w1', ['t', 'y'], ['m', 's0']), wire('w2', ['m', 'y'], ['l', 'a'])],
    });
    const c = compile(b, noLib);
    const typ = analyzeTiming(c, { column: 'typ' });
    // sel_to_y (74LS153) typ tplh/tphl = 19/25 -> tpd = max(19,25) = 25 ns.
    expect(typ.worst?.totalTpdPs).toBe(25_000);
  });

  it('selectBits=3 (74LS151) resolves sel_to_y', () => {
    const b = board({
      components: [comp('t', 'toggle'), comp('m', 'mux', { selectBits: 3 }), comp('l', 'led')],
      wires: [wire('w1', ['t', 'y'], ['m', 'd3']), wire('w2', ['m', 'y'], ['l', 'a'])],
    });
    const c = compile(b, noLib);
    const typ = analyzeTiming(c, { column: 'typ' });
    // sel_to_y (74LS151) typ tplh/tphl = 27/18 -> tpd = max(27,18) = 27 ns.
    expect(typ.worst?.totalTpdPs).toBe(27_000);
    expect(typ.worst?.critical[0]?.part).toBe('74LS151');
  });

  it('selectBits=4 resolves via the non-LS 74150 part (no LS-family 16:1 mux exists)', () => {
    const b = board({
      components: [
        comp('t', 'toggle'),
        comp('m', 'mux', { selectBits: 4, hasEnable: true }),
        comp('l', 'led'),
      ],
      wires: [wire('w1', ['t', 'y'], ['m', 'en']), wire('w2', ['m', 'y'], ['l', 'a'])],
    });
    const c = compile(b, noLib);
    const typ = analyzeTiming(c, { column: 'typ' });
    // sel_to_y (74150) typ tplh/tphl = 23/22 -> tpd = max(23,22) = 23 ns.
    expect(typ.worst?.totalTpdPs).toBe(23_000);
    expect(typ.worst?.critical[0]?.part).toBe('74150');
  });

  it('codecPathKey resolves every mux pin class directly', () => {
    expect(codecPathKey('d0', 'y')).toBe('data_to_y');
    expect(codecPathKey('d15', 'y')).toBe('data_to_y');
    expect(codecPathKey('s0', 'y')).toBe('sel_to_y');
    expect(codecPathKey('s3', 'y')).toBe('sel_to_y');
    expect(codecPathKey('en', 'y')).toBe('en_to_y');
    expect(codecPathKey('d0', 'valid')).toBeUndefined(); // mux has no 'valid' output
  });

  it('demux selectBits=1 (74LS139) resolves d via en_to_y', () => {
    const b = board({
      components: [comp('t', 'toggle'), comp('m', 'demux', { selectBits: 1 }), comp('l', 'led')],
      wires: [wire('w1', ['t', 'y'], ['m', 'd']), wire('w2', ['m', 'y0'], ['l', 'a'])],
    });
    const c = compile(b, noLib);
    const typ = analyzeTiming(c, { column: 'typ' });
    // s0 is unwired but still a zero-arrival source (same convention the mux
    // selectBits=1 test above relies on), and its sel_to_y arc (typ tplh/tphl
    // 18/25 -> tpd 25) beats d's en_to_y arc (typ tplh/tphl 16/21 -> tpd 21),
    // so it's the reported critical path -- both arcs still resolve real
    // 74LS139 numbers either way.
    expect(typ.worst?.totalTpdPs).toBe(25_000);
    expect(typ.worst?.critical[0]?.part).toBe('74LS139');
  });

  it('demux selectBits=3 (74LS138) resolves s<n> via sel_to_y', () => {
    const b = board({
      components: [comp('t', 'toggle'), comp('m', 'demux', { selectBits: 3 }), comp('l', 'led')],
      wires: [wire('w1', ['t', 'y'], ['m', 's0']), wire('w2', ['m', 'y3'], ['l', 'a'])],
    });
    const c = compile(b, noLib);
    const typ = analyzeTiming(c, { column: 'typ' });
    // sel_to_y (74LS138) typ tplh/tphl = 21/20 -> tpd = max(21,20) = 21 ns.
    expect(typ.worst?.totalTpdPs).toBe(21_000);
    expect(typ.worst?.critical[0]?.part).toBe('74LS138');
  });

  it('demux selectBits=4 (74LS154) resolves sel_to_y', () => {
    const b = board({
      components: [comp('t', 'toggle'), comp('m', 'demux', { selectBits: 4 }), comp('l', 'led')],
      wires: [wire('w1', ['t', 'y'], ['m', 's2']), wire('w2', ['m', 'y9'], ['l', 'a'])],
    });
    const c = compile(b, noLib);
    const typ = analyzeTiming(c, { column: 'typ' });
    // sel_to_y (74LS154) typ tplh/tphl = 30/30 -> tpd = 30 ns.
    expect(typ.worst?.totalTpdPs).toBe(30_000);
    expect(typ.worst?.critical[0]?.part).toBe('74LS154');
  });

  it('codecPathKey resolves every demux pin class (mirror image of mux)', () => {
    // Real parts (74LS139/138/154) demux through their strobe pin, so `d`
    // shares the en_to_y arc rather than a separate data arc.
    expect(codecPathKey('d', 'y0')).toBe('en_to_y');
    expect(codecPathKey('d', 'y15')).toBe('en_to_y');
    expect(codecPathKey('s0', 'y0')).toBe('sel_to_y');
    expect(codecPathKey('s3', 'y7')).toBe('sel_to_y');
    expect(codecPathKey('en', 'y0')).toBe('en_to_y');
    expect(codecPathKey('d', 'valid')).toBeUndefined();
  });
});

describe('analyzeTiming through a DIP', () => {
  const dipLib = builtinChipLibrary();
  const dipBoard = () =>
    board({
      components: [
        comp('ta', 'toggle', undefined, 'A'),
        comp('tb', 'toggle', undefined, 'B'),
        comp('tv', 'toggle', undefined, 'VCC'),
        comp('tg', 'toggle', undefined, 'GND'),
        { ...comp('u1', 'chip', undefined, 'U1'), defId: '74LS00' },
        comp('l', 'led'),
      ],
      wires: [
        wire('w1', ['ta', 'y'], ['u1', '1A']),
        wire('w2', ['tb', 'y'], ['u1', '1B']),
        wire('w3', ['tv', 'y'], ['u1', 'VCC']),
        wire('w4', ['tg', 'y'], ['u1', 'GND']),
        wire('w5', ['u1', '1Y'], ['l', 'a']),
      ],
    });

  it('reports the gate alone: no power-gate or output-buffer hop, no fallback 10 ns', () => {
    const c = compile(dipBoard(), dipLib);
    for (const column of ['typ', 'max'] as const) {
      const report = analyzeTiming(c, { column });
      const led = report.endpoints.find((e) => e.endpoint === 'main/l')!;
      expect(led.totalTpdPs).toBe(column === 'typ' ? 10_000 : 15_000);
      expect(led.totalTcdPs).toBe(3_000);
      for (const e of report.endpoints)
        for (const hop of [...e.critical, ...e.short])
          expect(hop.path).not.toMatch(/\/(pwr_\w+|t\d+)$/);
      expect(led.critical.map((h) => h.path)).toEqual(['main/U1:74LS00/u1']);
      expect(['main/A', 'main/B']).toContain(led.startpoint);
    }
  });
});

describe('analyzeTiming: timing shapes', () => {
  // A '163-shaped core bound to the '74 row only for figures: every class falls back to 20/5 ns.
  const COUNTER_163 = {
    clear: 'sync',
    hasLoad: true,
    dualEnable: true,
    activeLow: true,
    part: '74LS74',
  };

  it("reports a '163 core's sampled pins as endpoints, each with its own setup row", () => {
    const b = board({
      components: [
        comp('ck', 'clock', { periodPs: 100_000 }),
        comp('ctr', 'counter', COUNTER_163),
        comp('n1', 'not'),
        comp('t1', 'toggle'),
        comp('t2', 'toggle'),
        comp('t3', 'toggle'),
      ],
      wires: [
        wire('w1', ['ck', 'y'], ['ctr', 'clk']),
        wire('w2', ['ctr', 'q'], ['ctr', 'd']),
        wire('w3', ['ctr', 'tc'], ['n1', 'a']),
        wire('w4', ['n1', 'y'], ['ctr', 'load']),
        wire('w5', ['t1', 'y'], ['ctr', 'clr']),
        wire('w6', ['t2', 'y'], ['ctr', 'enp']),
        wire('w7', ['t3', 'y'], ['ctr', 'ent']),
      ],
    });
    const r = analyzeTiming(compile(b, noLib), { column: 'typ' });
    const names = r.endpoints.filter((e) => e.capturePin).map((e) => e.endpoint);
    expect(names.sort()).toEqual(
      ['main/ctr.clr', 'main/ctr.d', 'main/ctr.enp', 'main/ctr.ent', 'main/ctr.load'].sort(),
    );
    // Latest into load: the toggle on ENT, through ENT -> tc, then the NOT.
    const load = r.endpoints.find((e) => e.endpoint === 'main/ctr.load')!;
    expect(load.startpoint).toBe('main/t3');
    expect(load.critical.map((h) => h.path)).toEqual(['main/ctr', 'main/n1']);

    const rows = r.sequential!.paths;
    expect(rows.map((p) => p.capturePin).sort()).toEqual(['d', 'load']);
    const loadRow = rows.find((p) => p.capturePin === 'load')!;
    // tc launches at the '74 clk -> Q fallback (25 ns), then one unbound NOT (10 ns).
    expect(loadRow.tpcqPs).toBe(25_000);
    expect(loadRow.tpdCombPs).toBe(10_000);
    expect(loadRow.tsetupPs).toBe(20_000);
    expect(loadRow.minPeriodPs).toBe(55_000);
    expect(rows.find((p) => p.capturePin === 'd')!.minPeriodPs).toBe(45_000);
    expect(r.sequential!.minPeriodPs).toBe(55_000);
  });

  it("times a '163's sync clear at its own 25 ns setup and 3 ns hold", () => {
    const b = board({
      components: [
        comp('ck', 'clock', { periodPs: 100_000 }),
        comp('ctr', 'counter', { clear: 'sync', activeLow: true }),
        comp('n1', 'not'),
      ],
      wires: [
        wire('w1', ['ck', 'y'], ['ctr', 'clk']),
        wire('w2', ['ctr', 'tc'], ['n1', 'a']),
        wire('w3', ['n1', 'y'], ['ctr', 'clr']),
      ],
    });
    const r = analyzeTiming(compile(b, noLib), { column: 'typ' });
    const clr = r.sequential!.paths.find((p) => p.capturePin === 'clr')!;
    expect(clr.tpcqPs).toBe(20_000);
    expect(clr.tsetupPs).toBe(25_000);
    expect(clr.tholdPs).toBe(3_000);
    expect(clr.minPeriodPs).toBe(55_000);
  });

  it('gathers lane-expanded data into one endpoint: slow lane critical, fast lane short', () => {
    const b = board({
      components: [
        comp('ck', 'clock'),
        comp('ctr', 'counter', { hasLoad: true, width: 2, pinView: 'd=expanded' }),
        comp('t', 'toggle'),
        comp('n1', 'not'),
        comp('n2', 'not'),
      ],
      wires: [
        wire('w1', ['ck', 'y'], ['ctr', 'clk']),
        wire('w2', ['t', 'y'], ['ctr', 'd0']),
        wire('w3', ['t', 'y'], ['n1', 'a']),
        wire('w4', ['n1', 'y'], ['n2', 'a']),
        wire('w5', ['n2', 'y'], ['ctr', 'd1']),
      ],
    });
    const r = analyzeTiming(compile(b, noLib), { column: 'typ' });
    const d = r.endpoints.filter((e) => e.endpoint.startsWith('main/ctr.d'));
    expect(d.map((e) => e.endpoint)).toEqual(['main/ctr.d']);
    expect(d[0]!.totalTpdPs).toBe(20_000);
    expect(d[0]!.totalTcdPs).toBe(0);
    expect(d[0]!.critical.map((h) => h.path)).toEqual(['main/n1', 'main/n2']);
    expect(d[0]!.short).toEqual([]);
  });

  it('accumulates the enable -> tc arc down an RCO to ENT chain', () => {
    const dual = { dualEnable: true };
    const b = board({
      components: [
        comp('ck', 'clock'),
        comp('c1', 'counter'),
        comp('c2', 'counter', dual),
        comp('c3', 'counter', dual),
        comp('l', 'led'),
      ],
      wires: [
        wire('w1', ['ck', 'y'], ['c1', 'clk']),
        wire('w2', ['ck', 'y'], ['c2', 'clk']),
        wire('w3', ['ck', 'y'], ['c3', 'clk']),
        wire('w4', ['c1', 'tc'], ['c2', 'ent']),
        wire('w5', ['c2', 'tc'], ['c3', 'ent']),
        wire('w6', ['c3', 'tc'], ['l', 'a']),
      ],
    });
    const r = analyzeTiming(compile(b, noLib), { column: 'typ' });
    const led = r.endpoints.find((e) => e.endpoint === 'main/l')!;
    expect(led.startpoint).toBe('main/c1');
    expect(led.critical.map((h) => h.path)).toEqual(['main/c2', 'main/c3']);
    // Two '163 ENT to RCO hops, 9 ns typ each.
    expect(led.totalTpdPs).toBe(18_000);

    const row = r.sequential!.paths.find((p) => p.launch === 'main/c1' && p.capture === 'main/c3')!;
    expect(row.capturePin).toBe('ent');
    // CLK to RCO launches at its slower edge, 20 ns typ; one ENT to RCO hop follows.
    expect(row.tpcqPs).toBe(20_000);
    expect(row.tpdCombPs).toBe(9_000);
    // At max CLK to RCO (35 ns) parts from CLK to Q (28 ns), which typ cannot show.
    const max = analyzeTiming(compile(b, noLib), { column: 'max' });
    const maxRow = max.sequential!.paths.find(
      (p) => p.launch === 'main/c1' && p.capture === 'main/c3',
    )!;
    expect(maxRow.tpcqPs).toBe(35_000);
    expect(maxRow.tpdCombPs).toBe(14_000);
    expect(codecPathKey('clk', 'tc')).toBe('clk_to_tc');
    expect(codecPathKey('ent', 'tc')).toBe('ent_to_tc');
    expect(codecPathKey('en', 'tc')).toBe('ent_to_tc');
  });

  it("analyzes a mod-10 '161 (NAND of Q back to /CLR) and still refuses a real loop", () => {
    const b = board({
      components: [
        comp('ck', 'clock'),
        comp('ctr', 'counter', {
          clear: 'async',
          activeLow: true,
          dualEnable: true,
          pinView: 'q=expanded',
        }),
        comp('g', 'nand'),
      ],
      wires: [
        wire('w1', ['ck', 'y'], ['ctr', 'clk']),
        wire('w2', ['ctr', 'q3'], ['g', 'a']),
        wire('w3', ['ctr', 'q1'], ['g', 'b']),
        wire('w4', ['g', 'y'], ['ctr', 'clr']),
      ],
    });
    const r = analyzeTiming(compile(b, noLib), { column: 'typ' });
    const clr = r.endpoints.find((e) => e.endpoint === 'main/ctr.clr')!;
    expect(clr.critical.map((h) => h.path)).toEqual(['main/g']);
    expect(r.sequential!.paths.some((p) => p.capturePin === 'clr')).toBe(false);

    // A stop-at-N counter: Q into its own enable is registered, not combinational.
    const stop = board({
      components: [
        comp('ck', 'clock'),
        comp('ctr', 'counter', { hasEnable: true, pinView: 'q=expanded' }),
        comp('g', 'nand'),
      ],
      wires: [
        wire('w1', ['ck', 'y'], ['ctr', 'clk']),
        wire('w2', ['ctr', 'q3'], ['g', 'a']),
        wire('w3', ['ctr', 'q0'], ['g', 'b']),
        wire('w4', ['g', 'y'], ['ctr', 'en']),
      ],
    });
    const stopped = analyzeTiming(compile(stop, noLib), { column: 'typ' });
    const en = stopped.endpoints.find((e) => e.endpoint === 'main/ctr.en')!;
    expect(en.critical.map((h) => h.path)).toEqual(['main/g']);
    expect(stopped.sequential!.paths.find((p) => p.capturePin === 'en')?.tpdCombPs).toBe(10_000);

    const loop = board({
      components: [comp('ctr', 'counter', { dualEnable: true })],
      wires: [wire('w1', ['ctr', 'tc'], ['ctr', 'ent'])],
    });
    expect(() => analyzeTiming(compile(loop, noLib), { column: 'typ' })).toThrowError(TimingError);
  });

  it('starts paths at an SR latch block and keeps it out of min period', () => {
    const b = board({
      components: [
        comp('ck', 'clock'),
        comp('t', 'toggle'),
        comp('sr', 'srlatch'),
        comp('n1', 'not'),
        comp('ff', 'dff'),
      ],
      wires: [
        wire('w1', ['t', 'y'], ['sr', 's']),
        wire('w2', ['t', 'y'], ['sr', 'r']),
        wire('w3', ['sr', 'q'], ['n1', 'a']),
        wire('w4', ['n1', 'y'], ['ff', 'd']),
        wire('w5', ['ck', 'y'], ['ff', 'clk']),
      ],
    });
    const r = analyzeTiming(compile(b, noLib), { column: 'typ' });
    expect(r.endpoints.map((e) => e.endpoint)).toEqual(
      expect.arrayContaining(['main/sr.s', 'main/sr.r', 'main/ff.d']),
    );
    const d = r.endpoints.find((e) => e.endpoint === 'main/ff.d')!;
    expect(d.startpoint).toBe('main/sr');
    expect(d.totalTpdPs).toBe(10_000);
    expect(r.sequential!.paths).toEqual([]);
    expect(r.sequential!.minPeriodPs).toBeNull();
  });

  it("gives a register's enable its own endpoint and row; a dff's async pins only arrival", () => {
    const b = board({
      components: [
        comp('ck', 'clock'),
        comp('rg', 'register'),
        comp('ff', 'dff', { asyncClear: true }),
        comp('t', 'toggle'),
      ],
      wires: [
        wire('w1', ['ck', 'y'], ['rg', 'clk']),
        wire('w2', ['ck', 'y'], ['ff', 'clk']),
        wire('w3', ['ff', 'q'], ['rg', 'd']),
        wire('w4', ['ff', 'qn'], ['rg', 'en']),
        wire('w5', ['rg', 'q'], ['ff', 'd']),
        wire('w6', ['t', 'y'], ['ff', 'clr']),
      ],
    });
    const r = analyzeTiming(compile(b, noLib), { column: 'typ' });
    expect(r.endpoints.map((e) => e.endpoint)).toEqual(
      expect.arrayContaining(['main/rg.d', 'main/rg.en', 'main/ff.d', 'main/ff.clr']),
    );
    const rows = r.sequential!.paths.map((p) => `${p.launch}->${p.capture}.${p.capturePin}`);
    expect(rows.sort()).toEqual([
      'main/ff->main/rg.d',
      'main/ff->main/rg.en',
      'main/rg->main/ff.d',
    ]);
  });

  it('drops a clock-inhibited shift register out of sequential analysis', () => {
    const b = board({
      components: [
        comp('ck', 'clock'),
        comp('sr', 'shiftreg', { clockInhibit: true }),
        comp('t1', 'toggle'),
        comp('t2', 'toggle'),
      ],
      wires: [
        wire('w1', ['ck', 'y'], ['sr', 'clk']),
        wire('w2', ['t1', 'y'], ['sr', 'si']),
        wire('w3', ['t2', 'y'], ['sr', 'inh']),
      ],
    });
    const r = analyzeTiming(compile(b, noLib), { column: 'typ' });
    expect(r.endpoints.map((e) => e.endpoint).sort()).toEqual(['main/sr.inh', 'main/sr.si']);
    expect(r.sequential!.paths).toEqual([]);
  });
});

describe('outputDelayPs: single-edge arcs', () => {
  it("reads a '161 clear published as tPHL only from that edge", () => {
    // Clear 20 ns falls past CLK to Q 18 ns; t_cd is the fastest edge present, CLK to Q tPLH 13 ns.
    expect(outputDelayPs('74LS161', ['clk', 'clr'], 'q0', 'typ')).toMatchObject({
      tpdPs: 20_000,
      tcdPs: 5_000,
    });
  });
});
