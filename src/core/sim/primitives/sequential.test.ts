import { describe, expect, it } from 'vitest';
import * as bv from '../../value/busValue';
import type { Params, PrimitiveSpec } from './types';
import { dff, register, srlatch } from './sequential';
import { counter } from './counter';
import { shiftreg } from './shiftreg';

/**
 * One primitive driven the way the kernel drives it: inputs persist between
 * steps, each step is one evaluation, and the previous step's inputs are its
 * prevInputs. Values are MSB-first strings over 01XZ.
 */
class Bench {
  private readonly ins: { name: string; width: number }[];
  private readonly outs: { name: string; width: number }[];
  private cur: bv.BusValue[];
  private prev: bv.BusValue[];
  private state: unknown;
  private driven: (bv.BusValue | null)[] = [];

  constructor(
    private readonly spec: PrimitiveSpec,
    private readonly params: Params,
  ) {
    const pins = spec.pins(params);
    this.ins = pins.filter((p) => p.dir === 'in');
    this.outs = pins.filter((p) => p.dir === 'out');
    this.cur = this.ins.map((p) => bv.allX(p.width));
    this.prev = this.cur;
    this.state = spec.init?.(params);
  }

  /** Changes the named inputs together, in one evaluation. */
  set(values: Record<string, string>): this {
    const next = [...this.cur];
    for (const [name, lit] of Object.entries(values)) {
      const i = this.ins.findIndex((p) => p.name === name);
      if (i < 0) throw new Error(`no input ${name}`);
      next[i] = bv.fromString(lit);
    }
    this.prev = this.cur;
    this.cur = next;
    const result = this.spec.evaluate({
      params: this.params,
      state: this.state,
      inputs: this.cur,
      prevInputs: this.prev,
      time: 0,
    });
    if ('state' in result) this.state = result.state;
    this.driven = result.outputs;
    return this;
  }

  /** One rising edge: clk low, then high, as two evaluations. */
  clock(pin = 'clk'): this {
    return this.set({ [pin]: '0' }).set({ [pin]: '1' });
  }

  out(name: string): string {
    const i = this.outs.findIndex((p) => p.name === name);
    if (i < 0) throw new Error(`no output ${name}`);
    return bv.toString(this.driven[i]!, this.outs[i]!.width);
  }
}

describe('dff async preset and clear', () => {
  const params = { asyncSet: true, asyncClear: true };
  const bench = () => new Bench(dff, params).set({ d: '0', clk: '0', pre: '1', clr: '1' });

  it('both low drives Q and Qn high', () => {
    const b = bench().set({ pre: '0', clr: '0' });
    expect([b.out('q'), b.out('qn')]).toEqual(['1', '1']);
  });

  it('releasing both in one evaluation leaves X', () => {
    const b = bench().set({ pre: '0', clr: '0' }).set({ pre: '1', clr: '1' });
    expect([b.out('q'), b.out('qn')]).toEqual(['X', 'X']);
  });

  it('releasing one first lets the other win', () => {
    const b = bench().set({ pre: '0', clr: '0' }).set({ pre: '1' });
    expect(b.out('q')).toBe('0');
    b.set({ clr: '1' });
    expect([b.out('q'), b.out('qn')]).toEqual(['0', '1']);
    const c = bench().set({ pre: '0', clr: '0' }).set({ clr: '1' }).set({ pre: '1' });
    expect(c.out('q')).toBe('1');
  });

  it('an edge while either is asserted does not capture', () => {
    const b = bench().set({ clr: '0' }).set({ d: '1' }).clock();
    expect(b.out('q')).toBe('0');
    const c = bench().set({ pre: '0' }).set({ d: '0' }).clock();
    expect(c.out('q')).toBe('1');
  });

  it('an edge in the same evaluation as a release does not capture', () => {
    const b = bench().set({ clr: '0', d: '1' }).set({ clr: '1', clk: '1' });
    expect(b.out('q')).toBe('0');
    b.clock();
    expect(b.out('q')).toBe('1');
  });

  it('an unknown async pin gives X only where it could change an output', () => {
    // Cleared, then /CLR unknown: cleared or held, Q is 0 either way.
    const held = bench().set({ clr: '0' }).set({ clr: 'X' });
    expect([held.out('q'), held.out('qn')]).toEqual(['0', '1']);
    // /CLR low with /PRE unknown: Q is 1 or 0, but /Q is high in both rows.
    const both = bench().set({ clr: '0' }).set({ pre: 'X' });
    expect([both.out('q'), both.out('qn')]).toEqual(['X', '1']);
    const preset = bench().set({ clr: '0' }).set({ clr: '1' }).set({ pre: 'X' });
    expect([preset.out('q'), preset.out('qn')]).toEqual(['X', 'X']);
  });

  it('an edge just after an X async line may have been blocked, so Q keeps only what D agrees on', () => {
    const preset = bench().set({ pre: '0' }).set({ pre: '1' }).set({ pre: 'X' });
    expect(preset.out('q')).toBe('1');
    expect(preset.set({ pre: '1', clk: '1' }).out('q')).toBe('X');
    const cleared = bench().set({ d: '1', clr: '0' }).set({ clr: 'X' });
    expect(cleared.out('q')).toBe('0');
    expect(cleared.set({ clr: '1', clk: '1' }).out('q')).toBe('X');
    const agreeing = bench().set({ clr: '0' }).set({ clr: 'X' });
    expect(agreeing.set({ clr: '1', clk: '1' }).out('q')).toBe('0');
  });

  it('a clock that cannot have risen holds Q; an unknown edge keeps Q where D agrees', () => {
    const b = bench().set({ d: '1' }).clock();
    expect(b.set({ clk: 'X' }).out('q')).toBe('1');
    expect(b.set({ clk: '0' }).out('q')).toBe('1');
    expect(b.set({ d: '1' }).set({ clk: 'X' }).out('q')).toBe('1');
    const c = bench().set({ d: '0' }).clock().set({ clk: '0', d: '1' }).set({ clk: 'X' });
    expect(c.out('q')).toBe('X');
  });
});

describe('register enableLow', () => {
  it('loads at an edge while /E is low and holds while it is high', () => {
    const b = new Bench(register, { width: 4, enableLow: true });
    b.set({ d: '1010', clk: '0', en: '0' }).clock();
    expect(b.out('q')).toBe('1010');
    b.set({ d: '0101', en: '1' }).clock();
    expect(b.out('q')).toBe('1010');
  });

  it('flags the enable active low only under enableLow', () => {
    expect(register.pins({ enableLow: true }).find((p) => p.name === 'en')?.activeLow).toBe(true);
    expect(register.pins({}).find((p) => p.name === 'en')?.activeLow).toBeUndefined();
  });
});

describe('srlatch', () => {
  // [S, R] as their asserted levels; the NAND form drives the complements.
  const forms = [
    { form: 'nor', on: '1', off: '0', both: ['0', '0'] },
    { form: 'nand', on: '0', off: '1', both: ['1', '1'] },
  ] as const;

  for (const f of forms) {
    describe(`${f.form} form`, () => {
      const bench = () => new Bench(srlatch, { form: f.form });
      const state = (b: Bench) => [b.out('q'), b.out('qn')];

      it('powers on X and stays X while both inputs are inactive', () => {
        expect(state(bench().set({ s: f.off, r: f.off }))).toEqual(['X', 'X']);
      });

      it('follows the four table rows, holding between them', () => {
        const b = bench().set({ s: f.on, r: f.off });
        expect(state(b)).toEqual(['1', '0']);
        expect(state(b.set({ s: f.off }))).toEqual(['1', '0']);
        expect(state(b.set({ r: f.on }))).toEqual(['0', '1']);
        expect(state(b.set({ r: f.off }))).toEqual(['0', '1']);
        expect(state(b.set({ s: f.on, r: f.on }))).toEqual(f.both);
      });

      it('leaving the forbidden row with both inputs at once gives X', () => {
        const b = bench().set({ s: f.on, r: f.on }).set({ s: f.off, r: f.off });
        expect(state(b)).toEqual(['X', 'X']);
      });

      it('releasing one input first lets the other decide', () => {
        const b = bench().set({ s: f.on, r: f.on }).set({ r: f.off });
        expect(state(b)).toEqual(['1', '0']);
        expect(state(b.set({ s: f.off }))).toEqual(['1', '0']);
      });

      it('an unknown input gives X only where its two values disagree', () => {
        const b = bench().set({ s: f.on, r: f.off }).set({ s: 'X' });
        expect(state(b)).toEqual(['1', '0']);
        b.set({ s: f.off, r: f.on }).set({ s: 'X' });
        // S asserted would join the forbidden row, which moves only one output.
        expect(state(b)).toEqual(f.form === 'nor' ? ['0', 'X'] : ['X', '1']);
      });

      it('draws its inputs active low only in the NAND form', () => {
        const flags = srlatch.pins({ form: f.form }).map((p) => !!p.activeLow);
        expect(flags).toEqual(
          f.form === 'nand' ? [true, true, false, false] : [false, false, false, false],
        );
      });
    });
  }

  it('binds the derived latch timing of its gate family', () => {
    const part = srlatch.defaultPart as (p: Params) => string;
    expect(part({})).toBe('74LS02-SR');
    expect(part({ form: 'nand' })).toBe('74LS00-SR');
  });
});

describe('counter', () => {
  const full = { width: 4, clear: 'sync', hasLoad: true, hasEnable: true };
  const idle = { clk: '0', clr: '0', load: '0', d: '0000', en: '1' };

  it('pin shape follows the params', () => {
    const names = (p: Params) => counter.pins(p).map((x) => x.name);
    expect(names({})).toEqual(['clk', 'clr', 'q', 'tc']);
    expect(names(full)).toEqual(['clk', 'clr', 'load', 'd', 'en', 'q', 'tc']);
    expect(names({ clear: 'none', dualEnable: true })).toEqual(['clk', 'enp', 'ent', 'q', 'tc']);
    expect(names({ width: 2, pinView: 'q=expanded' })).toEqual(['clk', 'clr', 'q1', 'q0', 'tc']);
    expect(counter.pins({}).find((p) => p.name === 'q')!.width).toBe(4);
  });

  it('priority at an edge: clear, then load, then count, then hold', () => {
    const b = new Bench(counter, full).set({ ...idle, clr: '1', load: '1', d: '0110' }).clock();
    expect(b.out('q')).toBe('0000');
    b.set({ clr: '0' }).clock();
    expect(b.out('q')).toBe('0110');
    b.set({ load: '0' }).clock();
    expect(b.out('q')).toBe('0111');
    b.set({ en: '0' }).clock();
    expect(b.out('q')).toBe('0111');
  });

  it('an async clear acts at once and ignores the edge', () => {
    const b = new Bench(counter, { ...full, clear: 'async' }).set({
      ...idle,
      load: '1',
      d: '1001',
    });
    b.clock();
    expect(b.out('q')).toBe('1001');
    b.set({ clr: '1' });
    expect(b.out('q')).toBe('0000');
    b.set({ load: '0' }).clock();
    expect(b.out('q')).toBe('0000');
    b.set({ clr: '0', clk: '0' }).set({ clr: '0', clk: '1' });
    expect(b.out('q')).toBe('0001');
  });

  it('an edge in the same evaluation as an async clear release is ignored', () => {
    const b = new Bench(counter, { clear: 'async' }).set({ clk: '0', clr: '1' });
    b.set({ clr: '0', clk: '1' });
    expect(b.out('q')).toBe('0000');
  });

  it('an edge just after an unknown async clear goes X only on bits the outcomes disagree on', () => {
    const b = new Bench(counter, { clear: 'async' }).set({ clk: '0', clr: '1' }).set({ clr: '0' });
    expect(b.set({ clr: 'X' }).out('q')).toBe('0000');
    // Held at 0000 or counted to 0001.
    expect(b.set({ clr: '0', clk: '1' }).out('q')).toBe('000X');
  });

  it('an edge just after an unknown async clear moves only the shifted-in bit of the shift register to X', () => {
    const p = { width: 4, clear: 'async' };
    const b = new Bench(shiftreg, p).set({ clk: '0', si: '1', clr: '1' }).set({ clr: '0' });
    expect(b.set({ clr: 'X' }).out('q')).toBe('0000');
    expect(b.set({ clr: '0', clk: '1' }).out('q')).toBe('000X');
  });

  for (const width of [1, 4, 32]) {
    it(`wraps from all ones to zero at width ${width}`, () => {
      const ones = '1'.repeat(width);
      const b = new Bench(counter, { width, clear: 'none', hasLoad: true });
      b.set({ clk: '0', load: '1', d: ones }).clock();
      expect(b.out('q')).toBe(ones);
      expect(b.out('tc')).toBe('1');
      b.set({ load: '0' }).clock();
      expect(b.out('q')).toBe('0'.repeat(width));
      expect(b.out('tc')).toBe('0');
    });
  }

  it('tc follows the enable combinationally, ENT only under dualEnable', () => {
    const b = new Bench(counter, { clear: 'none', hasLoad: true, hasEnable: true });
    b.set({ clk: '0', load: '1', d: '1111', en: '1' }).clock();
    expect(b.out('tc')).toBe('1');
    expect(b.set({ en: '0' }).out('tc')).toBe('0');
    const dual = new Bench(counter, { clear: 'none', hasLoad: true, dualEnable: true });
    dual.set({ clk: '0', load: '1', d: '1111', enp: '0', ent: '1' }).clock();
    expect(dual.out('tc')).toBe('1');
    expect(dual.set({ ent: '0' }).out('tc')).toBe('0');
  });

  it('counts under dualEnable only with both ENP and ENT high', () => {
    const b = new Bench(counter, { clear: 'none', hasLoad: true, dualEnable: true });
    b.set({ clk: '0', load: '1', d: '0000', enp: '1', ent: '1' }).clock();
    b.set({ load: '0', enp: '0' }).clock();
    expect(b.out('q')).toBe('0000');
    b.set({ enp: '1', ent: '0' }).clock();
    expect(b.out('q')).toBe('0000');
    b.set({ ent: '1' }).clock();
    expect(b.out('q')).toBe('0001');
  });

  it('an unknown control goes X only where it could change the outcome', () => {
    const loaded = () =>
      new Bench(counter, full)
        .set({ ...idle, load: '1', d: '0101' })
        .clock()
        .set({ load: '0' });
    // Held 0101 or counted to 0110: the top two bits agree.
    expect(loaded().set({ en: 'X' }).clock().out('q')).toBe('01XX');
    expect(loaded().set({ load: 'X' }).clock().out('q')).toBe('01XX');
    // Cleared to 0000 or counted to 0110.
    expect(loaded().set({ clr: 'X' }).clock().out('q')).toBe('0XX0');
    // A known asserted clear wins over an unknown load or enable.
    expect(loaded().set({ clr: '1', load: 'X', en: 'X' }).clock().out('q')).toBe('0000');
    // Loading what it would have held anyway is no change.
    expect(loaded().set({ en: '0', load: 'X', d: '0101' }).clock().out('q')).toBe('0101');
    // clock() leaves CLK high, and 1 to X cannot rise.
    expect(loaded().set({ clk: 'X' }).out('q')).toBe('0101');
    expect(loaded().set({ clk: '0' }).set({ clk: 'X' }).out('q')).toBe('01XX');
  });

  it('the 163 configuration stays X until its first cleared edge', () => {
    const p = { clear: 'sync', hasLoad: true, dualEnable: true, activeLow: true };
    const b = new Bench(counter, p).set({ clk: '0', clr: '1', load: '1', enp: '1', ent: '1' });
    b.clock();
    expect(b.out('q')).toBe('XXXX');
    b.set({ clr: '0' });
    expect(b.out('q')).toBe('XXXX');
    b.clock();
    expect(b.out('q')).toBe('0000');
  });

  it('the 161 configuration clears as soon as /CLR goes low', () => {
    const p = { clear: 'async', hasLoad: true, dualEnable: true, activeLow: true };
    const b = new Bench(counter, p).set({ clk: '0', clr: '1', load: '1', enp: '1', ent: '1' });
    expect(b.out('q')).toBe('XXXX');
    expect(b.set({ clr: '0' }).out('q')).toBe('0000');
  });

  it('flags clear and load active low under activeLow, never the enables', () => {
    const low = counter
      .pins({ hasLoad: true, dualEnable: true, activeLow: true })
      .filter((p) => p.activeLow)
      .map((p) => p.name);
    expect(low).toEqual(['clr', 'load']);
  });
});

describe('shiftreg', () => {
  it('pin shape follows the params', () => {
    const names = (p: Params) => shiftreg.pins(p).map((x) => x.name);
    expect(names({})).toEqual(['clk', 'si', 'q', 'so']);
    expect(names({ clear: 'sync', hasLoad: true, parallelOut: false })).toEqual([
      'clk',
      'si',
      'clr',
      'load',
      'd',
      'so',
    ]);
    expect(
      names({ serialAnd: true, clear: 'async', activeLow: true, pinView: 'q=expanded', width: 2 }),
    ).toEqual(['clk', 'si0', 'si1', 'clr', 'q1', 'q0', 'so']);
    expect(
      names({ hasLoad: true, asyncLoad: true, clockInhibit: true, invertedOut: true }),
    ).toEqual(['clk', 'si', 'inh', 'load', 'd', 'q', 'so', 'son']);
  });

  it('stage 0 takes the serial input and so is the last stage', () => {
    const b = new Bench(shiftreg, { width: 4 }).set({ clk: '0', si: '1' });
    b.clock();
    expect(b.out('q')).toBe('XXX1');
    b.set({ si: '0' }).clock();
    b.set({ si: '1' }).clock();
    b.set({ si: '1' }).clock();
    expect(b.out('q')).toBe('1011');
    expect(b.out('so')).toBe('1');
    b.set({ si: '0' }).clock();
    expect(b.out('q')).toBe('0110');
    expect(b.out('so')).toBe('0');
  });

  it('an unknown serial bit fills only its own stage', () => {
    const b = new Bench(shiftreg, { width: 4, clear: 'sync' }).set({ clk: '0', si: '0', clr: '1' });
    b.clock().set({ clr: '0', si: 'X' }).clock();
    expect(b.out('q')).toBe('000X');
    b.set({ si: '1' }).clock();
    expect(b.out('q')).toBe('00X1');
  });

  it('the block load is synchronous and takes priority below clear', () => {
    const p = { width: 4, clear: 'sync', hasLoad: true };
    const b = new Bench(shiftreg, p).set({ clk: '0', si: '0', clr: '0', load: '1', d: '1001' });
    expect(b.out('q')).toBe('XXXX');
    b.clock();
    expect(b.out('q')).toBe('1001');
    b.set({ clr: '1' }).clock();
    expect(b.out('q')).toBe('0000');
    b.set({ clr: '0', load: 'X', d: '0000' }).clock();
    expect(b.out('q')).toBe('0000');
  });

  it('the 164 configuration ANDs its serial inputs and clears asynchronously', () => {
    const p = { width: 8, serialAnd: true, clear: 'async', activeLow: true };
    const b = new Bench(shiftreg, p).set({ clk: '0', si0: '1', si1: '1', clr: '0' });
    expect(b.out('q')).toBe('00000000');
    b.set({ clr: '1' }).clock();
    expect(b.out('q')).toBe('00000001');
    b.set({ si1: '0' }).clock();
    expect(b.out('q')).toBe('00000010');
    b.set({ clr: '0' });
    expect(b.out('q')).toBe('00000000');
  });

  describe('the 165 configuration', () => {
    const p = {
      width: 8,
      hasLoad: true,
      asyncLoad: true,
      clockInhibit: true,
      invertedOut: true,
      activeLow: true,
      parallelOut: false,
    };
    const loaded = () =>
      new Bench(shiftreg, p).set({ clk: '0', si: '0', inh: '0', load: '0', d: '10110001' });

    it('loads asynchronously while SH/LD is low, following d', () => {
      const b = loaded();
      expect([b.out('so'), b.out('son')]).toEqual(['1', '0']);
      b.set({ d: '00110001' });
      expect(b.out('so')).toBe('0');
      b.set({ clk: '1' }).set({ clk: '0' }).set({ clk: '1' });
      expect(b.out('so')).toBe('0');
    });

    it('shifts toward QH once SH/LD is high', () => {
      const b = loaded().set({ load: '1' });
      const seen: string[] = [];
      for (let i = 0; i < 8; i++) {
        seen.push(b.out('so'));
        b.clock();
      }
      expect(seen.join('')).toBe('10110001');
    });

    it('an inhibit rise while clk is low clocks the part', () => {
      const b = loaded().set({ load: '1' });
      b.set({ inh: '1' });
      expect(b.out('so')).toBe('0');
    });

    it('a clock rise while inhibited does nothing', () => {
      const b = loaded().set({ load: '1' }).set({ inh: '1' }).set({ inh: '1', clk: '0' });
      const before = b.out('so');
      b.set({ clk: '1' });
      expect(b.out('so')).toBe(before);
    });
  });
});
