import type { ChipLibrary, Circuit } from '../../core/model/types';
import {
  captionAwareBounds,
  measureMonoText,
  oneLine,
  symbolBounds,
} from '../../render/glyphs/symbol';
import type { Rect, Vec2, Viewport } from '../../render/scene';
import type { Theme } from '../../render/theme';
import { groupNameBox, groupRects } from './editorScene';
import { circuitRoutes, componentGeometry } from './routeCache';

/** World rect of everything a circuit draws, or null when it has no parts. */
export function circuitDrawnBounds(
  circuit: Circuit,
  chipLib: ChipLibrary,
  theme: Theme,
): Rect | null {
  if (circuit.components.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const take = (p: Vec2) => {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  };
  for (const c of circuit.components) {
    const def = c.defId ? chipLib.get(c.defId) : undefined;
    // Labels are drawn outside the symbol box, so fitting the boxes alone
    // pushed the outermost captions off the edge of the view.
    const b = captionAwareBounds(symbolBounds(c, theme, def).bounds, c.label, theme);
    take(b);
    take({ x: b.x + b.w, y: b.y + b.h });
  }
  // A wire can run past every part, as a bus or a loop-back does.
  for (const j of circuit.junctions) take(j.pos);
  for (const w of circuit.wires) {
    w.points.forEach(take);
    for (const e of [w.a, w.b]) if (e.kind === 'free' || e.kind === 'tap') take(e.pos);
  }
  takeGroupFrames(circuit, chipLib, theme, take);
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Group borders and their name boxes draw outside every member, so the
 *  parts alone clip them in a fit and in an export. */
function takeGroupFrames(
  circuit: Circuit,
  chipLib: ChipLibrary,
  theme: Theme,
  take: (p: Vec2) => void,
): void {
  if (!circuit.groups?.length) return;
  const g = theme.gridSchematic;
  const geo = componentGeometry(circuit.components, chipLib, theme);
  const routes = circuitRoutes(circuit, chipLib, theme, g);
  const rects = groupRects(circuit, (id) => geo.get(id)?.bounds, g, routes);
  for (const group of circuit.groups) {
    const rect = rects.get(group.id);
    if (!rect) continue;
    const name = groupNameBox(
      group,
      rect,
      measureMonoText(oneLine(group.name), theme.glyphText),
      theme,
    );
    for (const r of [rect, name]) {
      take(r);
      take({ x: r.x + r.w, y: r.y + r.h });
    }
  }
}

/** Centers `bounds` plus `margin` (world units) in a `viewW` x `viewH` CSS-px
 *  view, at the largest zoom that fits, clamped to [minZoom, maxZoom]. */
export function fitViewport(
  bounds: Rect,
  viewW: number,
  viewH: number,
  margin: number,
  minZoom: number,
  maxZoom: number,
): Viewport {
  const w = bounds.w + 2 * margin;
  const h = bounds.h + 2 * margin;
  const zoom = Math.min(maxZoom, Math.max(minZoom, Math.min(viewW / w, viewH / h)));
  return {
    panX: bounds.x - margin - (viewW / zoom - w) / 2,
    panY: bounds.y - margin - (viewH / zoom - h) / 2,
    zoom,
  };
}
