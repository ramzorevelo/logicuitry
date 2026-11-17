// Where a piece of chrome is on screen right now. The tour points at elements
// other components own, which move on resize, rotation, the compact switch, a
// theme change or a panel opening, so the rect is re-read on all of them.

import { useEffect, useState } from 'react';

export interface TargetRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function visibleArea(r: DOMRect): number {
  const w = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
  const h = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
  return w > 0 && h > 0 ? w * h : 0;
}

/** The copy most on screen: a phone keeps the toolbar's power group scrolled out of view and
 *  shows a floating copy instead, and a hidden copy measures zero. */
function measure(selector: string | null): TargetRect | null {
  if (!selector) return null;
  let best: DOMRect | null = null;
  for (const el of document.querySelectorAll<HTMLElement>(selector)) {
    const r = el.getBoundingClientRect();
    if (visibleArea(r) > (best ? visibleArea(best) : 0)) best = r;
  }
  return best && { x: best.left, y: best.top, w: best.width, h: best.height };
}

const same = (a: TargetRect | null, b: TargetRect | null) =>
  a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);

/** Null while the target is not rendered: the caller skips or falls back. */
export function useTargetRect(selector: string | null): TargetRect | null {
  const [rect, setRect] = useState<TargetRect | null>(() => measure(selector));
  useEffect(() => {
    if (!selector) {
      setRect(null);
      return;
    }
    let frame = 0;
    // Coalesced to one read per frame: a running board mutates the DOM often.
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const next = measure(selector);
        setRect((prev) => (same(prev, next) ? prev : next));
      });
    };
    schedule();
    const resize = new ResizeObserver(schedule);
    resize.observe(document.body);
    const mutation = new MutationObserver(schedule);
    mutation.observe(document.body, { childList: true, subtree: true, attributes: true });
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutation.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
    };
  }, [selector]);
  return rect;
}
