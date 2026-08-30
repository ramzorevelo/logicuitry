// Editing model for the typed bit row. Pure: columns in, columns out, so the
// behaviour is testable without a DOM and BitGrid only has to wire events to it.
//
// Columns are MSB-left indices into a fixed-width digit string. Editing
// overwrites, so a collapsed span (anchor === head) is a CELL cursor -- the
// column the next digit lands on -- never an insertion point between two cells;
// it can never sit past the last cell. `head` is still an exclusive edge while a
// selection is being extended, so a selection's end does reach `width`.

export interface BitSel {
  anchor: number;
  head: number;
}

export interface BitEntry {
  bits: string;
  sel: BitSel;
}

export function span(sel: BitSel): { start: number; end: number } {
  return { start: Math.min(sel.anchor, sel.head), end: Math.max(sel.anchor, sel.head) };
}

const clamp = (n: number, width: number) => Math.max(0, Math.min(width, n));
// A cursor addresses a cell, so it stops one short of a selection's exclusive end.
const clampCell = (n: number, width: number) => Math.max(0, Math.min(width - 1, n));
const caret = (at: number): BitSel => ({ anchor: at, head: at });

function overwrite(bits: string, at: number, digits: string): string {
  if (at < 0 || at >= bits.length) return bits;
  const room = Math.min(digits.length, bits.length - at);
  return bits.slice(0, at) + digits.slice(0, room) + bits.slice(at + room);
}

/**
 * Drag selection extends THROUGH the cell under the cursor, so sweeping across
 * four cells selects four rather than three.
 */
export function dragTo(sel: BitSel, col: number): BitSel {
  return { anchor: sel.anchor, head: col >= sel.anchor ? col + 1 : col };
}

export interface KeyStroke {
  key: string;
  shift?: boolean;
  ctrl?: boolean;
}

/**
 * Apply one keystroke. Returns null when the key is not ours, so the caller can
 * let it through. Editing always OVERWRITES: the string length never changes,
 * so a bit outside the edited span keeps both its value and its column.
 */
export function applyKey(entry: BitEntry, stroke: KeyStroke): BitEntry | null {
  const { bits, sel } = entry;
  const width = bits.length;
  const { start, end } = span(sel);

  if (stroke.key === '0' || stroke.key === '1')
    return { bits: overwrite(bits, start, stroke.key), sel: caret(clampCell(start + 1, width)) };

  if (stroke.key === 'Backspace' || stroke.key === 'Delete') {
    if (end > start)
      return { bits: overwrite(bits, start, '0'.repeat(end - start)), sel: caret(start) };
    const at = stroke.key === 'Backspace' ? start - 1 : start;
    if (at < 0 || at >= width) return { bits, sel: caret(clampCell(at, width)) };
    return { bits: overwrite(bits, at, '0'), sel: caret(at) };
  }

  if (stroke.key === 'ArrowLeft' || stroke.key === 'ArrowRight') {
    const step = sel.head + (stroke.key === 'ArrowLeft' ? -1 : 1);
    return {
      bits,
      sel: stroke.shift
        ? { anchor: sel.anchor, head: clamp(step, width) }
        : caret(clampCell(step, width)),
    };
  }

  if (stroke.key === 'Home' || stroke.key === 'End') {
    const end = stroke.key === 'Home' ? 0 : width;
    return {
      bits,
      sel: stroke.shift ? { anchor: sel.anchor, head: end } : caret(clampCell(end, width)),
    };
  }

  if (stroke.ctrl && (stroke.key === 'a' || stroke.key === 'A'))
    return { bits, sel: { anchor: 0, head: width } };

  return null;
}

/** Pasted text overwrites forward from the caret, ignoring non-binary characters. */
export function applyPaste(entry: BitEntry, text: string): BitEntry {
  const digits = text.replace(/[^01]/g, '');
  const { start } = span(entry.sel);
  if (!digits) return entry;
  const room = Math.min(digits.length, entry.bits.length - start);
  return {
    bits: overwrite(entry.bits, start, digits),
    sel: caret(clampCell(start + room, entry.bits.length)),
  };
}

/** The digits a copy should place on the clipboard: the selection, or all of it. */
export function copyText(entry: BitEntry): string {
  const { start, end } = span(entry.sel);
  return end > start ? entry.bits.slice(start, end) : entry.bits;
}

/**
 * Apply a composed text edit (`beforeinput`) rather than a keystroke. Software
 * keyboards report what was inserted or deleted and often send no useful `key`,
 * so this is the phone's route into the same overwrite model. Returns null when
 * the edit is not ours.
 */
export function applyInput(
  entry: BitEntry,
  inputType: string,
  data: string | null,
): BitEntry | null {
  if (inputType === 'deleteContentBackward') return applyKey(entry, { key: 'Backspace' });
  if (inputType === 'deleteContentForward') return applyKey(entry, { key: 'Delete' });
  if (inputType !== 'insertText' && inputType !== 'insertCompositionText') return null;
  const digits = (data ?? '').replace(/[^01]/g, '');
  if (!digits) return null;
  return applyPaste(entry, digits);
}
