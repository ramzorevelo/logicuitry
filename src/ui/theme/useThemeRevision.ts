// Redraw signal for canvas chrome that is not already inside a workbench's own
// draw loop: bumps whenever the theme or presentation class changes.
//
// One observer for every subscriber, not one each. The palette mounts a canvas
// per component, and a MutationObserver on <html> per thumbnail is what made
// opening a group crawl.

import { useSyncExternalStore } from 'react';

let observer: MutationObserver | null = null;
const subscribers = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  subscribers.add(onChange);
  if (!observer) {
    observer = new MutationObserver(() => {
      for (const s of [...subscribers]) s();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class'],
    });
  }
  return () => {
    subscribers.delete(onChange);
    if (subscribers.size === 0) {
      observer?.disconnect();
      observer = null;
    }
  };
}

/** Read from the attributes themselves, not counted by the observer: a count missed every
 *  change made while nothing was subscribed, such as T pressed on another workbench. */
export function themeRevision(): string {
  const root = document.documentElement;
  return `${root.getAttribute('data-theme') ?? ''}|${root.className}`;
}

export function useThemeRevision(): string {
  return useSyncExternalStore(subscribe, themeRevision, themeRevision);
}
