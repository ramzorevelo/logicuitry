// Android Back (and a browser's Back button) closes the top open layer instead of leaving the
// app. A phone has no Esc, and a tab with one history entry has nowhere to go back to but out.
// Each open layer owns one same-URL history entry; Back pops it and closes that layer.

import { useEffect, useRef } from 'react';

export interface HistoryPort {
  pushState(data: unknown, unused: string): void;
  go(delta: number): void;
  readonly state: unknown;
}

export interface BackStack {
  /** Registers an open layer; the returned function is called when it closes by other means. */
  open(close: () => void): () => void;
  /** The popstate handler. */
  onPop(): void;
  /** Pops the layer entries a reload left behind, which no open layer owns any more. */
  dropStale(): void;
  readonly depth: number;
}

interface LayerEntry {
  lcirLayer: true;
  /** How many layers were open with this entry current; entry n belongs to layer n. */
  depth?: number;
}

const layerEntry = (state: unknown): LayerEntry | null =>
  (state as { lcirLayer?: unknown } | null)?.lcirLayer === true ? (state as LayerEntry) : null;

export function createBackStack(history: HistoryPort): BackStack {
  const layers: (() => void)[] = [];
  // A traversal is asynchronous, and Chrome folds a second one asked for in the same task into
  // the first, so at most one is ever in flight; entries owed meanwhile go in the next one.
  let inFlight = false;
  let owed = 0;
  // A push made before the traversal lands would be the entry it removes, so it waits.
  let deferredPushes = 0;
  let draining = false;
  const depthOf = (state: unknown): number => {
    const entry = layerEntry(state);
    return entry ? (entry.depth ?? layers.length) : 0;
  };
  const push = () => history.pushState({ lcirLayer: true, depth: depthOf(history.state) + 1 }, '');
  const traverse = (delta: number) => {
    inFlight = true;
    history.go(-delta);
  };
  const settle = () => {
    for (; deferredPushes > 0; deferredPushes--) push();
    if (owed > 0) {
      const delta = owed;
      owed = 0;
      traverse(delta);
    }
  };

  return {
    open(close) {
      layers.push(close);
      // An entry still owed to a traversal is the one this layer needs: keep it instead.
      if (owed > 0) owed--;
      else if (inFlight) deferredPushes++;
      else push();
      return () => {
        const i = layers.lastIndexOf(close);
        // Already gone: Back closed it and took its entry along.
        if (i < 0) return;
        layers.splice(i, 1);
        if (deferredPushes > 0) {
          deferredPushes--;
          return;
        }
        owed++;
        if (!inFlight) settle();
      };
    },
    onPop() {
      if (inFlight) {
        inFlight = false;
        if (draining) {
          if (layerEntry(history.state)) {
            traverse(1);
            return;
          }
          draining = false;
        }
        settle();
        return;
      }
      const depth = depthOf(history.state);
      // Forward onto an entry whose layer is gone: step back off it rather than strand it.
      if (depth > layers.length) {
        traverse(depth - layers.length);
        return;
      }
      while (layers.length > depth) layers.pop()?.();
    },
    dropStale() {
      if (!layerEntry(history.state) || inFlight) return;
      draining = true;
      traverse(1);
    },
    get depth() {
      return layers.length;
    },
  };
}

let shared: BackStack | null = null;

function sharedStack(): BackStack {
  if (!shared) {
    const stack = createBackStack(window.history);
    window.addEventListener('popstate', () => stack.onPop());
    stack.dropStale();
    shared = stack;
  }
  return shared;
}

/** Clears what a reload with a layer open left in the history, before any Back press needs it. */
export function initBackStack(): void {
  sharedStack();
}

/**
 * Makes a layer closable by Back while it is open. Pass null while it is closed. The latest
 * `onClose` is the one called, so callers may pass an inline function.
 */
export function useBackLayer(onClose: (() => void) | null): void {
  const latest = useRef(onClose);
  latest.current = onClose;
  const open = onClose !== null;
  useEffect(() => {
    if (!open) return;
    return sharedStack().open(() => latest.current?.());
  }, [open]);
}
