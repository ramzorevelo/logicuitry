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

describe('groupRects around wires', () => {
  const pin = (component: string) => ({ kind: 'pin', component, pin: 'y' });
  const circuit = (wires: unknown[], junctions: unknown[] = []) =>
    ({
      groups: [
        { id: 'outer', name: 'Outer' },
        { id: 'inner', name: 'Inner', parent: 'outer' },
        { id: 'other', name: 'Other' },
      ],
      components: [
        { id: 'a', kind: 'and', pos: { x: 0, y: 0 }, group: 'inner' },
        { id: 'b', kind: 'and', pos: { x: 0, y: 0 }, group: 'inner' },
        { id: 'c', kind: 'and', pos: { x: 0, y: 0 }, group: 'outer' },
        { id: 'd', kind: 'and', pos: { x: 0, y: 0 }, group: 'other' },
        { id: 'e', kind: 'and', pos: { x: 0, y: 0 } },
      ],
      wires,
      junctions,
    }) as unknown as Circuit;
  const bounds = new Map<string, Rect>([
    ['a', { x: 0, y: 0, w: 40, h: 40 }],
    ['b', { x: 100, y: 0, w: 40, h: 40 }],
    ['c', { x: 0, y: 200, w: 40, h: 40 }],
    ['d', { x: 400, y: 0, w: 40, h: 40 }],
    ['e', { x: 400, y: 200, w: 40, h: 40 }],
  ]);
  const rectsOf = (c: Circuit) => groupRects(c, (id) => bounds.get(id), G);
  const loop = (id: string, a: string, b: string) => ({
    id,
    a: pin(a),
    b: pin(b),
    points: [
      { x: 40, y: -80 },
      { x: 100, y: -80 },
    ],
  });

  it('takes in a wire routed past its own members', () => {
    const inner = rectsOf(circuit([loop('w1', 'a', 'b')])).get('inner')!;
    expect(inner.y).toBe(-80 - 1.5 * G);
  });

  it('takes in the drawn route of a wire that stores no bends', () => {
    const c = circuit([{ id: 'w1', a: pin('a'), b: pin('b'), points: [] }]);
    const routes = new Map([
      [
        'w1',
        [
          { x: 40, y: 20 },
          { x: 40, y: -60 },
          { x: 100, y: -60 },
          { x: 100, y: 20 },
        ],
      ],
    ]);
    expect(rectsOf(c).get('inner')!.y).toBe(-1.5 * G);
    expect(groupRects(c, (id) => bounds.get(id), G, routes).get('inner')!.y).toBe(-60 - 1.5 * G);
  });

  it('gives a wire between a child and its parent to the parent', () => {
    const rects = rectsOf(circuit([loop('w1', 'a', 'c')]));
    expect(rects.get('inner')!.y).toBe(-1.5 * G);
    expect(rects.get('outer')!.y).toBe(-80 - 1.5 * G);
  });

  it('leaves out a wire that has to cross a border', () => {
    const plain = rectsOf(circuit([]));
    for (const [a, b] of [
      ['a', 'd'],
      ['a', 'e'],
    ] as const)
      expect(rectsOf(circuit([loop('w1', a, b)]))).toEqual(plain);
  });

  it('follows a tree through a junction and a tap, out of the group if any branch leaves', () => {
    const j = { id: 'j1', pos: { x: 70, y: -40 } };
    const inside = circuit(
      [
        { id: 'w1', a: pin('a'), b: { kind: 'junction', junction: 'j1' }, points: [] },
        { id: 'w2', a: { kind: 'junction', junction: 'j1' }, b: pin('b'), points: [] },
      ],
      [j],
    );
    expect(rectsOf(inside).get('inner')!.y).toBe(-40 - 1.5 * G);
    const leaving = circuit(
      [
        ...inside.wires,
        {
          id: 'w3',
          a: { kind: 'tap', wire: 'w2', range: { lo: 0, hi: 0 }, pos: { x: 70, y: -60 } },
          b: pin('d'),
          points: [],
        },
      ],
      [j],
    );
    expect(rectsOf(leaving).get('inner')!.y).toBe(-1.5 * G);
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
