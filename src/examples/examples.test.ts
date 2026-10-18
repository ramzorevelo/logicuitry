import { describe, expect, it } from 'vitest';
import { EXAMPLES, type Example } from './index';
import { validateDocument } from '../io/validate';
import { compile } from '../core/model/compile';
import { buildTruthTable, resolveOutputNet } from '../core/boolean/truthTable';
import { builtinChipLibrary } from '../core/parts/packages';
import { Simulator } from '../core/sim/kernel';
import { datasheetDelay, idealDelay, type DelayModel } from '../core/sim/delay';
import type { Board, ChipDef, ChipLibrary } from '../core/model/types';

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

  const TIMINGS: [string, DelayModel][] = [
    ['ideal', idealDelay],
    ['datasheet typ', datasheetDelay('typ')],
    ['datasheet max', datasheetDelay('max')],
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
  });
});
