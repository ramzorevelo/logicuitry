import { describe, expect, it } from 'vitest';
import {
  BOARD_TOO_LARGE,
  MAX_BOARD_CHARS,
  MAX_PREFILL_URL_CHARS,
  buildPrefillLink,
  buildReport,
  reportToFormData,
  reportToText,
  truncateBoard,
} from './collect';

const base = {
  description: '  it crashed  ',
  workbench: 'numbers',
  version: 'v0.1.0',
  build: 'abc1234',
  userAgent: 'Chrome/1',
  screen: '1920x1080',
};

describe('buildReport', () => {
  it('names where the problem is, so a Numbers report is not read as a circuit bug', () => {
    expect(buildReport({ ...base }).workbench).toBe('numbers');
    expect(reportToText(buildReport({ ...base }))).toContain('Where: numbers');
  });

  it('trims the description and marks an omitted board rather than sending empty', () => {
    const p = buildReport({ ...base });
    expect(p.description).toBe('it crashed');
    expect(p.board).toBe('(not included)');
    expect(p.lastError).toBe('(none)');
  });

  it('carries the last error with its stack when there is one', () => {
    const p = buildReport({ ...base, lastError: { at: 0, message: 'boom', stack: 'at x' } });
    expect(p.lastError).toContain('boom');
    expect(p.lastError).toContain('at x');
  });
});

describe('truncateBoard', () => {
  it('passes a small board through untouched', () => {
    expect(truncateBoard('{"a":1}')).toBe('{"a":1}');
  });

  it('marks the truncation instead of silently cutting', () => {
    const big = 'x'.repeat(MAX_BOARD_CHARS + 500);
    const out = truncateBoard(big);
    expect(out.length).toBeLessThan(big.length);
    expect(out).toContain('truncated 500 chars');
  });
});

describe('reportToText / reportToFormData', () => {
  it('the preview text mentions every field that gets sent', () => {
    const p = buildReport({ ...base, boardJson: '{}' });
    const text = reportToText(p);
    for (const value of Object.values(p)) expect(text).toContain(value);
  });

  it('maps every payload field onto its form entry id', () => {
    const p = buildReport({ ...base });
    const fields = {
      description: 'entry.1',
      workbench: 'entry.8',
      version: 'entry.2',
      build: 'entry.3',
      browser: 'entry.4',
      screen: 'entry.5',
      lastError: 'entry.6',
      board: 'entry.7',
    };
    const body = reportToFormData(p, fields);
    expect(body.get('entry.1')).toBe('it crashed');
    expect(body.get('entry.4')).toBe('Chrome/1');
    expect([...body.keys()].sort()).toEqual(Object.values(fields).sort());
  });
});

describe('buildPrefillLink', () => {
  const fields = {
    description: 'entry.1',
    workbench: 'entry.2',
    version: 'entry.3',
    build: 'entry.4',
    browser: 'entry.5',
    screen: 'entry.6',
    lastError: 'entry.7',
    board: 'entry.8',
  };
  const view = 'https://docs.google.com/forms/d/e/FORMID/viewform';

  it('carries every answer, so the reporter retypes nothing', () => {
    const p = buildReport({ ...base, boardJson: '{"a":1}' });
    const { url, boardIncluded } = buildPrefillLink(view, p, fields);
    const q = new URL(url).searchParams;
    expect(q.get('usp')).toBe('pp_url');
    expect(q.get('entry.1')).toBe('it crashed');
    expect(q.get('entry.2')).toBe('numbers');
    expect(q.get('entry.8')).toBe('{"a":1}');
    expect(boardIncluded).toBe(true);
  });

  it('drops a board too big for a URL rather than truncating it to unparseable JSON', () => {
    const p = buildReport({ ...base, boardJson: `{"x":"${'w'.repeat(MAX_PREFILL_URL_CHARS)}"}` });
    const { url, boardIncluded } = buildPrefillLink(view, p, fields);
    expect(boardIncluded).toBe(false);
    expect(new URL(url).searchParams.get('entry.8')).toBe(BOARD_TOO_LARGE);
    expect(url.length).toBeLessThanOrEqual(MAX_PREFILL_URL_CHARS);
  });

  it('keeps a board that was already truncated for the POST out of the link too', () => {
    // truncateBoard caps at MAX_BOARD_CHARS, which is far past what a URL takes:
    // the two limits are independent and the link must apply its own.
    const p = buildReport({ ...base, boardJson: 'z'.repeat(MAX_BOARD_CHARS * 2) });
    expect(p.board.length).toBeGreaterThan(MAX_PREFILL_URL_CHARS);
    expect(buildPrefillLink(view, p, fields).boardIncluded).toBe(false);
  });
});
