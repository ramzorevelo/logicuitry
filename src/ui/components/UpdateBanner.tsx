// A new build never takes over mid-lecture: it announces itself and waits.

import { useEffect } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';

const UPDATE_CHECK_MS = 60 * 60 * 1000;

export function UpdateBanner() {
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
