import type { Component } from '../../core/model/types';
import { ledActiveLow } from '../../core/sim/primitives/stimulus';
import type { Params } from '../../core/sim/primitives/types';
import { symbolBounds } from '../../render/glyphs/symbol';
import type { Theme } from '../../render/theme';

/**
 * New pos for an LED whose `activeLow` flipped, so its first pin stays put in
 * world space. The anode lead widens the glyph on its right, which moves the
 * pin under any turn or mirror that puts that edge on the left.
 */
export function ledPolarityReanchor(
  before: Component,
  after: Component,
  theme: Theme,
): { x: number; y: number } | undefined {
  if (after.kind !== 'led') return undefined;
  const polarity = (c: Component) => ledActiveLow((c.params ?? {}) as Params);
  if (polarity(before) === polarity(after)) return undefined;
  const was = symbolBounds(before, theme).pins;
  const now = symbolBounds(after, theme).pins;
  const name = [...was.keys()].find((n) => now.has(n));
  if (name === undefined) return undefined;
  const p0 = was.get(name)!;
  const p1 = now.get(name)!;
  return { x: after.pos.x + (p0.x - p1.x), y: after.pos.y + (p0.y - p1.y) };
}
