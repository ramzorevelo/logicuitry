import { describe, expect, it } from 'vitest';
import type { CompiledPrimitive } from '../model/compile';
import { datasheetDelay, FALLBACK_NS, pinNamesOf } from '../sim/delay';
import { getPrimitive } from '../sim/primitives/registry';
import type { Params } from '../sim/primitives/types';
import * as bv from '../value/busValue';
import { arcFigure, arcPathKey, codecPathKey, outputPropagationNs } from './arcs';
import { estimatedContaminationNs, getPart, partsDb, setupHoldNs, type PartEntry } from './partsDb';
import { partCore } from './packages';

/** A primitive as the compiler would bind it, nets left empty. */
function bound(kind: string, params: Params): CompiledPrimitive {
  const spec = getPrimitive(kind);
  const part = typeof spec.defaultPart === 'function' ? spec.defaultPart(params) : spec.defaultPart;
  return {
    kind,
    params,
    path: `main/${kind}`,
    componentId: `main/${kind}`,
    inputs: [],
    outputs: [],
    ...(part ? { part } : {}),
  };
}

const COLLAPSED = 'd=collapsed;s=collapsed;y=collapsed';

/** Every combinational or latch shape bound to per-arc rows; a clocked shape's sampled pins have no arc. */
function arcBoundPrims(): CompiledPrimitive[] {
  const prims: CompiledPrimitive[] = [];
  for (let bits = 1; bits <= 4; bits++) {
    for (const pinView of ['', COLLAPSED]) {
      prims.push(bound('mux', { selectBits: bits, hasEnable: true, pinView }));
      prims.push(bound('demux', { selectBits: bits, hasEnable: true, pinView }));
    }
  }
  prims.push(bound('decoder', { addressBits: 3, hasEnable: true }));
  prims.push(bound('decoder', { addressBits: 3, hasEnable: true, pinView: 'a=expanded' }));
  prims.push(bound('encoder', { addressBits: 3 }));
  prims.push(bound('encoder', { addressBits: 3, pinView: 'i=collapsed;a=expanded' }));
  prims.push(bound('bcd7seg', { activeLow: true }));
  prims.push(bound('bcd7seg', {}));
  prims.push(bound('adder', {}));
  prims.push(bound('adder', { pinView: 'a=expanded;b=expanded;sum=expanded' }));
  prims.push(bound('comparator', {}));
  prims.push(bound('comparator', { hasCascade: true, pinView: 'a=expanded;b=expanded' }));
  prims.push(bound('parity', {}));
  prims.push(bound('dlatch', {}));
  return prims;
}

describe('arc table', () => {
  it('times every input-to-output pair of an arc-bound part from a published row', () => {
    for (const prim of arcBoundPrims()) {
      expect(getPart(prim.part!)?.paths, prim.part).toBeDefined();
      const { ins, outs } = pinNamesOf(prim);
      for (const out of outs)
        for (const inp of ins)
          expect(arcFigure(prim.part!, inp, out), `${prim.part} ${inp}->${out}`).toBeDefined();
    }
  });

  it('never schedules a bound output at the unbound fallback by default', () => {
    const model = datasheetDelay('typ');
    for (const prim of arcBoundPrims()) {
      const { ins, outs } = pinNamesOf(prim);
      outs.forEach((out, o) => {
        const want = Math.max(
          outputPropagationNs(prim.part!, ins, out, 'lh', 'typ')!,
          outputPropagationNs(prim.part!, ins, out, 'hl', 'typ')!,
        );
        expect(model.delayPs(prim, o, bv.allX(1), bv.known(0, 1))).toBe(want * 1000);
      });
    }
    expect(FALLBACK_NS).toBe(10);
  });

  it("splits the '148 by output: the code and valid no longer share one figure", () => {
    const prim = bound('encoder', { addressBits: 3 });
    const { outs } = pinNamesOf(prim);
    const model = datasheetDelay('typ');
    const rise = (out: string) =>
      model.delayPs(prim, outs.indexOf(out), bv.known(0, 1), bv.known(1, 1));
    expect(rise('valid')).toBe(35_000);
    expect(rise('a')).toBe(20_000);
  });

  it("the slowest arc into a mux output and one arc's own row ('153)", () => {
    const prim = bound('mux', { selectBits: 2 });
    const { ins } = pinNamesOf(prim);
    expect(outputPropagationNs(prim.part!, ins, 'y', 'hl', 'typ')).toBe(25);
    expect(arcFigure(prim.part!, 'd0', 'y')!.tphl!.typ).toBe(17);
  });

  it("carries the '283 a/b to carry-out row", () => {
    expect(arcFigure('74LS283', 'a', 'cout')).toEqual(getPart('74LS283')!.paths!['ab_to_cout']);
    expect(arcFigure('74LS283', 'b', 'cout')!.tphl).toEqual({ typ: 12, max: 17 });
  });

  it('names an arc for every pin the faithful cores add', () => {
    expect(arcPathKey('74LS138', 'enh0', 'y3')).toBe('en_to_y');
    expect(arcPathKey('74LS138', 'enl1', 'y3')).toBe('en_to_y');
    expect(arcPathKey('74LS148', 'i4', 'gs')).toBe('i_to_valid');
    expect(arcPathKey('74LS148', 'i4', 'eo')).toBe('i_to_eo');
    expect(arcPathKey('74LS148', 'ei', 'a1')).toBe('ei_to_y');
    expect(arcPathKey('74LS148', 'ei', 'gs')).toBe('ei_to_gs');
    expect(arcPathKey('74LS148', 'ei', 'eo')).toBe('ei_to_eo');
    expect(arcPathKey('74LS151', 'd3', 'w')).toBe('data_to_w');
    expect(arcPathKey('74LS151', 's2', 'w')).toBe('sel_to_w');
    expect(arcPathKey('74LS151', 'en', 'w')).toBe('en_to_w');
  });

  it("times a lane-expanded '283 bit like its bus pin", () => {
    expect(arcPathKey('74LS283', 'a3', 'sum0')).toBe('ab_to_sum');
    expect(arcPathKey('74LS283', 'b0', 'cout')).toBe('ab_to_cout');
    expect(arcPathKey('74LS283', 'cin', 'sum2')).toBe('cin_to_sum');
  });

  it("names the '85 and '280 arcs their datasheet rows will carry", () => {
    expect(arcPathKey('74LS85', 'a2', 'eq')).toBe('ab_to_eq');
    expect(arcPathKey('74LS85', 'b', 'gt')).toBe('ab_to_gt');
    expect(arcPathKey('74LS85', 'ilt', 'gt')).toBe('cascade_to_gt');
    expect(arcPathKey('74LS85', 'ieq', 'eq')).toBe('cascade_to_eq');
    expect(arcPathKey('74LS280', 'd8', 'odd')).toBe('data_to_odd');
    expect(arcPathKey('74LS280', 'd0', 'even')).toBe('data_to_even');
  });

  it('binds the comparator and parity cores to their listed parts', () => {
    expect(getPart('74LS85')).toBeDefined();
    expect(getPart('74LS280')).toBeDefined();
    expect(bound('comparator', {}).part).toBe('74LS85');
    expect(bound('parity', {}).part).toBe('74LS280');
    expect(bound('adder', {}).part).toBe('74LS283');
  });

  it('answers a part with no per-arc rows with its single figure', () => {
    expect(outputPropagationNs('74LS00', ['a', 'b'], 'y', 'lh', 'typ')).toBe(9);
  });

  it("keeps the '74 clk -> Q fields equal to its clk_to_q arc row", () => {
    const ff = getPart('74LS74')!;
    expect(outputPropagationNs('74LS74', ['d', 'clk'], 'q', 'hl', 'typ')).toBe(25);
    expect(ff.paths!.clk_to_q).toEqual({ tplh: ff.tplh_clk_q, tphl: ff.tphl_clk_q });
  });
});

describe('clocked part figures', () => {
  it('names an arc for every launch, through and async pin of each clocked shape', () => {
    const keys = (ins: string[], outs: string[]) =>
      ins.flatMap((i) => outs.map((o) => codecPathKey(i, o)));
    expect(keys(['clk'], ['q', 'qn', 'q3', 'so', 'son'])).toEqual(Array(5).fill('clk_to_q'));
    expect(keys(['clk'], ['tc'])).toEqual(['clk_to_tc']);
    expect(keys(['en', 'ent'], ['tc'])).toEqual(['ent_to_tc', 'ent_to_tc']);
    expect(keys(['clr'], ['q', 'q0', 'so'])).toEqual(Array(3).fill('clr_to_q'));
    expect(keys(['pre'], ['q', 'qn'])).toEqual(['pre_to_q', 'pre_to_q']);
    expect(keys(['load', 'd7'], ['so'])).toEqual(['load_to_q', 'data_to_q']);
    expect(keys(['d', 'en'], ['q'])).toEqual(['data_to_q', 'en_to_q']);
  });

  it('falls back from a missing setup or hold class to the single minimum', () => {
    const entry: PartEntry = {
      part: 'test',
      primitive: 'counter',
      setup_min: 20,
      hold_min: 3,
      setup: { load: 25 },
      hold: { enable: 0 },
      verified: false,
      source: 'test',
    };
    expect(setupHoldNs(entry, 'load')).toEqual({ setupNs: 25, holdNs: 3 });
    expect(setupHoldNs(entry, 'enable')).toEqual({ setupNs: 20, holdNs: 0 });
    expect(setupHoldNs(entry, 'data')).toEqual({ setupNs: 20, holdNs: 3 });
    expect(setupHoldNs(undefined, 'data')).toEqual({ setupNs: 0, holdNs: 0 });
  });

  it('never estimates a real delay to a zero contamination delay', () => {
    expect(estimatedContaminationNs(10)).toBe(4);
    expect(estimatedContaminationNs(9)).toBe(3);
    expect(estimatedContaminationNs(1)).toBe(0.4);
    for (const p of partsDb().parts)
      for (const fig of Object.values(p.paths ?? {}))
        for (const f of [fig.tplh, fig.tphl])
          if (f) expect(estimatedContaminationNs(f.typ ?? f.max), p.part).toBeGreaterThan(0);
  });

  it("an async clear times only the edge it drives ('161 Q, '175 /Q)", () => {
    const ins161 = ['clk', 'clr', 'load', 'd0', 'enp', 'ent'];
    expect(outputPropagationNs('74LS161', ins161, 'q0', 'lh', 'typ')).toBe(13);
    expect(outputPropagationNs('74LS161', ins161, 'q0', 'hl', 'typ')).toBe(20);
    expect(outputPropagationNs('74LS175', ['d', 'clk', 'clr'], 'qn', 'lh', 'typ')).toBe(20);
    expect(outputPropagationNs('74LS175', ['d', 'clk', 'clr'], 'qn', 'hl', 'typ')).toBe(16);
  });

  it('every published arc carries at least one edge', () => {
    for (const p of partsDb().parts)
      for (const [key, fig] of Object.entries(p.paths ?? {}))
        expect(fig.tplh ?? fig.tphl, `${p.part} ${key}`).toBeDefined();
  });
});

describe('sim delay follows the arc from the inputs that moved', () => {
  function core(part: string): CompiledPrimitive {
    const c = partCore(part)!;
    return { ...bound(c.kind, c.params ?? {}), part };
  }
  const typ = datasheetDelay('typ');
  /** Delay of one clean output edge when only the named input pins moved. */
  function edgePs(part: string, moved: string[], out: string, rising: boolean): number {
    const prim = core(part);
    const { ins, outs } = pinNamesOf(prim);
    const [from, to] = rising ? [0, 1] : [1, 0];
    const changed = moved.map((m) => ins.indexOf(m));
    expect(changed).not.toContain(-1);
    return typ.delayPs(prim, outs.indexOf(out), bv.known(from, 1), bv.known(to, 1), changed);
  }

  it("'161 ENT->RCO takes the 9 ns row, a clocked RCO the CLK row", () => {
    expect(edgePs('74LS161', ['ent'], 'tc', true)).toBe(9_000);
    expect(edgePs('74LS161', ['clk'], 'tc', true)).toBe(20_000);
  });

  it("'161 clocked wrap: QA falls on the CLK row (18 ns), not CLR (20 ns)", () => {
    expect(edgePs('74LS161', ['clk'], 'q0', false)).toBe(18_000);
    expect(edgePs('74LS161', ['clr'], 'q0', false)).toBe(20_000);
  });

  it("'165 CLK->QH falls in 16 ns, not the 26 ns load row", () => {
    expect(edgePs('74LS165', ['clk'], 'so', false)).toBe(16_000);
  });

  it('an edge no moved input times falls back to the slowest arc', () => {
    const prim = core('74LS161');
    const { ins, outs } = pinNamesOf(prim);
    const slowest = outputPropagationNs('74LS161', ins, 'tc', 'lh', 'typ')! * 1000;
    expect(typ.delayPs(prim, outs.indexOf('tc'), bv.known(0, 1), bv.known(1, 1), [])).toBe(slowest);
    expect(typ.delayPs(prim, outs.indexOf('tc'), bv.known(0, 1), bv.known(1, 1))).toBe(slowest);
  });
});
