import { describe, expect, it } from 'vitest';
import { builtinChipLibrary } from '../core/parts/packages';
import { checkRows, staticFindings } from '../core/checks/checks';
import { EXAMPLES } from '.';

/** Warning and info rows per example. A change here is a check changing what it
 *  says about shipped content: read the new rows before accepting it. */
const EXPECTED: Record<string, [number, number]> = {
  'basic-gates': [0, 0],
  'de-morgan-pair': [0, 0],
  'three-variable-sum-of-products': [0, 0],
  'static-hazard': [0, 0],
  'half-adder': [0, 0],
  'full-adder': [0, 0],
  'full-adder-on-a-74ls153': [0, 0],
  'ripple-carry-adder': [0, 0],
  'four-bit-adder-on-a-74ls283': [0, 0],
  'eight-bit-adder': [0, 0],
  'adder-subtracter': [0, 0],
  'four-operation-alu': [0, 0],
  'full-adder-propagation-delay': [0, 0],
  absorption: [0, 0],
  elimination: [0, 0],
  consensus: [0, 0],
  'distributive-law': [0, 0],
  'complement-and-covering': [0, 0],
  'two-to-one-multiplexer': [0, 0],
  'four-to-one-multiplexer': [0, 0],
  'four-to-one-multiplexer-tree': [0, 0],
  'multiplexer-as-lookup-table': [0, 0],
  'function-on-an-eight-to-one-multiplexer': [0, 0],
  'folded-variable-on-a-four-to-one-multiplexer': [0, 0],
  'four-variable-function-on-a-74ls151': [0, 0],
  'majority-on-an-eight-to-one-multiplexer': [0, 0],
  'majority-on-a-four-to-one-multiplexer': [0, 0],
  'two-to-four-decoder': [0, 0],
  'three-to-eight-decoder': [0, 0],
  'three-to-eight-decoder-from-a-74ls139': [0, 0],
  'decoder-logic-on-a-74ls138': [0, 1],
  'majority-from-a-decoder': [0, 1],
  'demultiplexer-on-a-74ls138': [0, 0],
  'priority-encoder': [0, 0],
  'seven-segment-segment-a-unused-codes-0': [0, 0],
  'seven-segment-segment-a-unused-codes-dont-care': [0, 0],
  'seven-segment-display-on-a-74ls47': [0, 0],
  'seven-segment-display-on-a-74ls48': [0, 0],
  'sr-latch': [0, 0],
  'switch-debouncer-on-a-74ls00': [0, 1],
  'd-latch': [0, 0],
  'd-flip-flop': [0, 0],
  'latch-versus-flip-flop': [0, 2],
  'preset-and-clear-on-a-74ls74': [0, 1],
  'divide-by-two': [0, 0],
  'enabled-register-on-a-74ls157-and-two-74ls74s': [0, 2],
  'shift-register': [0, 1],
  'ring-oscillator-on-a-74ls00-and-a-74ls04': [0, 2],
  'register-to-register-path': [0, 2],
  'three-bit-counter-on-two-74ls74s': [0, 4],
  'mod-10-counter': [0, 1],
  'divide-by-three-counter': [0, 2],
  'moore-and-mealy-01-recognizers': [0, 4],
  'logic-project-module': [0, 3],
  'clock-module': [0, 4],
  'bus-and-registers': [0, 0],
  'alu-and-flags': [0, 2],
  'registers-and-alu': [0, 2],
  'program-counter-mar-and-ram': [0, 5],
  'eight-bit-bus-computer': [0, 7],
  'four-bank-interleaved-memory': [0, 1],
  'cache-tag-lookup': [0, 2],
  // Starters: the student wires them, so every input is unused and every output unwired.
  'majority-vote-nand-only': [1, 3],
  'minterms-on-a-74ls138': [1, 3],
  'three-bit-counter-from-74ls-parts': [3, 2],
};

describe('checks over the bundled examples', () => {
  it.each(EXAMPLES.map((e) => [e.id, e] as const))('%s', (id, e) => {
    const lib = new Map([
      ...builtinChipLibrary(),
      ...(e.chips ?? []).map((c) => [c.id, c] as const),
    ]);
    const hidden = new Set(e.board.hiddenChecks);
    const rows = checkRows(staticFindings(e.board, lib), hidden, e.board, lib).shown;
    const n = (severity: string) => rows.filter((r) => r.severity === severity).length;
    expect(rows.some((r) => r.severity === 'error')).toBe(false);
    expect([n('warning'), n('info')]).toEqual(EXPECTED[id]);
  });
});
