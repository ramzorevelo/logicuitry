import { describe, expect, it } from 'vitest';
import type { Menu, MenuCommand } from '../menu/menuModel';
import { lockMenusForLessonEditor } from './lessonLock';

const cmd = (id: string): MenuCommand => ({ id, label: id, run: () => {} });

const menus: Menu[] = [
  { id: 'file', items: [cmd('import'), cmd('build')] },
  { id: 'edit', items: [cmd('undo'), cmd('redo'), { separator: true }, cmd('delete')] },
  { id: 'view', items: [cmd('fit'), cmd('viewOnly'), cmd('analyze')] },
  {
    id: 'simulate',
    items: [cmd('power'), { id: 'run-speed', label: 'Run speed', items: [cmd('x1')] }],
  },
];

const state = (locked: Menu[]) =>
  Object.fromEntries(
    locked.flatMap((m) =>
      m.items.flatMap((e) => ('separator' in e ? [] : [[`${m.id}.${e.id}`, !e.disabled]])),
    ),
  );

describe('lockMenusForLessonEditor', () => {
  it('greys everything that edits or drives the board and keeps the look-only items', () => {
    expect(state(lockMenusForLessonEditor(menus))).toEqual({
      'file.import': false,
      'file.build': false,
      'edit.undo': true,
      'edit.redo': true,
      'edit.delete': false,
      'view.fit': true,
      'view.viewOnly': false,
      'view.analyze': true,
      'simulate.power': false,
      'simulate.run-speed': false,
    });
  });

  it('points Undo and Redo at the lesson', () => {
    const edit = lockMenusForLessonEditor(menus).find((m) => m.id === 'edit')!;
    expect(edit.items.slice(0, 2).map((e) => ('label' in e ? e.label : ''))).toEqual([
      'Undo lesson edit',
      'Redo lesson edit',
    ]);
  });
});
