// The contract that makes free-form themed I/O glyphs safe: a variant may
// redraw the shape, never move the box or the pins. Wiring, hit-testing,
// routing obstacles, splice, rotation pivots and lasso all read those.

import { describe, expect, it } from 'vitest';
import type { Component, ComponentKind } from '../../core/model/types';
import { THEMES } from '../theme';
import { makeTestTheme } from '../theme.fixture';
import { symbolBounds } from './symbol';
import { registeredVariants, VARIANT_DEVICES } from './variants';
import './io';
import './gates';
import './chip';
import './charVariants';

const at = (kind: ComponentKind): Component => ({ id: `c-${kind}`, kind, pos: { x: 24, y: 16 } });

describe('glyph variants', () => {
  it('every registered variant is for a device the contract covers', () => {
    const registered = registeredVariants();
    expect(registered.length).toBeGreaterThan(0);
    for (const v of registered) {
      expect(VARIANT_DEVICES).toContain(v.device);
      expect(THEMES.map((t) => t.name)).toContain(v.theme);
    }
  });

  it('gives every character theme its own output indicator', () => {
    const withLed = registeredVariants()
      .filter((v) => v.device === 'led')
      .map((v) => v.theme);
    for (const t of THEMES)
      if (t.name !== 'light' && t.name !== 'dark') expect(withLed, t.name).toContain(t.name);
    // The teaching defaults keep the canonical IEC glyph set unaltered.
    expect(withLed).not.toContain('light');
    expect(withLed).not.toContain('dark');
  });

  it('leaves bounds and pin anchors identical in every theme', () => {
    for (const device of VARIANT_DEVICES) {
      const canonical = symbolBounds(at(device), makeTestTheme());
      for (const t of THEMES) {
        const themed = symbolBounds(at(device), makeTestTheme({ name: t.name }));
        expect(themed.bounds, `${device} bounds in ${t.name}`).toEqual(canonical.bounds);
        expect([...themed.pins.entries()], `${device} pins in ${t.name}`).toEqual([
          ...canonical.pins.entries(),
        ]);
      }
    }
  });
});
