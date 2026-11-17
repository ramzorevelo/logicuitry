import { beforeEach, describe, expect, it } from 'vitest';
import { useCircuitStore } from './circuitStore';
import { board, comp, wire } from '../../core/model/testFixtures';
import type { BoardSequence } from '../../core/model/types';
import { EXAMPLES } from '../../examples';

const st = () => useCircuitStore.getState();

const keySequence: BoardSequence = {
  inputs: ['a', 'b'],
  expect: ['y'],
  rows: [
    { set: [5, 0], expect: [5] },
    { set: [3, 1], expect: [2] },
    { set: [0xf, 0], expect: [null] },
  ],
  advance: { mode: 'key' },
  hideExpected: true,
};

function loadKeyBoard(sequence: BoardSequence = keySequence) {
  st().loadBoard(
    board({
      components: [
        comp('a', 'toggle', { width: 4 }, 'A'),
        comp('b', 'button', undefined, 'B'),
        comp('y', 'led', { width: 4 }, 'Y'),
      ],
      wires: [wire('w1', ['a', 'y'], ['y', 'a'])],
      sequence,
    }),
  );
}

// D toggles each row; the DFF must see each new D before the next rising edge.
function loadClockBoard() {
  st().loadBoard(
    board({
      components: [
        comp('ck', 'clock', { periodPs: 1000, dutyPercent: 50 }, 'CLK'),
        comp('d', 'toggle', undefined, 'D'),
        comp('ff', 'dff'),
        comp('q', 'led', undefined, 'Q'),
      ],
      wires: [
        wire('w1', ['ck', 'y'], ['ff', 'clk']),
        wire('w2', ['d', 'y'], ['ff', 'd']),
        wire('w3', ['ff', 'q'], ['q', 'a']),
      ],
      sequence: {
        inputs: ['d'],
        expect: [],
        rows: [{ set: [1] }, { set: [0] }, { set: [1] }],
        advance: { mode: 'clock', clock: 'ck' },
        hideExpected: false,
      },
    }),
  );
}

beforeEach(() => {
  useCircuitStore.setState({ selection: new Set(), powered: false, running: false });
});

describe('sequence rows by key', () => {
  it('refuses to apply while unpowered', () => {
    loadKeyBoard();
    expect(st().applySequenceRow(0)).toBe(false);
    expect(st().sequenceRun()).toBeNull();
  });

  it('sets every input of a row at once and marks pass or fail after settling', () => {
    loadKeyBoard();
    st().power();
    expect(st().sequenceRun()).toEqual({ cursor: -1, results: [], pending: null });
    expect(st().stepSequence(1)).toBe(true);
    expect(st().buttonHeld('b')).toBe(false);
    expect(st().canSettle()).toBe(true);
    st().settle();
    expect(st().pinRawValue('y', 'a')?.v).toBe(5);
    expect(st().stepSequence(1)).toBe(true);
    expect(st().buttonHeld('b')).toBe(true);
    st().settle();
    expect(st().sequenceRun()).toMatchObject({ cursor: 1, results: [true, false] });
    expect(st().stepSequence(1)).toBe(true);
    st().settle();
    expect(st().sequenceRun()!.results[2]).toBeNull();
  });

  it('checks an active-low LED against what it shows, not its net', () => {
    st().loadBoard(
      board({
        components: [
          comp('a', 'toggle', { width: 4 }, 'A'),
          comp('y', 'led', { width: 4, activeLow: true }, 'Y'),
        ],
        wires: [wire('w1', ['a', 'y'], ['y', 'a'])],
        sequence: {
          inputs: ['a'],
          expect: ['y'],
          rows: [
            { set: [5], expect: [10] },
            { set: [5], expect: [5] },
          ],
          advance: { mode: 'key' },
          hideExpected: true,
        },
      }),
    );
    st().power();
    st().stepSequence(1);
    st().stepSequence(1);
    st().settle();
    expect(st().sequenceRun()!.results).toEqual([true, false]);
  });

  it('stops at either end without wrapping', () => {
    loadKeyBoard();
    st().power();
    expect(st().stepSequence(-1)).toBe(false);
    st().applySequenceRow(2);
    expect(st().stepSequence(1)).toBe(false);
    expect(st().sequenceRun()!.cursor).toBe(2);
    expect(st().stepSequence(-1)).toBe(true);
    st().settle();
    expect(st().pinRawValue('y', 'a')?.v).toBe(3);
  });

  it('starts over after a power cycle', () => {
    loadKeyBoard();
    st().power();
    st().applySequenceRow(1);
    st().power();
    st().power();
    expect(st().sequenceRun()!.cursor).toBe(-1);
  });

  it('masks a value to the switch width it has now', () => {
    loadKeyBoard({ ...keySequence, rows: [{ set: [0x1f, 0], expect: [0xf] }] });
    st().power();
    st().applySequenceRow(0);
    st().settle();
    expect(st().pinRawValue('y', 'a')?.v).toBe(0xf);
    expect(st().sequenceRun()!.results[0]).toBe(true);
  });

  it('is not an undo step and leaves the board as loaded', () => {
    loadKeyBoard();
    const before = st().board;
    st().power();
    st().applySequenceRow(0);
    expect(st().board).toBe(before);
  });
});

describe('sequence rows on clock falls', () => {
  it('applies one row per falling edge while running, holding the last', () => {
    loadClockBoard();
    st().power();
    st().toggleRun();
    st().pump(400);
    expect(st().sequenceRun()!.cursor).toBe(-1);
    st().pump(200); // fall at 500
    expect(st().sequenceRun()!.cursor).toBe(0);
    expect(st().pinSignal('d', 'y')).toBe('1');
    st().pump(1000); // rise at 1000 samples D = 1, fall at 1500 applies row 1
    expect(st().pinSignal('q', 'a')).toBe('1');
    expect(st().sequenceRun()!.cursor).toBe(1);
    st().pump(10_000);
    expect(st().sequenceRun()!.cursor).toBe(2);
    st().toggleRun();
  });

  it('handles several falls inside one frame, each at its own time', () => {
    loadClockBoard();
    st().power();
    st().toggleRun();
    st().pump(2600); // falls at 500, 1500, 2500
    expect(st().sequenceRun()!.cursor).toBe(2);
    expect(st().pinSignal('q', 'a')).toBe('0');
    st().toggleRun();
  });

  it('applies the first row when a single step lands on the first fall', () => {
    loadClockBoard();
    st().power();
    // Nothing reads the run first, as with the Sequence tab closed.
    while ((st().simTimePs() ?? 0) < 500) st().gateStep();
    // The press folds the clock's wake at the fall into the edge it lands one unit delay later.
    expect(st().simTimePs()).toBe(501);
    expect(st().sequenceRun()!.cursor).toBe(0);
    // The row lands after the press: the switch's wake and its output change come in the next.
    expect(st().pinSignal('d', 'y')).toBe('0');
    for (let i = 0; i < 3 && st().pinSignal('d', 'y') !== '1'; i++) st().gateStep();
    expect(st().pinSignal('d', 'y')).toBe('1');
    expect(st().simTimePs()).toBeLessThan(1000);
  });

  it('applies at most the falls inside one step after clock mode is turned on late', () => {
    loadClockBoard();
    st().editSequence('key', (s) => ({ ...s, advance: { mode: 'key' } }));
    st().power();
    expect(st().sequenceRun()!.cursor).toBe(-1);
    st().toggleRun();
    st().pump(10_000);
    st().toggleRun();
    st().editSequence('clock', (s) => ({ ...s, advance: { mode: 'clock', clock: 'ck' } }));
    st().gateStep();
    expect(st().sequenceRun()!.cursor).toBeLessThanOrEqual(0);
  });

  it('closes the last row on the fall after it and keeps holding it', () => {
    loadClockBoard();
    st().editSequence('expect q', (s) => ({
      ...s,
      expect: ['q'],
      rows: s.rows.map((r) => ({ ...r, expect: [null] })),
    }));
    st().editSequence('expect last', (s) => ({
      ...s,
      rows: s.rows.map((r, i) => (i === 2 ? { ...r, expect: [1] } : r)),
    }));
    st().power();
    st().toggleRun();
    st().pump(2600);
    expect(st().sequenceRun()!.pending).toBe(2);
    st().pump(1000); // rise at 3000 latches D = 1, fall at 3500 compares row 3
    expect(st().sequenceRun()).toMatchObject({ cursor: 2, pending: null });
    expect(st().sequenceRun()!.results[2]).toBe(true);
    st().toggleRun();
  });
});

describe('sequence rows by key while running', () => {
  it('compares the last row when Run stops', () => {
    loadKeyBoard();
    st().power();
    st().toggleRun();
    st().applySequenceRow(0);
    expect(st().sequenceRun()!.pending).toBe(0);
    st().pump(20_000);
    st().toggleRun();
    expect(st().sequenceRun()).toMatchObject({ pending: null, results: [true] });
  });

  it('keeps the cursor across Run off and on', () => {
    loadKeyBoard();
    st().power();
    st().applySequenceRow(1);
    st().toggleRun();
    st().toggleRun();
    expect(st().sequenceRun()!.cursor).toBe(1);
  });

  it('falls back to keys when the clock is deleted', () => {
    loadClockBoard();
    useCircuitStore.setState({ selection: new Set(['ck']) });
    st().deleteSelection();
    expect(st().board.sequence!.advance).toEqual({ mode: 'key' });
  });
});

describe('example sequences', () => {
  // Expected cells were computed apart from the board, so a pass is a real check of its wiring.
  it('the four-operation ALU passes every row of its sequence', () => {
    const alu = EXAMPLES.find((e) => e.id === 'four-operation-alu')!;
    st().loadBoard(structuredClone(alu.board));
    st().power();
    const rows = st().board.sequence!.rows.length;
    for (let i = 0; i < rows; i++) expect(st().stepSequence(1)).toBe(true);
    st().settle();
    expect(st().sequenceRun()!.results).toEqual(new Array<boolean>(rows).fill(true));
  });
});

describe('sequence editing', () => {
  it('drops a deleted input column in the same undo step, and undo brings it back', () => {
    loadKeyBoard();
    useCircuitStore.setState({ selection: new Set(['b']) });
    st().deleteSelection();
    expect(st().board.sequence!.inputs).toEqual(['a']);
    expect(st().board.sequence!.rows[1]!.set).toEqual([3]);
    st().undo();
    expect(st().board.sequence!.inputs).toEqual(['a', 'b']);
    expect(st().board.sequence!.rows[1]!.set).toEqual([3, 1]);
  });

  it('edits as one undo step without dropping power', () => {
    loadKeyBoard();
    st().power();
    st().editSequence('note', (seq) => ({ ...seq, hideExpected: false }));
    expect(st().powered).toBe(true);
    expect(st().board.sequence!.hideExpected).toBe(false);
    st().undo();
    expect(st().board.sequence!.hideExpected).toBe(true);
  });

  it('captures the live inputs while powered and the saved ones while off', () => {
    loadKeyBoard();
    st().captureSequenceRow();
    expect(st().board.sequence!.rows.at(-1)).toEqual({ set: [0, 0], expect: [null] });
    st().power();
    st().toggleInput('a', 1);
    st().captureSequenceRow();
    expect(st().board.sequence!.rows.at(-1)!.set).toEqual([2, 0]);
  });

  it('prunes columns for parts missing from a loaded board', () => {
    loadKeyBoard({ ...keySequence, inputs: ['a', 'gone'], rows: [{ set: [1, 1] }] });
    expect(st().board.sequence!.inputs).toEqual(['a']);
    expect(st().board.sequence!.rows[0]!.set).toEqual([1]);
  });
});
