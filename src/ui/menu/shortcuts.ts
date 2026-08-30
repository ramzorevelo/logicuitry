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
  deleteHeal: 'Ctrl+X',
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
  smartConnectPicker: 'Shift+F',
  bubbleMode: 'B',
  power: 'Space',
  step: '.',
  fullscreen: 'P',
  theme: 'T',
  themeBack: 'Shift+T',
  menuBar: 'F10',
} as const;

export type ShortcutId = keyof typeof SHORTCUTS;
