import { describe, expect, it } from 'vitest';
import { isDesktop } from './platform';

describe('isDesktop', () => {
  it('is false with no window at all (node, tests, SSR)', () => {
    expect(isDesktop()).toBe(false);
  });

  it('is true only when the desktop shell injected its global', () => {
    const g = globalThis as { window?: unknown };
    const had = 'window' in g;
    g.window = {};
    expect(isDesktop()).toBe(false);
    g.window = { __TAURI_INTERNALS__: {} };
    expect(isDesktop()).toBe(true);
    if (!had) delete g.window;
  });
});
