import { describe, expect, it } from 'vitest';
import {
  busSignalState,
  cycleTheme,
  signalStyle,
  withoutPresentationScale,
  SELECTABLE_THEMES,
  THEMES,
} from './theme';
import { makeTestTheme } from './theme.fixture';

const v = (value: number, x = 0, z = 0) => ({ v: value, x, z });

describe('busSignalState', () => {
  it('resolves a 1-bit net to plain 0/1, never M', () => {
    expect(busSignalState(v(0), 1)).toBe('0');
    expect(busSignalState(v(1), 1)).toBe('1');
  });

  it('is 0 only when every lane is 0, and 1 only when every lane is 1', () => {
    expect(busSignalState(v(0b0000), 4)).toBe('0');
    expect(busSignalState(v(0b1111), 4)).toBe('1');
  });

  it('is M for any partially-asserted bus', () => {
    expect(busSignalState(v(0b0001), 4)).toBe('M');
    expect(busSignalState(v(0b1110), 4)).toBe('M');
    expect(busSignalState(v(0b1010), 4)).toBe('M');
  });

  it('lets unknown dominate everything else', () => {
    expect(busSignalState(v(0b1111, 0b0001), 4)).toBe('X');
    expect(busSignalState(v(0b0000, 0b0001, 0b1110), 4)).toBe('X');
  });

  it('is Z only when every lane floats, and M when floating lanes mix with driven ones', () => {
    expect(busSignalState(v(0, 0, 0b1111), 4)).toBe('Z');
    expect(busSignalState(v(0b0011, 0, 0b1100), 4)).toBe('M');
    expect(busSignalState(v(0b0000, 0, 0b1100), 4)).toBe('M');
  });

  it('ignores lanes above the net width', () => {
    expect(busSignalState(v(0b1111_0000), 4)).toBe('0');
  });
});

describe('signalStyle', () => {
  it('gives the mixed state its own colour plus an alternating second stroke', () => {
    const theme = makeTestTheme();
    const style = signalStyle(theme, 'M');
    expect(style.color).toBe(theme.colors.signalMixed);
    expect(style.alt).toBe(theme.colors.muted);
    expect(style.dashed).toBe(false);
  });

  it('leaves Z as the only dashed state', () => {
    const theme = makeTestTheme();
    for (const s of ['0', '1', 'X', 'M'] as const) expect(signalStyle(theme, s).dashed).toBe(false);
    expect(signalStyle(theme, 'Z').dashed).toBe(true);
  });
});

describe('cycleTheme', () => {
  // Cycling walks the selectable list, not the whole registry: T must never
  // land on a theme the build has taken off the menu.
  it('wraps in selectable order both ways', () => {
    const first = SELECTABLE_THEMES[0]!.name;
    const last = SELECTABLE_THEMES[SELECTABLE_THEMES.length - 1]!.name;
    expect(cycleTheme(last, 1)).toBe(first);
    expect(cycleTheme(first, -1)).toBe(last);
  });

  it('never yields a theme outside the selectable list', () => {
    for (const t of THEMES)
      for (const dir of [1, -1] as const)
        expect(SELECTABLE_THEMES.map((x) => x.name)).toContain(cycleTheme(t.name, dir));
  });
});

describe('withoutPresentationScale', () => {
  const base = makeTestTheme();

  it('passes a non-presentation theme through untouched', () => {
    expect(withoutPresentationScale(base)).toBe(base);
  });

  it('drops the presentation text scale, so glyph geometry cannot move', () => {
    const scaled = { ...base, presentation: true, glyphText: base.canvasTextMin * 1.5 };
    const schematic = withoutPresentationScale(scaled);
    expect(schematic.glyphText).toBe(base.canvasTextMin);
    expect(schematic.glyphText).toBeLessThan(scaled.glyphText);
  });

  it('keeps the heavier presentation strokes and grid, which move nothing', () => {
    const scaled = { ...base, presentation: true, glyphText: base.canvasTextMin * 1.5 };
    const schematic = withoutPresentationScale(scaled);
    expect(schematic.strokes).toEqual(scaled.strokes);
    expect(schematic.gridSchematic).toBe(scaled.gridSchematic);
    expect(schematic.presentation).toBe(true);
  });
});
