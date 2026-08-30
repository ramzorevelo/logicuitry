// Nothing leaves the app unseen: the dialog previews exactly the payload it
// would send, and says honestly what it can and cannot confirm.

import { useMemo, useState } from 'react';
import { buildPrefillLink, buildReport, reportToFormData, reportToText } from '../report/collect';
import { lastError, type LoggedError } from '../report/errorLog';
import {
  FORM_FIELDS,
  FORM_URL,
  SCREENSHOT_FORM_FIELDS,
  SCREENSHOT_FORM_URL,
  reportingConfigured,
  screenshotFormConfigured,
} from '../report/reportConfig';
import { openExternal } from '../desktop/openExternal';
import { serializeDocument } from '../../io/library';
import { useCircuitStore } from '../workbench-circuit/circuitStore';
import { useShellStore } from '../store';

interface Props {
  onClose: () => void;
  /** Prefills the description when opened from a crash panel. */
  initialDescription?: string;
  crash?: LoggedError | undefined;
}

type Status = 'idle' | 'sent' | 'copied' | 'failed' | 'opened' | 'openFailed' | 'linkCopied';

/** The three workbenches, plus the two answers a workbench list cannot give:
 *  the chrome is not a workbench, and "I do not know" is a real answer that
 *  must not be forced into a wrong one. */
const WHERE_OPTIONS = [
  { id: 'numbers', label: 'Numbers' },
  { id: 'circuit', label: 'Circuit' },
  { id: 'devicelab', label: 'Device Lab' },
  { id: 'chrome', label: 'Menus, dialogs or the app itself' },
  { id: 'unsure', label: 'Not sure' },
] as const;

export function BugReportDialog({ onClose, initialDescription, crash }: Props) {
  const [description, setDescription] = useState(initialDescription ?? '');
  const workbench = useShellStore((st) => st.workbench);
  const board = useCircuitStore((s) => s.board);
  // Which tab happens to be open does not decide this. The board is in the
  // store either way, and making the checkbox follow the active workbench
  // meant noticing something on the Circuit board, opening this from anywhere
  // else, and being told to go back and switch tabs first. Having a circuit
  // at all is the only thing that matters.
  const hasCircuit = board.components.length > 0;
  const [includeBoard, setIncludeBoard] = useState(hasCircuit);
  const [where, setWhere] = useState<string>(workbench);
  const [status, setStatus] = useState<Status>('idle');

  const payload = useMemo(
    () =>
      buildReport({
        description,
        workbench: where,
        version: __APP_VERSION__,
        build: __BUILD_COMMIT__,
        userAgent: navigator.userAgent,
        screen: `${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio}x`,
        lastError: crash ?? lastError(),
        boardJson: includeBoard ? serializeDocument(board) : undefined,
      }),
    [description, includeBoard, board, crash, where],
  );

  const preview = reportToText(payload);
  const canSend = reportingConfigured() && navigator.onLine && description.trim().length > 0;

  const send = () => {
    // no-cors returns an opaque response, so delivery cannot be confirmed --
    // the wording below never claims it was.
    void fetch(FORM_URL, {
      method: 'POST',
      mode: 'no-cors',
      body: reportToFormData(payload, FORM_FIELDS),
    })
      .then(() => setStatus('sent'))
      .catch(() => setStatus('failed'));
  };

  const copy = () => {
    void navigator.clipboard
      .writeText(preview)
      .then(() => setStatus('copied'))
      .catch(() => setStatus('failed'));
  };

  // A screenshot cannot be posted: the upload question makes Google demand a
  // sign-in for its whole form, so the reporter finishes that one by hand with
  // every answer already filled in.
  const screenshot = useMemo(
    () => buildPrefillLink(SCREENSHOT_FORM_URL, payload, SCREENSHOT_FORM_FIELDS),
    [payload],
  );

  const openScreenshotForm = () => {
    // A blocked popup reports itself only as a falsy return, so Copy link stays
    // the route that always works.
    void openExternal(screenshot.url).then((opened) => setStatus(opened ? 'opened' : 'openFailed'));
  };

  const copyScreenshotLink = () => {
    void navigator.clipboard
      .writeText(screenshot.url)
      .then(() => setStatus('linkCopied'))
      .catch(() => setStatus('failed'));
  };

  return (
    <div
      className="package-overlay"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="package-dialog bug-report-dialog">
        <h3>Report a problem</h3>
        <label className="settings-row">
          <span className="settings-row__text">
            <span>What is wrong?</span>
          </span>
        </label>
        <textarea
          className="bug-report__description"
          rows={4}
          autoFocus
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Tell us what you saw."
        />
        {/* A report is not about whichever tab happened to be open. It can be
            about the menus, or about something the reporter cannot place --
            so this is a question, defaulted to the open tab, not an assertion
            made on their behalf. */}
        <label className="settings-row">
          <span className="settings-row__text">
            <span>Where is it?</span>
          </span>
          <select value={where} onChange={(e) => setWhere(e.target.value)}>
            {WHERE_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="settings-row">
          <input
            type="checkbox"
            checked={includeBoard && hasCircuit}
            disabled={!hasCircuit}
            onChange={(e) => setIncludeBoard(e.target.checked)}
          />
          <span className="settings-row__text">
            <span>Include my circuit</span>
            <span className="settings-row__hint">
              {hasCircuit
                ? `Attaches "${board.name}", whichever tab you are on. Usually the fastest way to reproduce it.`
                : 'The board is empty, so there is nothing to attach.'}
            </span>
          </span>
        </label>
        {screenshotFormConfigured() && (
          <p className="settings-row__hint">
            Adding a screenshot needs a Google sign-in, so it opens a second form in your browser
            with all of this already filled in.
          </p>
        )}
        <p className="settings-row__hint">This is everything that would be sent:</p>
        <pre className="bug-report__preview">{preview}</pre>
        <div className="label-conflict-buttons">
          <button type="button" className="tool-btn" disabled={!canSend} onClick={send}>
            Send report
          </button>
          <button type="button" className="tool-btn" onClick={copy}>
            Copy report
          </button>
          {screenshotFormConfigured() && (
            <>
              <button type="button" className="tool-btn" onClick={openScreenshotForm}>
                Attach a screenshot
              </button>
              <button type="button" className="tool-btn" onClick={copyScreenshotLink}>
                Copy screenshot link
              </button>
            </>
          )}
          <button type="button" className="tool-btn" onClick={onClose}>
            Close
          </button>
        </div>
        {status === 'sent' && (
          <p className="label-conflict-hint">
            Report sent. Delivery cannot be confirmed from here, so keep a copy if it matters.
          </p>
        )}
        {status === 'copied' && (
          <p className="label-conflict-hint">Copied. Paste it wherever you report problems.</p>
        )}
        {status === 'opened' && (
          <p className="label-conflict-hint">
            Opened in a new tab with this report filled in. Attach the screenshot and submit there,
            and do not also use Send report or it arrives twice.
          </p>
        )}
        {status === 'openFailed' && (
          <p className="label-conflict-hint">
            A tab could not be opened from here. Use Copy screenshot link and paste it into your
            browser.
          </p>
        )}
        {status === 'linkCopied' && (
          <p className="label-conflict-hint">
            Link copied. Open it in any browser, sign in, and attach the screenshot there.
          </p>
        )}
        {(status === 'opened' || status === 'linkCopied') && !screenshot.boardIncluded && (
          <p className="label-conflict-hint">
            Your circuit is too big to travel in a link, so it is not in that form. Use Send report
            for the circuit, or Copy report and paste it in.
          </p>
        )}
        {status === 'failed' && <p className="circuit-error">That did not go through.</p>}
        {!reportingConfigured() && (
          <p className="label-conflict-hint">
            No report address is configured in this build, so Copy report is the only route.
          </p>
        )}
        {reportingConfigured() && !navigator.onLine && (
          <p className="label-conflict-hint">Offline: copy the report and send it later.</p>
        )}
      </div>
    </div>
  );
}
