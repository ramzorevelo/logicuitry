import { PALETTE_SLOTS, type Group, type PaletteSlot, type Wire } from './types';

/** Colour for a new group: the lowest slot no group uses, skipping the
 *  parent's so a nested frame never vanishes into the one around it. Past
 *  eight groups the least-used slot is shared rather than leaving one plain. */
export function nextGroupColor(groups: readonly Group[], parent?: string): PaletteSlot {
  const uses = new Map<PaletteSlot, number>(PALETTE_SLOTS.map((s) => [s, 0]));
  for (const g of groups) if (g.color) uses.set(g.color, (uses.get(g.color) ?? 0) + 1);
  const parentColor = groups.find((g) => g.id === parent)?.color;
  const candidates = PALETTE_SLOTS.filter((s) => s !== parentColor);
  let best = candidates[0]!;
  for (const s of candidates) if (uses.get(s)! < uses.get(best)!) best = s;
  return best;
}

/** Colour for a wire made from existing runs (a split half, a healed
 *  junction, a spliced-out part): the first run's that has one, so cutting or
 *  joining a coloured bus line never strips its colour. Spread into the new
 *  wire; empty when no run is coloured. */
export function inheritedColor(...runs: (Pick<Wire, 'color'> | undefined)[]): Pick<Wire, 'color'> {
  const color = runs.find((r) => r?.color)?.color;
  return color ? { color } : {};
}

/** A group with a new name and style. A tab needs a colour, so plain drops it;
 *  absent fields stay absent rather than being written as false. */
export function styledGroup(
  group: Group,
  name: string,
  color: PaletteSlot | null | undefined,
  tab: boolean | undefined,
): Group {
  const next: Group = { ...group, name };
  delete next.color;
  delete next.tab;
  if (color) next.color = color;
  if (color && tab) next.tab = true;
  return next;
}

/** A wire with its insulation colour set, or cleared by `null`. */
export function recoloredWire(wire: Wire, color: PaletteSlot | null): Wire {
  const next = { ...wire };
  if (color) next.color = color;
  else delete next.color;
  return next;
}
