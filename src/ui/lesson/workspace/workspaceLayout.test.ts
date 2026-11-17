import { describe, expect, it } from 'vitest';
import {
  areasOf,
  isArea,
  isNarrow,
  nodeAt,
  parseStoredLayout,
  presetLayout,
  resetSplit,
  resizeSplit,
  setAreaView,
  type LayoutNode,
  type SplitNode,
} from './workspaceLayout';

const preset = () => presetLayout('write') as SplitNode;
const sizesOf = (n: LayoutNode) => (n as SplitNode).sizes;
const sum = (xs: number[]) => xs.reduce((t, s) => t + s, 0);

describe('presetLayout', () => {
  it('write is a row of steps, board, inspector', () => {
    const p = preset();
    expect(p.dir).toBe('row');
    expect(p.sizes).toEqual([19, 51, 30]);
    expect(areasOf(p).map((a) => [a.id, a.view])).toEqual([
      ['a1', 'steps'],
      ['a2', 'board'],
      ['a3', 'insp'],
    ]);
  });
});

describe('setAreaView', () => {
  it('swaps views with the area that showed the requested one', () => {
    const next = setAreaView(preset(), 'a1', 'board');
    expect(areasOf(next).map((a) => a.view)).toEqual(['board', 'steps', 'insp']);
  });

  it('is a no-op for the same view or an unknown id', () => {
    const p = preset();
    expect(setAreaView(p, 'a1', 'steps')).toBe(p);
    expect(setAreaView(p, 'zz', 'board')).toBe(p);
  });

  it('does not mutate its input', () => {
    const p = preset();
    const snapshot = JSON.stringify(p);
    setAreaView(p, 'a1', 'board');
    expect(JSON.stringify(p)).toBe(snapshot);
  });
});

describe('resizeSplit', () => {
  it('moves the pair by the delta as a percent of the length', () => {
    const next = resizeSplit(preset(), '', 0, 100, 1000);
    const s = sizesOf(next);
    expect(s[0]).toBeCloseTo(29);
    expect(s[1]).toBeCloseTo(41);
    expect(s[2]).toBe(30);
    expect(sum(s)).toBeCloseTo(100);
  });

  it('clamps both sides to the minimum', () => {
    const left = sizesOf(resizeSplit(preset(), '', 0, -5000, 1000));
    expect(left[0]).toBeCloseTo(16);
    expect(left[1]).toBeCloseTo(54);
    const right = sizesOf(resizeSplit(preset(), '', 0, 5000, 1000));
    expect(right[0]).toBeCloseTo(54);
    expect(right[1]).toBeCloseTo(16);
    expect(right[2]).toBe(30);
    expect(sum(right)).toBeCloseTo(100);
  });

  it('is a no-op on a bad index, path or length', () => {
    const p = preset();
    expect(resizeSplit(p, '', -1, 50, 1000)).toBe(p);
    expect(resizeSplit(p, '', 2, 50, 1000)).toBe(p);
    expect(resizeSplit(p, '9', 0, 50, 1000)).toBe(p);
    expect(resizeSplit(p, '0', 0, 50, 1000)).toBe(p);
    expect(resizeSplit(p, '', 0, 50, 0)).toBe(p);
  });

  it('returns the same object when clamping leaves nothing to change', () => {
    const atMin = resizeSplit(preset(), '', 0, -5000, 1000);
    expect(resizeSplit(atMin, '', 0, -50, 1000)).toBe(atMin);
  });

  it('does not push an already undersized area further down', () => {
    const small: LayoutNode = { ...preset(), sizes: [10, 60, 30] };
    expect(resizeSplit(small, '', 0, -100, 1000)).toBe(small);
    const grown = sizesOf(resizeSplit(small, '', 0, 50, 1000));
    expect(grown[0]).toBeCloseTo(15);
    const smallRight: LayoutNode = { ...preset(), sizes: [60, 10, 30] };
    expect(resizeSplit(smallRight, '', 0, 100, 1000)).toBe(smallRight);
  });
});

describe('resetSplit', () => {
  it('restores the pair to the preset shares and leaves the rest', () => {
    const moved = resizeSplit(preset(), '', 0, 100, 1000);
    const s = sizesOf(resetSplit(moved, 'write', '', 0));
    expect(s[0]).toBeCloseTo(19);
    expect(s[1]).toBeCloseTo(51);
    expect(s[2]).toBe(30);
  });

  it('splits the pair total in the preset ratio', () => {
    const moved = resizeSplit(preset(), '', 1, 100, 1000);
    const s = sizesOf(resetSplit(moved, 'write', '', 0));
    expect(s[0]).toBeCloseTo((19 / 70) * 80);
    expect(s[2]).toBeCloseTo(20);
    expect(sum(s)).toBeCloseTo(100);
  });
});

describe('parseStoredLayout', () => {
  it('round-trips the preset through JSON', () => {
    const raw = JSON.parse(JSON.stringify(preset()));
    expect(parseStoredLayout(raw, 'write')).toEqual(preset());
  });

  it('accepts swapped views', () => {
    const swapped = setAreaView(preset(), 'a1', 'board');
    const raw = JSON.parse(JSON.stringify(swapped));
    expect(parseStoredLayout(raw, 'write')).toEqual(swapped);
  });

  const mutate = (f: (p: SplitNode) => void) => {
    const p = JSON.parse(JSON.stringify(preset())) as SplitNode;
    f(p);
    return p;
  };

  it.each<[string, unknown]>([
    ['null', null],
    ['string', 'row'],
    ['wrong dir', mutate((p) => (p.dir = 'col'))],
    ['sizes not summing to 100', mutate((p) => (p.sizes = [19, 51, 40]))],
    ['negative size', mutate((p) => (p.sizes = [-10, 80, 30]))],
    ['NaN size', mutate((p) => (p.sizes = [NaN, 70, 30]))],
    ['unknown view', mutate((p) => ((p.kids[0] as { view: string }).view = 'nope'))],
    ['duplicate views', mutate((p) => ((p.kids[0] as { view: string }).view = 'board'))],
    ['different area id', mutate((p) => ((p.kids[0] as { id: string }).id = 'x9'))],
    [
      'extra kid',
      mutate((p) => {
        p.kids.push({ id: 'a4', view: 'steps' });
        p.sizes = [19, 51, 20, 10];
      }),
    ],
  ])('rejects %s', (_name, raw) => {
    expect(parseStoredLayout(JSON.parse(JSON.stringify(raw)), 'write')).toBeNull();
  });
});

describe('isNarrow', () => {
  it('is true below 1000 and false at 1000', () => {
    expect(isNarrow(999)).toBe(true);
    expect(isNarrow(1000)).toBe(false);
  });
});

describe('nodeAt', () => {
  it('finds the root, a kid, and nothing for a bad path', () => {
    const p = preset();
    expect(nodeAt(p, '')).toBe(p);
    expect(nodeAt(p, '1')).toBe(p.kids[1]);
    expect(isArea(nodeAt(p, '1')!)).toBe(true);
    expect(nodeAt(p, '7')).toBeUndefined();
    expect(nodeAt(p, '1.0')).toBeUndefined();
  });
});
