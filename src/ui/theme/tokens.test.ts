// readTheme() throws on a missing token, which is a hard crash rather than a
// visual bug, so the token sheet is checked statically: every name the bridge
// reads must exist in :root, every registered theme must have a block, and no
// block may introduce a name :root does not already default.

import { describe, expect, it } from 'vitest';
import css from './tokens.css?raw';
import bridge from '../../render/theme.ts?raw';
import { THEMES } from '../../render/theme';

function block(selector: string): string {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) return '';
  return css.slice(at, css.indexOf('\n}', at));
}

function declaredIn(selector: string): Set<string> {
  return new Set(Array.from(block(selector).matchAll(/(--[\w-]+)\s*:/g), (m) => m[1] as string));
}

/** Token names readTheme() asks for, taken from its own source so a new read
 *  site cannot be added without the sheet being checked for it. */
function tokensRead(): Set<string> {
  const names = new Set(
    Array.from(bridge.matchAll(/token\('(--[\w-]+)'\)/g), (m) => m[1] as string),
  );
  for (let i = 1; i <= 8; i++) names.add(`--kmap-g${i}`);
  return names;
}

const rootTokens = declaredIn(':root');

describe('design tokens', () => {
  it(':root defaults every token the canvas bridge reads', () => {
    for (const name of tokensRead()) expect(rootTokens).toContain(name);
  });

  it('every registered theme has a block', () => {
    for (const t of THEMES) expect(css).toContain(`:root[data-theme='${t.name}'] {`);
  });

  it('no theme introduces a token :root does not default', () => {
    for (const t of THEMES)
      for (const name of declaredIn(`:root[data-theme='${t.name}']`))
        expect(rootTokens).toContain(name);
  });

  it('every theme states the full colour palette rather than inheriting it', () => {
    const palette = [
      '--paper',
      '--surface',
      '--ink',
      '--muted',
      '--line',
      '--accent',
      '--accent-2',
      '--accent-fill',
      '--warn',
      '--ok',
      '--signal-mixed',
    ];
    for (const t of THEMES) {
      const declared = declaredIn(`:root[data-theme='${t.name}']`);
      for (const name of palette) expect(declared).toContain(name);
    }
  });
});
