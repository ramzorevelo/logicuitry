import { describe, expect, it } from 'vitest';
import {
  firstSelectable,
  isSeparator,
  isSubmenu,
  lastSelectable,
  mergeMenus,
  nextSelectable,
  trimSeparators,
  type Menu,
  type MenuEntry,
} from './menuModel';

const cmd = (id: string, over: Partial<{ disabled: boolean }> = {}): MenuEntry => ({
  id,
  label: id,
  run: () => {},
  ...over,
});
const sep: MenuEntry = { separator: true };

describe('mergeMenus', () => {
  it('orders the bar by MENU_ORDER, not by contribution order', () => {
    const shell: Menu[] = [{ id: 'help', items: [cmd('about')] }];
    const workbench: Menu[] = [
      { id: 'edit', items: [cmd('undo')] },
      { id: 'file', items: [cmd('new')] },
    ];
    expect(mergeMenus(shell, workbench).map((m) => m.id)).toEqual(['file', 'edit', 'help']);
  });

  it('concatenates same-id menus with a rule between them', () => {
    const a: Menu[] = [{ id: 'view', items: [cmd('zoom')] }];
    const b: Menu[] = [{ id: 'view', items: [cmd('theme')] }];
    const items = mergeMenus(a, b)[0]!.items;
    expect(items.map((i) => (isSeparator(i) ? '-' : i.id))).toEqual(['zoom', '-', 'theme']);
  });

  it('drops a menu with nothing in it rather than showing a dead bar item', () => {
    expect(mergeMenus([{ id: 'file', items: [] }])).toEqual([]);
    expect(mergeMenus([{ id: 'file', items: [sep] }])).toEqual([]);
  });

  it('ignores a contribution under an unknown id', () => {
    expect(mergeMenus([{ id: 'nope' as 'file', items: [cmd('x')] }])).toEqual([]);
  });
});

describe('trimSeparators', () => {
  it('removes leading, trailing and doubled rules', () => {
    const out = trimSeparators([sep, sep, cmd('a'), sep, sep, cmd('b'), sep]);
    expect(out.map((i) => (isSeparator(i) ? '-' : i.id))).toEqual(['a', '-', 'b']);
  });
});

describe('nextSelectable', () => {
  const items = [cmd('a'), sep, cmd('b', { disabled: true }), cmd('c')];

  it('skips separators and disabled entries', () => {
    expect(nextSelectable(items, 0, 1)).toBe(3);
    expect(nextSelectable(items, 3, -1)).toBe(0);
  });

  it('wraps in both directions', () => {
    expect(nextSelectable(items, 3, 1)).toBe(0);
    expect(nextSelectable(items, 0, -1)).toBe(3);
  });

  it('reports -1 when a menu has nothing to land on', () => {
    expect(nextSelectable([sep, cmd('x', { disabled: true })], 0, 1)).toBe(-1);
    expect(firstSelectable([])).toBe(-1);
  });

  it('first and last land on the ends', () => {
    expect(firstSelectable(items)).toBe(0);
    expect(lastSelectable(items)).toBe(3);
  });
});

describe('submenus', () => {
  const sub = (id: string, n: number): MenuEntry => ({
    id,
    label: id,
    items: Array.from({ length: n }, (_, i) => ({
      id: `${id}${i}`,
      label: `${id}${i}`,
      run: () => {},
    })),
  });

  it('recognises a submenu without mistaking it for a command or separator', () => {
    const entry = sub('recent', 2);
    expect(isSubmenu(entry)).toBe(true);
    expect(isSeparator(entry)).toBe(false);
    expect(isSubmenu(cmd('open'))).toBe(false);
    expect(isSubmenu(sep)).toBe(false);
  });

  it('drops an empty submenu rather than showing a flyout that opens nothing', () => {
    const items = mergeMenus([{ id: 'file', items: [cmd('open'), sub('recent', 0)] }])[0]!.items;
    expect(items.map((i) => (isSeparator(i) ? '-' : i.id))).toEqual(['open']);
  });

  it('drops a menu whose only entry is an empty submenu', () => {
    expect(mergeMenus([{ id: 'file', items: [sub('recent', 0)] }])).toEqual([]);
  });

  it('keeps a submenu that still has items', () => {
    const items = mergeMenus([{ id: 'file', items: [cmd('open'), sub('recent', 3)] }])[0]!.items;
    expect(items.map((i) => (isSeparator(i) ? '-' : i.id))).toEqual(['open', 'recent']);
  });

  it('lands on a submenu with the arrow keys', () => {
    const items = [cmd('open'), sub('recent', 2), cmd('save')];
    expect(nextSelectable(items, 0, 1)).toBe(1);
    expect(nextSelectable(items, 2, -1)).toBe(1);
  });

  it('skips a disabled submenu', () => {
    const items = [cmd('open'), { ...sub('recent', 2), disabled: true }, cmd('save')];
    expect(nextSelectable(items, 0, 1)).toBe(2);
  });
});
