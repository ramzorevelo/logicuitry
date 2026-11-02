import { describe, expect, it } from 'vitest';
import { formatEngineering, parseEngineering } from './engineering';

describe('formatEngineering', () => {
  it.each<[number, string, string]>([
    [1000, 'Ω', '1 kΩ'],
    [4700, 'Ω', '4.7 kΩ'],
    [820_000, 'Ω', '820 kΩ'],
    [1e6, 'Ω', '1 MΩ'],
    [100, 'Ω', '100 Ω'],
    [0, 'Ω', '0 Ω'],
    [1e-6, 'F', '1 µF'],
    [1e-7, 'F', '100 nF'],
    [1e-12, 'F', '1 pF'],
    [999_960, 'Ω', '1 MΩ'],
    [1234.5, 'Ω', '1.23 kΩ'],
  ])('%s %s -> %s', (v, unit, out) => {
    expect(formatEngineering(v, unit)).toBe(out);
  });

  it('keeps sub-unit values whole when asked', () => {
    expect(formatEngineering(0.7211, 'Hz', 0)).toBe('0.721 Hz');
    expect(formatEngineering(6857, 'Hz', 0)).toBe('6.86 kHz');
  });
});

describe('parseEngineering', () => {
  it.each<[string, number]>([
    ['4.7k', 4700],
    ['4k7', 4700],
    ['1M', 1e6],
    ['470', 470],
    ['100n', 1e-7],
    ['10u', 1e-5],
    ['2.2 µF', 2.2e-6],
    ['1 kΩ', 1000],
    ['10 ohm', 10],
    ['1e-6', 1e-6],
    ['.5k', 500],
  ])('%s -> %s', (text, v) => {
    expect(parseEngineering(text)).toBeCloseTo(v, 15);
  });

  it.each(['', 'k', 'abc', '1.2.3', '-5', '1x'])('rejects %j', (text) => {
    expect(parseEngineering(text)).toBeNaN();
  });

  it('reads prefixed values exactly, so a saved file holds 8200, not 8199.999', () => {
    expect(parseEngineering('8.2k')).toBe(8200);
    expect(parseEngineering('4.7u')).toBe(4.7e-6);
    expect(parseEngineering('3k3')).toBe(3300);
  });

  it('round-trips what it formats', () => {
    for (const v of [1, 1000, 4700, 1e6, 1e-6, 2.2e-9])
      expect(parseEngineering(formatEngineering(v, 'Ω'))).toBeCloseTo(v, 15);
  });
});
