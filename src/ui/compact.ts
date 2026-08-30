// One breakpoint for the whole app. JS owns the threshold and stamps a class
// on the shell; CSS keys off that class rather than repeating a media query,
// so the layout and the behavioural differences can never disagree on where
// "phone" starts.

import { useEffect, useState } from 'react';

/** Widest viewport still treated as a phone. Tablets get the desktop shell. */
export const COMPACT_MAX_WIDTH = 767;

/** A phone on its side is WIDE and SHORT: 844x390 on a modern handset, which
 *  clears the width test comfortably while having less usable height than any
 *  desktop window. Width alone therefore hands a rotated phone the desktop
 *  shell, complete with a palette rail and a toolbar taller than the board.
 *  The height arm is qualified by a coarse pointer so a deliberately short
 *  desktop window keeps the desktop layout. */
export const COMPACT_MAX_HEIGHT = 540;

export const COMPACT_QUERY =
  `(max-width: ${COMPACT_MAX_WIDTH}px), ` +
  `(max-height: ${COMPACT_MAX_HEIGHT}px) and (pointer: coarse)`;

/** Which way up a compact shell is. Not a second breakpoint: the same phone
 *  rotated, whose layout problem is the opposite one. Portrait is short of
 *  width and stacks its chrome; landscape is short of height and has width to
 *  spare, so the chrome moves to the left and right edges instead. */
export const LANDSCAPE_QUERY = '(orientation: landscape)';

function matches(query: string): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.(query).matches;
}

function useMediaQuery(query: string): boolean {
  const [on, setOn] = useState(() => matches(query));
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setOn(mq.matches);
    mq.addEventListener('change', onChange);
    onChange();
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return on;
}

/** True while the viewport is phone-width. Re-renders on rotation and on the
 *  software keyboard resizing the window. */
export function useCompact(): boolean {
  return useMediaQuery(COMPACT_QUERY);
}

/** True while the viewport is wider than it is tall. Only meaningful together
 *  with useCompact: a desktop is landscape too, and wants none of this. */
export function useLandscape(): boolean {
  return useMediaQuery(LANDSCAPE_QUERY);
}
