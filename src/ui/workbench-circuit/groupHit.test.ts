import { describe, expect, it } from 'vitest';
import { groupContaining, groupHandleAt, groupMemberIds } from './groupHit';
import type { Circuit, Group } from '../../core/model/types';
import type { Rect } from '../../render/scene';

const outer: Rect = { x: 0, y: 0, w: 100, h: 100 };
const inner: Rect = { x: 20, y: 20, w: 30, h: 30 };

const query = (groups: readonly Group[], rects: [string, Rect][]) => ({
  groups,
  rects: new Map(rects),
  tol: 2,
  nameHeight: 10,
  measureName: (name: string) => name.length * 6,
});

describe('groupHandleAt', () => {
  const q = query([{ id: 'g1', name: 'Adder' }], [['g1', outer]]);

  it('takes the border stroke from either side of it', () => {
    for (const p of [
      { x: 50, y: 0 },
      { x: 50, y: 1 },
      { x: 50, y: -1 },
      { x: 0, y: 50 },
      { x: 100, y: 50 },
      { x: 50, y: 100 },
    ])
      expect(groupHandleAt(q, p)).toBe('g1');
  });

  it('leaves the interior alone, so a lasso can still start inside', () => {
    expect(groupHandleAt(q, { x: 50, y: 50 })).toBeUndefined();
    expect(groupHandleAt(q, { x: 10, y: 10 })).toBeUndefined();
  });

  it('leaves the outside alone', () => {
    expect(groupHandleAt(q, { x: 50, y: -20 })).toBeUndefined();
    expect(groupHandleAt(q, { x: 140, y: 50 })).toBeUndefined();
  });

  it('takes the name above the top edge, for its measured width only', () => {
    expect(groupHandleAt(q, { x: 12, y: -5 })).toBe('g1'); // "Adder" is 30 wide
    expect(groupHandleAt(q, { x: 60, y: -5 })).toBeUndefined();
  });

  it('gives a nested border to the child, not the parent', () => {
    const nested = query(
      [
        { id: 'g1', name: 'Outer' },
        { id: 'g2', name: 'Inner', parent: 'g1' },
      ],
      [
        ['g1', outer],
        ['g2', inner],
      ],
    );
    expect(groupHandleAt(nested, { x: 35, y: 20 })).toBe('g2');
    expect(groupHandleAt(nested, { x: 50, y: 0 })).toBe('g1');
  });

  it('finds nothing when a group has no rect yet', () => {
    expect(
      groupHandleAt(query([{ id: 'g1', name: 'Adder' }], []), { x: 50, y: 0 }),
    ).toBeUndefined();
  });
});

describe('groupMemberIds', () => {
  const circuit = {
    components: [
      { id: 'c1', group: 'g1' },
      { id: 'c2', group: 'g2' },
      { id: 'c3', group: 'g3' },
      { id: 'c4' },
    ],
    junctions: [
      { id: 'j1', pos: { x: 60, y: 60 } },
      { id: 'j2', pos: { x: 400, y: 400 } },
    ],
    groups: [
      { id: 'g1', name: 'Outer' },
      { id: 'g2', name: 'Inner', parent: 'g1' },
      { id: 'g3', name: 'Elsewhere' },
    ],
  } as unknown as Circuit;

  it('takes the group and every descendant, never a sibling', () => {
    const ids = groupMemberIds(circuit, 'g1', outer);
    expect([...ids].sort()).toEqual(['c1', 'c2', 'j1']);
  });

  it('takes only the junctions the border encloses', () => {
    expect(groupMemberIds(circuit, 'g1', undefined).has('j1')).toBe(false);
    expect(groupMemberIds(circuit, 'g1', outer).has('j2')).toBe(false);
  });

  it('does not reach upward from a child', () => {
    expect([...groupMemberIds(circuit, 'g2', inner)]).toEqual(['c2']);
  });
});

describe('groupContaining', () => {
  const groups: Group[] = [
    { id: 'g1', name: 'Outer' },
    { id: 'g2', name: 'Inner', parent: 'g1' },
  ];
  const rects = new Map([
    ['g1', outer],
    ['g2', inner],
  ]);

  it('claims a drop anywhere inside the border, not just on it', () => {
    expect(groupContaining(groups, rects, { x: 70, y: 70 })).toBe('g1');
    expect(groupContaining(groups, rects, { x: 0, y: 0 })).toBe('g1');
  });

  it('takes the innermost group, so a nested drop does not land in the parent', () => {
    expect(groupContaining(groups, rects, { x: 30, y: 30 })).toBe('g2');
  });

  it('leaves a drop outside every border ungrouped', () => {
    expect(groupContaining(groups, rects, { x: 140, y: 50 })).toBeUndefined();
    expect(groupContaining([], new Map(), { x: 0, y: 0 })).toBeUndefined();
  });

  it('ignores a group with no rect (no members yet)', () => {
    expect(groupContaining(groups, new Map([['g2', inner]]), { x: 70, y: 70 })).toBeUndefined();
  });
});
