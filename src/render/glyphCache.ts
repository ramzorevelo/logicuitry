// Offscreen glyph cache. renderBoard() redraws every component every frame, and
// relief/rim-lines/patterns/emission multiply the per-glyph cost, so a glyph is
// rasterised once per (identity, state, rotation, theme, zoom bucket) and
// blitted afterwards.
//
// Tiles are trimmed to what was actually drawn rather than to symbolBounds:
// instance names, probe badges and bus labels legitimately paint outside the
// bounds rect, and a tile sized to the rect would clip them.

import type { Rect } from './scene';

interface Tile {
  canvas: HTMLCanvasElement;
  /** Top-left of the tile RELATIVE to the bounds it was built from. Position is
   *  deliberately not part of the key, so an absolute origin here would pin
   *  every later blit to the position the tile happened to be built at. */
  dx: number;
  dy: number;
  scale: number;
}

/** Slack around symbolBounds for out-of-bounds paint, in world units. The
 *  scratch tile is trimmed afterwards, so this only bounds the scan cost --
 *  but paint falling outside it IS lost, so a caller that knows it draws a
 *  long caption passes its own. */
const SCRATCH_PAD = 96;
const MAX_ENTRIES = 400;

/** Device pixels per world unit, quantised so a zoom gesture does not mint a
 *  tile per frame. Rounded UP to the next eighth: a tile is then never
 *  magnified at blit time, only ever minified by at most an eighth, which
 *  costs a shade of softness instead of visible blockiness. */
export function zoomBucket(scale: number): number {
  return Math.max(0.25, Math.ceil(scale * 8) / 8);
}

/**
 * World size a tile must be drawn at: its own pixel size divided by the scale
 * it was rasterised at. Dividing by the current frame's scale instead rescales
 * the glyph by bucket/scale, which pulls its pins off the wires drawn beside
 * it at true scale.
 */
export function tileWorldSize(
  pixelW: number,
  pixelH: number,
  tileScale: number,
): { w: number; h: number } {
  return { w: pixelW / tileScale, h: pixelH / tileScale };
}

const cache = new Map<string, Tile>();

export function clearGlyphCache(): void {
  cache.clear();
}

export function glyphCacheSize(): number {
  return cache.size;
}

/**
 * Draws `paint` (which paints in world coordinates) through the cache. `ctx`
 * must already carry the world->device transform at `scale` device pixels per
 * world unit. Falls back to painting directly whenever a tile cannot be built.
 */
export function drawCachedGlyph(
  ctx: CanvasRenderingContext2D,
  key: string,
  scale: number,
  bounds: Rect,
  paint: (c: CanvasRenderingContext2D) => void,
  pad = SCRATCH_PAD,
): void {
  const bucket = zoomBucket(scale);
  const full = `${key}|${bucket}`;
  const hit = cache.get(full);
  let tile: Tile | null = hit ?? null;
  if (tile) {
    // Refresh LRU position.
    cache.delete(full);
    cache.set(full, tile);
  } else {
    tile = buildTile(bounds, bucket, paint, pad);
    if (!tile) {
      paint(ctx);
      return;
    }
    cache.set(full, tile);
    while (cache.size > MAX_ENTRIES) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  }

  // Size and offset are both in the tile's OWN scale, never the frame's: the
  // zoom bucket means the two differ most of the time, and dividing the tile's
  // pixel size by the frame scale silently rescaled the glyph, so pins drifted
  // away from the wires drawn directly beside them (worse the further the zoom
  // sat from a bucket boundary). Position is exact, not pixel-snapped -- half a
  // device pixel of softness is cheaper than half a pixel of misalignment.
  const { w, h } = tileWorldSize(tile.canvas.width, tile.canvas.height, tile.scale);
  ctx.drawImage(tile.canvas, bounds.x + tile.dx, bounds.y + tile.dy, w, h);
}

function buildTile(
  bounds: Rect,
  scale: number,
  paint: (c: CanvasRenderingContext2D) => void,
  pad: number,
): Tile | null {
  const x0 = bounds.x - pad;
  const y0 = bounds.y - pad;
  const w = Math.ceil((bounds.w + pad * 2) * scale);
  const h = Math.ceil((bounds.h + pad * 2) * scale);
  if (!(w > 0) || !(h > 0) || w * h > 4e6) return null;
  if (typeof document === 'undefined') return null;

  const scratch = document.createElement('canvas');
  scratch.width = w;
  scratch.height = h;
  const sc = scratch.getContext('2d', { willReadFrequently: true });
  if (!sc) return null;
  sc.setTransform(scale, 0, 0, scale, -x0 * scale, -y0 * scale);
  paint(sc);

  const box = paintedBox(sc, w, h);
  if (!box) return null;
  const tile = document.createElement('canvas');
  tile.width = box.w;
  tile.height = box.h;
  const tc = tile.getContext('2d');
  if (!tc) return null;
  tc.drawImage(scratch, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
  return {
    canvas: tile,
    dx: box.x / scale - pad,
    dy: box.y / scale - pad,
    scale,
  };
}

/** Device-pixel bounding box of everything `paint` touched. */
function paintedBox(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
): { x: number; y: number; w: number; h: number } | null {
  const { data } = ctx.getImageData(0, 0, w, h);
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (data[row + x * 4 + 3] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
