import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS, mergePrefs } from './prefs';

describe('mergePrefs', () => {
  it('returns the defaults for a missing or non-object blob', () => {
    expect(mergePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(mergePrefs('nonsense')).toEqual(DEFAULT_PREFS);
  });

  it('keeps known fields and ignores unknown ones', () => {
    const out = mergePrefs({ alwaysShowPinBusWidth: true, somethingRemoved: 42 });
    expect(out.alwaysShowPinBusWidth).toBe(true);
    expect(out.autosave).toBe(DEFAULT_PREFS.autosave);
    expect(out).not.toHaveProperty('somethingRemoved');
  });

  it('falls back per field on a wrong type rather than discarding the blob', () => {
    const out = mergePrefs({ autosave: 'yes', hideAnswersDefault: false });
    expect(out.autosave).toBe(DEFAULT_PREFS.autosave);
    expect(out.hideAnswersDefault).toBe(false);
  });

  it('clamps the glitch threshold so the scan can never be disabled by a bad value', () => {
    expect(mergePrefs({ glitchThresholdNs: 0 }).glitchThresholdNs).toBe(1);
    expect(mergePrefs({ glitchThresholdNs: 1e9 }).glitchThresholdNs).toBe(10000);
    expect(mergePrefs({ glitchThresholdNs: Number.NaN }).glitchThresholdNs).toBe(
      DEFAULT_PREFS.glitchThresholdNs,
    );
  });

  it('rejects a theme name that is not currently selectable', () => {
    expect(mergePrefs({ defaultTheme: 'dark' }).defaultTheme).toBe('dark');
    expect(mergePrefs({ defaultTheme: 'not-a-theme' }).defaultTheme).toBe(
      DEFAULT_PREFS.defaultTheme,
    );
  });

  it('accepts only the two timing models', () => {
    expect(mergePrefs({ timingModel: 'datasheet' }).timingModel).toBe('datasheet');
    expect(mergePrefs({ timingModel: 'wishful' }).timingModel).toBe('ideal');
  });
});

describe('fitOnOpen', () => {
  it('defaults on, and survives a blob that predates it', () => {
    expect(DEFAULT_PREFS.fitOnOpen).toBe(true);
    expect(mergePrefs({ autosave: false }).fitOnOpen).toBe(true);
  });

  it('keeps an explicit off', () => {
    expect(mergePrefs({ fitOnOpen: false }).fitOnOpen).toBe(false);
  });
});
