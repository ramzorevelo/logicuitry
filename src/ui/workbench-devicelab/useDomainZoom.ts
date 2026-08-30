// Zoom and pan for a plot, expressed as a window over the DATA domain rather
// than a transform on the canvas. Redrawing at the new domain keeps the plot
// crisp at any magnification, where scaling the bitmap would blur it, and the
// axes go on telling the truth about what is on screen.

import { useCallback, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

export interface Domain {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** Deepest zoom, as a fraction of the full domain. Past this the axis labels
 *  repeat to two decimals and the view stops meaning anything. */
const MIN_SPAN = 0.05;

export function clampSpan(
  lo: number,
  hi: number,
  fullLo: number,
  fullHi: number,
): [number, number] {
  const full = fullHi - fullLo;
  const span = Math.min(Math.max(hi - lo, full * MIN_SPAN), full);
  const mid = (lo + hi) / 2;
  let a = mid - span / 2;
  if (a < fullLo) a = fullLo;
  if (a + span > fullHi) a = fullHi - span;
  return [a, a + span];
}

export function useDomainZoom(full: Domain) {
  const [view, setView] = useState<Domain | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<number | null>(null);

  const current = view ?? full;
  const fit = useCallback(() => setView(null), []);

  const pan = (dxPx: number, dyPx: number, boxW: number, boxH: number) => {
    setView((v) => {
      const c = v ?? full;
      const dx = (dxPx / boxW) * (c.x1 - c.x0);
      // Screen y grows downward and the value axis grows upward.
      const dy = (dyPx / boxH) * (c.y1 - c.y0);
      const [x0, x1] = clampSpan(c.x0 - dx, c.x1 - dx, full.x0, full.x1);
      const [y0, y1] = clampSpan(c.y0 + dy, c.y1 + dy, full.y0, full.y1);
      return { x0, x1, y0, y1 };
    });
  };

  const scaleAbout = (factor: number) => {
    setView((v) => {
      const c = v ?? full;
      const mx = (c.x0 + c.x1) / 2;
      const my = (c.y0 + c.y1) / 2;
      const hw = ((c.x1 - c.x0) / 2) * factor;
      const hh = ((c.y1 - c.y0) / 2) * factor;
      const [x0, x1] = clampSpan(mx - hw, mx + hw, full.x0, full.x1);
      const [y0, y1] = clampSpan(my - hh, my + hh, full.y0, full.y1);
      return { x0, x1, y0, y1 };
    });
  };

  const dist = () => {
    const [a, b] = [...pointers.current.values()];
    if (!a || !b) return null;
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) pinch.current = dist();
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const box = e.currentTarget.getBoundingClientRect();
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size >= 2) {
      const d = dist();
      if (d && pinch.current) {
        scaleAbout(pinch.current / d);
        pinch.current = d;
      }
      return;
    }
    pan(e.clientX - prev.x, e.clientY - prev.y, box.width, box.height);
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  };

  return {
    domain: current,
    zoomed: view !== null,
    fit,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
    },
  };
}
