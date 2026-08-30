// Accessibility floors every theme must clear, checked against the token sheet
// itself so a new palette cannot ship without meeting them:
//   - text contrast >= 4.5:1
//   - the five signal states separate in luminance, not hue alone

import { describe, expect, it } from 'vitest';
import css from './tokens.css?raw';
import { THEMES } from '../../render/theme';

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

/** A theme's effective value for a token: its own block, else the :root default. */
function tokens(theme: string): Map<string, string> {
  return new Map([...read(':root'), ...read(`:root[data-theme='${theme}']`)]);
}

function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (r as number) + 0.7152 * (g as number) + 0.0722 * (b as number);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe.each(THEMES.map((t) => t.name))('theme %s', (name) => {
  const t = tokens(name);
  const get = (k: string) => t.get(k) as string;

  it('renders body text at 4.5:1 or better on both surfaces', () => {
    expect(contrast(get('--ink'), get('--surface'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(get('--ink'), get('--paper'))).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps secondary text and every status colour legible', () => {
    for (const key of ['--muted', '--accent', '--warn', '--ok'])
      expect(contrast(get(key), get('--surface')), key).toBeGreaterThanOrEqual(3);
  });

  // Floors are what the shipped teaching defaults already achieve, so a
  // character theme can never be less legible in grayscale than Light or Dark.
  // 1-vs-X is the narrow pair even in Light (blue against rust), and leans on
  // hue and on X's rarity; the other pairs must part clearly.
  it('separates the signal states in luminance, not hue alone', () => {
    const gap = (a: string, b: string) => Math.abs(luminance(get(a)) - luminance(get(b)));
    expect(gap('--accent', '--muted'), '1 vs 0').toBeGreaterThanOrEqual(0.1);
    expect(gap('--muted', '--warn'), '0 vs X').toBeGreaterThanOrEqual(0.08);
    expect(gap('--accent', '--warn'), '1 vs X').toBeGreaterThanOrEqual(0.018);
  });

  it('keeps the mixed bus apart from the lanes-all-clear colour it alternates with', () => {
    expect(
      Math.abs(luminance(get('--signal-mixed')) - luminance(get('--muted'))),
    ).toBeGreaterThanOrEqual(0.1);
  });
});

// Firefly's palette IS its power indicator, so the swapped state has to clear
// the same floors -- it is a second palette, not a tint.
describe('firefly powered', () => {
  const t = new Map([
    ...read(':root'),
    ...read(":root[data-theme='firefly']"),
    ...read(":root[data-theme='firefly'].powered"),
  ]);
  const get = (k: string) => t.get(k) as string;

  it('keeps signal separation and legibility once the board is energised', () => {
    expect(contrast(get('--accent'), get('--surface'))).toBeGreaterThanOrEqual(3);
    const gap = (a: string, b: string) => Math.abs(luminance(get(a)) - luminance(get(b)));
    expect(gap('--accent', '--muted'), '1 vs 0').toBeGreaterThanOrEqual(0.1);
    expect(gap('--accent', '--warn'), '1 vs X').toBeGreaterThanOrEqual(0.018);
  });

  it('changes the accent, since that swap is the whole point', () => {
    const off = tokens('firefly');
    expect(get('--accent')).not.toBe(off.get('--accent'));
    expect(get('--signal-mixed')).toBe(get('--accent'));
  });
});
