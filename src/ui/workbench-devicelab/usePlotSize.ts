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

export function usePlotSize(designW: number, designH: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: designW, h: designH });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const avail = el.clientWidth;
      if (avail <= 0) return;
      const w = Math.max(MIN_W, Math.min(designW, Math.round(avail)));
      const h = Math.round(w * (designH / designW));
      setBox((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [designW, designH]);

  return { ref, box, scale: box.w / designW };
}
