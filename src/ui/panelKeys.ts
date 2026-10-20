// Window-level shortcuts (Delete, digits, T) must not fire while the key is
// meant for a control in a side panel: Delete on a K-map cell would otherwise
// delete board parts, and T typed into a select would cycle the theme.

/** The part of an event target this check reads, so it runs without a DOM. */
export interface KeyTarget {
  tagName?: string;
  closest?: (selector: string) => unknown;
}

const DRAWER = '.ref-drawer';
const PANELS = '.ref-drawer, .wave-panel, .circuit-inspector';

/** Keys a focused panel acts on itself. Anything else (Space, `.`, digits,
 *  Ctrl+Z) still drives the board while the panel has focus. */
const PANEL_KEYS = new Set([
  'Delete',
  'Backspace',
  'Enter',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'x',
  'X',
]);

export function isPanelKeyTarget(target: KeyTarget | null, key: string): boolean {
  if (!target?.closest) return false;
  const tag = target.tagName?.toUpperCase();
  if (tag === 'SELECT') return true;
  if (!PANEL_KEYS.has(key)) return false;
  if (target.closest(DRAWER)) return true;
  return tag === 'BUTTON' && !!target.closest(PANELS);
}

/** True when a window keydown handler should leave the event alone. */
export function keyBelongsElsewhere(e: {
  defaultPrevented: boolean;
  target: EventTarget | null;
  key: string;
}): boolean {
  return e.defaultPrevented || isPanelKeyTarget(e.target as KeyTarget | null, e.key);
}

/** A select's typeahead owns letter keys, so `t` picks an option there. */
export function isSelectTarget(target: EventTarget | null): boolean {
  return (target as KeyTarget | null)?.tagName?.toUpperCase() === 'SELECT';
}
