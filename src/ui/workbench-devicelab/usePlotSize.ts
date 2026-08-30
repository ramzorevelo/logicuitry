// Plots were drawn at a fixed size, so a 560px one on a 360px phone had to be
// panned to be read at all. They now fit their container and keep the design
// aspect ratio, and never exceed the design size, so the desktop is unchanged.

import { useEffect, useRef, useState } from 'react';

/** Smallest plot still worth drawing axes on. */
const MIN_W = 200;

export function usePlotSize(designW: number, designH: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: designW, h: designH });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const avail = el.clientWidth;
      if (avail <= 0) return;
      const w = Math.max(MIN_W, Math.min(designW, Math.round(avail)));
      const h = Math.round(w * (designH / designW));
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [designW, designH]);

  return { ref, size };
}
