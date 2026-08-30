// Redraw signal for canvas chrome that is not already inside a workbench's own
// draw loop: bumps whenever the theme or presentation class changes.
//
// One observer for every subscriber, not one each. The palette mounts a canvas
// per component, and a MutationObserver on <html> per thumbnail is what made
// opening a group crawl.

import { useSyncExternalStore } from 'react';

let revision = 0;
let observer: MutationObserver | null = null;
const subscribers = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  subscribers.add(onChange);
  if (!observer) {
    observer = new MutationObserver(() => {
      revision++;
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

export function themeRevision(): number {
  return revision;
}

export function useThemeRevision(): number {
  return useSyncExternalStore(subscribe, themeRevision, themeRevision);
}
