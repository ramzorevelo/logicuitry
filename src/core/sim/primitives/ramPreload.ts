// RAM preload text: cells in address order, one hex value or `X` per cell,
// separated by spaces. Trailing X cells are left out, so '' is all X.

import * as bv from '../../value/busValue';

export class PreloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreloadError';
  }
}

/** Hex digits one cell prints with. */
export function preloadDigits(width: number): number {
  return Math.ceil(width / 4);
}

const HEX_CELL = /^[0-9a-fA-F]+$/;

/**
 * Cells for `count` addresses. Digits above `width` are masked off, so a
 * width edit never makes a saved preload unreadable.
 */
export function parsePreload(text: string, width: number, count: number): bv.BusValue[] {
  const tokens = text.trim() === '' ? [] : text.trim().split(/\s+/);
  if (tokens.length > count)
    throw new PreloadError(`${tokens.length} cells for ${count} addresses`);
  const digits = preloadDigits(width);
  const cells = tokens.map((token, address) => {
    if (token === 'X' || token === 'x') return bv.allX(width);
    if (!HEX_CELL.test(token))
      throw new PreloadError(`address ${address}: '${token}' is not a hex value or X`);
    if (token.length > digits)
      throw new PreloadError(`address ${address}: '${token}' has more than ${digits} hex digits`);
    return bv.known(Number.parseInt(token, 16), width);
  });
  while (cells.length < count) cells.push(bv.allX(width));
  return cells;
}

/** The parse error as text, or null for a preload that loads. */
export function preloadError(text: string, width: number, count: number): string | null {
  try {
    parsePreload(text, width, count);
    return null;
  } catch (e) {
    if (e instanceof PreloadError) return e.message;
    throw e;
  }
}

/** A cell with any unknown bit prints as X: the format has no per-bit unknowns. */
export function printPreload(cells: readonly bv.BusValue[], width: number): string {
  const digits = preloadDigits(width);
  const tokens = cells.map((cell) =>
    bv.isFullyKnown(cell, width)
      ? (cell.v >>> 0).toString(16).toUpperCase().padStart(digits, '0')
      : 'X',
  );
  while (tokens.length > 0 && tokens[tokens.length - 1] === 'X') tokens.pop();
  return tokens.join(' ');
}

/**
 * The preload rewritten for a new size: cells past the new count are dropped,
 * new ones are X, values are masked to the new width. A preload that does not
 * parse comes back unchanged, so the load check still names it.
 */
export function resizePreload(
  text: string,
  from: { width: number; count: number },
  to: { width: number; count: number },
): string {
  let cells: bv.BusValue[];
  try {
    cells = parsePreload(text, from.width, from.count);
  } catch (e) {
    if (e instanceof PreloadError) return text;
    throw e;
  }
  const kept = cells.slice(0, to.count).map((cell) => bv.norm(cell, to.width));
  return printPreload(kept, to.width);
}
