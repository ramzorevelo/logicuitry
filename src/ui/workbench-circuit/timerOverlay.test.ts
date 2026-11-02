import { describe, expect, it } from 'vitest';
import {
  nearestSliderIndex,
  parseTimerFields,
  parseTimerValue,
  SLIDER_OHMS,
  sliderKey,
  timerFieldText,
} from './timerOverlay';
import { clampParamValue, isLiveEditable, paramKeysFor, paramLiveness } from './paramSpecs';

describe('timer overlay fields', () => {
  it('shows the stored values as a person would type them', () => {
    expect(timerFieldText({ mode: 'monostable', r1: 4700, r2: 1e6, c: 1e-7 })).toEqual({
      mode: 'monostable',
      r1: '4.7k',
      r2: '1M',
      c: '100n',
    });
  });

  it('shows every digit a value has, so an untouched field commits it unchanged', () => {
    for (const v of [4753, 1.234e-6, 8200, 1e6, 3.3e-9, 123_456]) {
      const text = timerFieldText({ r1: v, c: 1e-6 }).r1;
      expect(parseTimerFields({ mode: 'astable', r1: text, r2: '1M', c: '1u' })!['r1']).toBe(v);
    }
    expect(timerFieldText({ r1: 4753 }).r1).toBe('4.753k');
  });

  it('commits parsed values and refuses anything out of range', () => {
    expect(parseTimerFields({ mode: 'astable', r1: '1k', r2: '8.2k', c: '10u' })).toEqual({
      mode: 'astable',
      r1: 1000,
      r2: 8200,
      c: 1e-5,
    });
    expect(parseTimerFields({ mode: 'astable', r1: '1k', r2: '20M', c: '10u' })).toBeNull();
    expect(parseTimerValue('c', '0')).toBeNull();
    expect(parseTimerValue('c', '2m')).toBeNull();
    expect(parseTimerValue('r1', '0')).toBe(0);
    expect(parseTimerValue('r1', 'abc')).toBeNull();
  });

  it('slides R2 on an astable, R on a monostable, nothing on a bistable', () => {
    expect(sliderKey('astable')).toBe('r2');
    expect(sliderKey('monostable')).toBe('r1');
    expect(sliderKey('bistable')).toBeNull();
  });

  it('walks exact E12 values from 100 ohm to 10 Mohm', () => {
    expect(SLIDER_OHMS[0]).toBe(100);
    expect(SLIDER_OHMS.at(-1)).toBe(10_000_000);
    expect(SLIDER_OHMS).toContain(4_700);
    expect(SLIDER_OHMS).toContain(820_000);
    expect(SLIDER_OHMS.every((v) => Number.isInteger(v))).toBe(true);
    expect(SLIDER_OHMS[nearestSliderIndex(1e6)]).toBe(1e6);
    expect(SLIDER_OHMS[nearestSliderIndex(5000)]).toBe(4700);
    expect(nearestSliderIndex(0)).toBe(0);
  });
});

describe('timer params in the overlay and batch edits', () => {
  it('edits R and C live and the mode only unpowered', () => {
    expect(paramLiveness('timer555', 'r2')).toBe('stimulus');
    expect(paramLiveness('timer555', 'c')).toBe('stimulus');
    expect(paramLiveness('timer555', 'mode')).toBe('structural');
    expect(isLiveEditable('timer555', ['r1', 'r2', 'c'])).toBe(true);
  });

  it('offers mode, R1, R2 and C, and refuses them on any other kind', () => {
    expect([...paramKeysFor('timer555', {})]).toEqual(['mode', 'r1', 'r2', 'c']);
    expect(clampParamValue('clock', 'r2', 1000)).toBeNull();
    expect(clampParamValue('timer555', 'mode', 'bistable')).toBe('bistable');
    expect(clampParamValue('timer555', 'mode', 'other')).toBeNull();
    expect(clampParamValue('timer555', 'r1', 1e9)).toBe(10e6);
  });
});
