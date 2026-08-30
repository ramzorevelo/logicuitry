import { describe, expect, it } from 'vitest';
import { hasPrimitive } from '../../core/sim/primitives/registry';
import { buildLocalGeometry, primitivePins } from '../../render/glyphs/symbol';
// Side-effect imports: glyph geometry registers at module load.
import '../../render/glyphs/gates';
import '../../render/glyphs/chip';
import '../../render/glyphs/io';
import type { Theme } from '../../render/theme';
import { makeTestTheme } from '../../render/theme.fixture';
import { PALETTE, PALETTE_GROUPS } from './palette';

const theme: Theme = makeTestTheme();

describe('PALETTE', () => {
  it('every entry is a registered sim primitive with glyph geometry', () => {
    for (const item of PALETTE) {
      expect(hasPrimitive(item.kind), `primitive '${item.kind}'`).toBe(true);
      const geo = buildLocalGeometry(
        {
          kind: item.kind,
          params: item.params ?? {},
          pins: primitivePins(item.kind, item.params ?? {}),
        },
        theme,
      );
      expect(geo.bounds.w).toBeGreaterThan(0);
      expect(geo.pins.size).toBeGreaterThan(0);
    }
  });

  it('every entry lands in a rendered group, and every group has entries', () => {
    for (const item of PALETTE) expect(PALETTE_GROUPS, item.label).toContain(item.group);
    for (const group of PALETTE_GROUPS)
      expect(PALETTE.filter((i) => i.group === group).length, group).toBeGreaterThan(0);
  });

  it('keeps every entry unique by label, since the rail keys on it', () => {
    expect(new Set(PALETTE.map((i) => i.label)).size).toBe(PALETTE.length);
  });
});
