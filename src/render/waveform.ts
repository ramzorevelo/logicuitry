// Time-domain waveform instrument (separate from plotXY by design): pure
// layout metrics -> rects/projections, pure draw over the layout. Digital
// tracks speak the signalStyle color language; t_cd->t_pd uncertainty renders
// as a cross-hatched eye; annotations are generic data records so future
// lessons (setup/hold apertures, skew hatching) need zero renderer changes.

import type { Rect } from './scene';
import { oneLine } from './glyphs/symbol';
import type { Theme } from './theme';
import { signalStyle, type SignalState } from './theme';
import type { CauseArrow, GlitchMarker, Segment, Track } from '../core/timing/traceView';

export interface WaveformMetrics {
  rowH: number;
  rowGap: number;
  /** Left column for track labels and cursor readouts (JetBrains Mono). */
  labelW: number;
  axisH: number;
  /** Vertical inset from row edge to the logic-high/low levels. */
  levelPad: number;
  /** Headroom above the first row so its annotation strip ("glitch") fits. */
  topPad: number;
  /** Minimum px between time ticks; a theme's grid density scales it. */
  tickSpacing: number;
}

export const defaultWaveformMetrics: WaveformMetrics = {
  rowH: 34,
  rowGap: 8,
  labelW: 120,
  // Tick labels sit at +6; the cursor timestamp draws a line below at +18 and
  // needs its full text height inside the band.
  axisH: 32,
  levelPad: 7,
  topPad: 14,
  tickSpacing: 90,
};

export interface WaveformWindow {
  t0: number;
  t1: number;
}

export interface WaveformRow {
  track: Track;
  rect: Rect;
  high: number;
  low: number;
  mid: number;
}

export interface WaveformLayout {
  metrics: WaveformMetrics;
  window: WaveformWindow;
  rows: WaveformRow[];
  /** Plot area right of the label column, above the axis. */
  plot: Rect;
  ticks: { t: number; x: number; label: string }[];
  width: number;
  height: number;
  timeToX(t: number): number;
  xToTime(x: number): number;
}

/** Generic annotation record (binding forward-compat contract; data, not code). */
export interface WaveAnnotation {
  kind: 'interval' | 'window' | 'marker' | 'band';
  /** Scope to one track; omitted = full plot height. */
  trackPath?: string;
  t0: number;
  t1?: number;
  label?: string;
  style?: 'accent' | 'warn' | 'ok' | 'muted';
}

export interface WaveformDrawOpts {
  cursor?: number | null;
  /** Per-path value string shown beside the label while the cursor is set. */
  cursorValues?: ReadonlyMap<string, string> | null;
  annotations?: readonly WaveAnnotation[];
  glitches?: readonly GlitchMarker[];
  /** Fig 2.69 causality arcs; drawn only between rows present in the layout. */
  arrows?: readonly CauseArrow[];
  /** Track highlighted from a schematic wire hover (and vice versa). */
  hoverPath?: string | null;
  /** Rows to highlight together, e.g. every lane of a group under a
   *  hovered chevron -- same visual treatment as hoverPath, just multiple. */
  highlightPaths?: ReadonlySet<string> | undefined;
  showBands?: boolean;
  /** Paths of width>1 tracks currently expanded into per-bit lane rows
   *  (Task 5 chevron); drives the collapse-control glyph on a lane-0 row. */
  expandedTracks?: ReadonlySet<string>;
}

/** Lane-row path separator (expandTrackByBit): 'name#bit'. */
const LANE_SEP = '#';

/** The bus track's own path, if `path` is one of its derived lane rows. */
export function laneOriginPath(path: string): string | null {
  const i = path.lastIndexOf(LANE_SEP);
  if (i < 0) return null;
  const bit = path.slice(i + 1);
  return /^\d+$/.test(bit) ? path.slice(0, i) : null;
}

export function isLaneZeroPath(path: string): boolean {
  return path.endsWith(`${LANE_SEP}0`);
}

/** Row order-sort key for the waveform panel's drag-reorderable rows,
 *  including a chevron-expanded track's derived lane rows. A real (parent)
 *  track keeps the plain rule: its own `trackOrder` position, else board
 *  order appended after every explicitly-ordered one. A lane row inherits
 *  its PARENT's key plus a small bit-indexed tiebreak, so expanding a track
 *  the user already dragged elsewhere splices its lanes in at THAT
 *  position instead of resetting to board order -- unless the lane itself
 *  was separately dragged, which always wins via its own direct
 *  `trackOrder` entry. */
export function waveformOrderKey(
  path: string,
  boardOrder: readonly string[],
  trackOrder: readonly string[],
): number {
  const idx = new Map(trackOrder.map((p, i) => [p, i]));
  const direct = idx.get(path);
  if (direct !== undefined) return direct;
  const origin = laneOriginPath(path);
  if (origin) {
    const originIdx = boardOrder.indexOf(origin);
    const originKey = idx.get(origin) ?? trackOrder.length + Math.max(0, originIdx);
    const bit = Number(path.slice(path.lastIndexOf(LANE_SEP) + 1));
    // +1-based: the origin's own "folder" row always sorts at originKey
    // itself (offset 0), strictly before every one of its lane children.
    return originKey + ((Number.isFinite(bit) ? bit : 0) + 1) / 1000;
  }
  const boardIdx = boardOrder.indexOf(path);
  return trackOrder.length + Math.max(0, boardIdx);
}

/** Chevron hit/draw rect, in the row's own label gutter -- same geometry
 *  drawWaveform uses to draw it, so a caller's hit-test never drifts from
 *  what's on screen. */
export function chevronRect(rowRect: Rect): Rect {
  const size = 10;
  return { x: 4, y: rowRect.y + rowRect.h / 2 - size / 2, w: size, h: size };
}

function drawChevron(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  r: Rect,
  expanded: boolean,
): void {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  ctx.fillStyle = theme.wave.muted;
  ctx.beginPath();
  if (expanded) {
    // pointing down: reveals the lane rows already beneath it
    ctx.moveTo(r.x, cy - r.h * 0.2);
    ctx.lineTo(r.x + r.w, cy - r.h * 0.2);
    ctx.lineTo(cx, cy + r.h * 0.35);
  } else {
    // pointing right: collapsed, click to expand
    ctx.moveTo(cx - r.w * 0.2, r.y);
    ctx.lineTo(cx - r.w * 0.2, r.y + r.h);
    ctx.lineTo(cx + r.w * 0.35, cy);
  }
  ctx.closePath();
  ctx.fill();
}

/** '1200 ps' / '1.2 ns' / '3 us' style, trimming trailing zeros. */
export function formatTimePs(ps: number): string {
  const abs = Math.abs(ps);
  const fmt = (v: number, unit: string) => {
    const s = v.toFixed(2).replace(/\.?0+$/, '');
    return `${s} ${unit}`;
  };
  if (abs < 1_000) return `${ps} ps`;
  if (abs < 1_000_000) return fmt(ps / 1_000, 'ns');
  return fmt(ps / 1_000_000, 'us');
}

/** Largest 1/2/5 x 10^k step giving at most maxTicks ticks over span. */
export function tickStepPs(spanPs: number, maxTicks: number): number {
  if (spanPs <= 0) return 1;
  const raw = spanPs / Math.max(1, maxTicks);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (mag * m >= raw) return Math.max(1, Math.round(mag * m));
  return Math.max(1, Math.round(mag * 10));
}

export function layoutWaveform(
  tracks: readonly Track[],
  window: WaveformWindow,
  width: number,
  metrics: WaveformMetrics = defaultWaveformMetrics,
): WaveformLayout {
  const { rowH, rowGap, labelW, axisH, levelPad, topPad, tickSpacing } = metrics;
  const plotX = labelW;
  const plotW = Math.max(1, width - labelW);
  const span = Math.max(1, window.t1 - window.t0);
  const timeToX = (t: number) => plotX + ((t - window.t0) / span) * plotW;
  const xToTime = (x: number) => window.t0 + ((x - plotX) / plotW) * span;

  const rows: WaveformRow[] = tracks.map((track, i) => {
    const y = topPad + i * (rowH + rowGap);
    return {
      track,
      rect: { x: plotX, y, w: plotW, h: rowH },
      high: y + levelPad,
      low: y + rowH - levelPad,
      mid: y + rowH / 2,
    };
  });
  const rowsH = rows.length ? rows.length * (rowH + rowGap) - rowGap : 0;
  const plot: Rect = { x: plotX, y: topPad, w: plotW, h: rowsH };

  const step = tickStepPs(span, Math.max(2, Math.floor(plotW / tickSpacing)));
  const ticks: WaveformLayout['ticks'] = [];
  for (let t = Math.ceil(window.t0 / step) * step; t <= window.t1; t += step)
    ticks.push({ t, x: timeToX(t), label: formatTimePs(t) });

  return {
    metrics,
    window,
    rows,
    plot,
    ticks,
    width,
    height: topPad + rowsH + axisH,
    timeToX,
    xToTime,
  };
}

function stateOf(seg: Segment, width: number): SignalState {
  if (width > 1) return seg.mixed ? 'X' : '1';
  if (seg.value.z & 1) return 'Z';
  if (seg.value.x & 1) return 'X';
  return seg.value.v & 1 ? '1' : '0';
}

function hatch(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: string,
  lineWidth: number,
  gap = 5,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, x1 - x0, y1 - y0);
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  const h = y1 - y0;
  for (let x = x0 - h; x < x1; x += gap) {
    ctx.moveTo(x, y1);
    ctx.lineTo(x + h, y0);
  }
  ctx.stroke();
  ctx.restore();
}

function annColor(theme: Theme, style: WaveAnnotation['style']): string {
  switch (style) {
    case 'warn':
      return theme.colors.warn;
    case 'ok':
      return theme.colors.ok;
    case 'muted':
      return theme.wave.muted;
    default:
      return theme.colors.accent;
  }
}

/** Transition slant into a segment, possibly truncated (runt, see below). */
interface EdgeRamp {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  runt: boolean;
}

function drawDigitalRow(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  layout: WaveformLayout,
  row: WaveformRow,
): void {
  const { timeToX } = layout;
  // Datasheet-mode transitions slope over the driver's t_cd -> t_pd window
  // (the same span the eye bands carry); ideal mode has no bands -> vertical.
  const slantStart = new Map<number, number>();
  for (const band of row.track.bands) slantStart.set(band.t, band.earliest);
  const segs = row.track.segments;
  const states = segs.map((s) => stateOf(s, row.track.width));
  const yOf = (state: SignalState) => (state === '1' ? row.high : row.low);

  // Pass 1: the ramp into each segment whose level differs from a known
  // predecessor. Sub-2px slants degrade to vertical.
  const ramps = new Map<number, EdgeRamp>();
  for (let i = 1; i < segs.length; i++) {
    const a = states[i - 1]!;
    const b = states[i]!;
    if ((a !== '0' && a !== '1') || (b !== '0' && b !== '1') || a === b) continue;
    const x1 = Math.max(row.rect.x, timeToX(segs[i]!.t0));
    let x0 = x1;
    const earliest = slantStart.get(segs[i]!.t0);
    if (earliest !== undefined) {
      const xe = Math.max(row.rect.x, timeToX(earliest));
      if (x1 - xe >= 2) x0 = xe;
    }
    ramps.set(i, { x0, y0: yOf(a), x1, y1: yOf(b), runt: false });
  }
  // Pass 2: a pulse narrower than the delay spread makes consecutive ramps
  // overlap. One net cannot fall and rise at once, so instead of drawing a
  // crossed X the signal turns around mid-swing where the slants intersect --
  // a runt pulse that never reaches the rail.
  for (let i = 1; i < segs.length; i++) {
    const fall = ramps.get(i);
    const rise = ramps.get(i + 1);
    if (!fall || !rise || rise.x0 >= fall.x1) continue;
    const d1x = fall.x1 - fall.x0;
    const d1y = fall.y1 - fall.y0;
    const d2x = rise.x1 - rise.x0;
    const d2y = rise.y1 - rise.y0;
    const den = d1x * d2y - d1y * d2x;
    let ix = fall.x1;
    let iy = fall.y1;
    if (den !== 0) {
      const t = ((rise.x0 - fall.x0) * d2y - (rise.y0 - fall.y0) * d2x) / den;
      const tc = Math.max(0, Math.min(1, t));
      ix = fall.x0 + tc * d1x;
      iy = fall.y0 + tc * d1y;
    }
    fall.x1 = ix;
    fall.y1 = iy;
    fall.runt = true;
    rise.x0 = ix;
    rise.y0 = iy;
  }

  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    const x0 = Math.max(row.rect.x, timeToX(seg.t0));
    let x1 = Math.min(row.rect.x + row.rect.w, timeToX(seg.t1));
    if (x1 < x0) continue;
    const state = states[i]!;
    const style = signalStyle(theme, state);
    // A theme may give the instrument its own logic-1 ink; every other state
    // keeps the shared signal language.
    if (state === '1') style.color = theme.wave.traceHigh;
    ctx.strokeStyle = style.color;
    ctx.lineWidth = theme.strokes.wire * theme.wave.traceWeight;
    ctx.setLineDash(style.dashed ? [4, 3] : []);

    if (state === 'X') {
      // Warn mid-band: unknown occupies the whole eye between levels.
      ctx.save();
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = style.color;
      ctx.fillRect(x0, row.high, x1 - x0, row.low - row.high);
      ctx.restore();
      ctx.beginPath();
      ctx.moveTo(x0, row.high);
      ctx.lineTo(x1, row.high);
      ctx.moveTo(x0, row.low);
      ctx.lineTo(x1, row.low);
      ctx.stroke();
    } else if (state === 'Z') {
      ctx.beginPath();
      ctx.moveTo(x0, row.mid);
      ctx.lineTo(x1, row.mid);
      ctx.stroke();
    } else {
      const y = yOf(state);
      const ramp = ramps.get(i);
      // Fill-under-high: a solid block reads as "high" from the back of a
      // lecture hall far better than a 2px line does.
      if (state === '1' && theme.wave.fillUnderHigh) {
        ctx.save();
        ctx.globalAlpha = 0.16;
        ctx.fillStyle = style.color;
        ctx.fillRect(x0, row.high, x1 - x0, row.low - row.high);
        ctx.restore();
      }
      ctx.beginPath();
      if (ramp) {
        ctx.moveTo(ramp.x0, ramp.y0);
        ctx.lineTo(ramp.x1, ramp.y1);
      }
      // A runt never reaches its level: no flat run. Otherwise the flat is
      // clipped where the next edge's ramp departs.
      if (!ramp?.runt) {
        const next = ramps.get(i + 1);
        if (next) x1 = Math.max(x0, Math.min(x1, next.x0));
        ctx.moveTo(x0, y);
        ctx.lineTo(x1, y);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }
}

function drawBusRow(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  layout: WaveformLayout,
  row: WaveformRow,
): void {
  const { timeToX } = layout;
  const chev = Math.min(6, (row.low - row.high) / 2);
  ctx.lineWidth = theme.strokes.bus;
  ctx.font = `${Math.max(theme.canvasTextMin, 12)}px ${theme.fonts.mono}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const seg of row.track.segments) {
    const x0 = Math.max(row.rect.x, timeToX(seg.t0));
    const x1 = Math.min(row.rect.x + row.rect.w, timeToX(seg.t1));
    if (x1 - x0 < 1) continue;
    const color = seg.mixed ? theme.colors.warn : theme.wave.ink;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(x0, row.mid);
    ctx.lineTo(x0 + chev, row.high);
    ctx.lineTo(x1 - chev, row.high);
    ctx.lineTo(x1, row.mid);
    ctx.lineTo(x1 - chev, row.low);
    ctx.lineTo(x0 + chev, row.low);
    ctx.closePath();
    ctx.stroke();
    if (seg.mixed) hatch(ctx, x0 + chev, row.high, x1 - chev, row.low, color, theme.strokes.min);
    else if (x1 - x0 > 24) {
      ctx.fillStyle = theme.wave.ink;
      ctx.fillText(seg.label, (x0 + x1) / 2, row.mid);
    }
  }
}

function drawBands(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  layout: WaveformLayout,
  row: WaveformRow,
): void {
  for (const band of row.track.bands) {
    const x0 = Math.max(row.rect.x, layout.timeToX(band.earliest));
    const x1 = Math.min(row.rect.x + row.rect.w, layout.timeToX(band.t));
    if (x1 - x0 < 1) continue;
    // Estimated t_cd hatches lighter; the panel footnote carries the caveat.
    ctx.save();
    ctx.globalAlpha = band.estimated ? 0.35 : 0.6;
    hatch(ctx, x0, row.high, x1, row.low, theme.wave.muted, theme.strokes.min);
    ctx.restore();
  }
}

function drawGlitch(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  layout: WaveformLayout,
  row: WaveformRow,
  g: GlitchMarker,
): void {
  // The pulse's visual extent starts where its falling slant departs (the
  // band's earliest), not at the record time the fall completes -- otherwise
  // the ellipse hugs only the rising edge of the h-l-h shape.
  const inBand = row.track.bands.find((b) => b.t === g.t0);
  const x0 = layout.timeToX(inBand ? inBand.earliest : g.t0);
  const x1 = layout.timeToX(g.t1);
  const cx = (x0 + x1) / 2;
  const rx = Math.max(10, (x1 - x0) / 2 + 6);
  const ry = (row.low - row.high) / 2 + 5;
  ctx.save();
  ctx.strokeStyle = theme.colors.warn;
  ctx.lineWidth = theme.strokes.min;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.ellipse(cx, row.mid, rx, ry, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = theme.colors.warn;
  ctx.font = `${theme.canvasTextMin}px ${theme.fonts.ui}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText('glitch', cx, row.rect.y - 1 + layout.metrics.rowGap);
  ctx.restore();
}

/** X of an edge's visual anchor: mid-slant when the edge draws as a ramp
 * (same EdgeBand span + >=2px degrade rule as drawDigitalRow), else the edge. */
function edgeAnchorX(layout: WaveformLayout, row: WaveformRow, t: number): number {
  const x = layout.timeToX(t);
  const band = row.track.bands.find((b) => b.t === t);
  if (!band) return x;
  const xe = Math.max(row.rect.x, layout.timeToX(band.earliest));
  return x - xe >= 2 ? (x + xe) / 2 : x;
}

/** Fig 2.69 causality arc: S-curve anchored on the edges' slant midpoints,
 * solid filled arrowhead at the target end only. */
function drawCauseArrow(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  layout: WaveformLayout,
  a: CauseArrow,
): void {
  const from = layout.rows.find((r) => r.track.path === a.fromPath);
  const to = layout.rows.find((r) => r.track.path === a.toPath);
  if (!from || !to) return;
  const x0 = edgeAnchorX(layout, from, a.fromT);
  const x1 = edgeAnchorX(layout, to, a.toT);
  const plotR = layout.plot.x + layout.plot.w;
  if (x1 < layout.plot.x || x0 > plotR) return;
  const y0 = from.mid;
  const y1 = to.mid;
  const dy = y1 - y0;
  // Book shape (Figs 2.67/3.15/3.17) is a true S: leave the source heading
  // forward, cross back over the chord, then hook forward into the target --
  // control points sit on opposite sides of the chord.
  const s = Math.min(48, Math.max(14, Math.abs(dy) * 0.4));
  const c1x = x0 + s;
  const c1y = y0 + dy * 0.15;
  const c2x = x1 - s;
  const c2y = y1 - dy * 0.15;
  ctx.save();
  ctx.beginPath();
  ctx.rect(layout.plot.x, 0, layout.plot.w, layout.plot.y + layout.plot.h);
  ctx.clip();
  ctx.strokeStyle = theme.colors.accent;
  ctx.fillStyle = theme.colors.accent;
  ctx.lineWidth = theme.strokes.min * 1.5;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.bezierCurveTo(c1x, c1y, c2x, c2y, x1, y1);
  ctx.stroke();
  // Arrowhead along the curve's arrival tangent (c2 -> end).
  const ang = Math.atan2(y1 - c2y, x1 - c2x);
  const head = 11;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - head * Math.cos(ang - 0.42), y1 - head * Math.sin(ang - 0.42));
  ctx.lineTo(x1 - head * Math.cos(ang + 0.42), y1 - head * Math.sin(ang + 0.42));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function annotationSpan(layout: WaveformLayout, a: WaveAnnotation): { y0: number; y1: number } {
  if (a.trackPath) {
    const row = layout.rows.find((r) => r.track.path === a.trackPath);
    if (row) return { y0: row.rect.y, y1: row.rect.y + row.rect.h };
  }
  return { y0: layout.plot.y, y1: layout.plot.y + layout.plot.h };
}

function drawAnnotation(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  layout: WaveformLayout,
  a: WaveAnnotation,
): void {
  const color = annColor(theme, a.style);
  const { y0, y1 } = annotationSpan(layout, a);
  const x0 = layout.timeToX(a.t0);
  const x1 = a.t1 !== undefined ? layout.timeToX(a.t1) : x0;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = theme.strokes.min;
  ctx.font = `${theme.canvasTextMin}px ${theme.fonts.mono}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';

  if (a.kind === 'window' || a.kind === 'band') {
    ctx.globalAlpha = 0.16;
    ctx.fillRect(x0, y0, Math.max(1, x1 - x0), y1 - y0);
    ctx.globalAlpha = 1;
    ctx.strokeRect(x0, y0, Math.max(1, x1 - x0), y1 - y0);
    if (a.label) ctx.fillText(a.label, (x0 + x1) / 2, y0 - 2);
  } else if (a.kind === 'interval') {
    const y = y0 + 8;
    const head = 5;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0, y1);
    ctx.moveTo(x1, y0);
    ctx.lineTo(x1, y1);
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.moveTo(x0 + head, y - head * 0.7);
    ctx.lineTo(x0, y);
    ctx.lineTo(x0 + head, y + head * 0.7);
    ctx.moveTo(x1 - head, y - head * 0.7);
    ctx.lineTo(x1, y);
    ctx.lineTo(x1 - head, y + head * 0.7);
    ctx.stroke();
    const label = a.label ?? `Δt = ${formatTimePs(Math.abs((a.t1 ?? a.t0) - a.t0))}`;
    ctx.fillText(label, (x0 + x1) / 2, y - 3);
  } else {
    // marker: a single instant, drawn at wire weight rather than the hairline
    // the spans use. Its whole job is to be found again -- it marks the edge a
    // pending measure is anchored to, with nothing yet to pair it against.
    ctx.lineWidth = theme.strokes.wire;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0, y1);
    ctx.stroke();
    if (a.label) ctx.fillText(a.label, x0, y0 - 2);
  }
  ctx.restore();
}

export function drawWaveform(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  layout: WaveformLayout,
  opts: WaveformDrawOpts = {},
): void {
  ctx.clearRect(0, 0, layout.width, layout.height);
  ctx.fillStyle = theme.wave.surface;
  ctx.fillRect(0, 0, layout.width, layout.height);

  // Time grid + axis. Instrument ruling is the theme's structural colour, not
  // the plain line colour: a themed frame is chrome, and it must never be
  // mistaken for a signal, which is why accent2 and never accent.
  ctx.strokeStyle = theme.colors.accent2;
  ctx.globalAlpha = 0.45;
  ctx.lineWidth = theme.strokes.min;
  ctx.beginPath();
  for (const tick of layout.ticks) {
    ctx.moveTo(tick.x, layout.plot.y);
    ctx.lineTo(tick.x, layout.plot.y + layout.plot.h);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = theme.colors.accent2;
  ctx.font = `${theme.canvasTextMin}px ${theme.fonts.mono}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const tick of layout.ticks)
    ctx.fillText(tick.label, tick.x, layout.plot.y + layout.plot.h + 6);

  for (const row of layout.rows) {
    const hovered =
      (opts.hoverPath != null && row.track.path === opts.hoverPath) ||
      !!opts.highlightPaths?.has(row.track.path);
    if (hovered) {
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = theme.colors.accentFill;
      ctx.fillRect(0, row.rect.y, layout.width, row.rect.h);
      ctx.restore();
    }
    // Chevron: the "folder" row (the origin's own width>1 track, which
    // always stays rendered per expandedList) owns it, open or closed
    // depending on group expand state -- a lane child row just reserves the
    // same gutter width for label alignment, no chevron of its own.
    const laneOrigin = laneOriginPath(row.track.path);
    let labelX = 8;
    if (row.track.width > 1) {
      const r = chevronRect(row.rect);
      drawChevron(ctx, theme, r, !!opts.expandedTracks?.has(row.track.path));
      labelX = r.x + r.w + 4;
    } else if (laneOrigin) {
      const r = chevronRect(row.rect);
      labelX = r.x + r.w + 4;
    }

    // Label (+ cursor readout).
    ctx.fillStyle = hovered ? theme.colors.accent : theme.wave.ink;
    ctx.font = `${Math.max(theme.canvasTextMin, 12)}px ${theme.fonts.mono}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(oneLine(row.track.label), labelX, row.mid, layout.metrics.labelW - (labelX + 8));
    const readout = opts.cursorValues?.get(row.track.path);
    if (readout) {
      ctx.fillStyle = theme.colors.accent;
      ctx.textAlign = 'right';
      ctx.fillText(readout, layout.metrics.labelW - 6, row.mid);
    }

    if (opts.showBands !== false) drawBands(ctx, theme, layout, row);
    if (row.track.width > 1) drawBusRow(ctx, theme, layout, row);
    else drawDigitalRow(ctx, theme, layout, row);
    for (const g of opts.glitches ?? [])
      if (g.trackPath === row.track.path) drawGlitch(ctx, theme, layout, row, g);
  }

  for (const a of opts.arrows ?? []) drawCauseArrow(ctx, theme, layout, a);

  for (const a of opts.annotations ?? []) drawAnnotation(ctx, theme, layout, a);

  if (opts.cursor != null) {
    const x = layout.timeToX(opts.cursor);
    ctx.strokeStyle = theme.colors.accent;
    ctx.lineWidth = theme.strokes.min * 1.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, layout.plot.y + layout.plot.h);
    ctx.stroke();
    ctx.fillStyle = theme.colors.accent;
    ctx.font = `${theme.canvasTextMin}px ${theme.fonts.mono}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(formatTimePs(opts.cursor), x, layout.plot.y + layout.plot.h + 6 + 12);
  }
}
