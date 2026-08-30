// The chip-colour picker names each swatch from the colour the ACTIVE theme
// resolved it to, so the names have to hold up against the token sheet itself:
// two swatches in one row that read the same are the bug this replaced.

import { describe, expect, it } from 'vitest';
import css from './tokens.css?raw';
import { CHIP_TINTS, colorName, THEMES } from '../../render/theme';

function block(selector: string): string {
  const at = css.indexOf(`${selector} {`);
  return at < 0 ? '' : css.slice(at, css.indexOf('\n}', at));
}

const read = (sel: string) =>
  new Map(
    Array.from(block(sel).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g), (m) => [
      m[1] as string,
      (m[2] as string).trim(),
    ]),
  );

const tokens = (theme: string) =>
  new Map([...read(':root'), ...read(`:root[data-theme='${theme}']`)]);

/** ChipTint key -> the CSS custom property it reads (theme.ts's own mapping). */
const TOKEN: Record<string, string> = {
  accent2: '--accent-2',
  accent3: '--accent-3',
  ok: '--ok',
  warn: '--warn',
  muted: '--muted',
};

const namesFor = (theme: string) => {
  const t = tokens(theme);
  return CHIP_TINTS.map((tint) => colorName(t.get(TOKEN[tint]!)!));
};

describe('chip-tint colour names', () => {
  for (const { name, label } of THEMES) {
    it(`${label}: all five tints get a distinct name`, () => {
      const bare = namesFor(name).map((n) => n.split(' (')[0]);
      expect(new Set(bare).size).toBe(bare.length);
    });
  }

  it('never shows a token name to the user', () => {
    for (const { name } of THEMES)
      for (const n of namesFor(name))
        for (const tint of CHIP_TINTS) expect(n.split(' (')[0]!.toLowerCase()).not.toBe(tint);
  });

  it('always carries the hex it is naming', () => {
    for (const { name } of THEMES)
      for (const n of namesFor(name)) expect(n).toMatch(/ \(#[0-9a-f]{6}\)$/);
  });

  it('uses US spelling', () => {
    for (const { name } of THEMES) for (const n of namesFor(name)) expect(n).not.toMatch(/grey/i);
  });
});

describe('colorName', () => {
  const bare = (c: string) => colorName(c).split(' (')[0];

  it('names a dark warm hue brown, not "dark orange"', () => {
    expect(bare('#9a5a0b')).toBe('Brown');
    expect(bare('#6e2a07')).toBe('Dark brown');
  });

  it('names a dark blue navy', () => {
    expect(bare('#26307d')).toBe('Navy');
  });

  it('separates two blue-grays by lightness', () => {
    expect(bare('#5f6580')).toBe('Blue gray');
    expect(bare('#8c92a8')).toBe('Light blue gray');
  });

  it('names a washed-out warm neutral a brown gray, not an orange one', () => {
    expect(bare('#948274')).toBe('Brown gray');
  });

  it('calls a vivid mid-light colour bright rather than light', () => {
    expect(bare('#ffb02e')).toBe('Bright amber');
  });

  it('falls back to neutrals with no hue when there is none', () => {
    expect(bare('#000000')).toBe('Black');
    expect(bare('#ffffff')).toBe('White');
    expect(bare('#808080')).toBe('Gray');
  });

  it('accepts rgb() and 3-digit hex, and passes anything else through', () => {
    expect(colorName('rgb(255, 0, 0)')).toBe('Red (#ff0000)');
    expect(colorName('#f00')).toBe('Red (#ff0000)');
    expect(colorName('var(--nope)')).toBe('var(--nope)');
  });
});
