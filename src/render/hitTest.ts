// Topmost-node hit-testing over a Scene. Screen point -> world (via viewport) ->
// last node whose bounds contain it (last drawn wins, matching paint order). Fat
// targets: bounds may be padded by the caller; presentation scales the pad.

import { identityViewport, rectContains, screenToWorld } from './scene';
import type { Node, Scene, Vec2, Viewport } from './scene';

export const MIN_HIT_RADIUS = 12; // px at 100% zoom, per design-system

// Wire-body proximity, not a point fat-target: half the schematic grid unit
// (8px), the established snap-to-nearest-wire tolerance -- any click stays
// within its own grid cell, so a wire one unit over is never swallowed.
export const WIRE_BODY_HIT_RADIUS = 4; // px at 100% zoom

/** Smallest comfortable finger target: 44px across, the WCAG 2.2 AAA and
 *  Apple HIG floor. A pin drawn at 12px is unhittable by a fingertip, so on
 *  touch the hit area grows well past the glyph even though the glyph does
 *  not. */
export const TOUCH_HIT_RADIUS = 22; // px at 100% zoom

export interface HitScale {
  zoom: number;
  presentation?: boolean;
  touch?: boolean;
}

/**
 * A screen-pixel hit budget converted to world units.
 *
 * Every caller used to divide a raw constant by the zoom, which meant the
 * touch budget had to be threaded through ten call sites by hand. Radii are a
 * property of the input device and the screen, never of the drawing, so the
 * conversion lives in one place.
 */
export function hitRadius(basePx: number, { zoom, presentation, touch }: HitScale): number {
  const px = Math.max(basePx, touch ? TOUCH_HIT_RADIUS : 0) * (presentation ? 1.4 : 1);
  // A zoom of 0 would be a division by zero and an infinite radius that
  // swallows the whole board.
  return px / Math.max(zoom, 0.01);
}

/** Node under a screen-space point, or undefined. Later nodes take priority. */
export function hitTest(
  scene: Scene,
  screenPoint: Vec2,
  vp: Viewport = identityViewport,
): Node | undefined {
  const world = screenToWorld(vp, screenPoint);
  const nodes = scene.all;
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]!;
    if (rectContains(node.bounds, world)) return node;
  }
  return undefined;
}

/** Grow a hit rect to at least the fat-target radius, scaled by presentation. */
export function padHitRect<T extends { x: number; y: number; w: number; h: number }>(
  rect: T,
  presentation: boolean,
): { x: number; y: number; w: number; h: number } {
  const min = MIN_HIT_RADIUS * (presentation ? 1.4 : 1);
  const padX = Math.max(0, min - rect.w) / 2;
  const padY = Math.max(0, min - rect.h) / 2;
  return { x: rect.x - padX, y: rect.y - padY, w: rect.w + 2 * padX, h: rect.h + 2 * padY };
}
