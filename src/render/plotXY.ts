// XY plot renderer for the Device Lab VTC (analog axes), kept separate from the
// time-domain waveform view. Draws axes, grid,
// one or more curves, shaded rectangles (noise margins), a vertical band (the
// forbidden zone), and labelled markers. Colours come from the caller so the
// plot speaks the shared signal language; text/axis colours come from the Theme.

import type { Rect } from './scene';
import type { Theme } from './theme';

export interface Axis {
  min: number;
  max: number;
  label: string;
  ticks?: number;
}

export interface Series {
  xs: number[];
  ys: number[];
  color: string;
  dashed?: boolean;
  widthPx?: number;
}

export interface ShadeRect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  color: string;
  alpha?: number;
}

export interface Band {
  x0: number;
  x1: number;
  color: string;
  alpha?: number;
}

export interface Marker {
  x: number;
  y: number;
  label: string;
}

export interface PlotSpec {
  size: { w: number; h: number };
  x: Axis;
  y: Axis;
  series: Series[];
  rects?: ShadeRect[];
  bands?: Band[];
  markers?: Marker[];
}

const MARGIN = { left: 44, right: 12, top: 12, bottom: 32 };

export interface Projection {
  area: Rect;
  x: (v: number) => number;
  y: (v: number) => number;
}

/** Map data coordinates into the inner plot rect (y inverted for screen). */
export function makeProjection(spec: PlotSpec): Projection {
  const area: Rect = {
    x: MARGIN.left,
    y: MARGIN.top,
    w: spec.size.w - MARGIN.left - MARGIN.right,
    h: spec.size.h - MARGIN.top - MARGIN.bottom,
  };
  const sx = area.w / (spec.x.max - spec.x.min || 1);
  const sy = area.h / (spec.y.max - spec.y.min || 1);
  return {
    area,
    x: (v) => area.x + (v - spec.x.min) * sx,
    y: (v) => area.y + area.h - (v - spec.y.min) * sy,
  };
}

export function drawPlot(ctx: CanvasRenderingContext2D, theme: Theme, spec: PlotSpec): void {
  const p = makeProjection(spec);
  const { area } = p;
  const ticks = spec.x.ticks ?? 5;

  ctx.clearRect(0, 0, spec.size.w, spec.size.h);

  // Grid + tick labels.
  ctx.strokeStyle = theme.colors.line;
  ctx.fillStyle = theme.colors.muted;
  ctx.lineWidth = theme.strokes.min;
  ctx.font = `${theme.canvasTextMin}px ${theme.fonts.mono}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let i = 0; i <= ticks; i++) {
    const vx = spec.x.min + ((spec.x.max - spec.x.min) * i) / ticks;
    const sx = p.x(vx);
    ctx.beginPath();
    ctx.moveTo(sx, area.y);
    ctx.lineTo(sx, area.y + area.h);
    ctx.stroke();
    ctx.fillText(vx.toFixed(1), sx, area.y + area.h + 4);
  }
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= ticks; i++) {
    const vy = spec.y.min + ((spec.y.max - spec.y.min) * i) / ticks;
    const sy = p.y(vy);
    ctx.beginPath();
    ctx.moveTo(area.x, sy);
    ctx.lineTo(area.x + area.w, sy);
    ctx.stroke();
    ctx.fillText(vy.toFixed(1), area.x - 4, sy);
  }

  // Forbidden-zone bands (behind everything).
  for (const b of spec.bands ?? []) {
    ctx.globalAlpha = b.alpha ?? 0.12;
    ctx.fillStyle = b.color;
    ctx.fillRect(p.x(b.x0), area.y, p.x(b.x1) - p.x(b.x0), area.h);
    ctx.globalAlpha = 1;
  }

  // Noise-margin rectangles.
  for (const r of spec.rects ?? []) {
    ctx.globalAlpha = r.alpha ?? 0.16;
    ctx.fillStyle = r.color;
    const x = p.x(Math.min(r.x0, r.x1));
    const y = p.y(Math.max(r.y0, r.y1));
    ctx.fillRect(x, y, Math.abs(p.x(r.x1) - p.x(r.x0)), Math.abs(p.y(r.y1) - p.y(r.y0)));
    ctx.globalAlpha = 1;
  }

  // Axis labels.
  ctx.fillStyle = theme.colors.ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(spec.x.label, area.x + area.w / 2, spec.size.h);
  ctx.save();
  ctx.translate(10, area.y + area.h / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textBaseline = 'top';
  ctx.fillText(spec.y.label, 0, 0);
  ctx.restore();

  // Curves.
  for (const s of spec.series) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = (s.widthPx ?? theme.strokes.wire) * (theme.presentation ? 1.4 : 1);
    ctx.setLineDash(s.dashed ? [5, 4] : []);
    ctx.beginPath();
    for (let i = 0; i < s.xs.length; i++) {
      const px = p.x(s.xs[i]!);
      const py = p.y(s.ys[i]!);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Markers with labels.
  for (const m of spec.markers ?? []) {
    const mx = p.x(m.x);
    const my = p.y(m.y);
    ctx.fillStyle = theme.colors.accent;
    ctx.beginPath();
    ctx.arc(mx, my, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = theme.colors.ink;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(m.label, mx + 5, my - 3);
  }
}
