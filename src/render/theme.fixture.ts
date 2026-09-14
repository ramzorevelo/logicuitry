// Test-only Theme literal. Glyph geometry must stay Node-testable without
// readTheme(), which needs a DOM; every test that draws shares this one shape
// so widening Theme is a single edit rather than seven.

import type { Theme } from './theme';

export function makeTestTheme(overrides: Partial<Theme> = {}): Theme {
  return {
    name: 'light',
    appearance: 'light',
    colors: {
      paper: '#000',
      surface: '#fff',
      ink: '#111',
      muted: '#888',
      line: '#ccc',
      accent: '#06c',
      accent2: '#999',
      accent3: '#0cf',
      accentFill: '#cde',
      warn: '#c60',
      ok: '#0a0',
      signalMixed: '#06c',
      kmapGroups: [],
    },
    ledColors: {
      red: '#e03127',
      green: '#2fb24c',
      blue: '#2f7de0',
      yellow: '#e3c11c',
      orange: '#e8791d',
      cyan: '#21b4c4',
      magenta: '#d4419a',
      white: '#f2f3f7',
    },
    ledEmission: {
      red: '#e03127',
      green: '#2fb24c',
      blue: '#2f7de0',
      yellow: '#e3c11c',
      orange: '#e8791d',
      cyan: '#21b4c4',
      magenta: '#d4419a',
      white: '#ffd9a0',
    },
    fonts: { ui: 'sans', mono: 'mono', display: 'sans' },
    strokes: { min: 1.5, wire: 2, bus: 4, cornerRadius: 0 },
    glyph: {
      bodyFill: 'surface',
      bodyPattern: 'none',
      boxCorner: 'sharp',
      relief: 'flat',
      rimLine: 'none',
      corners: 'none',
      emphasis: 'none',
      pinCap: 'butt',
      junctionDot: 'circle',
    },
    wave: {
      surface: '#fff',
      ink: '#111',
      muted: '#888',
      traceHigh: '#06c',
      traceWeight: 1,
      gridDensity: 1,
      fillUnderHigh: true,
    },
    lod: 'full',
    canvasTextMin: 13,
    glyphText: 13,
    gridSchematic: 8,
    presentation: false,
    ...overrides,
  };
}
