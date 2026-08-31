// Preferences. Changes apply immediately -- a setting that needs an OK button
// is a dialog, not a setting.

import { useEffect, useState } from 'react';
import { SELECTABLE_THEMES, applyTheme, type ThemeName } from '../../render/theme';
import { isDesktop } from '../../io/platform';
import { DEFAULT_PREFS, usePrefsStore, type Prefs } from '../prefs';
import { clearSession } from '../../io/sessionStore';

interface Props {
  onClose: () => void;
}

export function SettingsDialog({ onClose }: Props) {
  const prefs = usePrefsStore((s) => s.prefs);
  const setPref = usePrefsStore((s) => s.setPref);
  const resetPrefs = usePrefsStore((s) => s.resetPrefs);
  const [note, setNote] = useState<string | null>(null);

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

  const check = (key: keyof Prefs, label: string, hint?: string) => (
    <label className="settings-row" key={key}>
      <input
        type="checkbox"
        checked={prefs[key] as boolean}
        onChange={(e) => setPref(key, e.target.checked as never)}
      />
      <span className="settings-row__text">
        <span>{label}</span>
        {hint ? <span className="settings-row__hint">{hint}</span> : null}
      </span>
    </label>
  );

  return (
    <div
      className="package-overlay"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="package-dialog settings-dialog">
        <h3>Preferences</h3>

        <h4>Display</h4>
        {check(
          'alwaysShowPinBusWidth',
          'Always show bus width on pins',
          'Off: a wide pin drops its bus label once wired.',
        )}
        {check('waveformArrows', 'Show cause arrows in the waveform panel')}
        <label className="settings-row">
          <input
            type="number"
            min={1}
            max={10000}
            value={prefs.glitchThresholdNs}
            onChange={(e) => setPref('glitchThresholdNs', Number(e.target.value))}
          />
          <span className="settings-row__text">
            <span>Glitch threshold (ns)</span>
            <span className="settings-row__hint">Pulses shorter than this are flagged.</span>
          </span>
        </label>

        <h4>Teaching</h4>
        {check('hideAnswersDefault', 'Hide answers by default', 'Enter reveals, as it does today.')}
        {check('presentationAtLaunch', 'Start in presentation scaling')}
        {check(
          'thickenStrokesInPresentation',
          'Thicker lines in presentation mode',
          'Off: a board draws identically fullscreen and windowed.',
        )}
        <label className="settings-row">
          <select
            value={prefs.timingModel}
            onChange={(e) => setPref('timingModel', e.target.value as Prefs['timingModel'])}
          >
            <option value="ideal">Ideal (unit delay)</option>
            <option value="datasheet">Datasheet (74LS timing)</option>
          </select>
          <span className="settings-row__text">
            <span>Timing model for a new board</span>
          </span>
        </label>
        <label className="settings-row">
          <select
            value={prefs.defaultTheme}
            onChange={(e) => {
              const next = e.target.value as ThemeName;
              setPref('defaultTheme', next);
              applyTheme(next);
            }}
          >
            {SELECTABLE_THEMES.map((t) => (
              <option key={t.name} value={t.name}>
                {t.label}
              </option>
            ))}
          </select>
          <span className="settings-row__text">
            <span>Theme</span>
          </span>
        </label>

        <h4>Editor</h4>
        {check('autosave', 'Autosave the board as you work')}
        {check('restoreLastBoard', 'Reopen the last board at launch')}
        {check(
          'fitOnOpen',
          'Fit the board to the window when it opens',
          'Bundled examples always fit; this governs your own boards.',
        )}
        {check(
          'confirmReplaceBoard',
          'Ask before replacing a board with unsaved edits',
          'Off means New and Open discard unsaved work without asking.',
        )}

        {/* Meaningless in a browser, where updates come from the service
            worker, so they are not shown there at all. */}
        {isDesktop() && (
          <>
            <h4>Updates</h4>
            {check('autoDownloadUpdates', 'Download updates in the background')}
            {check('applyUpdatesOnClose', 'Install a downloaded update when the app closes')}
          </>
        )}

        <h4>Stored data</h4>
        <div className="label-conflict-buttons">
          <button
            type="button"
            className="tool-btn"
            onClick={() => {
              resetPrefs();
              applyTheme(DEFAULT_PREFS.defaultTheme);
              setNote('Preferences reset.');
            }}
          >
            Reset preferences
          </button>
          <button
            type="button"
            className="tool-btn"
            onClick={() => {
              void clearSession()
                .then(() => setNote('Autosaved board cleared. It reopens empty next launch.'))
                .catch(() => setNote('Could not clear the autosaved board.'));
            }}
          >
            Clear autosaved board
          </button>
          <button type="button" className="tool-btn" onClick={onClose}>
            Close
          </button>
        </div>
        {note ? <p className="label-conflict-hint">{note}</p> : null}
      </div>
    </div>
  );
}
