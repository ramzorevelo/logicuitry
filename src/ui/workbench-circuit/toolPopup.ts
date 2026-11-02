import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { clampPopupToCanvas } from './paramEdit';

/**
 * Open state and placement for a toolbar button's popup menu. A press outside
 * the anchor, Esc or a resize closes it; the popup is placed once, in viewport
 * pixels, clamped to the window, so a rotation would otherwise strand it.
 */
export function useToolPopup() {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e.type === 'pointerdown' && anchorRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('keydown', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      window.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('keydown', dismiss, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [open]);
  useLayoutEffect(() => {
    const popup = popupRef.current;
    const anchor = anchorRef.current;
    if (!open || !popup || !anchor) return;
    const r = anchor.getBoundingClientRect();
    const { x, y } = clampPopupToCanvas(
      { compLeft: r.left, compTop: r.top, compRight: r.right, compBottom: r.bottom },
      { w: popup.offsetWidth, h: popup.offsetHeight },
      { w: window.innerWidth, h: window.innerHeight },
    );
    popup.style.left = `${x}px`;
    popup.style.top = `${y}px`;
  }, [open]);
  return { open, setOpen, anchorRef, popupRef };
}
