import type { Menu, MenuEntry } from '../menu/menuModel';
import { useLessonEditorStore } from './lessonEditorStore';

const LOCKED = 'Close the lesson editor to change the board';

/** View items that only look; everything else the workbench contributes edits or drives the board. */
const VIEW_KEEPS = new Set(['fit', 'wireColours', 'subExpressions', 'analyze', 'waveform']);

function lock(entry: MenuEntry): MenuEntry {
  if ('separator' in entry) return entry;
  return { ...entry, disabled: true, ...('run' in entry ? { title: LOCKED } : {}) };
}

/**
 * The workbench's menus while the lesson editor is open: Undo and Redo act on
 * the lesson, the look-only View items stay, the rest grey out.
 */
export function lockMenusForLessonEditor(menus: readonly Menu[]): Menu[] {
  const ed = () => useLessonEditorStore.getState();
  return menus.map((menu) => ({
    ...menu,
    items: menu.items.map((entry): MenuEntry => {
      if ('separator' in entry) return entry;
      if (menu.id === 'edit' && entry.id === 'undo' && 'run' in entry)
        return { ...entry, label: 'Undo lesson edit', run: () => ed().undo() };
      if (menu.id === 'edit' && entry.id === 'redo' && 'run' in entry)
        return { ...entry, label: 'Redo lesson edit', run: () => ed().redo() };
      if (menu.id === 'view' && VIEW_KEEPS.has(entry.id)) return entry;
      return lock(entry);
    }),
  }));
}
