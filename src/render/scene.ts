// A deliberately small retained scene: nodes carry world-space bounds and a draw
// callback, a viewport maps world <-> screen (pan/zoom), and render walks the list
// under that transform. Enough for the bit grid and XY plot; not a general graph.

import type { Theme } from './theme';

export interface Vec2 {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function rectContains(r: Rect, p: Vec2): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/** True if the two rects overlap at all (touching containment, for lasso select). */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;
}

/** Normalizes two corner points into a Rect with non-negative w/h. */
export function rectFromPoints(p0: Vec2, p1: Vec2): Rect {
  const x = Math.min(p0.x, p1.x);
  const y = Math.min(p0.y, p1.y);
  return { x, y, w: Math.abs(p1.x - p0.x), h: Math.abs(p1.y - p0.y) };
}

/** Screen = (world - pan) * zoom, with zoom about the world origin. */
export interface Viewport {
  panX: number;
  panY: number;
  zoom: number;
}

export const identityViewport: Viewport = { panX: 0, panY: 0, zoom: 1 };

export function worldToScreen(vp: Viewport, p: Vec2): Vec2 {
  return { x: (p.x - vp.panX) * vp.zoom, y: (p.y - vp.panY) * vp.zoom };
}

export function screenToWorld(vp: Viewport, p: Vec2): Vec2 {
  return { x: p.x / vp.zoom + vp.panX, y: p.y / vp.zoom + vp.panY };
}

export type DrawFn = (ctx: CanvasRenderingContext2D, theme: Theme) => void;

export interface Node {
  id: string;
  bounds: Rect; // world space, used for hit-testing
  draw?: DrawFn;
  data?: unknown; // caller payload (e.g. which bit a cell maps to)
}

export class Scene {
  private nodes: Node[] = [];

  add(node: Node): Node {
    this.nodes.push(node);
    return node;
  }

  remove(id: string): void {
    this.nodes = this.nodes.filter((n) => n.id !== id);
  }

  clear(): void {
    this.nodes = [];
  }

  get all(): readonly Node[] {
    return this.nodes;
  }

  /** Draw every node in insertion order under the viewport transform. */
  render(ctx: CanvasRenderingContext2D, theme: Theme, vp: Viewport = identityViewport): void {
    ctx.save();
    ctx.setTransform(vp.zoom, 0, 0, vp.zoom, -vp.panX * vp.zoom, -vp.panY * vp.zoom);
    for (const node of this.nodes) node.draw?.(ctx, theme);
    ctx.restore();
  }
}
