// Real browser fullscreen, paired with the presentation class by App.tsx.
// Everything here swallows its own failures: iOS Safari refuses fullscreen on
// anything but a video, and a lecture must not end at an unhandled rejection.

import { useEffect, useState } from 'react';

export function fullscreenSupported(): boolean {
  return (
    typeof document !== 'undefined' && document.documentElement.requestFullscreen !== undefined
  );
}

export function isFullscreen(): boolean {
  return typeof document !== 'undefined' && document.fullscreenElement !== null;
}

// Held so exit can release it; the lock itself dies with the document, so a
// missed release is untidy rather than harmful.
let wakeLock: { release: () => Promise<void> } | null = null;

async function acquireWakeLock(): Promise<void> {
  try {
    const nav = navigator as Navigator & {
      wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> };
    };
    wakeLock = (await nav.wakeLock?.request('screen')) ?? null;
  } catch {
    // Denied, unsupported, or the tab lost visibility mid-request. A dimming
    // screen is a nuisance, never a reason to refuse fullscreen.
  }
}

function releaseWakeLock(): void {
  void wakeLock?.release().catch(() => {
    // Already released by the browser on visibility loss.
  });
  wakeLock = null;
}

export async function requestAppFullscreen(): Promise<boolean> {
  if (!fullscreenSupported()) return false;
  try {
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    await acquireWakeLock();
    return true;
  } catch {
    return false;
  }
}

export async function exitAppFullscreen(): Promise<void> {
  releaseWakeLock();
  if (!isFullscreen()) return;
  try {
    await document.exitFullscreen();
  } catch {
    // Already left, or the browser dropped it for us.
  }
}

/** Tracks the real fullscreen state, so Esc and F11 cannot desync the UI. */
export function useFullscreenState(): boolean {
  const [on, setOn] = useState(isFullscreen);
  useEffect(() => {
    const onChange = () => {
      const now = isFullscreen();
      setOn(now);
      if (!now) releaseWakeLock();
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  return on;
}
