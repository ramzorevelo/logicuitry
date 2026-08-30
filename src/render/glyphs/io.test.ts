import { describe, expect, it } from 'vitest';
import {
  buttonCapCircle,
  buttonLayout,
  clockLayout,
  dipBankLayout,
  dipCellIndexAt,
  ledBankLayout,
  ledLayout,
  portLayout,
  switchLayout,
} from './io';
import { resolveComponentPins, symbolBounds } from './symbol';
import type { Component } from '../../core/model/types';
import type { Theme } from '../theme';
import { makeTestTheme } from '../theme.fixture';

const glyphTheme: Theme = makeTestTheme({
  strokes: { min: 1.5, wire: 2, bus: 4, cornerRadius: 3 },
});

const G = 8;

function expectGridAligned(pins: Map<string, { x: number; y: number }>): void {
  for (const p of pins.values()) {
    expect(p.x % G).toBeCloseTo(0, 6);
    expect(p.y % G).toBeCloseTo(0, 6);
  }
}

describe('switchLayout', () => {
  it('housing height matches a 2-bit DIP-bank (2 * 2G row pitch)', () => {
    const l = switchLayout(G, 'y');
    expect(l.housing.h).toBeCloseTo(4 * G, 6);
    expect(l.housing.h).toBeCloseTo(dipBankLayout(G, 2, ['y0', 'y1']).housing.h, 6);
  });

  it('the lever (the part that actually slides on/off) is square', () => {
    const l = switchLayout(G, 'y');
    expect(l.lever.w).toBeCloseTo(l.lever.h, 6);
    expect(l.lever.h).toBeCloseTo(1.5 * G, 6);
  });

  it('housing width is just the lever plus a 0.5G margin each side', () => {
    const l = switchLayout(G, 'y');
    expect(l.housing.w).toBeCloseTo(l.lever.w + G, 6);
  });

  it('the output pin lands on a grid intersection despite the half-grid housing center', () => {
    const l = switchLayout(G, 'y');
    expectGridAligned(l.pins);
  });
});

describe('buttonLayout', () => {
  it('is a square 3G x 3G housing', () => {
    const btn = buttonLayout(G, 'y');
    expect(btn.housing.w).toBeCloseTo(btn.housing.h, 6);
    expect(btn.housing.h).toBeCloseTo(3 * G, 6);
    expectGridAligned(btn.pins);
  });

  it('the cap circle sits centered in the housing with a 0.5G margin', () => {
    const btn = buttonLayout(G, 'y');
    const cap = buttonCapCircle(btn);
    expect(cap.cx).toBeCloseTo(btn.housing.w / 2, 6);
    expect(cap.cy).toBeCloseTo(btn.housing.h / 2, 6);
    expect(cap.r).toBeCloseTo(G, 6);
    expect(cap.cx - cap.r).toBeGreaterThanOrEqual(btn.housing.x);
    expect(cap.cy - cap.r).toBeGreaterThanOrEqual(btn.housing.y);
  });
});

describe('ledLayout', () => {
  it('uses the NOT/BUF H = 4G convention plus arrow headroom', () => {
    const l = ledLayout(G, 'a');
    expect(l.H).toBe(4 * G);
    expect(l.topPad).toBe(G);
    expect(l.bounds.h).toBe(l.topPad + l.H);
  });

  // Dead space in the bounds is dead space in the hit box, and an LED has no
  // output pin to reserve stub room for.
  it('stops the bounds at the cathode bar', () => {
    const l = ledLayout(G, 'a');
    const cathodeX = 2 * G + 0.9 * l.H;
    expect(l.bounds.w).toBeGreaterThanOrEqual(cathodeX);
    expect(l.bounds.w - cathodeX).toBeLessThan(G);
  });

  it('input pin lands on the grid', () => {
    const l = ledLayout(G, 'a');
    expectGridAligned(l.pins);
  });
});

describe('clockLayout', () => {
  it('is at least the spec minimum 4G x 4G box', () => {
    const l = clockLayout(G, 'y');
    expect(l.boxW).toBeGreaterThanOrEqual(4 * G);
    expect(l.boxH).toBeGreaterThanOrEqual(4 * G);
  });

  it('output pin lands cleanly on the grid with no rounding needed', () => {
    const l = clockLayout(G, 'y');
    expectGridAligned(l.pins);
    expect(l.tipX).toBe(8 * G);
  });
});

describe('dipBankLayout', () => {
  it('housing height is a function of width, at 2G pitch per bit', () => {
    for (const width of [2, 3, 4, 8]) {
      const l = dipBankLayout(G, width, ['y']);
      expect(l.housing.h).toBe(width * 2 * G);
      expect(l.housing.w).toBe(3 * G); // same width as the 1-bit switch housing
    }
  });

  it('the shared output pin lands on the grid', () => {
    const l = dipBankLayout(G, 4, ['y']);
    expectGridAligned(l.pins);
  });
});

describe('dipCellIndexAt', () => {
  it('the MSB is topmost: row 0 maps to the highest bit', () => {
    const width = 4;
    const l = dipBankLayout(G, width, ['y']);
    expect(dipCellIndexAt(l, 0)).toBe(3); // top row -> MSB
    expect(dipCellIndexAt(l, 2 * G)).toBe(2);
    expect(dipCellIndexAt(l, 4 * G)).toBe(1);
    expect(dipCellIndexAt(l, 6 * G)).toBe(0); // bottom row -> bit 0
  });

  it('a Y inside a cell resolves to that cell, not just the boundary', () => {
    const l = dipBankLayout(G, 4, ['y']);
    expect(dipCellIndexAt(l, 0.5 * G)).toBe(3);
    expect(dipCellIndexAt(l, 6.9 * G)).toBe(0);
  });

  it('outside the housing is undefined', () => {
    const l = dipBankLayout(G, 4, ['y']);
    expect(dipCellIndexAt(l, -1)).toBeUndefined();
    expect(dipCellIndexAt(l, l.housing.h)).toBeUndefined();
    expect(dipCellIndexAt(l, l.housing.h + G)).toBeUndefined();
  });
});

describe('ledBankLayout (M6.6 LED array)', () => {
  it('housing height is a function of width, at its own (taller, for per-cell arrows) row pitch than the DIP bank', () => {
    for (const width of [2, 3, 4, 8]) {
      const l = ledBankLayout(G, width, ['a']);
      const sw = dipBankLayout(G, width, ['a']);
      expect(l.housing.h).toBe(width * l.cellH);
      expect(l.cellH).toBeGreaterThan(sw.cellH);
      expect(l.housing.w).toBeGreaterThan(sw.housing.w);
    }
  });

  it("pin sits on the input (left) side, unlike the DIP bank's output (right) side", () => {
    const led = ledBankLayout(G, 4, ['a']);
    const sw = dipBankLayout(G, 4, ['y']);
    expect(led.pins.get('a')!.x).toBe(0);
    expect(sw.pins.get('y')!.x).toBeGreaterThan(led.housing.x);
    expect(led.housing.x).toBeGreaterThan(0); // housing sits right of the stub, mirrored from the switch
  });

  it('the shared input pin lands on the grid', () => {
    const l = ledBankLayout(G, 4, ['a']);
    expectGridAligned(l.pins);
  });

  it('dipCellIndexAt (shared bank geometry) still resolves MSB-topmost against a LED bank', () => {
    const l = ledBankLayout(G, 4, ['a']);
    expect(dipCellIndexAt(l, 0)).toBe(3);
    expect(dipCellIndexAt(l, 3.5 * l.cellH)).toBe(0);
  });
});

describe('bank layout with lane-expanded pins (M6.6 Phase 6)', () => {
  it('dipBankLayout gives each name its own on-grid pin at its own row center', () => {
    const names = ['y3', 'y2', 'y1', 'y0']; // MSB-topmost, matching busPins.expandPin order
    const l = dipBankLayout(G, 4, names);
    expect(l.pins.size).toBe(4);
    expectGridAligned(l.pins);
    // Row 0 (top) -> y3 (MSB); rows descend toward y0 (LSB, bottom).
    const ys = names.map((n) => l.pins.get(n)!.y);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    expect(l.pins.get('y3')!.y).toBeLessThan(l.pins.get('y0')!.y);
    // Every expanded pin still shares the same stub tip x (same edge).
    const xs = names.map((n) => l.pins.get(n)!.x);
    expect(new Set(xs).size).toBe(1);
  });

  it('ledBankLayout mirrors the same per-row expansion on its own (left) side', () => {
    const names = ['a1', 'a0'];
    const l = ledBankLayout(G, 2, names);
    expect(l.pins.size).toBe(2);
    expectGridAligned(l.pins);
    expect(l.pins.get('a1')!.y).toBeLessThan(l.pins.get('a0')!.y);
  });

  it('a single collapsed name still gets one shared pin regardless of width', () => {
    const l = dipBankLayout(G, 4, ['y']);
    expect(l.pins.size).toBe(1);
    expect(l.pins.get('y')).toBeDefined();
  });
});

describe('portLayout (pinView expand)', () => {
  it('a single collapsed name gets one pin at the tip', () => {
    const l = portLayout(G, ['y'], 'in1', true, 13);
    expect(l.pins.size).toBe(1);
  });

  it('multiple names each get their own row, bit 0 topmost, same tip x', () => {
    const l = portLayout(G, ['y0', 'y1'], 'in1', true, 13);
    expect(l.pins.size).toBe(2);
    expect(l.pins.get('y0')!.y).toBeLessThan(l.pins.get('y1')!.y);
    expect(l.pins.get('y0')!.x).toBe(l.pins.get('y1')!.x);
    expect(l.height).toBeGreaterThan(portLayout(G, ['y'], 'in1', true, 13).height);
  });
});

describe('probe/output primitives lane-expand through to the real glyph geometry', () => {
  // End-to-end (primitive.pins() -> registered glyph geometry), not just the
  // layout helper in isolation -- this is the exact path a pinView-expanded
  // probe/output needs a second wireable pin through in the live app.
  const comp = (kind: string, params: Record<string, unknown>): Component =>
    ({ id: 'c1', kind, pos: { x: 0, y: 0 }, params }) as Component;

  it('a pinView-expanded probe exposes one pin per bit', () => {
    const c = comp('probe', { width: 2, pinView: 'a=expanded' });
    const specs = resolveComponentPins(c);
    expect(specs.map((p) => p.name).sort()).toEqual(['a0', 'a1']);
    const geo = symbolBounds(c, glyphTheme);
    expect(geo.pins.size).toBe(2);
    expect(geo.pins.get('a0')).toBeDefined();
    expect(geo.pins.get('a1')).toBeDefined();
  });

  it('a pinView-expanded Out port exposes one pin per bit', () => {
    const c = comp('outport', { width: 2, pinView: 'a=expanded' });
    const geo = symbolBounds(c, glyphTheme);
    expect(geo.pins.size).toBe(2);
    expect(geo.pins.get('a0')).toBeDefined();
    expect(geo.pins.get('a1')).toBeDefined();
  });

  it('a pinView-expanded In port exposes one pin per bit', () => {
    const c = comp('inport', { width: 2, pinView: 'y=expanded' });
    const geo = symbolBounds(c, glyphTheme);
    expect(geo.pins.size).toBe(2);
    expect(geo.pins.get('y0')).toBeDefined();
    expect(geo.pins.get('y1')).toBeDefined();
  });

  it('a collapsed (un-expanded) width>1 probe/port still exposes exactly one pin', () => {
    expect(symbolBounds(comp('probe', { width: 2 }), glyphTheme).pins.size).toBe(1);
    expect(symbolBounds(comp('outport', { width: 2 }), glyphTheme).pins.size).toBe(1);
    expect(symbolBounds(comp('inport', { width: 2 }), glyphTheme).pins.size).toBe(1);
  });
});

describe('text-bodied glyphs grow with the glyph text (presentation)', () => {
  const g = 8;
  const names = ['y'];

  it('a port row is 2G at the default text size and doubles when the text does', () => {
    const normal = portLayout(g, names, 'A', true, 13);
    const presentation = portLayout(g, names, 'A', true, 26);
    expect(normal.rowH).toBe(2 * g);
    expect(normal.height).toBe(2 * g);
    // The reported bug: the label scaled but its row did not, so the text
    // overflowed a body too short to hold it.
    expect(presentation.rowH).toBe(4 * g);
    expect(presentation.height).toBe(4 * g);
  });

  it('every row pitch stays a whole number of grid units, so pins stay on grid', () => {
    for (const fontPx of [13, 16, 20, 26, 32]) {
      const l = portLayout(g, ['y0', 'y1', 'y2'], 'A', true, fontPx);
      expect(l.rowH % g).toBe(0);
      for (const pin of l.pins.values()) expect(pin.y % (g / 2)).toBe(0);
    }
  });

  it('the width already followed the text, and still does', () => {
    const narrow = portLayout(g, names, 'A', true, 13);
    const wide = portLayout(g, names, 'A', true, 26);
    expect(wide.bounds.w).toBeGreaterThan(narrow.bounds.w);
  });
});

describe('port/tag row band grows around the pin, not below it', () => {
  it('never moves the pin when the text scales', () => {
    for (const fontPx of [13, 19.5, 26]) {
      const l = portLayout(G, ['y'], 'in1', true, fontPx);
      expect(l.pinY).toBe(G);
      expect(l.pins.get('y')!.y).toBe(G);
      expect(l.pinY % G).toBe(0);
    }
  });

  it('extends the body equally above and below the pin', () => {
    for (const fontPx of [13, 19.5, 26]) {
      const l = portLayout(G, ['y'], 'in1', true, fontPx);
      const above = l.pinY - l.bounds.y;
      const below = l.bounds.y + l.bounds.h - l.pinY;
      expect(above).toBe(below);
    }
  });

  it('is byte-identical at the default text size', () => {
    const l = portLayout(G, ['y'], 'in1', true, 13);
    expect(l.pinY).toBe(G);
    expect(l.bounds.y).toBe(0);
    expect(l.bounds.h).toBe(2 * G);
  });

  it('keeps every expanded row on the grid, one pitch apart', () => {
    const l = portLayout(G, ['y0', 'y1', 'y2'], 'in1', true, 19.5);
    const ys = ['y0', 'y1', 'y2'].map((n) => l.pins.get(n)!.y);
    expect(ys[0]).toBe(G);
    for (const y of ys) expect(y % G).toBe(0);
    expect(ys[1]! - ys[0]!).toBe(l.rowH);
    expect(ys[2]! - ys[1]!).toBe(l.rowH);
  });
});
