import { describe, expect, it } from 'vitest';
import { EXAMPLES, EXAMPLE_GROUPS, type Example } from './index';
import { validateDocument } from '../io/validate';
import { compile } from '../core/model/compile';
import { buildTruthTable, resolveOutputNet } from '../core/boolean/truthTable';
import { builtinChipLibrary } from '../core/parts/packages';
import { Simulator } from '../core/sim/kernel';
import { datasheetDelay, idealDelay, type DelayModel } from '../core/sim/delay';
import { analyzeTiming } from '../core/timing/sta';
import {
  column,
  getPart,
  vendorHasRow,
  type DatasheetColumn,
  type Vendor,
} from '../core/parts/partsDb';
import type { Board, ChipDef, ChipLibrary } from '../core/model/types';
import * as bv from '../core/value/busValue';
import { getPrimitive } from '../core/sim/primitives/registry';
import { segmentLit, sevenSegCommon } from '../core/sim/primitives/display';
import { BOUNCE_EDGES_PS } from '../core/sim/primitives/bounce';

/** The library the app opens an example with: built-ins under its own chips. */
function libraryOf(e: Example): ChipLibrary {
  return new Map<string, ChipDef>([
    ...builtinChipLibrary(),
    ...(e.chips ?? []).map((d): [string, ChipDef] => [d.id, d]),
  ]);
}

// Bundled examples are shipped content: without this they rot silently on the
// next format change, which is then a shipped bug rather than a stale file.

describe('bundled examples', () => {
  it('ships a non-empty, uniquely-named list', () => {
    expect(EXAMPLES.length).toBeGreaterThan(0);
    expect(new Set(EXAMPLES.map((e) => e.id)).size).toBe(EXAMPLES.length);
    expect(new Set(EXAMPLES.map((e) => e.name)).size).toBe(EXAMPLES.length);
  });

  // The naming rule: an example is named for the circuit, never for where it
  // came from.
  it('carries no course, chapter or figure references', () => {
    const banned = /chapter|figure|fig\.|section|exercise|harris|textbook|lesson|ch\d/i;
    for (const e of EXAMPLES) {
      expect(banned.test(e.name), e.name).toBe(false);
      expect(banned.test(e.description), e.name).toBe(false);
    }
  });

  for (const e of EXAMPLES) {
    describe(e.name, () => {
      it('validates against the board schema', () => {
        const result = validateDocument(e.board);
        expect(result.valid ? [] : result.errors).toEqual([]);
      });

      it('validates every chip it depends on', () => {
        for (const chip of e.chips ?? []) {
          const result = validateDocument(chip);
          expect(result.valid ? [] : result.errors).toEqual([]);
        }
      });

      it('compiles', () => {
        expect(() => compile(e.board, libraryOf(e))).not.toThrow();
      });
    });
  }

  // Truth tables where one applies: a combinational example whose behaviour is
  // stated here, so a wiring slip cannot pass as "it still compiles".
  const expected: Record<string, { inputs: string[]; outputs: string[]; rows: number[][] }> = {
    'three-variable-sum-of-products': {
      inputs: ['A', 'B', 'C'],
      outputs: ['Y'],
      // Majority of three: at least two inputs high.
      rows: [[0], [0], [0], [1], [0], [1], [1], [1]],
    },
    'de-morgan-pair': {
      inputs: ['A', 'B'],
      outputs: ['NAND', 'OR of inverses'],
      // The whole point: the two outputs agree on every row.
      rows: [
        [1, 1],
        [1, 1],
        [1, 1],
        [0, 0],
      ],
    },
  };

  for (const [id, spec] of Object.entries(expected)) {
    it(`${id} has the truth table it is meant to`, () => {
      const example = EXAMPLES.find((e) => e.id === id)!;
      const circuit = compile(example.board, new Map());
      const table = buildTruthTable(
        circuit,
        spec.inputs.map((i) => `main/${i}`),
        spec.outputs.map((o) => `main/${o}`),
      );
      expect(table.rows.map((r) => r.map((v) => v.v))).toEqual(spec.rows);
    });
  }

  // Nine inputs is one past the truth-table limit, so Cin is fixed per half.
  it('ripple-carry-adder adds A + B + Cin on all 512 rows', () => {
    const example = EXAMPLES.find((e) => e.id === 'ripple-carry-adder')!;
    const bits = (prefix: string) => [3, 2, 1, 0].map((i) => `main/${prefix}${i}`);
    for (const cin of [0, 1]) {
      const board: Board = {
        ...example.board,
        components: example.board.components.map((c) =>
          c.label === 'Cin' ? { ...c, params: { initial: cin } } : c,
        ),
      };
      const table = buildTruthTable(
        compile(board, libraryOf(example)),
        [...bits('A'), ...bits('B')],
        ['main/Cout', ...bits('S')],
      );
      const sums = table.rows.map((r) => r.reduce((acc, v) => acc * 2 + v.v, 0));
      expect(sums).toEqual(Array.from({ length: 256 }, (_, row) => (row >> 4) + (row & 15) + cin));
    }
  });

  /** Row bits MSB-first over the inputs, as buildTruthTable numbers them. */
  const bit = (row: number, i: number, n: number) => (row >> (n - 1 - i)) & 1;
  const minterms =
    (...ms: number[]) =>
    (row: number) => [ms.includes(row) ? 1 : 0];
  const MAJORITY = minterms(3, 5, 6, 7);
  const Y_FUNCTION = minterms(0, 3, 4, 5);
  const F_FUNCTION = [0, 1, 2, 4, 5, 7, 11, 15];
  const range = (n: number) => Array.from({ length: n }, (_, i) => i);
  const activeLowLeds = range(8).map((i) => `/Y${i}`);

  // Each multiplexer and decoder board against the function it builds, on
  // every row, through whatever DIPs carry it.
  const functions: Record<
    string,
    { inputs: string[]; outputs: string[]; rowOf: (row: number) => number[] }
  > = {
    'two-to-one-multiplexer': {
      inputs: ['S', 'D1', 'D0'],
      outputs: ['Y'],
      rowOf: (r) => [bit(r, 0, 3) ? bit(r, 1, 3) : bit(r, 2, 3)],
    },
    'four-to-one-multiplexer-tree': {
      inputs: ['S1', 'S0', 'D3', 'D2', 'D1', 'D0'],
      outputs: ['Y'],
      rowOf: (r) => [(r >> (r >> 4)) & 1],
    },
    'function-on-an-eight-to-one-multiplexer': {
      inputs: ['A', 'B', 'C'],
      outputs: ['Y'],
      rowOf: Y_FUNCTION,
    },
    'folded-variable-on-a-four-to-one-multiplexer': {
      inputs: ['A', 'B', 'C'],
      outputs: ['Y'],
      rowOf: Y_FUNCTION,
    },
    'four-variable-function-on-a-74ls151': {
      inputs: ['A', 'B', 'C', 'D'],
      outputs: ['F', "F'"],
      rowOf: (r) => (F_FUNCTION.includes(r) ? [1, 0] : [0, 1]),
    },
    'majority-on-an-eight-to-one-multiplexer': {
      inputs: ['A', 'B', 'C'],
      outputs: ['Y'],
      rowOf: MAJORITY,
    },
    'majority-on-a-four-to-one-multiplexer': {
      inputs: ['A', 'B', 'C'],
      outputs: ['Y'],
      rowOf: MAJORITY,
    },
    'majority-from-a-decoder': { inputs: ['A', 'B', 'C'], outputs: ['Y'], rowOf: MAJORITY },
    'two-to-four-decoder': {
      inputs: ['A1', 'A0'],
      outputs: ['Y0', 'Y1', 'Y2', 'Y3'],
      rowOf: (r) => range(4).map((i) => (i === r ? 1 : 0)),
    },
    'three-to-eight-decoder-from-a-74ls139': {
      inputs: ['A2', 'A1', 'A0'],
      outputs: activeLowLeds,
      rowOf: (r) => range(8).map((i) => (i === r ? 0 : 1)),
    },
    'decoder-logic-on-a-74ls138': { inputs: ['A', 'B', 'C'], outputs: ['Y'], rowOf: Y_FUNCTION },
    'demultiplexer-on-a-74ls138': {
      inputs: ['C', 'B', 'A', 'DATA'],
      outputs: activeLowLeds,
      rowOf: (r) => range(8).map((i) => (i === r >> 1 ? r & 1 : 1)),
    },
  };

  for (const [id, spec] of Object.entries(functions)) {
    it(`${id} computes its function on every row`, () => {
      const example = EXAMPLES.find((e) => e.id === id)!;
      const table = buildTruthTable(
        compile(example.board, libraryOf(example)),
        spec.inputs.map((i) => `main/${i}`),
        spec.outputs.map((o) => `main/${o}`),
      );
      const known = table.rows.map((r) => r.map((v) => (v.x | v.z ? 'X' : v.v)));
      expect(known).toEqual(table.rows.map((_, row) => spec.rowOf(row)));
    });
  }

  /** A powered display board, read the way the glyph lights it. */
  function displayBoard(id: string, switches: string[]) {
    const example = EXAMPLES.find((e) => e.id === id)!;
    const circuit = compile(example.board, libraryOf(example));
    const ds = example.board.components.find((c) => c.kind === 'sevenseg')!;
    const prim = circuit.primitives[circuit.pathToPrimitive.get(`main/${ds.label ?? ds.id}`)!]!;
    const pinNames = getPrimitive('sevenseg')
      .pins(prim.params)
      .map((p) => p.name);
    const netOf = (pin: string) => prim.inputs[pinNames.indexOf(pin)]!;
    const common = sevenSegCommon(prim.params);
    const sim = new Simulator(circuit, idealDelay);
    sim.powerOn();
    /** Segment letters lit for one switch code, first switch most significant. */
    return (code: number): string => {
      switches.forEach((s, i) => sim.setToggle(`main/${s}`, bit(code, i, switches.length) === 1));
      sim.settle();
      const state = (pin: string) => bv.toString(sim.netValue(netOf(pin)), 1);
      return [...'abcdefg'].filter((s) => segmentLit(state(s), common, state('com1'))).join('');
    };
  }

  // Segment a lights on 0, 2, 3, 5, 6, 7, 8 and 9 in both minimums; they part
  // on the unused codes, which is the whole lesson of the pair.
  const SEGMENT_A_DIGITS = [0, 2, 3, 5, 6, 7, 8, 9];
  it.each([
    ['seven-segment-segment-a-unused-codes-0', false],
    ['seven-segment-segment-a-unused-codes-dont-care', true],
  ])('%s lights segment a by its own minimum', (id, litOnUnused) => {
    const lit = displayBoard(id, ['A', 'B', 'C', 'D']);
    for (let code = 0; code < 16; code++)
      expect({ code, lit: lit(code) }).toEqual({
        code,
        lit: (code > 9 ? litOnUnused : SEGMENT_A_DIGITS.includes(code)) ? 'a' : '',
      });
  });

  /** The '47/'48 datasheet glyphs, codes 0 to 15: 6 has no a and 9 no d. */
  const DATASHEET_GLYPHS = [
    'abcdef',
    'bc',
    'abdeg',
    'abcdg',
    'bcfg',
    'acdfg',
    'cdefg',
    'abc',
    'abcdefg',
    'abcfg',
    'deg',
    'cdg',
    'bfg',
    'adfg',
    'defg',
    '',
  ];
  it.each(['seven-segment-display-on-a-74ls47', 'seven-segment-display-on-a-74ls48'])(
    '%s shows the datasheet glyph for every code',
    (id) => {
      const lit = displayBoard(id, ['D', 'C', 'B', 'A']);
      expect(range(16).map(lit)).toEqual(DATASHEET_GLYPHS);
    },
  );

  /** A powered combinational board on ideal timing: set switches, read
   *  outputs as one number, first label most significant. */
  function bench(id: string) {
    const example = EXAMPLES.find((e) => e.id === id)!;
    const circuit = compile(example.board, libraryOf(example));
    const sim = new Simulator(circuit, idealDelay);
    sim.powerOn();
    const set = (values: Record<string, number>) => {
      for (const [label, v] of Object.entries(values)) sim.setToggleValue(`main/${label}`, v);
      expect(sim.settle().settled).toBe(true);
    };
    const read = (...labels: string[]) =>
      labels.reduce((acc, label) => {
        const net = resolveOutputNet(circuit, `main/${label}`);
        const v = sim.netValue(net);
        expect(v.x | v.z, label).toBe(0);
        return acc * 2 ** circuit.nets[net]!.width + v.v;
      }, 0);
    return { set, read };
  }

  const signed4 = (x: number) => (x & 8 ? x - 16 : x);

  it('half-adder writes S = A xor B and Cout = AB', () => {
    const { set, read } = bench('half-adder');
    for (let a = 0; a < 2; a++)
      for (let b = 0; b < 2; b++) {
        set({ A: a, B: b });
        expect(read('Cout', 'S')).toBe(a + b);
      }
  });

  for (const id of ['full-adder-on-a-74ls153', 'full-adder-propagation-delay'])
    it(`${id} adds A + B + Cin on all 8 rows`, () => {
      const { set, read } = bench(id);
      for (let row = 0; row < 8; row++) {
        set({ A: row >> 2, B: (row >> 1) & 1, Cin: row & 1 });
        expect(read('Cout', 'S'), `row ${row}`).toBe((row >> 2) + ((row >> 1) & 1) + (row & 1));
      }
    });

  // The switches number bits from 0; the package numbers its pins from 1.
  it('four-bit-adder-on-a-74ls283 adds A + B + C0 on all 512 rows', () => {
    const { set, read } = bench('four-bit-adder-on-a-74ls283');
    for (let c0 = 0; c0 < 2; c0++)
      for (let a = 0; a < 16; a++)
        for (let b = 0; b < 16; b++) {
          const bits: Record<string, number> = { C0: c0 };
          for (let i = 0; i < 4; i++) {
            bits[`A${i}`] = (a >> i) & 1;
            bits[`B${i}`] = (b >> i) & 1;
          }
          set(bits);
          expect(read('C4', 'S3', 'S2', 'S1', 'S0')).toBe(a + b + c0);
        }
  });

  // Every A against every fifth B and 255: all 65,536 pairs outrun the test timeout.
  it(
    'eight-bit-adder adds every A to a spread of B, carries across the packages included',
    { timeout: 30_000 },
    () => {
      const { set, read } = bench('eight-bit-adder');
      const bs = [...Array.from({ length: 52 }, (_, i) => i * 5), 255];
      for (let a = 0; a < 256; a++)
        for (const b of bs) {
          set({ 'A7-A4': a >> 4, 'A3-A0': a & 15, 'B7-B4': b >> 4, 'B3-B0': b & 15 });
          expect(read('C8', 'S7-S4', 'S3-S0')).toBe(a + b);
        }
    },
  );

  it('adder-subtracter gives A + B or A - B, the carry and signed overflow', () => {
    const { set, read } = bench('adder-subtracter');
    for (let sub = 0; sub < 2; sub++)
      for (let a = 0; a < 16; a++)
        for (let b = 0; b < 16; b++) {
          set({ A: a, B: b, SUB: sub });
          const exact = sub ? signed4(a) - signed4(b) : signed4(a) + signed4(b);
          const want = {
            s: (sub ? a - b + 16 : a + b) & 15,
            // Subtracting, C4 is 1 exactly when there is no borrow.
            c4: sub ? +(a >= b) : +(a + b > 15),
            v: +(exact < -8 || exact > 7),
          };
          const got = { s: read('S3', 'S2', 'S1', 'S0'), c4: read('C4'), v: read('V') };
          expect(got, `${a} ${sub ? '-' : '+'} ${b}`).toEqual(want);
        }
  });

  // F1 F0: 00 add, 01 subtract, 10 AND, 11 OR. C and V are forced to 0 for
  // the logic operations; N is Y3 and Z is Y = 0.
  it('four-operation-alu runs all four operations on all 256 pairs, flags included', () => {
    const { set, read } = bench('four-operation-alu');
    for (let f = 0; f < 4; f++)
      for (let a = 0; a < 16; a++)
        for (let b = 0; b < 16; b++) {
          set({ A: a, B: b, F1: f >> 1, F0: f & 1 });
          const bx = f & 1 ? ~b & 15 : b;
          const total = a + bx + (f & 1);
          const s = total & 15;
          const y = [s, s, a & b, a | b][f]!;
          const arith = f < 2 ? 1 : 0;
          const want = {
            y,
            n: y >> 3,
            z: +(y === 0),
            c: arith & (total >> 4),
            v: arith & ((a >> 3) ^ (s >> 3)) & ((bx >> 3) ^ (s >> 3)),
          };
          const got = { y: read('Y'), n: read('N'), z: read('Z'), c: read('C'), v: read('V') };
          expect(got, `F=${f} A=${a} B=${b}`).toEqual(want);
        }
  });

  /** The larger of tPLH and tPHL in one column, the figure the delay
   *  calculation takes; the 74LS86 takes its worst-case row on max. */
  function larger(part: string, col: 'typ' | 'max', vendor: Vendor = 'ti'): number {
    const p = getPart(part, vendor)!;
    const rows =
      col === 'max' ? [p.tplh_worst ?? p.tplh, p.tphl_worst ?? p.tphl] : [p.tplh, p.tphl];
    return Math.max(...rows.map((r) => column(r!, col)));
  }
  const largerArc = (part: string, arc: string, col: 'typ' | 'max') => {
    const row = getPart(part)!.paths![arc]!;
    return Math.max(column(row.tplh!, col), column(row.tphl!, col));
  };
  const timingOf = (id: string, col: DatasheetColumn, vendor?: Vendor) => {
    const example = EXAMPLES.find((e) => e.id === id)!;
    return analyzeTiming(compile(example.board, libraryOf(example)), {
      column: col,
      vendor: vendor ?? example.board.timing.vendor,
    });
  };

  it('full-adder-propagation-delay is slowest from A or B through X1, A2 and O1 to Cout', () => {
    const example = EXAMPLES.find((e) => e.id === 'full-adder-propagation-delay')!;
    expect(example.board.timing).toEqual({
      mode: 'datasheet',
      datasheet: 'max',
      vendor: 'fairchild',
    });
    for (const vendor of ['fairchild', 'ti'] as const)
      for (const col of ['typ', 'max'] as const) {
        const worst = timingOf('full-adder-propagation-delay', col, vendor).worst!;
        expect(worst.endpoint).toBe('main/Cout');
        expect(['main/A', 'main/B']).toContain(worst.startpoint);
        expect(worst.critical.map((h) => h.part)).toEqual(['74LS86', '74LS08', '74LS32']);
        expect(worst.totalTpdPs).toBe(
          1000 *
            (larger('74LS86', col, vendor) +
              larger('74LS08', col, vendor) +
              larger('74LS32', col, vendor)),
        );
      }
  });

  // The chapter's figures: 18 + 13 + 11 from Fairchild's sheets against TI's 30 + 20 + 22,
  // and a t_cd of AND min + OR min that is printed, not estimated.
  it('full-adder-propagation-delay reads 42 ns on Fairchild and 72 ns on TI', () => {
    const fairchild = timingOf('full-adder-propagation-delay', 'max').worst!;
    expect(fairchild.totalTpdPs).toBe(42_000);
    expect(fairchild.totalTcdPs).toBe(6_000);
    expect(fairchild.estimated).toBe(false);
    // Max-only sheets: max stands in for typ only where typ is the column read.
    expect(fairchild.typUnpublished).toBe(false);
    expect(timingOf('full-adder-propagation-delay', 'typ').worst!.typUnpublished).toBe(true);
    const ti = timingOf('full-adder-propagation-delay', 'max', 'ti').worst!;
    expect(ti.totalTpdPs).toBe(72_000);
    expect(ti.estimated).toBe(true);
  });

  // The register is a seed, not a hop, so the board-wide list is what names it.
  it('lists the TI-timed 74LS74 among the parts of a Fairchild register board', () => {
    const report = timingOf('register-to-register-path', 'max');
    expect(report.parts).toContain('74LS74');
    expect(vendorHasRow('74LS74', 'fairchild')).toBe(false);
  });

  // Six stage delays a period: Fairchild's 3 ns min and 10 ns max for the '00 and '04.
  it.each([
    ['min', 18_000],
    ['max', 60_000],
  ] as const)(
    'ring-oscillator-on-a-74ls00-and-a-74ls04 runs a %s period of %i ps',
    (col, period) => {
      const example = EXAMPLES.find((e) => e.id === 'ring-oscillator-on-a-74ls00-and-a-74ls04')!;
      expect(example.board.timing).toEqual({
        mode: 'datasheet',
        datasheet: 'max',
        vendor: 'fairchild',
      });
      const circuit = compile(example.board, libraryOf(example));
      const sim = new Simulator(circuit, datasheetDelay(col, 'fairchild'));
      sim.powerOn();
      sim.settle();
      const y = resolveOutputNet(circuit, 'main/Y');
      expect(sim.netValue(y), 'EN low holds the ring').toEqual(bv.known(1, 1));
      sim.setToggle('main/EN', true);
      sim.runUntil(sim.time + 10 * period);
      const rises = sim
        .traceRecords()
        .filter((r) => r.net === y && r.value.v === 1 && r.value.x === 0)
        .map((r) => r.time);
      const gaps = rises.slice(-4).map((t, i, a) => (i ? t - a[i - 1]! : 0));
      expect(gaps.slice(1)).toEqual(Array(3).fill(period));
    },
  );

  it('switch-debouncer-on-a-74ls00 sets Q once while /S bounces', () => {
    const example = EXAMPLES.find((e) => e.id === 'switch-debouncer-on-a-74ls00')!;
    expect(example.board.runSpeed).toBe(100_000_000);
    const circuit = compile(example.board, libraryOf(example));
    const sim = new Simulator(circuit, datasheetDelay('max', 'fairchild'));
    sim.powerOn();
    sim.settle();
    const q = resolveOutputNet(circuit, 'main/Q');
    const s = circuit.pathToNet.get('main//S')!;
    expect(sim.netValue(q), 'starts reset, the lever on B').toEqual(bv.known(0, 1));
    const t0 = sim.time;
    sim.setPrimitiveState('main/SW', { position: 'a' });
    sim.settle();
    const after = sim.traceRecords().filter((r) => r.time > t0);
    expect(after.filter((r) => r.net === s)).toHaveLength(BOUNCE_EDGES_PS.length);
    expect(after.filter((r) => r.net === q).map((r) => bv.toString(r.value, 1))).toEqual(['1']);
  });

  it('times every Chapter 7 and 8 example from Fairchild and the bus computer from TI', () => {
    const vendorOf = (id: string) => EXAMPLES.find((e) => e.id === id)!.board.timing.vendor;
    const fairchildIds = [
      'half-adder',
      'full-adder',
      'full-adder-on-a-74ls153',
      'ripple-carry-adder',
      'four-bit-adder-on-a-74ls283',
      'eight-bit-adder',
      'adder-subtracter',
      'four-operation-alu',
      'full-adder-propagation-delay',
      'static-hazard',
      'sr-latch',
      'd-latch',
      'd-flip-flop',
      'divide-by-two',
      'mod-10-counter',
      'shift-register',
      'register-to-register-path',
      'latch-versus-flip-flop',
      'preset-and-clear-on-a-74ls74',
      'enabled-register-on-a-74ls157-and-two-74ls74s',
      'three-bit-counter-on-two-74ls74s',
      'ring-oscillator-on-a-74ls00-and-a-74ls04',
      'switch-debouncer-on-a-74ls00',
    ];
    for (const id of fairchildIds) expect(vendorOf(id), id).toBe('fairchild');
    for (const e of EXAMPLES.filter((x) => x.group === 'Bus computer'))
      expect(e.board.timing.vendor, e.id).toBe('ti');
  });

  // Ai, Bi to C4 of the low package, then its carry to a sum of the high one.
  it('eight-bit-adder is slowest from a low operand through both packages to S7-S4', () => {
    for (const col of ['typ', 'max'] as const) {
      const worst = timingOf('eight-bit-adder', col).worst!;
      expect(worst.endpoint).toBe('main/S7-S4');
      expect(['main/A3-A0', 'main/B3-B0']).toContain(worst.startpoint);
      expect(worst.critical.map((h) => h.path)).toEqual(['main/U1', 'main/U2']);
      expect(worst.totalTpdPs).toBe(
        1000 * (largerArc('74LS283', 'ab_to_cout', col) + largerArc('74LS283', 'cin_to_sum', col)),
      );
    }
  });

  const TIMINGS: [string, DelayModel][] = [
    ['ideal', idealDelay],
    ['datasheet typ', datasheetDelay('typ')],
    ['datasheet max', datasheetDelay('max')],
    ['datasheet min', datasheetDelay('min')],
    ['datasheet Fairchild max', datasheetDelay('max', 'fairchild')],
  ];

  describe.each(TIMINGS)('clocked examples, %s', (_, delay) => {
    const periodOf = (id: string) => {
      const clk = EXAMPLES.find((e) => e.id === id)!.board.components.find(
        (c) => c.kind === 'clock',
      );
      return clk!.params!['periodPs'] as number;
    };
    /** Rising edges fall on whole periods; this is the settled low phase. */
    const sampleAt = (id: string, cycle: number) => (cycle + 0.75) * periodOf(id);
    /** Past the slowest asynchronous preset or clear, still short of the next rising edge. */
    const SETTLE_PS = 80_000;

    /** A powered, free-running board and a reader for its LEDs as one
     *  number, first label most significant. */
    function running(id: string, leds: string[]) {
      const example = EXAMPLES.find((e) => e.id === id)!;
      const circuit = compile(example.board, libraryOf(example));
      const sim = new Simulator(circuit, delay);
      sim.powerOn();
      sim.start();
      const nets = leds.map((label) => resolveOutputNet(circuit, `main/${label}`));
      const read = () =>
        nets.reduce((acc, net, i) => {
          const v = sim.netValue(net);
          expect(v.x | v.z, leds[i]).toBe(0);
          return acc * 2 + v.v;
        }, 0);
      return { sim, read };
    }

    it('mod-10-counter counts 0 to 9 and wraps once /RST is released', () => {
      const { sim, read: q } = running('mod-10-counter', ['QD', 'QC', 'QB', 'QA']);
      const at = (cycle: number) => sampleAt('mod-10-counter', cycle);
      sim.runUntil(at(1));
      expect(q()).toBe(0);
      sim.runUntil(at(2));
      expect(q()).toBe(0);
      sim.setToggle('main//RST', true);
      const counts: number[] = [];
      for (let cycle = 3; cycle <= 14; cycle++) {
        sim.runUntil(at(cycle));
        counts.push(q());
      }
      expect(counts).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1, 2]);
    });

    it('shift-register moves the serial input one stage per clock edge', () => {
      const { sim, read: q } = running('shift-register', ['Q3', 'Q2', 'Q1', 'Q0']);
      const at = (cycle: number) => sampleAt('shift-register', cycle);
      sim.runUntil(at(0));
      expect(q()).toBe(0);
      sim.setToggle('main/CLR', false);
      const pattern = [1, 0, 1, 1, 0, 0, 0, 0];
      const seen = pattern.map((bit, i) => {
        sim.setToggle('main/SI', bit === 1);
        sim.runUntil(at(i + 1));
        return q();
      });
      let expected = 0;
      expect(seen).toEqual(pattern.map((bit) => (expected = ((expected << 1) | bit) & 15)));
    });

    // CLK rises every 400 ns; D is a 600 ns clock from 50 ns, so the pattern repeats every
    // 1200 ns and each D edge sits 50 ns from a CLK edge, in both phases.
    it('latch-versus-flip-flop parts the latch from the flip-flop when D moves mid-phase', () => {
      const { sim, read } = running('latch-versus-flip-flop', ['Latch Q', 'Flip-flop Q']);
      const offsets = [150, 300, 500, 700, 900, 1100];
      const seen: number[] = [];
      for (const start of [1200, 2400])
        for (const ns of offsets) {
          sim.runUntil((start + ns) * 1000);
          seen.push(read());
        }
      const latch = [1, 1, 0, 0, 1, 0];
      const flipFlop = [0, 0, 0, 0, 1, 1];
      const once = latch.map((l, i) => l * 2 + flipFlop[i]!);
      expect(seen).toEqual([...once, ...once]);
    });

    it('preset-and-clear-on-a-74ls74 overrides the clock and D through /PRE and /CLR', () => {
      const { sim, read } = running('preset-and-clear-on-a-74ls74', ['Q', '/Q']);
      const at = (cycle: number) => sampleAt('preset-and-clear-on-a-74ls74', cycle);
      const Q0 = 0b01;
      const Q1 = 0b10;
      sim.runUntil(at(0));
      expect(read(), 'held clear at power-on').toBe(Q0);
      sim.setToggle('main//CLR', true);
      sim.setToggle('main/D', true);
      sim.runUntil(at(1));
      expect(read(), 'D clocked in').toBe(Q1);
      sim.setToggle('main//CLR', false);
      sim.runUntil(sim.time + SETTLE_PS);
      expect(read(), 'cleared mid-phase').toBe(Q0);
      sim.runUntil(at(3));
      expect(read(), 'clear beats two edges with D high').toBe(Q0);
      sim.setToggle('main//CLR', true);
      sim.setToggle('main/D', false);
      sim.setToggle('main//PRE', false);
      sim.runUntil(sim.time + SETTLE_PS);
      expect(read(), 'preset mid-phase').toBe(Q1);
      sim.runUntil(at(5));
      expect(read(), 'preset beats two edges with D low').toBe(Q1);
      sim.setToggle('main//CLR', false);
      sim.runUntil(sim.time + SETTLE_PS);
      expect(read(), 'both low drives Q and /Q high').toBe(Q0 | Q1);
      sim.setToggle('main//PRE', true);
      sim.runUntil(sim.time + SETTLE_PS);
      expect(read(), 'clear alone again').toBe(Q0);
    });

    it('enabled-register-on-a-74ls157-and-two-74ls74s loads with LOAD high and holds with it low', () => {
      const id = 'enabled-register-on-a-74ls157-and-two-74ls74s';
      const { sim, read: q } = running(id, ['Q3', 'Q2', 'Q1', 'Q0']);
      const at = (cycle: number) => sampleAt(id, cycle);
      const setD = (word: number) =>
        [3, 2, 1, 0].forEach((i) => sim.setToggle(`main/D${i}`, ((word >> i) & 1) === 1));
      setD(0b1011);
      sim.runUntil(at(1));
      expect(q(), 'held clear').toBe(0);
      sim.setToggle('main//CLR', true);
      sim.runUntil(at(2));
      expect(q(), 'LOAD low holds the cleared word').toBe(0);
      sim.setToggle('main/LOAD', true);
      sim.runUntil(at(3));
      expect(q(), 'loaded').toBe(0b1011);
      sim.setToggle('main/LOAD', false);
      setD(0b0110);
      sim.runUntil(at(5));
      expect(q(), 'held through two edges').toBe(0b1011);
      sim.setToggle('main/LOAD', true);
      sim.runUntil(at(6));
      expect(q(), 'loaded again').toBe(0b0110);
      sim.setToggle('main//CLR', false);
      sim.runUntil(sim.time + SETTLE_PS);
      expect(q(), 'cleared mid-phase').toBe(0);
    });

    it('three-bit-counter-on-two-74ls74s counts 0 to 7 and wraps once /CLR is released', () => {
      const id = 'three-bit-counter-on-two-74ls74s';
      const { sim, read: q } = running(id, ['Q2', 'Q1', 'Q0']);
      const at = (cycle: number) => sampleAt(id, cycle);
      sim.runUntil(at(1));
      expect(q()).toBe(0);
      sim.setToggle('main//CLR', true);
      const counts: number[] = [];
      for (let cycle = 2; cycle <= 11; cycle++) {
        sim.runUntil(at(cycle));
        counts.push(q());
      }
      expect(counts).toEqual([1, 2, 3, 4, 5, 6, 7, 0, 1, 2]);
    });

    describe('program-counter-mar-and-ram', () => {
      const id = 'program-counter-mar-and-ram';
      const period = periodOf(id);
      const switchPath = (name: string) => `main/${name}`;

      /** A powered, free-running board. Controls change in the high phase and
       *  take effect at the next rising edge; the bus is read before the fall. */
      function computer() {
        const example = EXAMPLES.find((e) => e.id === id)!;
        const circuit = compile(example.board, libraryOf(example));
        const sim = new Simulator(circuit, delay);
        sim.powerOn();
        sim.start();
        const lines = Array.from({ length: 8 }, (_, bit) =>
          resolveOutputNet(circuit, `main/BUS.a${bit}`),
        );
        let now = 0.45 * period;
        sim.runUntil(now);
        const idle = { '/CO': true, '/MI': true, '/RO': true, '/J': true, CE: false, RI: false };
        const cycle = (set: Record<string, boolean> = {}) => {
          for (const [name, on] of Object.entries(set)) sim.setToggle(switchPath(name), on);
          now += period;
          sim.runUntil(now);
          return lines.reduce((word, net, bit) => {
            const v = sim.netValue(net);
            expect(v.x | v.z, `B${bit}`).toBe(0);
            return word | (v.v << bit);
          }, 0);
        };
        const count = (n: number) => {
          let last = 0;
          for (let i = 0; i < n; i++) last = cycle({ ...idle, '/CO': false, CE: true });
          return last;
        };
        const release = () => cycle({ ...idle, CLR: false });
        /** MAR takes the PC, then the RAM word there is read while the PC steps on. */
        const fetch = () => {
          cycle({ ...idle, '/CO': false, '/MI': false });
          return cycle({ ...idle, '/RO': false, CE: true });
        };
        /** Program mode: the switch word goes into the switch address. */
        const program = (address: number, word: number) => {
          sim.setToggleValue(switchPath('ADDR'), address);
          sim.setToggleValue(switchPath('DATA'), word);
          cycle({ PROG: true });
          sim.setButtonPressed(switchPath('WRITE'), true);
          cycle();
          sim.setButtonPressed(switchPath('WRITE'), false);
          // The strobe must be gone before the address and data sources switch back.
          cycle();
          cycle({ PROG: false });
        };
        return { cycle, count, release, fetch, program, idle };
      }

      it('counts 0 to 15 on the bus and wraps', () => {
        const { cycle, count, idle } = computer();
        expect(cycle({ ...idle, '/CO': false })).toBe(0);
        cycle({ CLR: false });
        const seen = Array.from({ length: 18 }, () => count(1));
        expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0, 1, 2]);
      });

      it('reads the program and its data through the PC, MAR and RAM', () => {
        const { fetch, release } = computer();
        release();
        const words = Array.from({ length: 16 }, () => fetch());
        const expected = Array<number>(16).fill(0);
        [0x1e, 0x2f, 0xe0, 0xf0].forEach((w, i) => (expected[i] = w));
        expected[14] = 0x1c;
        expected[15] = 0x0e;
        expect(words).toEqual(expected);
      });

      it('loads the PC from the bus on /J', () => {
        const { cycle, count, idle, release } = computer();
        release();
        count(14);
        cycle({ ...idle, '/CO': false, '/MI': false });
        // Cell 14 holds 0x1C, so the jump lands on its low nibble.
        expect(cycle({ ...idle, '/RO': false, '/J': false })).toBe(0x1c);
        expect(cycle({ ...idle, '/CO': false })).toBe(0xc);
      });

      it('stores the bus on RI and the clock in run mode', () => {
        const { cycle, count, idle, release } = computer();
        release();
        count(3);
        cycle({ ...idle, '/CO': false, '/MI': false });
        // The PC (3) is on the bus while RI is high, so cell 3 stops being 0xF0.
        cycle({ ...idle, '/CO': false, RI: true });
        expect(cycle({ ...idle, '/RO': false })).toBe(3);
      });

      it('writes a cell in program mode and reads it back in run mode', () => {
        const { count, release, fetch, program } = computer();
        release();
        program(5, 0xa5);
        count(5);
        expect(fetch()).toBe(0xa5);
      });

      it('loads the preload again at the next power-on', () => {
        const first = computer();
        first.release();
        first.program(0, 0x55);
        expect(first.fetch()).toBe(0x55);

        const second = computer();
        second.release();
        expect(second.fetch()).toBe(0x1e);
      });
    });
  });

  describe.each(TIMINGS)('bus examples, %s', (_, delay) => {
    /** A powered, free-running board whose switches are changed in the low
     *  phase of the clock, so a load edge is always a whole period away. */
    function powered(id: string) {
      const example = EXAMPLES.find((e) => e.id === id)!;
      const circuit = compile(example.board, libraryOf(example));
      const sim = new Simulator(circuit, delay);
      sim.powerOn();
      sim.start();
      const clk = example.board.components.find((c) => c.kind === 'clock')!;
      const period = clk.params!['periodPs'] as number;
      let now = 0.6 * period;
      sim.runUntil(now);
      const advance = (periods: number) => sim.runUntil((now += periods * period));
      /** Bits MSB first; X where two drivers disagree. */
      const bits = (label: string) =>
        range(8)
          .reverse()
          .map((i) => {
            const v = sim.netValue(resolveOutputNet(circuit, `main/${label}.a${i}`));
            return v.x | v.z ? 'X' : String(v.v & 1);
          })
          .join('');
      const led = (label: string) => {
        const v = sim.netValue(resolveOutputNet(circuit, `main/${label}`));
        return v.x | v.z ? 'X' : v.v;
      };
      const flip = (label: string, on: boolean) => sim.setToggle(`main/${label}`, on);
      const put = (label: string, value: number) => sim.setToggleValue(`main/${label}`, value);
      return { advance, bits, led, flip, put };
    }
    const pattern = (v: number) => v.toString(2).padStart(8, '0');

    it('bus-and-registers reads 0 undriven, loads through the bus and shows X on contention', () => {
      const { advance, bits, flip, put } = powered('bus-and-registers');
      flip('CLR', false);
      advance(0.25);
      expect(bits('BUS')).toBe('00000000');

      // Switches onto the bus, then into A on the next edge.
      put('IN', 0xa5);
      flip('/IE', false);
      flip('/AI', false);
      advance(0.25);
      expect(bits('BUS')).toBe(pattern(0xa5));
      advance(1);
      expect(bits('A')).toBe(pattern(0xa5));
      flip('/IE', true);
      flip('/AI', true);
      advance(0.25);
      expect(bits('BUS')).toBe('00000000');

      // A is held while the switches change, then moves to B across the bus.
      put('IN', 0x3c);
      advance(1);
      expect(bits('A')).toBe(pattern(0xa5));
      expect(bits('B')).toBe('00000000');
      flip('/AO', false);
      flip('/BI', false);
      advance(1);
      expect(bits('B')).toBe(pattern(0xa5));
      expect(bits('BUS')).toBe(pattern(0xa5));
      flip('/AO', true);
      flip('/BI', true);
      advance(0.25);
      expect(bits('BUS')).toBe('00000000');

      // Two drivers: X on the lines that disagree, the shared value elsewhere.
      flip('/IE', false);
      flip('/AO', false);
      advance(0.25);
      expect(bits('BUS')).toBe('X01XX10X');
      put('IN', 0xa5);
      advance(0.25);
      expect(bits('BUS')).toBe(pattern(0xa5));
    });

    // A spread of operands that reaches every carry boundary: all 65,536 pairs outrun the timeout.
    const operands = [0, 1, 2, 15, 16, 17, 85, 127, 128, 129, 170, 200, 240, 254, 255];

    it('alu-and-flags puts A + B or A - B on the bus when /EO is low', () => {
      const { advance, bits, flip, put } = powered('alu-and-flags');
      for (const sub of [false, true]) {
        flip('SU', sub);
        for (const a of operands)
          for (const b of operands) {
            put('A', a);
            put('B', b);
            flip('/EO', false);
            advance(0.2);
            const want = (sub ? a - b : a + b) & 255;
            expect(bits('BUS'), `${a} ${sub ? '-' : '+'} ${b}`).toBe(pattern(want));
            flip('/EO', true);
            advance(0.2);
            expect(bits('BUS')).toBe('00000000');
          }
      }
    });

    it('alu-and-flags latches CF and ZF only on a clock edge with /FI low', () => {
      const { advance, led, flip, put } = powered('alu-and-flags');
      flip('CLR', false);
      advance(0.25);
      const flags = () => [led('CF'), led('ZF')];
      expect(flags()).toEqual([0, 0]);

      // 200 + 100 carries out and is not zero; nothing moves until /FI is low and the clock rises.
      put('A', 200);
      put('B', 100);
      advance(1);
      expect(flags()).toEqual([0, 0]);
      flip('/FI', false);
      advance(0.1);
      expect(flags()).toEqual([0, 0]);
      advance(0.9);
      expect(flags()).toEqual([1, 0]);

      // 5 - 5 is zero with no borrow, but /FI is high so the flags stay.
      flip('/FI', true);
      flip('SU', true);
      put('A', 5);
      put('B', 5);
      advance(2);
      expect(flags()).toEqual([1, 0]);
      flip('/FI', false);
      advance(1);
      expect(flags()).toEqual([1, 1]);

      // 3 - 5 borrows and is not zero.
      put('A', 3);
      advance(1);
      expect(flags()).toEqual([0, 0]);
    });
  });

  /** A grouped bus board on its free-running clock. Switch paths carry the
   *  group name, so `where` maps each control line to its full path. */
  function groupedComputer(
    id: string,
    where: Record<string, string>,
    idle: Record<string, boolean>,
    delay: DelayModel,
  ) {
    const example = EXAMPLES.find((e) => e.id === id)!;
    const circuit = compile(example.board, libraryOf(example));
    const sim = new Simulator(circuit, delay);
    sim.powerOn();
    sim.start();
    const period = example.board.components.find((c) => c.kind === 'clock')!.params![
      'periodPs'
    ] as number;
    let now = 0.45 * period;
    sim.runUntil(now);
    const lane = (label: string, bit: number) => resolveOutputNet(circuit, `main/${label}.a${bit}`);
    const word = (label: string) =>
      range(8).reduce((acc, bit) => {
        const v = sim.netValue(lane(label, bit));
        expect(v.x | v.z, `${label} bit ${bit}`).toBe(0);
        return acc | (v.v << bit);
      }, 0);
    /** Switches change in the high phase and act at the next rising edge. */
    const cycle = (set: Record<string, boolean> = {}) => {
      for (const [name, on] of Object.entries({ ...idle, ...set }))
        sim.setToggle(`main/${where[name]}`, on);
      now += period;
      sim.runUntil(now);
      return word('BUS');
    };
    const put = (name: string, value: number) => sim.setToggleValue(`main/${name}`, value);
    return { cycle, word, put, sim, circuit, period };
  }

  /** The controls the Input, Register A, Register B and ALU groups share. */
  const DATAPATH_WHERE: Record<string, string> = {
    '/IE': 'Input//IE',
    '/AI': 'Register A//AI',
    '/AO': 'Register A//AO',
    '/BI': 'Register B//BI',
    '/BO': 'Register B//BO',
    SU: 'ALU/SU',
    '/EO': 'ALU//EO',
    '/FI': 'ALU//FI',
    CLR: 'CLR',
  };
  const DATAPATH_IDLE: Record<string, boolean> = {
    '/IE': true,
    '/AI': true,
    '/AO': true,
    '/BI': true,
    '/BO': true,
    SU: false,
    '/EO': true,
    '/FI': true,
  };

  describe.each(TIMINGS)('clock-module, %s', (_, delay) => {
    const MS = 1_000_000_000;
    function clockModule() {
      const example = EXAMPLES.find((e) => e.id === 'clock-module')!;
      const circuit = compile(example.board, libraryOf(example));
      const sim = new Simulator(circuit, delay);
      sim.powerOn();
      sim.start();
      const net = (name: string) => resolveOutputNet(circuit, `main/${name}`);
      const level = (name: string) => bv.toString(sim.netValue(net(name)), 1);
      const changes = (name: string, from: number) =>
        sim.traceRecords().filter((r) => r.net === net(name) && r.time > from);
      const edges = (name: string, from: number) =>
        changes(name, from).map((r) => bv.toString(r.value, 1));
      const at = (ms: number) => sim.runUntil(ms * MS);
      return { sim, level, changes, edges, at };
    }

    it('runs from the real time astable on MODE B, with /CLK its complement', () => {
      const example = EXAMPLES.find((e) => e.id === 'clock-module')!;
      expect(example.board.runSpeed).toBe(1_000_000_000_000);
      const { level, at } = clockModule();
      // Inside the 1101 ms first HIGH, the 693 ms LOW and the next HIGH.
      const seen = [500, 1200, 1900].map((ms) => {
        at(ms);
        return [level('MANUAL'), level('TICK'), level('CLK'), level('/CLK')].join('');
      });
      expect(seen).toEqual(['0110', '0001', '0110']);
    });

    it('HLT holds CLK low while the astable keeps running', () => {
      const { sim, level, at } = clockModule();
      at(500);
      sim.setToggle('main/HLT', true);
      at(510);
      expect([level('TICK'), level('CLK'), level('/CLK')]).toEqual(['1', '0', '1']);
    });

    it('MODE A selects the step button, and one bouncing press gives one 110 ms pulse', () => {
      const { sim, level, changes, edges, at } = clockModule();
      at(500);
      const flipped = sim.time;
      sim.setPrimitiveState('main/MODE', { position: 'a' });
      at(510);
      expect(edges('MANUAL', flipped), 'the bistable debounces the lever').toEqual(['1']);
      expect([level('TICK'), level('CLK')]).toEqual(['1', '0']);

      const pressed = sim.time;
      sim.setPrimitiveState('main/STEP', { on: true });
      at(530);
      expect(level('CLK')).toBe('1');
      sim.setPrimitiveState('main/STEP', { on: false });
      at(700);
      expect(edges('CLK', pressed)).toEqual(['1', '0']);
      const [rise, fall] = changes('CLK', pressed);
      // tw = 1.1 R C = 110 ms; the gates' rise and fall delays differ by nanoseconds.
      expect(Math.abs(fall!.time - rise!.time - 110 * MS)).toBeLessThan(1_000_000);
    });
  });

  describe.each(TIMINGS)('registers-and-alu, %s', (_, delay) => {
    const computer = () =>
      groupedComputer('registers-and-alu', DATAPATH_WHERE, DATAPATH_IDLE, delay);

    it('keeps only the input, the two registers and the ALU', () => {
      const board = EXAMPLES.find((e) => e.id === 'registers-and-alu')!.board;
      expect(board.groups?.map((g) => g.name)).toEqual([
        'Input',
        'Register B',
        'Register A',
        'ALU',
      ]);
      expect(board.components.some((c) => c.defId === '74LS189' || c.defId === '74LS161')).toBe(
        false,
      );
    });

    it('reads 0 on an undriven bus', () => {
      const { cycle } = computer();
      expect(cycle({ CLR: false })).toBe(0);
    });

    it('loads A and B from the switches and puts A + B or A - B on the bus', () => {
      const { cycle, word, put } = computer();
      cycle({ CLR: false });
      put('Input/IN', 0x2a);
      cycle({ '/IE': false, '/AI': false });
      put('Input/IN', 0x07);
      cycle({ '/IE': false, '/BI': false });
      expect([word('Register A/A'), word('Register B/B')]).toEqual([0x2a, 0x07]);
      expect(cycle({ '/EO': false })).toBe(0x31);
      expect(cycle({ '/EO': false, SU: true })).toBe(0x23);
    });

    it('clocks the sum back into A, so each /AI edge adds B again', () => {
      const { cycle, word, put } = computer();
      cycle({ CLR: false });
      put('Input/IN', 0x05);
      cycle({ '/IE': false, '/AI': false });
      cycle({ '/IE': false, '/BI': false });
      const sums = [1, 2, 3].map(() => {
        cycle({ '/EO': false, '/AI': false });
        return word('Register A/A');
      });
      expect(sums).toEqual([0x0a, 0x0f, 0x14]);
      // A copied into B leaves A - B at zero.
      expect(cycle({ '/AO': false, '/BI': false })).toBe(0x14);
      expect(cycle({ '/EO': false, SU: true })).toBe(0);
    });
  });

  describe.each(TIMINGS)('eight-bit-bus-computer, %s', (_, delay) => {
    const id = 'eight-bit-bus-computer';
    const where: Record<string, string> = {
      ...DATAPATH_WHERE,
      CE: 'Program counter/CE',
      '/CO': 'Program counter//CO',
      '/J': 'Program counter//J',
      '/MI': 'Address register//MI',
      RI: 'RAM/RI',
      '/RO': 'RAM//RO',
      PROG: 'RAM/PROG',
    };
    const idle: Record<string, boolean> = {
      ...DATAPATH_IDLE,
      CE: false,
      '/CO': true,
      '/J': true,
      '/MI': true,
      RI: false,
      '/RO': true,
    };
    const computer = () => groupedComputer(id, where, idle, delay);

    it('reads 0 on an undriven bus', () => {
      const { cycle } = computer();
      expect(cycle({ CLR: false })).toBe(0);
    });

    it('loads A from the switches, copies it to B, and adds and subtracts through the bus', () => {
      const { cycle, word, put } = computer();
      cycle({ CLR: false });
      put('Input/IN', 0x35);
      expect(cycle({ '/IE': false, '/AI': false })).toBe(0x35);
      cycle();
      expect(word('Register A/A')).toBe(0x35);
      cycle({ '/AO': false, '/BI': false });
      expect(word('Register B/B')).toBe(0x35);
      // A is 0x35 and B is 0x35: A + B goes onto the bus and back into A.
      expect(cycle({ '/EO': false })).toBe(0x6a);
      cycle({ '/EO': false, '/AI': false });
      expect(word('Register A/A')).toBe(0x6a);
      expect(cycle({ '/EO': false, SU: true })).toBe(0x35);
    });

    it('latches the flags only on an edge with /FI low', () => {
      const { cycle, put, sim, circuit } = computer();
      const flag = (name: string) => sim.netValue(resolveOutputNet(circuit, `main/ALU/${name}`)).v;
      cycle({ CLR: false });
      put('Input/IN', 0x35);
      cycle({ '/IE': false, '/AI': false });
      cycle({ '/AO': false, '/BI': false });
      cycle({ SU: true });
      expect([flag('CF'), flag('ZF')]).toEqual([0, 0]);
      cycle({ SU: true, '/FI': false });
      expect([flag('CF'), flag('ZF')]).toEqual([1, 1]);
    });

    it('reads the program through the PC, MAR and RAM, and jumps', () => {
      const { cycle } = computer();
      cycle({ CLR: false });
      const fetch = () => {
        cycle({ '/CO': false, '/MI': false });
        return cycle({ '/RO': false, CE: true });
      };
      expect([fetch(), fetch(), fetch(), fetch()]).toEqual([0x1e, 0x2f, 0xe0, 0xf0]);
      for (let i = 0; i < 10; i++) cycle({ '/CO': false, CE: true });
      cycle({ '/CO': false, '/MI': false });
      expect(cycle({ '/RO': false, '/J': false })).toBe(0x1c);
      expect(cycle({ '/CO': false })).toBe(0xc);
    });
  });

  describe.each(TIMINGS)('four-bank-interleaved-memory, %s', (_, delay) => {
    const example = EXAMPLES.find((e) => e.id === 'four-bank-interleaved-memory')!;
    const switches = ['A5 A4', 'A3 A2', 'A1 A0'];

    /** The board with the decoder's bus wire and the chips' low address bus
     *  wire moved onto each other's switch: the two-wire change the
     *  description names. */
    function lowOrder(): Board {
      const toggleOf = new Map([
        ['bank', 'alo'],
        ['low', 'ahi'],
      ]);
      return {
        ...example.board,
        wires: example.board.wires.map((w) => {
          const to = toggleOf.get(w.id);
          return to ? { ...w, a: { kind: 'pin', component: to, pin: 'y' } } : w;
        }),
      };
    }

    function memory(board: Board = example.board) {
      const circuit = compile(board, libraryOf(example));
      const sim = new Simulator(circuit, delay);
      sim.powerOn();
      sim.settle();
      const address = (a: number) => {
        switches.forEach((s, i) => sim.setToggleValue(`main/${s}`, (a >> (4 - 2 * i)) & 3));
        sim.settle();
      };
      const write = (a: number, word: number) => {
        address(a);
        sim.setToggleValue('main/DATA', word);
        sim.settle();
        sim.setButtonPressed('main/WRITE', true);
        sim.settle();
        sim.setButtonPressed('main/WRITE', false);
        sim.settle();
      };
      /** The /DATA lights, MSB first; Z while every bank's outputs float. */
      const lights = () =>
        range(8)
          .reverse()
          .map((i) => {
            const v = sim.netValue(resolveOutputNet(circuit, `main//DATA.a${i}`));
            return v.z ? 'Z' : v.x ? 'X' : String(v.v);
          })
          .join('');
      /** The stored word: the '189 drives its complement onto /DATA. */
      const read = (a: number) => {
        address(a);
        return ~Number.parseInt(lights(), 2) & 0xff;
      };
      /** Banks whose /CS line is low. */
      const enabled = () =>
        range(4).filter((b) => sim.netValue(circuit.pathToNet.get(`main//CS${b}`)!).v === 0);
      return { sim, address, write, read, lights, enabled };
    }

    it('reads the complement of the stored word, and floats while WRITE is held', () => {
      const { sim, write, address, lights } = memory();
      write(0x05, 0b1010_0011);
      address(0x05);
      expect(lights()).toBe('01011100');
      sim.setButtonPressed('main/WRITE', true);
      sim.settle();
      expect(lights()).toBe('ZZZZZZZZ');
    });

    it('enables the bank A5 A4 name, so each bank holds 16 consecutive words', () => {
      const { address, enabled } = memory();
      for (let a = 0; a < 64; a++) {
        address(a);
        expect({ a, banks: enabled() }).toEqual({ a, banks: [a >> 4] });
      }
    });

    it('writes the same offset in each bank and reads back four different words', () => {
      const { write, read, address, lights } = memory();
      const words = [0x11, 0x2c, 0xd4, 0x7e];
      words.forEach((w, bank) => write((bank << 4) | 5, w));
      expect(range(4).map((bank) => read((bank << 4) | 5))).toEqual(words);
      // No preload: a cell nobody wrote holds whatever the RAM powered up with.
      address(0x06);
      expect(lights()).toBe('XXXXXXXX');
    });

    it('holds 64 different words, one per address', () => {
      const { write, read } = memory();
      const word = (a: number) => (a * 37 + 11) & 0xff;
      for (let a = 0; a < 64; a++) write(a, word(a));
      expect(range(64).map(read)).toEqual(range(64).map(word));
    });

    it('interleaves on A1 A0 once the two bus wires swap switches', () => {
      const { address, enabled, write, read } = memory(lowOrder());
      // The first five words land in banks 0, 1, 2, 3, 0, as low-order interleaving places them.
      const firstFive = range(5).map((a) => {
        address(a);
        return enabled();
      });
      expect(firstFive).toEqual([[0], [1], [2], [3], [0]]);
      for (let a = 0; a < 64; a++) {
        address(a);
        expect({ a, banks: enabled() }).toEqual({ a, banks: [a & 3] });
      }
      const word = (a: number) => (a * 37 + 11) & 0xff;
      for (let a = 0; a < 64; a++) write(a, word(a));
      expect(range(64).map(read)).toEqual(range(64).map(word));
    });
  });

  describe.each(TIMINGS)('cache-tag-lookup, %s', (_, delay) => {
    function cache() {
      const example = EXAMPLES.find((e) => e.id === 'cache-tag-lookup')!;
      const circuit = compile(example.board, libraryOf(example));
      const sim = new Simulator(circuit, delay);
      sim.powerOn();
      sim.settle();
      const hitNet = resolveOutputNet(circuit, 'main/Hit');
      const access = (tag: number, set: number) => {
        sim.setToggleValue('main/TAG', tag);
        sim.setToggleValue('main/SET', set);
        sim.settle();
        const v = sim.netValue(hitNet);
        expect(v.x | v.z, 'Hit').toBe(0);
        return v.v === 1;
      };
      /** The word in the addressed set: the data '189 drives its complement. */
      const data = () =>
        range(4).reduce((word, i) => {
          const v = sim.netValue(resolveOutputNet(circuit, `main//DATA.a${i}`));
          expect(v.x | v.z, `/DATA ${i}`).toBe(0);
          return word | ((~v.v & 1) << i);
        }, 0);
      /** The miss fill: WRITE stores the tag, a valid bit of 1 and DATA in the set. */
      const fill = (word: number) => {
        sim.setToggleValue('main/DATA', word);
        sim.settle();
        sim.setButtonPressed('main/WRITE', true);
        sim.settle();
        sim.setButtonPressed('main/WRITE', false);
        sim.settle();
      };
      return { access, data, fill };
    }

    it('misses on every tag and set while the valid bits are 0', () => {
      const { access } = cache();
      for (let set = 0; set < 8; set++)
        for (let tag = 0; tag < 8; tag++)
          expect({ tag, set, hit: access(tag, set) }).toEqual({ tag, set, hit: false });
    });

    it('hits after a fill only on the same tag in the same set', () => {
      const { access, data, fill } = cache();
      expect(access(2, 0)).toBe(false);
      fill(0b0101);
      expect(access(2, 0)).toBe(true);
      expect(data()).toBe(0b0101);
      expect(access(3, 0), 'other tag').toBe(false);
      expect(access(2, 1), 'set still invalid').toBe(false);
    });

    // a[0], a[1], a[2] at 0x40, 0x44, 0x48 and x at 0x60, twice: tag A7-A5, set A4-A2.
    it('runs the two-pass loop trace with a fill on every miss', () => {
      const { access, fill } = cache();
      const trace = [0x40, 0x44, 0x48, 0x60, 0x40, 0x44, 0x48, 0x60];
      const hits = trace.map((address) => {
        const hit = access((address >> 5) & 7, (address >> 2) & 7);
        if (!hit) fill((address >> 2) & 0xf);
        return hit;
      });
      expect(hits).toEqual([false, false, false, false, false, true, true, false]);
    });
  });
});

describe('example sections', () => {
  it('files every example under a known group', () => {
    for (const e of EXAMPLES) expect(EXAMPLE_GROUPS).toContain(e.group);
  });

  it('keeps each group contiguous, in EXAMPLE_GROUPS order', () => {
    const runs = EXAMPLES.map((e) => e.group).filter((g, i, all) => g !== all[i - 1]);
    expect(runs).toEqual([...EXAMPLE_GROUPS]);
  });

  it('has at least one example per group', () => {
    for (const g of EXAMPLE_GROUPS) expect(EXAMPLES.some((e) => e.group === g)).toBe(true);
  });

  it('has unique ids', () => {
    expect(new Set(EXAMPLES.map((e) => e.id)).size).toBe(EXAMPLES.length);
  });
});
