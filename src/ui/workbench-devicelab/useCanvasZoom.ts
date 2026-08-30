// Magnifying the plot as a picture: the whole figure grows, axes and labels
// with it, and panning moves a window over the enlarged drawing.
//
// NOT a zoom of the plotted range. Narrowing the domain and redrawing shows a
// different chart, with axes reading 1.2..2.8V instead of 0..5V and the bands
// recomputed for a sub-range, which is not what magnifying a figure means.
//
// The scale goes into the canvas transform rather than onto the bitmap through
// CSS, so the plot is re-rasterised at the magnified size and stays sharp.

import { useCallback, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react';

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 6;

export interface Viewport {
  zoom: number;
  panX: number;
  panY: number;
}

export const FIT: Viewport = { zoom: 1, panX: 0, panY: 0 };

/** Keeps the drawing covering the window: pan runs from 0 to the overhang, so
 *  a magnified plot can never be dragged off its own edge into blank space. */
export function clampPan(v: Viewport, w: number, h: number): Viewport {
  const zoom = Math.min(Math.max(v.zoom, MIN_ZOOM), MAX_ZOOM);
  const maxX = w * (zoom - 1);
  const maxY = h * (zoom - 1);
  return {
    zoom,
    panX: Math.min(Math.max(v.panX, 0), maxX),
    panY: Math.min(Math.max(v.panY, 0), maxY),
  };
}

/** Rescales about a point in window coordinates, so whatever is under the
 *  fingers stays under them. */
export function zoomAbout(
  v: Viewport,
  factor: number,
  fx: number,
  fy: number,
  w: number,
  h: number,
) {
  const zoom = Math.min(Math.max(v.zoom * factor, MIN_ZOOM), MAX_ZOOM);
  const k = zoom / v.zoom;
  return clampPan({ zoom, panX: (v.panX + fx) * k - fx, panY: (v.panY + fy) * k - fy }, w, h);
}

export function useCanvasZoom(w: number, h: number) {
  const [view, setView] = useState<Viewport>(FIT);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<number | null>(null);

  const fit = useCallback(() => setView(FIT), []);

  const two = () => [...pointers.current.values()];
  const spread = () => {
    const [a, b] = two();
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : null;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) pinch.current = spread();
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const box = e.currentTarget.getBoundingClientRect();
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size >= 2) {
      const d = spread();
      if (d && pinch.current) {
        const [a, b] = two();
        const fx = a && b ? (a.x + b.x) / 2 - box.left : box.width / 2;
        const fy = a && b ? (a.y + b.y) / 2 - box.top : box.height / 2;
        setView((v) => zoomAbout(v, d / pinch.current!, fx, fy, w, h));
        pinch.current = d;
      }
      return;
    }
    // One finger drags the picture: moving right reveals what is to the left.
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    setView((v) => clampPan({ ...v, panX: v.panX - dx, panY: v.panY - dy }, w, h));
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  };

  // A wheel with no touchscreen to pinch with.
  const onWheel = (e: ReactWheelEvent<HTMLCanvasElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    setView((v) =>
      zoomAbout(v, e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - box.left, e.clientY - box.top, w, h),
    );
  };

  return {
    view,
    zoomed: view.zoom > MIN_ZOOM,
    fit,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onWheel,
    },
  };
}
