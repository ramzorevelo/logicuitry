// One Theme object per theme revision, shared by every canvas that draws
// chrome outside a workbench's own loop.
//
// readTheme() is a getComputedStyle plus ~30 custom-property reads, each of
// which forces a style recalc. Paying that once per palette thumbnail is what
// made expanding a palette group slow; the tokens cannot differ between two
// reads at the same revision, so the result is cached against it.

import { readTheme, type Theme } from '../../render/theme';
import { themeRevision } from './useThemeRevision';

let cached: Theme | null = null;
let cachedAt = -1;

export function sharedTheme(): Theme {
  const rev = themeRevision();
  if (!cached || cachedAt !== rev) {
    cached = readTheme();
    cachedAt = rev;
  }
  return cached;
}
