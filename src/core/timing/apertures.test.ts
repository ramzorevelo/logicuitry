import { describe, expect, it } from 'vitest';
import { compile } from '../model/compile';
import type { ChipLibrary } from '../model/types';
import { board, comp, wire } from '../model/testFixtures';
import { pinNamesOf } from '../sim/delay';
import { NO_CAUSE } from '../sim/kernel';
import * as bv from '../value/busValue';
import { setupHoldWindows } from './apertures';

const noLib: ChipLibrary = new Map();

function fixture() {
  const b = board({
    components: [
      comp('ck', 'clock'),
      comp('ff', 'dff'),
      comp('ctr', 'counter', { clear: 'sync', hasLoad: true, dualEnable: true, part: '74LS74' }),
      comp('rg', 'register'),
      comp('ub', 'register', { part: '74LS999' }),
    ],
    wires: [
      wire('w1', ['ck', 'y'], ['ff', 'clk']),
      wire('w2', ['ck', 'y'], ['ctr', 'clk']),
      wire('w3', ['ck', 'y'], ['rg', 'clk']),
      wire('w4', ['ck', 'y'], ['ub', 'clk']),
    ],
  });
  const c = compile(b, noLib);
  const prim = (id: string) => c.componentToPrimitive.get(`main/${id}`)!;
  const ff = c.primitives[prim('ff')]!;
  const clkNet = ff.inputs[pinNamesOf(ff).ins.indexOf('clk')]!;
  const records = [
    { time: 0, net: clkNet, value: bv.known(0, 1), cause: NO_CAUSE },
    { time: 50_000, net: clkNet, value: bv.known(1, 1), cause: NO_CAUSE },
  ];
  return { c, prim, records };
}

describe('setupHoldWindows', () => {
  it("shades a dff's d with the '74 setup and hold around each rising edge", () => {
    const { c, prim, records } = fixture();
    const ff = c.primitives[prim('ff')]!;
    const dNet = ff.inputs[pinNamesOf(ff).ins.indexOf('d')]!;
    expect(setupHoldWindows(c, records, [prim('ff')], 0, 100_000)).toEqual([
      { net: dNet, kind: 'setup', t0: 30_000, t1: 50_000 },
      { net: dNet, kind: 'hold', t0: 50_000, t1: 55_000 },
    ]);
  });

  it('shades every sampled pin of a counter, and nothing on its clock', () => {
    const { c, prim, records } = fixture();
    const ctr = c.primitives[prim('ctr')]!;
    const names = pinNamesOf(ctr).ins;
    const shaded = new Set(
      setupHoldWindows(c, records, [prim('ctr')], 0, 100_000).map((w) => w.net),
    );
    const pinsShaded = names.filter((_, slot) => shaded.has(ctr.inputs[slot]!));
    expect(pinsShaded).toEqual(['clr', 'load', 'd', 'enp', 'ent']);
  });

  it("shades a register's d and en with the '377 data and enable figures", () => {
    const { c, prim, records } = fixture();
    const rg = c.primitives[prim('rg')]!;
    const net = (pin: string) => rg.inputs[pinNamesOf(rg).ins.indexOf(pin)]!;
    expect(setupHoldWindows(c, records, [prim('rg')], 0, 100_000)).toEqual([
      { net: net('d'), kind: 'setup', t0: 30_000, t1: 50_000 },
      { net: net('d'), kind: 'hold', t0: 50_000, t1: 55_000 },
      { net: net('en'), kind: 'setup', t0: 25_000, t1: 50_000 },
      { net: net('en'), kind: 'hold', t0: 50_000, t1: 55_000 },
    ]);
  });

  it("shades a '163 counter's clear at 25/3 ns and a '164 shift reg's serial input at 15/5 ns", () => {
    const b = board({
      components: [
        comp('ck', 'clock'),
        comp('ctr', 'counter', { clear: 'sync', activeLow: true }),
        comp('sr', 'shiftreg'),
      ],
      wires: [wire('w1', ['ck', 'y'], ['ctr', 'clk']), wire('w2', ['ck', 'y'], ['sr', 'clk'])],
    });
    const c = compile(b, noLib);
    const prim = (id: string) => c.componentToPrimitive.get(`main/${id}`)!;
    const ctr = c.primitives[prim('ctr')]!;
    const sr = c.primitives[prim('sr')]!;
    const clkNet = ctr.inputs[pinNamesOf(ctr).ins.indexOf('clk')]!;
    const records = [
      { time: 0, net: clkNet, value: bv.known(0, 1), cause: NO_CAUSE },
      { time: 50_000, net: clkNet, value: bv.known(1, 1), cause: NO_CAUSE },
    ];
    const clrNet = ctr.inputs[pinNamesOf(ctr).ins.indexOf('clr')]!;
    expect(
      setupHoldWindows(c, records, [prim('ctr')], 0, 100_000).filter((w) => w.net === clrNet),
    ).toEqual([
      { net: clrNet, kind: 'setup', t0: 25_000, t1: 50_000 },
      { net: clrNet, kind: 'hold', t0: 50_000, t1: 53_000 },
    ]);
    const siNet = sr.inputs[pinNamesOf(sr).ins.indexOf('si')]!;
    expect(setupHoldWindows(c, records, [prim('sr')], 0, 100_000)).toEqual([
      { net: siNet, kind: 'setup', t0: 35_000, t1: 50_000 },
      { net: siNet, kind: 'hold', t0: 50_000, t1: 55_000 },
    ]);
  });

  it('shades nothing for a part with no row, or an edge outside the window', () => {
    const { c, prim, records } = fixture();
    expect(setupHoldWindows(c, records, [prim('ub')], 0, 100_000)).toEqual([]);
    expect(setupHoldWindows(c, records, [prim('ff')], 60_000, 100_000)).toEqual([]);
  });

  it('shades a net once when it feeds two sampled pins', () => {
    const b = board({
      components: [
        comp('ck', 'clock'),
        comp('t', 'toggle'),
        comp('ctr', 'counter', { dualEnable: true, part: '74LS74' }),
      ],
      wires: [
        wire('w1', ['ck', 'y'], ['ctr', 'clk']),
        wire('w2', ['t', 'y'], ['ctr', 'enp']),
        wire('w3', ['t', 'y'], ['ctr', 'ent']),
      ],
    });
    const c = compile(b, noLib);
    const pi = c.componentToPrimitive.get('main/ctr')!;
    const ctr = c.primitives[pi]!;
    const ins = pinNamesOf(ctr).ins;
    const clkNet = ctr.inputs[ins.indexOf('clk')]!;
    const enNet = ctr.inputs[ins.indexOf('enp')]!;
    const records = [
      { time: 0, net: clkNet, value: bv.known(0, 1), cause: NO_CAUSE },
      { time: 50_000, net: clkNet, value: bv.known(1, 1), cause: NO_CAUSE },
    ];
    const onEn = setupHoldWindows(c, records, [pi], 0, 100_000).filter((w) => w.net === enNet);
    expect(onEn.map((w) => w.kind)).toEqual(['setup', 'hold']);
  });
});
