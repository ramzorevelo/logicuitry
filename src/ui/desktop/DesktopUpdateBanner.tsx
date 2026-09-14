// Desktop update indicator. Passive by default: it says a version exists and
// waits. Nothing here downloads or installs without a click, except when the
// preferences say otherwise. It also carries the answer to Help > Check for
// updates, which otherwise had no way to say "nothing to install".

import { useEffect, useState } from 'react';
import { isDesktop } from '../../io/platform';
import {
  clearUpdateResult,
  downloadUpdate,
  installUpdate,
  subscribeUpdates,
  type UpdateState,
} from './updater';

/** How long an answer to an asked-for check stays up. Long enough to read,
 *  short enough that it is gone before anyone starts lecturing. */
const RESULT_MS = 6000;

export function DesktopUpdateBanner({ presentation }: { presentation: boolean }) {
  const [state, setState] = useState<UpdateState>({
    available: false,
    downloaded: false,
    downloading: false,
    checking: false,
    result: null,
  });
  useEffect(() => subscribeUpdates(setState), []);

  useEffect(() => {
    if (state.result === null) return;
    const id = window.setTimeout(clearUpdateResult, RESULT_MS);
    return () => window.clearTimeout(id);
  }, [state.result]);

  // Suppressed entirely while presenting: a banner on a 65" screen mid-lecture
  // is worse than a late update.
  const say = state.available || state.checking || state.result !== null;
  if (!isDesktop() || presentation || !say) return null;

  if (!state.available) {
    return (
      <div className="update-banner" role="status">
        <span>
          {state.checking
            ? 'Checking for updates...'
            : state.result === 'current'
              ? `Logicuitry ${__APP_VERSION__} is the latest version.`
              : 'Could not check for updates. There may be no connection.'}
        </span>
        {state.checking ? null : (
          <button type="button" className="tool-btn" onClick={clearUpdateResult}>
            OK
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="update-banner" role="status">
      <span>
        Version {state.version} is available.
        {state.notes ? <span className="update-banner__notes">{state.notes}</span> : null}
      </span>
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
