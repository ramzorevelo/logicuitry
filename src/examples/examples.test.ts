import { describe, expect, it } from 'vitest';
import { EXAMPLES } from './index';
import { validateDocument } from '../io/validate';
import { compile } from '../core/model/compile';
import { buildTruthTable } from '../core/boolean/truthTable';
import type { ChipLibrary } from '../core/model/types';

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
        const lib: ChipLibrary = new Map((e.chips ?? []).map((c) => [c.id, c]));
        expect(() => compile(e.board, lib)).not.toThrow();
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
});
