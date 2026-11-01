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
export const SCRATCH_PAD = 96;
/** Floor for the tile cap; above the part count of the largest example board. */
const MIN_TILES = 1000;
/** The current bucket plus the one before it, which stands in while the
 *  current one waits for a frame with budget left. */
const BUCKETS_PER_KEY = 2;
/** Tile building per frame, in ms. Re-rasterising every glyph of a large
 *  board in one frame stalled a zoom step on the bus computer for ~46 ms. */
const BUILD_BUDGET_MS = 6;

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

/** LRU by key (Map order); each key holds its tiles by zoom bucket. */
const cache = new Map<string, Map<number, Tile>>();
let tileCount = 0;
let maxTiles = MIN_TILES;
let buildMsLeft = Infinity;
let buildsDeferred = false;

export function clearGlyphCache(): void {
  cache.clear();
  tileCount = 0;
}

/**
 * Runs one frame's drawing with a cap on the time spent building tiles
 * (not on the frame: wires alone can outlast the cap). Past the cap a glyph
 * draws from its tile at another zoom, else directly, uncached. Returns true
 * when that happened, so the caller draws another frame to finish the tiles.
 * Drawing outside this builds every missing tile at once.
 */
export function drawWithGlyphBudget(draw: () => void, budgetMs = BUILD_BUDGET_MS): boolean {
  buildMsLeft = budgetMs;
  buildsDeferred = false;
  try {
    draw();
  } finally {
    buildMsLeft = Infinity;
  }
  return buildsDeferred;
}

// A tile's key describes the component and the theme, never the code that
// painted it, so an edit to a glyph module leaves every cached tile drawing
// the old shape beside freshly routed wires. Dev only: a production page load
// starts with an empty cache anyway.
if (import.meta.hot) import.meta.hot.on('vite:beforeUpdate', clearGlyphCache);

export function glyphCacheSize(): number {
  return tileCount;
}

/**
 * Sizes the cap to the board being drawn. A fixed cap below the glyph count
 * evicts tiles the same frame draws again: a 1484-part board cost 4.5x a
 * 371-part one per draw. Two tiles per glyph covers the bucket kept for zoom.
 */
export function fitGlyphCacheTo(glyphCount: number): void {
  maxTiles = Math.max(MIN_TILES, BUCKETS_PER_KEY * glyphCount);
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
  let tiles = cache.get(key);
  if (tiles) {
    cache.delete(key);
    cache.set(key, tiles);
  }
  let tile = tiles?.get(bucket);
  if (!tile) {
    if (buildMsLeft <= 0) {
      buildsDeferred = true;
      const standIn = tiles && [...tiles.values()].pop();
      if (standIn) blit(ctx, standIn, bounds);
      else paint(ctx);
      return;
    }
    const started = performance.now();
    tile = buildTile(bounds, bucket, paint, pad) ?? undefined;
    buildMsLeft -= performance.now() - started;
    if (!tile) {
      paint(ctx);
      return;
    }
    if (!tiles) {
      tiles = new Map();
      cache.set(key, tiles);
    }
    tiles.set(bucket, tile);
    tileCount++;
    for (const old of tiles.keys()) {
      if (tiles.size <= BUCKETS_PER_KEY) break;
      tiles.delete(old);
      tileCount--;
    }
    evictOldest();
  }
  blit(ctx, tile, bounds);
}

function evictOldest(): void {
  for (const [key, tiles] of cache) {
    if (tileCount <= maxTiles) return;
    cache.delete(key);
    tileCount -= tiles.size;
  }
}

function blit(ctx: CanvasRenderingContext2D, tile: Tile, bounds: Rect): void {
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
