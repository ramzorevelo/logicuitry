import { describe, expect, it } from 'vitest';
import { parsePatternFields, patternFieldText, type PatternFieldText } from './patternOverlay';
import { isLiveEditable, paramKeysFor } from './paramSpecs';

const fields = (over: Partial<PatternFieldText> = {}): PatternFieldText => ({
  width: '4',
  values: '3 5 9 F',
  stepNs: '100',
  after: 'repeat',
  clocked: false,
  ...over,
});

describe('pattern overlay fields', () => {
  it('shows the defaults for a part placed without params', () => {
    expect(patternFieldText({})).toEqual({
      width: '1',
      values: '0 1',
      stepNs: '100',
      after: 'repeat',
      clocked: false,
    });
  });

  it('shows stored params as typed, with the step in ns', () => {
    expect(
      patternFieldText({ width: 8, values: 'A 5', stepPs: 2500, after: 'hold', clocked: true }),
    ).toEqual({ width: '8', values: 'A 5', stepNs: '2.5', after: 'hold', clocked: true });
  });

  it('commits every field, step stored as integer ps', () => {
    expect(parsePatternFields(fields({ stepNs: '2.5', after: 'hold', clocked: true }))).toEqual({
      ok: true,
      params: { width: 4, values: '3 5 9 F', stepPs: 2500, after: 'hold', clocked: true },
    });
  });

  it('tidies the values to single spaces and upper case', () => {
    const r = parsePatternFields(fields({ values: ' a,  b\tc ' }));
    expect(r.ok && r.params['values']).toBe('A B C');
  });

  it('round-trips an untouched overlay to the same params', () => {
    const params = { width: 4, values: '3 5 9 F', stepPs: 1234, after: 'repeat', clocked: false };
    expect(parsePatternFields(patternFieldText(params))).toEqual({ ok: true, params });
  });

  it('flashes the width outside 1..32 or not a whole number', () => {
    for (const width of ['0', '33', '2.5', '', 'x'])
      expect(parsePatternFields(fields({ width })), width).toEqual({ ok: false, field: 'width' });
  });

  it('flashes values that are empty or not hex', () => {
    for (const values of ['', '   ', '3 G', '0x3', '123456789'])
      expect(parsePatternFields(fields({ values })), values).toEqual({
        ok: false,
        field: 'values',
      });
  });

  it('flashes a step under 2 ps', () => {
    for (const stepNs of ['0', '0.001', '-1', '', 'abc'])
      expect(parsePatternFields(fields({ stepNs })), stepNs).toEqual({
        ok: false,
        field: 'stepNs',
      });
    expect(parsePatternFields(fields({ stepNs: '0.002' })).ok).toBe(true);
  });

  it('keeps every field locked while powered', () => {
    expect(isLiveEditable('pattern', ['width', 'values', 'stepPs', 'after', 'clocked'])).toBe(
      false,
    );
    for (const key of ['values', 'stepPs', 'after', 'clocked'])
      expect(isLiveEditable('pattern', [key]), key).toBe(false);
  });

  it('offers width to batch edits, since it changes the output pin', () => {
    expect(paramKeysFor('pattern', { width: 1 }).has('width')).toBe(true);
  });
});
