import { describe, expect, it } from 'vitest';
import { groupNameBox, groupRects } from './editorScene';
import { makeTestTheme } from '../../render/theme.fixture';
import type { Circuit } from '../../core/model/types';
import type { Rect } from '../../render/scene';

const G = 8;

describe('groupRects', () => {
  const board = {
    groups: [
      { id: 'outer', name: 'Outer' },
      { id: 'inner', name: 'Inner', parent: 'outer' },
    ],
    components: [
      { id: 'a', kind: 'and', pos: { x: 0, y: 0 }, group: 'outer' },
      { id: 'b', kind: 'and', pos: { x: 0, y: 0 }, group: 'inner' },
    ],
    wires: [],
  } as unknown as Circuit;
  const bounds = new Map<string, Rect>([
    ['a', { x: 0, y: 200, w: 40, h: 40 }],
    ['b', { x: 0, y: 100, w: 40, h: 40 }],
  ]);
  const rects = groupRects(board, (id) => bounds.get(id), G);

  it('pads a group around its own members', () => {
    expect(rects.get('inner')).toEqual({ x: -12, y: 88, w: 64, h: 64 });
  });

  it('leaves a nested group room for its name inside the parent', () => {
    const inner = rects.get('inner')!;
    const outer = rects.get('outer')!;
    expect(outer.y).toBe(inner.y - 2 * G - 1.5 * G);
    expect(outer.y + outer.h).toBe(240 + 1.5 * G);
  });
});

describe('groupNameBox', () => {
  const rect: Rect = { x: 0, y: 100, w: 200, h: 80 };
  const palette = ['#017', '#d50', '#093', '#75c', '#870', '#b58', '#38c', '#a44'];
  const theme = makeTestTheme();
  theme.colors.kmapGroups = palette;

  it('sits the bare name on the border', () => {
    const box = groupNameBox({ id: 'g', name: 'A', color: 'g1' }, rect, 30, theme);
    expect(box).toEqual({ x: 0, y: 100 - theme.glyphText, w: 30, h: theme.glyphText });
  });

  it('grows the box by the tab padding, still within the name room above', () => {
    const box = groupNameBox({ id: 'g', name: 'A', color: 'g1', tab: true }, rect, 30, theme);
    expect(box.w).toBeGreaterThan(30);
    expect(box.y + box.h).toBe(rect.y);
    expect(box.h).toBeLessThanOrEqual(2 * G);
  });

  it('draws no tab without a colour the theme knows', () => {
    const plain = groupNameBox({ id: 'g', name: 'A', tab: true }, rect, 30, theme);
    expect(plain.w).toBe(30);
    const bogus = groupNameBox(
      { id: 'g', name: 'A', color: 'g9' as never, tab: true },
      rect,
      30,
      theme,
    );
    expect(bogus.w).toBe(30);
  });
});
