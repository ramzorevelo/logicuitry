// Body decoration driven by Theme.glyph: fill mode, pattern, relief, rim-line,
// corner motifs, corner geometry and asserted-signal emphasis. Everything here
// is additive and flat-renderable -- the silhouette a caller builds is the
// silhouette that gets drawn, so gate hit-testing stays valid.

import type { Rect } from '../scene';
import type { Theme } from '../theme';
import { showsBloom, showsCorners, showsPattern, showsRelief } from '../lod';

/** Offset of the two relief strokes, in world units. Deliberately 1px: relief
 *  is meant to be felt, not seen, and anything wider fights the outline. */
const RELIEF_OFFSET = 1;
const PATTERN_TILE = 16;

/** Very low alpha: a tint or a pattern must never compete with a state colour. */
const TINT_ALPHA = 0.1;
const PATTERN_ALPHA = 0.12;
const RELIEF_ALPHA = 0.35;

export interface BodyOptions {
  /** Rect bodies additionally get the rim-line and corner motifs. */
  rect?: Rect | undefined;
  /** A packaged chip's own colour, already resolved for this theme. Painted
   *  at the same low alpha as the theme's own tint dial, so a coloured chip
   *  still reads as a body and its outline and pins are untouched. */
  tint?: string | undefined;
  /** A packaged chip's border colour, already resolved for this theme. Unlike
   *  `tint` this strokes at full strength -- it is the chip's identity, meant
   *  to be picked out across a board. Pin and signal colours are untouched. */
  outline?: string | undefined;
}

/** Fill+stroke a body the theme's way. `path` must build (not stroke) the
 *  silhouette, and may be called more than once. */
export function paintBody(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  path: () => void,
  opts: BodyOptions = {},
): void {
  const lod = theme.lod;

  // The path is built once and left current: fill, tint, pattern and the final
  // stroke all reuse it. Only relief, which draws the same shape at an offset,
  // pays for a rebuild.
  ctx.fillStyle = theme.colors.surface;
  ctx.beginPath();
  path();
  ctx.fill();

  const tint = opts.tint ?? (theme.glyph.bodyFill === 'tint' ? theme.colors.accent : undefined);
  if (tint) {
    ctx.save();
    ctx.globalAlpha = TINT_ALPHA;
    ctx.fillStyle = tint;
    ctx.fill();
    ctx.restore();
  }

  // Patterns fill BOX bodies only. A gate's silhouette is its logic function
  // and a texture inside it fights the shape the student has to recognise.
  if (opts.rect && theme.glyph.bodyPattern !== 'none' && showsPattern(lod)) {
    const pattern = bodyPattern(ctx, theme);
    if (pattern) {
      ctx.save();
      ctx.clip();
      ctx.globalAlpha = PATTERN_ALPHA;
      ctx.fillStyle = pattern;
      ctx.fill();
      ctx.restore();
    }
  }

  if (theme.glyph.relief !== 'flat' && showsRelief(lod)) {
    paintRelief(ctx, theme, path);
    // Relief built the path under a translate, so the retained one is offset.
    ctx.beginPath();
    path();
  }

  ctx.strokeStyle = opts.outline ?? theme.colors.ink;
  ctx.lineWidth = theme.strokes.wire;
  ctx.stroke();

  if (opts.rect && theme.glyph.rimLine === 'inset' && showsRelief(lod))
    paintRimLine(ctx, theme, opts.rect);
  if (opts.rect && theme.glyph.corners === 'bracket' && showsCorners(lod))
    paintCornerBrackets(ctx, theme, opts.rect);
}

/** Two offset strokes, light then dark; bevel lights the top-left, emboss the
 *  bottom-right. No blur, so this costs exactly two extra strokes. */
function paintRelief(ctx: CanvasRenderingContext2D, theme: Theme, path: () => void): void {
  const d = theme.glyph.relief === 'emboss' ? -RELIEF_OFFSET : RELIEF_OFFSET;
  ctx.save();
  ctx.globalAlpha = RELIEF_ALPHA;
  ctx.lineWidth = theme.strokes.min;
  for (const [dx, color] of [
    [-d, theme.colors.surface],
    [d, theme.colors.line],
  ] as const) {
    ctx.save();
    ctx.translate(dx, dx);
    ctx.strokeStyle = color;
    ctx.beginPath();
    path();
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

const RIM_INSET = 3;

function paintRimLine(ctx: CanvasRenderingContext2D, theme: Theme, rect: Rect): void {
  if (rect.w <= RIM_INSET * 2 || rect.h <= RIM_INSET * 2) return;
  ctx.save();
  ctx.strokeStyle = theme.colors.accent2;
  ctx.lineWidth = theme.strokes.min;
  ctx.beginPath();
  ctx.rect(rect.x + RIM_INSET, rect.y + RIM_INSET, rect.w - RIM_INSET * 2, rect.h - RIM_INSET * 2);
  ctx.stroke();
  ctx.restore();
}

const BRACKET = 5;

function paintCornerBrackets(ctx: CanvasRenderingContext2D, theme: Theme, rect: Rect): void {
  const { x, y, w, h } = rect;
  if (w < BRACKET * 3 || h < BRACKET * 3) return;
  ctx.save();
  ctx.strokeStyle = theme.colors.accent2;
  ctx.lineWidth = theme.strokes.min;
  ctx.beginPath();
  for (const [cx, sx] of [
    [x, 1],
    [x + w, -1],
  ] as const)
    for (const [cy, sy] of [
      [y, 1],
      [y + h, -1],
    ] as const) {
      ctx.moveTo(cx + sx * BRACKET, cy);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx, cy + sy * BRACKET);
    }
  ctx.stroke();
  ctx.restore();
}

/** Builds a rect path with the theme's corner treatment. Bounds are unchanged
 *  either way -- only the drawn outline differs. */
export function bodyRectPath(ctx: CanvasRenderingContext2D, theme: Theme, rect: Rect): void {
  const { x, y, w, h } = rect;
  const cut = Math.min(6, w / 4, h / 4);
  if (theme.glyph.boxCorner === 'sharp' || cut <= 0) {
    ctx.rect(x, y, w, h);
    return;
  }
  if (theme.glyph.boxCorner === 'clip') {
    ctx.moveTo(x + cut, y);
    ctx.lineTo(x + w - cut, y);
    ctx.lineTo(x + w, y + cut);
    ctx.lineTo(x + w, y + h - cut);
    ctx.lineTo(x + w - cut, y + h);
    ctx.lineTo(x + cut, y + h);
    ctx.lineTo(x, y + h - cut);
    ctx.lineTo(x, y + cut);
    ctx.closePath();
    return;
  }
  if (theme.glyph.boxCorner === 'shard') {
    // Two opposite corners only: the body reads as a cut crystal rather than
    // the symmetric octagon a full clip produces.
    ctx.moveTo(x + cut, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y + h - cut);
    ctx.lineTo(x + w - cut, y + h);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x, y + cut);
    ctx.closePath();
    return;
  }
  // 'stair': the clip, quantised into two visible steps per corner.
  const s = cut / 2;
  ctx.moveTo(x + cut, y);
  ctx.lineTo(x + w - cut, y);
  ctx.lineTo(x + w - s, y);
  ctx.lineTo(x + w - s, y + s);
  ctx.lineTo(x + w, y + s);
  ctx.lineTo(x + w, y + h - s);
  ctx.lineTo(x + w - s, y + h - s);
  ctx.lineTo(x + w - s, y + h);
  ctx.lineTo(x + cut, y + h);
  ctx.lineTo(x + s, y + h);
  ctx.lineTo(x + s, y + h - s);
  ctx.lineTo(x, y + h - s);
  ctx.lineTo(x, y + s);
  ctx.lineTo(x + s, y + s);
  ctx.lineTo(x + s, y);
  ctx.closePath();
}

/**
 * Emphasis for an asserted signal.
 *
 * 'halo' is a second wider low-alpha stroke of the same path, about two
 * strokes, safe anywhere, including per-frame on wires.
 *
 * 'bloom' is real `shadowBlur`, and it is what actually reads as light: a halo
 * on a pale ground is nearly invisible, which is why the light character themes
 * looked flat. It is affordable here because lit glyphs are rasterised into the
 * glyph cache once per state, so the blur is paid on a state change rather than
 * every frame. Callers that draw per-frame (wires) pass allowBloom: false and
 * degrade to a halo, and it is dropped entirely below full LOD.
 */
export function paintEmphasis(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  color: string,
  path: () => void,
  allowBloom = true,
): void {
  const mode = theme.glyph.emphasis;
  const lod = theme.lod;
  if (mode === 'none' || lod === 'flat') return;
  const bloom = mode === 'bloom' && allowBloom && showsBloom(lod);

  ctx.save();
  if (bloom) {
    // Two passes: a tight bright core and a wide soft spill, both filled so
    // the light comes off the body rather than tracing its outline.
    ctx.shadowColor = color;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.9;
    ctx.shadowBlur = 6;
    ctx.beginPath();
    path();
    ctx.fill();
    ctx.globalAlpha = 0.55;
    ctx.shadowBlur = 16;
    ctx.fill();
  } else {
    ctx.globalAlpha = 0.25;
    ctx.strokeStyle = color;
    ctx.lineWidth = ctx.lineWidth * 3;
    ctx.beginPath();
    path();
    ctx.stroke();
  }
  ctx.restore();
}

const patterns = new Map<string, CanvasPattern | null>();

/** One CanvasPattern per theme, built on first use and reused every frame. */
export function bodyPattern(ctx: CanvasRenderingContext2D, theme: Theme): CanvasPattern | null {
  const key = `${theme.name}|${theme.glyph.bodyPattern}`;
  const cached = patterns.get(key);
  if (cached !== undefined) return cached;
  const built = buildPattern(ctx, theme);
  patterns.set(key, built);
  return built;
}

export function clearPatternCache(): void {
  patterns.clear();
}

function buildPattern(ctx: CanvasRenderingContext2D, theme: Theme): CanvasPattern | null {
  if (typeof document === 'undefined') return null;
  const tile = document.createElement('canvas');
  tile.width = PATTERN_TILE;
  tile.height = PATTERN_TILE;
  const c = tile.getContext('2d');
  if (!c) return null;
  c.strokeStyle = theme.colors.ink;
  c.lineWidth = 1;
  const n = PATTERN_TILE;
  c.beginPath();
  if (theme.glyph.bodyPattern === 'hatch') {
    c.moveTo(0, n);
    c.lineTo(n, 0);
  } else if (theme.glyph.bodyPattern === 'facet') {
    c.moveTo(0, n);
    c.lineTo(n, 0);
    c.moveTo(n / 2, n);
    c.lineTo(n, n / 2);
    c.moveTo(0, n / 2);
    c.lineTo(n / 2, 0);
  } else {
    // 'pixel': filled voxel cells, each in one of the theme's own hues, so a
    // multi-coloured glitch field and a single-hue voxel field both fall out
    // of the same code -- it follows whatever the theme's accents are.
    const cell = n / 4;
    const hues = [
      theme.colors.ink,
      theme.colors.accent,
      theme.colors.accent2,
      theme.colors.accent3,
    ];
    (
      [
        [0, 0],
        [2, 1],
        [1, 2],
        [3, 3],
      ] as const
    ).forEach(([cx, cy], i) => {
      c.fillStyle = hues[i % hues.length] as string;
      c.fillRect(cx * cell, cy * cell, cell, cell);
    });
    return ctx.createPattern(tile, 'repeat');
  }
  c.stroke();
  return ctx.createPattern(tile, 'repeat');
}
