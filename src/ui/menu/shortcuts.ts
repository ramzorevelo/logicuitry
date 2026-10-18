// Display text for every command that has a key. One table, read by both the
// menu items and the toolbar tooltips, so a label and its handler cannot
// drift apart.
//
// Ctrl+N, Ctrl+T, Ctrl+W and Ctrl+P are deliberately absent: the browser keeps
// those even in an installed standalone window, so a menu showing one would be
// a lie.

export const SHORTCUTS = {
  open: 'Ctrl+O',
  save: 'Ctrl+S',
  saveAs: 'Ctrl+Shift+S',
  undo: 'Ctrl+Z',
  redo: 'Ctrl+Shift+Z',
  copy: 'Ctrl+C',
  paste: 'Ctrl+V',
  duplicate: 'Shift+D',
  delete: 'Del',
  // Cut always heals what it takes out; the menu's Delete and reconnect is the
  // same heal without the clipboard, so it carries no key of its own.
  cutClipboard: 'Ctrl+X',
  group: 'Ctrl+G',
  ungroup: 'Ctrl+Shift+G',
  rotate: 'R',
  rotateGroup: 'Shift+R',
  mirror: 'M',
  lasso: 'L',
  wire: 'W',
  junction: 'J',
  cut: 'C',
  convertBubble: 'N',
  fit: 'Home',
  smartConnect: 'F',
  bubbleMode: 'B',
  power: 'Space',
  step: '.',
  fullscreen: 'P',
  theme: 'T',
  themeBack: 'Shift+T',
  menuBar: 'F10',
} as const;

export type ShortcutId = keyof typeof SHORTCUTS;

type HistoryKeyEvent = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey'>;

/** Which history step a key asks for. Ctrl+Y is the Windows redo, kept beside Ctrl+Shift+Z. */
export function historyKey(e: HistoryKeyEvent): 'undo' | 'redo' | null {
  if (!(e.ctrlKey || e.metaKey)) return null;
  const key = e.key.toLowerCase();
  if (key === 'z') return e.shiftKey ? 'redo' : 'undo';
  if (key === 'y' && !e.shiftKey) return 'redo';
  return null;
}
