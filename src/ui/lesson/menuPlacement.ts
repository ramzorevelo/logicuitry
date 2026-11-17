export type MenuPlacement = 'down' | 'up' | 'scroll';

/** Below when it fits, above when only that fits, else stay below and scroll it into view. */
export function placeMenu(
  spaceBelow: number,
  spaceAbove: number,
  menuHeight: number,
): MenuPlacement {
  if (menuHeight <= spaceBelow) return 'down';
  if (menuHeight <= spaceAbove) return 'up';
  return 'scroll';
}

/** Nearest ancestor that clips by scrolling, or null for the viewport. */
export function scrollParentOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'hidden') return p;
  }
  return null;
}
