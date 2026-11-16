import { describe, expect, it } from 'vitest';
import { EXAMPLES } from './index';
import { builtinChipLibrary } from '../core/parts/packages';
import { idealDelay } from '../core/sim/delay';
import { parseStimulus } from '../core/runner/stimulus';
import { runBoard } from '../core/runner/runBoard';
import type { ChipDef } from '../core/model/types';

// Lessons set these rows and their prose states the outputs, so every expect cell must hold.
const keyed = EXAMPLES.filter((e) => e.board.sequence?.advance.mode === 'key');

describe.each(keyed.map((e) => [e.id, e] as const))('sequence rows of %s', (_, example) => {
  it('read what each row expects, in order', () => {
    const board = example.board;
    const seq = board.sequence!;
    const name = (id: string) => {
      const c = board.components.find((x) => x.id === id)!;
      return c.label ?? c.id;
    };
    const steps = seq.rows.map((row) => ({
      set: Object.fromEntries(seq.inputs.map((id, i) => [name(id), row.set[i]!])),
      expect: Object.fromEntries(
        seq.expect.flatMap((id, i) => {
          const v = row.expect?.[i];
          return v === null || v === undefined ? [] : [[name(id), v]];
        }),
      ),
    }));
    const lib = new Map<string, ChipDef>([
      ...builtinChipLibrary(),
      ...(example.chips ?? []).map((d): [string, ChipDef] => [d.id, d]),
    ]);
    const result = runBoard(board, lib, parseStimulus({ steps }), idealDelay);
    expect(result.failures ?? [], JSON.stringify(result.failures)).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
