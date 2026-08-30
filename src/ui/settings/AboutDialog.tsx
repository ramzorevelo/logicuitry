// About is its own dialog, not a section of Preferences: "what is this and
// which build am I running" is a different question from "how should it
// behave", and Help > About pointing at a settings panel reads as a mistake.

import { useEffect } from 'react';

interface Props {
  onClose: () => void;
}

export function AboutDialog({ onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div
      className="package-overlay"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="package-dialog about-dialog">
        <h3>Logicuitry</h3>
        <p className="settings-row__hint">
          Teaching instruments for a logic circuits and design course: number systems, device-level
          voltage behaviour, and a schematic workbench with real 74LS timing.
        </p>
        <p className="settings-about">
          {__APP_VERSION__}
          <br />
          build {__BUILD_COMMIT__}
        </p>
        <p className="settings-row__hint">
          Runs entirely on this machine. Nothing is sent anywhere unless you submit a problem
          report.
        </p>
        <div className="label-conflict-buttons">
          <button type="button" className="tool-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
