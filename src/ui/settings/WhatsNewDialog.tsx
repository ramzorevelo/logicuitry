// Shown once after the running version changes, and on demand from Help.
// Nothing announced a release before this, so a build could change a gesture
// under the instructor mid-term with no notice anywhere.

import { useEffect, useState } from 'react';
import { useModalKeys } from '../modalKeys';

const SEEN_KEY = 'lcir.lastSeenVersion';

/** Storage can throw under a locked-down profile, and a notice is never worth
 *  failing startup over. */
function readSeen(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

function writeSeen(version: string): void {
  try {
    localStorage.setItem(SEEN_KEY, version);
  } catch {
    // no persistence available
  }
}

/**
 * Whether this launch should announce itself. A first-ever launch does not:
 * someone opening the app for the first time is not catching up on anything.
 */
export function useWhatsNew(presentation: boolean): [boolean, () => void] {
  const [due, setDue] = useState(false);
  useEffect(() => {
    const seen = readSeen();
    if (seen === null) writeSeen(__APP_VERSION__);
    else if (seen !== __APP_VERSION__) setDue(true);
  }, []);
  const dismiss = () => {
    writeSeen(__APP_VERSION__);
    setDue(false);
  };
  // Never on a lecture screen, the same rule the update banner follows.
  return [due && !presentation, dismiss];
}

type Release = (typeof __RELEASE_NOTES__)[number];

function ReleaseNotes({ release }: { release: Release }) {
  return (
    <>
      {release.body.length > 0 && (
        <ul className="whats-new__list">
          {release.body.map((line, j) => (
            <li key={j}>{line}</li>
          ))}
        </ul>
      )}
      {release.sections.map((section) => (
        <div key={section.heading}>
          <h4>{section.heading}</h4>
          <ul className="whats-new__list">
            {section.items.map((item, j) => (
              <li key={j}>{item}</li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

export function WhatsNewDialog({ onClose }: { onClose: () => void }) {
  useModalKeys(onClose);

  const [latest, ...older] = __RELEASE_NOTES__;

  // Only the latest release is open; the notes scroll between a fixed heading
  // and a fixed Close, which a phone otherwise reached only past every release.
  return (
    <div
      className="package-overlay"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="package-dialog settings-dialog whats-new">
        <h3>What&rsquo;s new in {latest ? latest.version : __APP_VERSION__}</h3>
        <div className="package-scroll">
          {latest ? (
            <ReleaseNotes release={latest} />
          ) : (
            <p className="analyze-muted">No release notes shipped with this build.</p>
          )}
          {older.length > 0 && <h4>Earlier versions</h4>}
          {older.map((release) => (
            <details key={release.version} className="whats-new__older">
              <summary>
                {release.version} &middot; {release.date}
              </summary>
              <ReleaseNotes release={release} />
            </details>
          ))}
        </div>
        <div className="label-conflict-buttons">
          <button type="button" className="tool-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
