// Shared HiDPI/pinch-zoom backing-store scale for canvas instruments.
// Backing scale = device pixels per CSS px times any visual-viewport (pinch)
// zoom, which changes neither devicePixelRatio nor window size; floored at 2x
// so a missed zoom signal still leaves headroom.

export function backingScale(): number {
  const dpr = window.devicePixelRatio || 1;
  return Math.max(2, dpr * (window.visualViewport?.scale ?? 1));
}

/**
 * Redraw triggers for backing-scale changes: window resize (Ctrl+/- layout
 * zoom), visualViewport resize (pinch/trackpad zoom), and a matchMedia
 * resolution listener for DPR flips resize can miss (moving across monitors).
 * Returns the cleanup function.
 */
export function watchBackingScale(onChange: () => void): () => void {
  watchers.add(onChange);
  if (watchers.size === 1) attach();
  return () => {
    watchers.delete(onChange);
    if (watchers.size === 0) detach();
  };
}

// One set of listeners for every watcher, not one set each: the palette mounts
// a canvas per component, and a listener triple per thumbnail is what made
// opening a group crawl.
const watchers = new Set<() => void>();
let mq: MediaQueryList | null = null;

const fire = (): void => {
  for (const w of [...watchers]) w();
};

const onDpr = (): void => {
  fire();
  armDpr(); // each match is one-shot; re-arm per change
};

function armDpr(): void {
  mq?.removeEventListener('change', onDpr);
  mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  mq.addEventListener('change', onDpr);
}

function attach(): void {
  window.addEventListener('resize', fire);
  window.visualViewport?.addEventListener('resize', fire);
  armDpr();
}

function detach(): void {
  window.removeEventListener('resize', fire);
  window.visualViewport?.removeEventListener('resize', fire);
  mq?.removeEventListener('change', onDpr);
  mq = null;
}

/** Sizes a canvas's backing store for CSS-px drawing at the current scale. */
export function sizeCanvas(
  canvas: HTMLCanvasElement,
  cssW: number,
  cssH: number,
): CanvasRenderingContext2D | null {
  const scale = backingScale();
  canvas.width = Math.round(cssW * scale);
  canvas.height = Math.round(cssH * scale);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext('2d');
  ctx?.setTransform(scale, 0, 0, scale, 0, 0);
  return ctx;
}
