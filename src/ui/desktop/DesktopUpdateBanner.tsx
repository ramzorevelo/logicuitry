// Desktop update indicator. Passive by default: it says a version exists and
// waits. Nothing here downloads or installs without a click, except when the
// preferences say otherwise.

import { useEffect, useState } from 'react';
import { isDesktop } from '../../io/platform';
import { downloadUpdate, installUpdate, subscribeUpdates, type UpdateState } from './updater';

export function DesktopUpdateBanner({ presentation }: { presentation: boolean }) {
  const [state, setState] = useState<UpdateState>({
    available: false,
    downloaded: false,
    downloading: false,
  });
  useEffect(() => subscribeUpdates(setState), []);

  // Suppressed entirely while presenting: a banner on a 65" screen mid-lecture
  // is worse than a late update.
  if (!isDesktop() || presentation || !state.available) return null;

  return (
    <div className="update-banner" role="status">
      <span>Version {state.version} is available.</span>
      {state.downloaded ? (
        <button type="button" className="tool-btn" onClick={() => void installUpdate()}>
          Restart now
        </button>
      ) : (
        <button
          type="button"
          className="tool-btn"
          disabled={state.downloading}
          onClick={() => void downloadUpdate()}
        >
          {state.downloading ? 'Downloading...' : 'Download'}
        </button>
      )}
    </div>
  );
}
