// The touch stand-in for the hover tooltip.
//
// The compact toolbar is icons only, and `title` is a hover affordance: a
// finger cannot hover, so on a phone those names are unreachable. Holding a
// button raises its title instead, and the lift that follows is swallowed --
// reading a label must never also fire the action.
//
// One document-level listener rather than props on every button: the labels
// already exist as `title`, and threading a handler through four toolbars and
// two workbenches to say the same thing would be worse.

import { useEffect, useState } from 'react';
import { useCoarsePointer } from '../pointerKind';
import { LONG_PRESS_MS, TAP_SLOP } from '../workbench-circuit/touchGestures';

interface Tip {
  text: string;
  x: number;
  y: number;
}

/** Buttons that opt in. Palette items keep their own text labels and their own
 *  long press (which latches continuous placement), so they stay out. */
const SELECTOR = '.tool-btn[title]';

export function HoldTip() {
  const coarse = useCoarsePointer();
  const [tip, setTip] = useState<Tip | null>(null);

  useEffect(() => {
    if (!coarse) return;
    let timer = 0;
    let startX = 0;
    let startY = 0;
    let fired = false;
    let swallowClick = false;

    const cancel = () => window.clearTimeout(timer);

    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      const btn = (e.target as Element | null)?.closest?.(SELECTOR);
      if (!btn) return;
      startX = e.clientX;
      startY = e.clientY;
      fired = false;
      // A hold that ends without a click (the finger wandered off the button)
      // must not leave the swallow armed for someone else's tap.
      swallowClick = false;
      cancel();
      timer = window.setTimeout(() => {
        const r = btn.getBoundingClientRect();
        fired = true;
        swallowClick = true;
        // Centred on the button, but kept off both edges: the first and last
        // buttons of a toolbar are exactly where a centred tip would overhang.
        const x = Math.min(Math.max(r.left + r.width / 2, 72), window.innerWidth - 72);
        setTip({ text: btn.getAttribute('title') ?? '', x, y: r.bottom });
      }, LONG_PRESS_MS);
    };

    const onMove = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) > TAP_SLOP) cancel();
    };

    const onUp = () => {
      cancel();
      if (fired) setTip(null);
      fired = false;
    };

    // Capture, so the button's own handler never sees the lift that ended a
    // read. The flag is consumed once: a later real tap must still work.
    const onClick = (e: MouseEvent) => {
      if (!swallowClick) return;
      swallowClick = false;
      e.preventDefault();
      e.stopPropagation();
    };

    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('pointercancel', onUp, true);
    document.addEventListener('click', onClick, true);
    return () => {
      cancel();
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('pointerup', onUp, true);
      document.removeEventListener('pointercancel', onUp, true);
      document.removeEventListener('click', onClick, true);
    };
  }, [coarse]);

  if (!tip) return null;
  return (
    <div className="hold-tip" role="tooltip" style={{ left: `${tip.x}px`, top: `${tip.y}px` }}>
      {tip.text}
    </div>
  );
}
