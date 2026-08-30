import { describe, expect, it } from 'vitest';
import type { Theme } from '../theme';
import { makeTestTheme } from '../theme.fixture';
import { boxLayout, busSlashGeometry } from './chip';
import type { GeometryInput } from './symbol';

const G = 8;

const theme: Theme = makeTestTheme();

const dffPins: GeometryInput['pins'] = [
  { name: 'd', dir: 'in', width: 1, role: 'data', order: 0 },
  { name: 'clk', dir: 'in', width: 1, role: 'clock', order: 1 },
  { name: 'pre', dir: 'in', width: 1, role: 'asyncSet', order: 2 },
  { name: 'clr', dir: 'in', width: 1, role: 'asyncClear', order: 3 },
  { name: 'q', dir: 'out', width: 1, role: 'data', order: 0 },
  { name: 'qn', dir: 'out', width: 1, role: 'data', order: 1 },
];

describe('boxLayout', () => {
  it('reserves a header band clear of the pins and stacks 2G-pitch rows below it', () => {
    const layout = boxLayout({ kind: 'dff', params: {}, pins: dffPins, name: 'DFF' }, theme);
    // 4 left pins is the taller side; rows at 2G pitch, one pitch below the header.
    const firstPinY = layout.headerH + 2 * G;
    expect(layout.left[0]!.y).toBe(firstPinY);
    expect(layout.left[3]!.y).toBe(firstPinY + 3 * 2 * G);
    expect(layout.height).toBe(firstPinY + 3 * 2 * G + G);
    expect(layout.headerH % G).toBe(0);
    expect(layout.headerH).toBeGreaterThanOrEqual(layout.nameFontPx);
  });

  it('width fits the widest facing pin-label pair with the 1G gap and 2G stubs', () => {
    const layout = boxLayout({ kind: 'dff', params: {}, pins: dffPins, name: 'DFF' }, theme);
    expect(layout.boxLeft).toBe(2 * G);
    expect(layout.width - layout.boxRight).toBe(2 * G);
    // Interior width covers widest-left + widest-right label + 1G gap + padding.
    const label = (t: string) => t.length * 13 * 0.6;
    expect(layout.boxRight - layout.boxLeft).toBeGreaterThanOrEqual(label('clk') + label('qn') + G);
  });

  it('width is at least 2G plus 1G stub margin each side', () => {
    const layout = boxLayout(
      {
        kind: 'dff',
        params: {},
        pins: [
          { name: 'a', dir: 'in', width: 1, role: 'data', order: 0 },
          { name: 'y', dir: 'out', width: 1, role: 'data', order: 0 },
        ],
        name: 'X',
      },
      theme,
    );
    expect(layout.width).toBeGreaterThanOrEqual(2 * G + 2 * 2 * G);
  });

  it('grows width to fit a long name, rounded up to the grid', () => {
    const short = boxLayout({ kind: 'chip', params: {}, pins: [], name: 'X' }, theme);
    const long = boxLayout(
      { kind: 'chip', params: {}, pins: [], name: 'RIPPLE_ADDER_8BIT' },
      theme,
    );
    expect(long.width).toBeGreaterThan(short.width);
    expect(long.width % G).toBe(0);
  });

  it('a lane-expanded bit label (bracket notation) both passes through and grows box width for it, not the plain name', () => {
    const plainPins: GeometryInput['pins'] = [
      { name: 'd0', dir: 'in', width: 1, role: 'data', order: 0 },
    ];
    const labeledPins: GeometryInput['pins'] = [
      { name: 'd00', dir: 'in', width: 1, role: 'data', order: 0, label: 'd0[0]' },
    ];
    const plain = boxLayout({ kind: 'mux', params: {}, pins: plainPins, name: 'MUX' }, theme);
    const labeled = boxLayout({ kind: 'mux', params: {}, pins: labeledPins, name: 'MUX' }, theme);
    // The label carries into the laid-out pin (display-only; wiring stays name).
    expect(labeled.left[0]!.name).toBe('d00');
    expect(labeled.left[0]!.label).toBe('d0[0]');
    // A longer bracket label ("d0[0]") needs more room than the bare name
    // ("d0") did -- the box must size off the label, not the wiring name.
    expect(labeled.width).toBeGreaterThanOrEqual(plain.width);
  });

  it('mux/demux/decoder/encoder share a minimum body width so collapsing pins never shrinks the box', () => {
    // Same short name/pin shape on both -- isolates the coder-family floor
    // from incidental differences in label/name length. A tiny mux
    // (collapsed select/data) still gets at least as much width as a
    // decoder needs for the same content, so it doesn't visibly resize as
    // pinView expand/collapse checkboxes are toggled.
    const pins: GeometryInput['pins'] = [
      { name: 'a', dir: 'in', width: 2, role: 'data', order: 0 },
      { name: 'y', dir: 'out', width: 1, role: 'data', order: 0 },
    ];
    const tinyMux = boxLayout({ kind: 'mux', params: {}, name: 'X', pins }, theme);
    const tinyDecoder = boxLayout({ kind: 'decoder', params: {}, name: 'X', pins }, theme);
    const plainDff = boxLayout({ kind: 'dff', params: {}, name: 'X', pins }, theme);
    expect(tinyMux.width).toBeGreaterThanOrEqual(tinyDecoder.width);
    // The floor is coder-family-specific: an unrelated box kind with the
    // exact same content stays at its natural (smaller) content-driven
    // width, not widened to match.
    expect(plainDff.width).toBeLessThan(tinyMux.width);
  });

  it('every pin lands on a grid intersection', () => {
    const layout = boxLayout({ kind: 'dff', params: {}, pins: dffPins, name: 'DFF' }, theme);
    for (const p of layout.pins.values()) {
      expect(p.x % G).toBeCloseTo(0, 6);
      expect(p.y % G).toBeCloseTo(0, 6);
    }
  });

  it('pin order top-to-bottom follows declared order', () => {
    const layout = boxLayout({ kind: 'dff', params: {}, pins: dffPins, name: 'DFF' }, theme);
    expect(layout.left.map((p) => p.name)).toEqual(['d', 'clk', 'pre', 'clr']);
    expect(layout.right.map((p) => p.name)).toEqual(['q', 'qn']);
    // Monotonically increasing y top-to-bottom.
    for (let i = 1; i < layout.left.length; i++)
      expect(layout.left[i]!.y).toBeGreaterThan(layout.left[i - 1]!.y);
  });
});

describe('boxLayout select pins (M6.6 mux/demux selSide)', () => {
  const muxPins: GeometryInput['pins'] = [
    { name: 'd0', dir: 'in', width: 1, role: 'data', order: 0 },
    { name: 'd1', dir: 'in', width: 1, role: 'data', order: 1 },
    { name: 's0', dir: 'in', width: 1, role: 'select', order: 2 },
    { name: 'y', dir: 'out', width: 1, role: 'data', order: 0 },
  ];

  it('defaults select pins to the bottom edge, on grid, stub extending past the box', () => {
    const layout = boxLayout({ kind: 'mux', params: {}, pins: muxPins, name: 'MUX' }, theme);
    expect(layout.top).toHaveLength(0);
    expect(layout.bottom).toHaveLength(1);
    const s0 = layout.bottom[0]!;
    expect(s0.name).toBe('s0');
    expect(s0.y).toBe(layout.height);
    expect(s0.x! % G).toBe(0);
    const tip = layout.pins.get('s0')!;
    expect(tip.x % G).toBe(0);
    expect(tip.y).toBe(layout.height + 2 * G);
  });

  it('routes select pins to the top edge when selSide is top', () => {
    const layout = boxLayout(
      { kind: 'mux', params: { selSide: 'top' }, pins: muxPins, name: 'MUX' },
      theme,
    );
    expect(layout.bottom).toHaveLength(0);
    expect(layout.top).toHaveLength(1);
    const s0 = layout.top[0]!;
    expect(s0.y).toBe(0);
    const tip = layout.pins.get('s0')!;
    expect(tip.y).toBe(-2 * G);
    // Bounds extend upward to include the stub past the box's own top edge.
    expect(layout.bounds.y).toBe(-2 * G);
  });

  it('grows body width to fit multiple select pins at 2G pitch', () => {
    const wideSelect: GeometryInput['pins'] = [
      { name: 'd0', dir: 'in', width: 1, role: 'data', order: 0 },
      { name: 'd1', dir: 'in', width: 1, role: 'data', order: 1 },
      { name: 's0', dir: 'in', width: 1, role: 'select', order: 2 },
      { name: 's1', dir: 'in', width: 1, role: 'select', order: 3 },
      { name: 's2', dir: 'in', width: 1, role: 'select', order: 4 },
      { name: 'y', dir: 'out', width: 1, role: 'data', order: 0 },
    ];
    const layout = boxLayout({ kind: 'mux', params: {}, pins: wideSelect, name: 'X' }, theme);
    expect(layout.bottom).toHaveLength(3);
    expect(layout.width).toBeGreaterThanOrEqual(2 * G * (3 + 1));
    for (const p of layout.bottom) expect(p.x! % G).toBe(0);
    // Strictly increasing left-to-right, one pitch apart.
    expect(layout.bottom[1]!.x! - layout.bottom[0]!.x!).toBe(2 * G);
    expect(layout.bottom[2]!.x! - layout.bottom[1]!.x!).toBe(2 * G);
    // MSB leftmost, so the select lines read as a binary number.
    expect(layout.bottom.map((p) => p.name)).toEqual(['s2', 's1', 's0']);
  });

  it('reserves a header-sized footer band (not the plain 1G margin) so the last data row clears the bottom select label', () => {
    const withSel = boxLayout({ kind: 'mux', params: {}, pins: muxPins, name: 'MUX' }, theme);
    const noSel = boxLayout(
      { kind: 'chip', params: {}, pins: muxPins.filter((p) => p.role !== 'select'), name: 'MUX' },
      theme,
    );
    expect(withSel.footerH).toBe(withSel.headerH);
    expect(withSel.footerH).toBeGreaterThan(G);
    expect(noSel.footerH).toBe(G);
    // The last data row (d1, right after d0/d1) sits a full footerH clear of
    // the bottom edge, not just the plain 1G margin.
    const lastData = withSel.left[withSel.left.length - 1]!;
    expect(withSel.height - lastData.y).toBe(withSel.footerH);
  });

  it('moves the name to the footer when select pins occupy the top edge, freeing the header', () => {
    const bottom = boxLayout({ kind: 'mux', params: {}, pins: muxPins, name: 'MUX' }, theme);
    const top = boxLayout(
      { kind: 'mux', params: { selSide: 'top' }, pins: muxPins, name: 'MUX' },
      theme,
    );
    expect(bottom.nameAtBottom).toBe(false);
    expect(top.nameAtBottom).toBe(true);
    // With no select pins at all there's nothing to swap for, even if the
    // (unused) selSide param says top.
    const noSelTop = boxLayout(
      {
        kind: 'chip',
        params: { selSide: 'top' },
        pins: muxPins.filter((p) => p.role !== 'select'),
        name: 'X',
      },
      theme,
    );
    expect(noSelTop.nameAtBottom).toBe(false);
  });
});

describe('busSlashGeometry', () => {
  it('places the badge offset perpendicular from the wire midpoint', () => {
    const geo = busSlashGeometry({ x: 0, y: 40 }, { x: 80, y: 40 }, G);
    const mid = { x: 40, y: 40 };
    // Horizontal wire -> badge should be offset vertically, not along the wire.
    expect(geo.badgePos.x).toBeCloseTo(mid.x, 6);
    expect(Math.abs(geo.badgePos.y - mid.y)).toBeCloseTo(G, 6);
  });

  it('slash mark is centered on the wire midpoint', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 100, y: 0 };
    const geo = busSlashGeometry(a, b, G);
    const slashMid = { x: (geo.slashA.x + geo.slashB.x) / 2, y: (geo.slashA.y + geo.slashB.y) / 2 };
    expect(slashMid.x).toBeCloseTo(50, 6);
    expect(slashMid.y).toBeCloseTo(0, 6);
  });
});

describe('boxLayout row pitch follows the pin-label size', () => {
  const input: GeometryInput = { kind: 'dff', params: {}, pins: dffPins, name: 'DFF' };

  it('keeps the 2G pitch at the default text size', () => {
    const layout = boxLayout(input, theme);
    expect(layout.left[1]!.y - layout.left[0]!.y).toBe(2 * G);
  });

  it('grows the pitch past the label height at presentation scale', () => {
    const big = boxLayout(input, { ...theme, glyphText: 26 });
    const pitch = big.left[1]!.y - big.left[0]!.y;
    expect(pitch).toBeGreaterThan(26);
    expect(pitch % G).toBe(0);
  });

  it('widens the select-pin pitch by the same rule', () => {
    const sel: GeometryInput = {
      kind: 'mux',
      params: {},
      pins: [
        { name: 'd0', dir: 'in', width: 1, role: 'data', order: 0 },
        { name: 'd1', dir: 'in', width: 1, role: 'data', order: 1 },
        { name: 'y', dir: 'out', width: 1, role: 'data', order: 0 },
        { name: 's0', dir: 'in', width: 1, role: 'select', order: 0 },
        { name: 's1', dir: 'in', width: 1, role: 'select', order: 1 },
      ],
      name: 'MUX',
    };
    expect(boxLayout(sel, theme).bottom[1]!.x! - boxLayout(sel, theme).bottom[0]!.x!).toBe(2 * G);
    const big = boxLayout(sel, { ...theme, glyphText: 26 });
    expect(big.bottom[1]!.x! - big.bottom[0]!.x!).toBeGreaterThan(2 * G);
  });
});
