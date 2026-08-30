// How a new build takes over depends on where the app is running.
//
// An INSTALLED app announces itself and waits. That is the one running in
// front of a class, and a reload it did not ask for is the worst thing that
// could happen mid-lecture.
//
// A BROWSER TAB just updates. Someone opening the url expects the current
// build, not a stale one sitting behind a prompt they have to notice and
// accept. The only reason to hold back there is unsaved work, so the update
// applies itself while nobody has touched the page and falls back to asking
// once somebody has.

import { useEffect, useRef } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { appliesSilently } from './updatePolicy';

const UPDATE_CHECK_MS = 60 * 60 * 1000;

/** True when the app runs as an installed app rather than in a browser tab.
 *  `navigator.standalone` is the iOS-only spelling, which has no display-mode
 *  media query behind it. */
function isInstalled(): boolean {
  const modes = ['standalone', 'fullscreen', 'minimal-ui'];
  const asStandalone = (navigator as { standalone?: boolean }).standalone === true;
  return asStandalone || modes.some((m) => window.matchMedia(`(display-mode: ${m})`).matches);
}

export function UpdateBanner({ presentation }: { presentation: boolean }) {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      if (!registration) return;
      const check = () => void registration.update();
      const id = window.setInterval(check, UPDATE_CHECK_MS);
      // Coming back to the tab is the other natural moment to look, and the
      // one that catches a machine that was asleep between lectures.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
      return () => window.clearInterval(id);
    },
  });

  // Whether anyone has touched this page yet. A pointer or a key is the signal
  // rather than the board's revision, because loading the autosaved board
  // bumps that on its own and would make every session look like work in
  // progress.
  const touched = useRef(false);
  useEffect(() => {
    const mark = () => {
      touched.current = true;
    };
    const opts = { once: true, capture: true } as const;
    window.addEventListener('pointerdown', mark, opts);
    window.addEventListener('keydown', mark, opts);
    return () => {
      window.removeEventListener('pointerdown', mark, true);
      window.removeEventListener('keydown', mark, true);
    };
  }, []);

  useEffect(() => {
    if (!needRefresh) return;
    if (!appliesSilently({ installed: isInstalled(), presentation, touched: touched.current })) {
      return;
    }
    void updateServiceWorker(true);
  }, [needRefresh, presentation, updateServiceWorker]);

  useEffect(() => {
    if (!offlineReady) return;
    const id = window.setTimeout(() => setOfflineReady(false), 6000);
    return () => window.clearTimeout(id);
  }, [offlineReady, setOfflineReady]);

  if (!needRefresh && !offlineReady) return null;

  return (
    <div className="update-banner" role="status">
      {needRefresh ? (
        <>
          <span>A new version is available.</span>
          <button type="button" className="tool-btn" onClick={() => void updateServiceWorker(true)}>
            Update
          </button>
          <button type="button" className="tool-btn" onClick={() => setNeedRefresh(false)}>
            Later
          </button>
        </>
      ) : (
        <span>Ready to work offline.</span>
      )}
    </div>
  );
}
