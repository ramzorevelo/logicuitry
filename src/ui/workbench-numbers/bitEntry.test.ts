import { describe, expect, it } from 'vitest';
import {
  applyInput,
  applyKey,
  applyPaste,
  copyText,
  dragTo,
  span,
  type BitEntry,
} from './bitEntry';

const at = (bits: string, anchor: number, head = anchor): BitEntry => ({
  bits,
  sel: { anchor, head },
});

describe('bit entry: selection', () => {
  it('drags through the cell under the cursor, both directions', () => {
    expect(span(dragTo({ anchor: 0, head: 0 }, 3))).toEqual({ start: 0, end: 4 });
    expect(span(dragTo({ anchor: 6, head: 6 }, 2))).toEqual({ start: 2, end: 6 });
  });
});

describe('bit entry: typing overwrites in place', () => {
  it('replaces a selected span and leaves the bits outside it untouched', () => {
    // The reported case: select bits 7..4 of 01010101 and type 1110.
    let e = at('01010101', 0, 4);
    for (const key of ['1', '1', '1', '0']) e = applyKey(e, { key })!;
    expect(e.bits).toBe('11100101');
  });

  it('never changes the width, so no bit ever shifts column', () => {
    let e = at('01010101', 0, 8);
    for (const key of ['1', '0', '1']) e = applyKey(e, { key })!;
    expect(e.bits).toHaveLength(8);
    expect(e.bits).toBe('10110101');
  });

  it('advances the caret per digit and stops on the last cell', () => {
    let e = at('0000', 2);
    e = applyKey(e, { key: '1' })!;
    expect(e.bits).toBe('0010');
    expect(e.sel).toEqual({ anchor: 3, head: 3 });
    // The cursor addresses a cell, so it never parks past the row: the last
    // cell stays current and a further digit overwrites it.
    e = applyKey(e, { key: '1' })!;
    expect(e.bits).toBe('0011');
    expect(e.sel).toEqual({ anchor: 3, head: 3 });
  });
});

describe('bit entry: deletion clears rather than removes', () => {
  it('clears a selected span to zeros', () => {
    expect(applyKey(at('11111111', 2, 5), { key: 'Delete' })!.bits).toBe('11000111');
  });

  it('Backspace clears the cell before the caret, Delete the one after', () => {
    expect(applyKey(at('1111', 2), { key: 'Backspace' })!.bits).toBe('1011');
    expect(applyKey(at('1111', 2), { key: 'Delete' })!.bits).toBe('1101');
  });

  it('Backspace at the start is a no-op', () => {
    expect(applyKey(at('1111', 0), { key: 'Backspace' })!.bits).toBe('1111');
  });
});

describe('bit entry: caret movement', () => {
  it('shift+arrow extends from the anchor, plain arrow collapses', () => {
    expect(applyKey(at('00000000', 2), { key: 'ArrowRight', shift: true })!.sel).toEqual({
      anchor: 2,
      head: 3,
    });
    expect(applyKey(at('00000000', 2, 5), { key: 'ArrowLeft' })!.sel).toEqual({
      anchor: 4,
      head: 4,
    });
  });

  it('clamps at both ends and selects all with ctrl+A', () => {
    expect(applyKey(at('1111', 0), { key: 'ArrowLeft' })!.sel).toEqual({ anchor: 0, head: 0 });
    expect(applyKey(at('1111', 3), { key: 'ArrowRight' })!.sel).toEqual({ anchor: 3, head: 3 });
    // Shift still extends to the exclusive edge, so the last cell is selectable.
    expect(applyKey(at('1111', 3), { key: 'ArrowRight', shift: true })!.sel).toEqual({
      anchor: 3,
      head: 4,
    });
    expect(applyKey(at('1111', 1), { key: 'a', ctrl: true })!.sel).toEqual({ anchor: 0, head: 4 });
  });

  it('passes an unhandled key back to the caller', () => {
    expect(applyKey(at('1111', 0), { key: '7' })).toBeNull();
  });
});

describe('bit entry: clipboard', () => {
  it('pastes over the caret, ignoring separators, and stops at the width', () => {
    expect(applyPaste(at('00000000', 2), '1111').bits).toBe('00111100');
    expect(applyPaste(at('00000000', 0), '1010 1010').bits).toBe('10101010');
    expect(applyPaste(at('00000000', 6), '1111').bits).toBe('00000011');
  });

  it('copies the selection, or the whole value when collapsed', () => {
    expect(copyText(at('10110000', 0, 4))).toBe('1011');
    expect(copyText(at('10110000', 3))).toBe('10110000');
  });
});

describe('bit entry: composed input (software keyboards)', () => {
  it('overwrites forward from the caret on inserted digits', () => {
    expect(applyInput(at('00000000', 2), 'insertText', '11')).toEqual({
      bits: '00110000',
      sel: { anchor: 4, head: 4 },
    });
  });

  it('ignores an inserted character that is not a bit', () => {
    expect(applyInput(at('00000000', 0), 'insertText', 'x')).toBeNull();
  });

  it('maps the two delete input types onto Backspace and Delete', () => {
    expect(applyInput(at('11111111', 3), 'deleteContentBackward', null)).toEqual(
      applyKey(at('11111111', 3), { key: 'Backspace' }),
    );
    expect(applyInput(at('11111111', 3), 'deleteContentForward', null)).toEqual(
      applyKey(at('11111111', 3), { key: 'Delete' }),
    );
  });

  it('leaves an edit it does not own to the caller', () => {
    expect(applyInput(at('00000000', 0), 'historyUndo', null)).toBeNull();
  });
});
