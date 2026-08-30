// The menu bar's data model. Menus are contributed by whichever workbench is
// active plus the shell's own, merged into one bar in a fixed order so File
// never jumps position when the workbench changes.

export interface MenuCommand {
  id: string;
  label: string;
  /** Display text only; the key itself is bound by whoever owns the handler. */
  shortcut?: string;
  checked?: boolean;
  disabled?: boolean;
  run: () => void;
}

export interface MenuSeparator {
  separator: true;
}

/** A nested flyout. One level only: anything that wants two is a dialog. */
export interface MenuSubmenu {
  id: string;
  label: string;
  disabled?: boolean;
  items: MenuCommand[];
}

export type MenuEntry = MenuCommand | MenuSeparator | MenuSubmenu;

export interface Menu {
  id: MenuId;
  items: MenuEntry[];
}

/** Bar order, fixed: a menu's place must not depend on which workbench filled
 *  it in. Anything contributed under an unknown id is dropped rather than
 *  silently appended somewhere arbitrary. */
export const MENU_ORDER = ['file', 'edit', 'view', 'simulate', 'settings', 'help'] as const;
export type MenuId = (typeof MENU_ORDER)[number];

export const MENU_LABELS: Record<MenuId, string> = {
  file: 'File',
  edit: 'Edit',
  view: 'View',
  simulate: 'Simulate',
  settings: 'Settings',
  help: 'Help',
};

export function isSeparator(entry: MenuEntry): entry is MenuSeparator {
  return 'separator' in entry;
}

export function isSubmenu(entry: MenuEntry): entry is MenuSubmenu {
  return 'items' in entry;
}

/** A submenu with nothing left to open is as dead as an empty bar item. */
function isDead(entry: MenuEntry): boolean {
  return isSeparator(entry) || (isSubmenu(entry) && entry.items.length === 0);
}

/** Menus of the same id concatenate (shell first, workbench after) rather than
 *  one replacing the other, so the shell can seed a menu a workbench extends.
 *  Empty menus are dropped: a bar item that opens nothing is a dead end. */
export function mergeMenus(...sources: readonly (readonly Menu[])[]): Menu[] {
  const byId = new Map<MenuId, MenuEntry[]>();
  for (const source of sources)
    for (const menu of source) {
      if (!MENU_ORDER.includes(menu.id)) continue;
      const existing = byId.get(menu.id);
      if (existing) existing.push({ separator: true }, ...menu.items);
      else byId.set(menu.id, [...menu.items]);
    }
  return MENU_ORDER.filter((id) => byId.get(id)?.some((e) => !isDead(e))).map((id) => ({
    id,
    items: trimSeparators(byId.get(id)!.filter((e) => !(isSubmenu(e) && e.items.length === 0))),
  }));
}

/** Drops leading, trailing and doubled separators, so a menu assembled from
 *  parts that happened to be empty has no stray rules in it. */
export function trimSeparators(items: readonly MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const item of items) {
    if (isSeparator(item)) {
      if (out.length === 0 || isSeparator(out[out.length - 1]!)) continue;
      out.push(item);
    } else out.push(item);
  }
  while (out.length > 0 && isSeparator(out[out.length - 1]!)) out.pop();
  return out;
}

/** Arrow-key target: the next selectable entry from `from`, wrapping, skipping
 *  separators and disabled entries. A submenu is selectable -- landing on it is
 *  how you open it. -1 when a menu has nothing to land on. */
export function nextSelectable(items: readonly MenuEntry[], from: number, dir: 1 | -1): number {
  const n = items.length;
  if (n === 0) return -1;
  for (let step = 1; step <= n; step++) {
    const i = (((from + dir * step) % n) + n) % n;
    const item = items[i]!;
    if (!isSeparator(item) && !item.disabled) return i;
  }
  return -1;
}

export function firstSelectable(items: readonly MenuEntry[]): number {
  return nextSelectable(items, -1, 1);
}

export function lastSelectable(items: readonly MenuEntry[]): number {
  return nextSelectable(items, 0, -1);
}
