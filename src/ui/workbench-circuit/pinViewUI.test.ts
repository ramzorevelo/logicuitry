import { describe, expect, it } from 'vitest';
import { currentPinView, isGroupCollapsed, pinViewGroupsFor } from './pinViewUI';

describe('pinViewGroupsFor', () => {
  it('gates: no groups at width 1, one per letter + y at width > 1', () => {
    expect(pinViewGroupsFor('and', { width: 1, inputs: 2 })).toEqual([]);
    expect(pinViewGroupsFor('and', { width: 3, inputs: 3 }).map((g) => g.key)).toEqual([
      'a',
      'b',
      'c',
      'y',
    ]);
  });

  it('buf/not: a and y at width > 1, nothing at width 1', () => {
    expect(pinViewGroupsFor('not', { width: 1 })).toEqual([]);
    expect(pinViewGroupsFor('not', { width: 4 }).map((g) => g.key)).toEqual(['a', 'y']);
  });

  it('toggle/led/probe: single group only above width 1', () => {
    expect(pinViewGroupsFor('toggle', { width: 1 })).toEqual([]);
    expect(pinViewGroupsFor('toggle', { width: 4 })).toEqual([{ key: 'y', label: 'y' }]);
    expect(pinViewGroupsFor('led', { width: 4 })).toEqual([{ key: 'a', label: 'a' }]);
    expect(pinViewGroupsFor('probe', { width: 4 })).toEqual([{ key: 'a', label: 'a' }]);
  });

  it('input/output: single group only above width 1', () => {
    expect(pinViewGroupsFor('inport', { width: 1 })).toEqual([]);
    expect(pinViewGroupsFor('inport', { width: 4 })).toEqual([{ key: 'y', label: 'y' }]);
    expect(pinViewGroupsFor('outport', { width: 1 })).toEqual([]);
    expect(pinViewGroupsFor('outport', { width: 4 })).toEqual([{ key: 'a', label: 'a' }]);
  });

  it('mux: select group always; data group collapses to one key at width 1, per-line at width >= 2; own y at width >= 2', () => {
    const w1 = pinViewGroupsFor('mux', { selectBits: 2, width: 1 }).map((g) => g.key);
    expect(w1).toEqual(['s', 'd']);
    const w2 = pinViewGroupsFor('mux', { selectBits: 2, width: 2 }).map((g) => g.key);
    expect(w2).toEqual(['s', 'd0', 'd1', 'd2', 'd3', 'y']);
  });

  it('demux mirrors mux onto the output side; own d at width >= 2', () => {
    const w1 = pinViewGroupsFor('demux', { selectBits: 2, width: 1 }).map((g) => g.key);
    expect(w1).toEqual(['s', 'y']);
    const w2 = pinViewGroupsFor('demux', { selectBits: 2, width: 2 }).map((g) => g.key);
    expect(w2).toEqual(['s', 'y0', 'y1', 'y2', 'y3', 'd']);
  });

  it('decoder: a only shown when addressBits > 1, outputs group always', () => {
    expect(pinViewGroupsFor('decoder', { addressBits: 1 }).map((g) => g.key)).toEqual(['y']);
    expect(pinViewGroupsFor('decoder', { addressBits: 2 }).map((g) => g.key)).toEqual(['a', 'y']);
  });

  it('encoder: inputs group always, a only when addressBits > 1', () => {
    expect(pinViewGroupsFor('encoder', { addressBits: 1 }).map((g) => g.key)).toEqual(['i']);
    expect(pinViewGroupsFor('encoder', { addressBits: 2 }).map((g) => g.key)).toEqual(['i', 'a']);
  });

  it('adder expands a, b and sum; comparator a and b; both start collapsed', () => {
    expect(pinViewGroupsFor('adder', {}).map((g) => g.key)).toEqual(['a', 'b', 'sum']);
    expect(pinViewGroupsFor('comparator', {}).map((g) => g.key)).toEqual(['a', 'b']);
    expect(currentPinView('adder', {})).toEqual({
      a: 'collapsed',
      b: 'collapsed',
      sum: 'collapsed',
    });
    expect(currentPinView('comparator', { pinView: 'a=expanded' })).toEqual({
      a: 'expanded',
      b: 'collapsed',
    });
  });

  it('counter and shift reg expand d (with load) and q (when it exists) to lanes', () => {
    const keys = (kind: string, p: Record<string, number | boolean>) =>
      pinViewGroupsFor(kind, p).map((g) => g.key);
    expect(keys('counter', { width: 4 })).toEqual(['q']);
    expect(keys('counter', { width: 4, hasLoad: true })).toEqual(['d', 'q']);
    expect(keys('counter', { width: 1, hasLoad: true })).toEqual([]);
    expect(keys('shiftreg', { width: 8, hasLoad: true, parallelOut: false })).toEqual(['d']);
    expect(currentPinView('counter', { width: 4, hasLoad: true, pinView: 'q=expanded' })).toEqual({
      d: 'collapsed',
      q: 'expanded',
    });
  });

  it('non-pinView kinds get no groups', () => {
    expect(pinViewGroupsFor('constant', { width: 4 })).toEqual([]);
    expect(pinViewGroupsFor('chip', {})).toEqual([]);
  });
});

describe('isGroupCollapsed / currentPinView', () => {
  it('mux select defaults expanded (individual lines), data defaults expanded too', () => {
    expect(isGroupCollapsed('mux', { selectBits: 2 }, 's')).toBe(false);
    expect(isGroupCollapsed('mux', { selectBits: 2, width: 1 }, 'd')).toBe(false);
  });

  it('an explicit pinView entry flips the reported state', () => {
    expect(isGroupCollapsed('mux', { selectBits: 2, pinView: 's=collapsed' }, 's')).toBe(true);
  });

  it('gate lanes default collapsed (one wide pin per letter)', () => {
    expect(isGroupCollapsed('and', { width: 3, inputs: 2 }, 'a')).toBe(true);
    expect(isGroupCollapsed('and', { width: 3, inputs: 2, pinView: 'a=expanded' }, 'a')).toBe(
      false,
    );
  });

  it('currentPinView matches isGroupCollapsed for every candidate group', () => {
    const params = { selectBits: 2, width: 1 };
    const view = currentPinView('mux', params);
    expect(view).toEqual({ s: 'expanded', d: 'expanded' });
  });
});
