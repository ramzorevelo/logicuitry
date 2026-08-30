// Builds the report payload. Pure and tested: everything the app would send
// has to be inspectable before it leaves, and the dialog shows exactly this.

import type { LoggedError } from './errorLog';

export interface ReportInput {
  description: string;
  /** Where the reporter says the problem is, which is not necessarily the tab
   *  that happened to be open: a bug can be in the menus, or somewhere they
   *  cannot name. The dialog defaults it to the open tab and lets them change
   *  it. Kept under the old key so the form mapping does not move. */
  workbench: string;
  version: string;
  build: string;
  userAgent: string;
  screen: string;
  lastError?: LoggedError | undefined;
  /** Serialized board, or undefined when the reporter opted out. */
  boardJson?: string | undefined;
}

export interface ReportPayload {
  description: string;
  workbench: string;
  version: string;
  build: string;
  browser: string;
  screen: string;
  lastError: string;
  board: string;
}

/** Google Forms rejects very long answers, and a big board is mostly noise
 *  anyway: the shape is what matters, not every wire. */
export const MAX_BOARD_CHARS = 50_000;

export function truncateBoard(json: string | undefined): string {
  if (!json) return '(not included)';
  if (json.length <= MAX_BOARD_CHARS) return json;
  return `${json.slice(0, MAX_BOARD_CHARS)}\n...[truncated ${json.length - MAX_BOARD_CHARS} chars of ${json.length}]`;
}

function formatError(e: LoggedError | undefined): string {
  if (!e) return '(none)';
  const when = new Date(e.at).toISOString();
  return e.stack ? `${when} ${e.message}\n${e.stack}` : `${when} ${e.message}`;
}

export function buildReport(input: ReportInput): ReportPayload {
  return {
    description: input.description.trim(),
    workbench: input.workbench,
    version: input.version,
    build: input.build,
    browser: input.userAgent,
    screen: input.screen,
    lastError: formatError(input.lastError),
    board: truncateBoard(input.boardJson),
  };
}

/** Human-readable form of exactly what would be sent, for the dialog's
 *  preview and for Copy report. */
export function reportToText(p: ReportPayload): string {
  return [
    `Description: ${p.description}`,
    `Where: ${p.workbench}`,
    `Version: ${p.version} (${p.build})`,
    `Browser: ${p.browser}`,
    `Screen: ${p.screen}`,
    `Last error: ${p.lastError}`,
    `Board: ${p.board}`,
  ].join('\n\n');
}

export function reportToFormData(
  p: ReportPayload,
  fields: Record<keyof ReportPayload, string>,
): URLSearchParams {
  const body = new URLSearchParams();
  for (const key of Object.keys(p) as (keyof ReportPayload)[]) body.set(fields[key], p[key]);
  return body;
}

/** Google's own prefill links run long, but a URL still has to survive the
 *  browser, Google's front end and whatever logs it on the way. 8000 keeps
 *  clear of the classic 8192-byte server limit. */
export const MAX_PREFILL_URL_CHARS = 8000;

/** Stands in for a board too big to ride in a URL. A truncated board would be
 *  JSON that no longer parses, which is worse than an honest absence. */
export const BOARD_TOO_LARGE = '(too large for this link: use Copy report instead)';

export interface PrefillLink {
  url: string;
  /** False when the board was left out for size, so the dialog can say so
   *  rather than letting the reporter assume it went along. */
  boardIncluded: boolean;
}

/** A prefilled `/viewform` link: the same answers the POST would carry, put in
 *  a URL so a reporter can finish the report by hand. Used for the screenshot
 *  route, where Google requires a sign-in the app cannot perform. */
export function buildPrefillLink(
  viewform: string,
  p: ReportPayload,
  fields: Record<keyof ReportPayload, string>,
): PrefillLink {
  const withBoard = (board: string): string => {
    const q = new URLSearchParams({ usp: 'pp_url' });
    for (const key of Object.keys(p) as (keyof ReportPayload)[]) {
      q.set(fields[key], key === 'board' ? board : p[key]);
    }
    return `${viewform}?${q.toString()}`;
  };
  const full = withBoard(p.board);
  if (full.length <= MAX_PREFILL_URL_CHARS) return { url: full, boardIncluded: true };
  return { url: withBoard(BOARD_TOO_LARGE), boardIncluded: false };
}
