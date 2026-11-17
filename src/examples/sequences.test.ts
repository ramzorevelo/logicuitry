import { describe, expect, it } from 'vitest';
import { EXAMPLES } from './index';
import { builtinChipLibrary } from '../core/parts/packages';
import { idealDelay } from '../core/sim/delay';
import { compile } from '../core/model/compile';
import { parseStimulus } from '../core/runner/stimulus';
import { runBoard } from '../core/runner/runBoard';
import type { ChipDef } from '../core/model/types';

// Lessons set these rows and their prose states the outputs, so every expect cell must hold.
const keyed = EXAMPLES.filter((e) => e.board.sequence?.advance.mode === 'key');

describe.each(keyed.map((e) => [e.id, e] as const))('sequence rows of %s', (_, example) => {
  it('read what each row expects, in order', () => {
    const board = example.board;
    const seq = board.sequence!;
    const lib = new Map<string, ChipDef>([
      ...builtinChipLibrary(),
      ...(example.chips ?? []).map((d): [string, ChipDef] => [d.id, d]),
    ]);
    // The runner names a grouped part by its group path, as compile does.
    const compiled = compile(board, lib);
    const name = (id: string) => {
      const p = compiled.primitives[compiled.componentToPrimitive.get(`main/${id}`)!]!;
      return p.path.slice(p.path.indexOf('/') + 1);
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
    const result = runBoard(board, lib, parseStimulus({ steps }), idealDelay);
    expect(result.failures ?? [], JSON.stringify(result.failures)).toEqual([]);
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
  });
});
