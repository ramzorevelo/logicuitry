import type { ComponentKind } from '../../core/model/types';
import { maskToWidth } from '../../core/model/sequence';
import { ALGEBRA_BOARD_IDS } from '../../examples';

/** Algebra boards compare two circuits by their LEDs; a stimulus table is noise there. */
export function sequenceTabApplies(tabKind: string | undefined, boardId: string): boolean {
  return tabKind === 'board' && !ALGEBRA_BOARD_IDS.has(boardId);
}

/** Wider than this reads as hex: eight binary digits is what a row can show legibly. */
const BINARY_MAX_WIDTH = 8;

export function formatCell(kind: ComponentKind | undefined, value: number, width: number): string {
  if (kind === 'spdt') return (value & 1) === 1 ? 'b' : 'a';
  if (width <= BINARY_MAX_WIDTH) return maskToWidth(value, width).toString(2).padStart(width, '0');
  const digits = Math.ceil(width / 4);
  return maskToWidth(value, width).toString(16).toUpperCase().padStart(digits, '0');
}

export function formatExpect(value: number | null, width: number): string {
  return value === null ? '-' : formatCell('led', value, width);
}

/**
 * Reads a cell back in the base it is shown in; `0x` and `0b` override it.
 * Null when the text is not a value that fits the column.
 */
export function parseCell(
  kind: ComponentKind | undefined,
  text: string,
  width: number,
): number | null {
  const t = text.trim().toLowerCase();
  if (kind === 'spdt') return t === 'a' || t === '0' ? 0 : t === 'b' || t === '1' ? 1 : null;
  let digits = t;
  let base = width <= BINARY_MAX_WIDTH ? 2 : 16;
  if (t.startsWith('0x')) [digits, base] = [t.slice(2), 16];
  else if (t.startsWith('0b')) [digits, base] = [t.slice(2), 2];
  const pattern = base === 2 ? /^[01]+$/ : /^[0-9a-f]+$/;
  if (!pattern.test(digits)) return null;
  const value = parseInt(digits, base);
  if (!Number.isSafeInteger(value) || value > maskToWidth(0xffffffff, width)) return null;
  return value >>> 0;
}

/** As parseCell, with `-`, `x` or an empty cell for don't care. */
export function parseExpect(text: string, width: number): number | null | undefined {
  const t = text.trim().toLowerCase();
  if (t === '' || t === '-' || t === 'x') return null;
  return parseCell('led', t, width) ?? undefined;
}
