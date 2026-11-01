import { describe, expect, it } from 'vitest';
import { PALETTE_SLOTS, isPaletteSlot, type Group } from './types';
import { inheritedColor, nextGroupColor } from './palette';

describe('nextGroupColor', () => {
  it('takes the lowest slot no group uses', () => {
    expect(nextGroupColor([])).toBe('g1');
    const groups: Group[] = [
      { id: 'a', name: 'A', color: 'g1' },
      { id: 'b', name: 'B', color: 'g3' },
      { id: 'c', name: 'C' },
    ];
    expect(nextGroupColor(groups)).toBe('g2');
  });

  it("skips the parent's colour for a nested group", () => {
    const groups: Group[] = [{ id: 'p', name: 'P', color: 'g2' }];
    expect(nextGroupColor(groups, 'p')).toBe('g1');
    expect(nextGroupColor([{ id: 'p', name: 'P', color: 'g1' }], 'p')).toBe('g2');
  });

  it('shares the least-used slot once all eight are taken', () => {
    const groups: Group[] = PALETTE_SLOTS.map((s, i) => ({ id: `g${i}`, name: s, color: s }));
    expect(nextGroupColor(groups)).toBe('g1');
    expect(nextGroupColor([...groups, { id: 'x', name: 'x', color: 'g1' }])).toBe('g2');
  });
});

describe('inheritedColor', () => {
  it('keeps the first coloured run, else the second, else none', () => {
    expect(inheritedColor({ color: 'g4' }, { color: 'g2' })).toEqual({ color: 'g4' });
    expect(inheritedColor({}, { color: 'g2' })).toEqual({ color: 'g2' });
    expect(inheritedColor(undefined, {})).toEqual({});
    expect(inheritedColor({ color: 'g7' })).toEqual({ color: 'g7' });
  });
});

describe('isPaletteSlot', () => {
  it('accepts only the eight slot names', () => {
    expect(isPaletteSlot('g8')).toBe(true);
    expect(isPaletteSlot('g9')).toBe(false);
    expect(isPaletteSlot('#ff0000')).toBe(false);
    expect(isPaletteSlot(undefined)).toBe(false);
  });
});
