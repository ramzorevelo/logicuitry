// Plots were drawn at a fixed size, so a 560px one on a 360px phone had to be
// panned to be read at all.
//
// This returns a BOX to fill and a SCALE to draw at, rather than a smaller size
// to lay out in. Figures here are composed at a design size with real spacing
// between labels; laying one out at 340px instead put those labels on top of
// each other. Drawing at the design size and scaling the whole figure keeps the
// composition exactly as drawn, only smaller.

import { useEffect, useRef, useState } from 'react';

/** Smallest plot still worth drawing axes on. */
const MIN_W = 200;
/** How far past its design size a plot may grow to fill a TV. */
const MAX_GROWTH = 2;
/** Room kept under a grown plot, so it does not end flush with the window. */
const BOTTOM_GAP = 16;

export function usePlotSize(designW: number, designH: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: designW, h: designH });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const avail = el.clientWidth;
      if (avail <= 0) return;
      const fit = Math.min(designW, avail);
      // Growing past the design size only takes room that is on screen, so a grown plot never
      // has to be scrolled to.
      const visibleH = window.innerHeight - el.getBoundingClientRect().top - BOTTOM_GAP;
      const grown = Math.min(designW * MAX_GROWTH, avail, (visibleH * designW) / designH);
      const w = Math.round(Math.max(MIN_W, fit, grown));
      const h = Math.round(w * (designH / designW));
      setBox((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [designW, designH]);

  return { ref, box, scale: box.w / designW };
}
