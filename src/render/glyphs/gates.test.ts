import { describe, expect, it } from 'vitest';
import type { Theme } from '../theme';
import { makeTestTheme } from '../theme.fixture';
import {
  GATE_KINDS,
  bareBubbleGeometry,
  bubbleAnchors,
  drawGate,
  gateContainsLocalPoint,
  gateLayout,
  isBareBubble,
  orBackX,
  orBackXSpan,
  type GateKind,
} from './gates';
import { buildLocalGeometry, transformGeometry, worldToLocal } from './symbol';
import type { GeometryInput, Placement } from './symbol';

const G = 8;

// Plain object literal per the module's contract: geometry must be Node-testable
// without readTheme() (which needs the DOM).
const theme: Theme = makeTestTheme();

function pinsFor(kind: GateKind, inputCount: number): GeometryInput['pins'] {
  const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].slice(0, inputCount);
  return [
    ...names.map((name, i) => ({
      name,
      dir: 'in' as const,
      width: 1,
      role: 'data' as const,
      order: i,
    })),
    { name: 'y', dir: 'out' as const, width: 1, role: 'data' as const, order: 0 },
  ];
}

describe('gateLayout', () => {
  it('scales H with input count per 2G*max(2, n)', () => {
    for (const n of [2, 3, 4]) {
      const layout = gateLayout('and', { kind: 'and', params: {}, pins: pinsFor('and', n) }, theme);
      expect(layout.H).toBe(2 * Math.max(2, n) * G);
    }
  });

  it('body scales with arity up to 4 inputs, then freezes at the 4-input size', () => {
    for (const kind of GATE_KINDS.filter((k) => k !== 'not' && k !== 'buf')) {
      const four = gateLayout(kind, { kind, params: {}, pins: pinsFor(kind, 4) }, theme);
      for (const n of [2, 3, 4]) {
        const layout = gateLayout(kind, { kind, params: {}, pins: pinsFor(kind, n) }, theme);
        expect(layout.Hbody).toBe(2 * n * G);
        expect(layout.bodyY0).toBe(0);
      }
      for (const n of [5, 8]) {
        const layout = gateLayout(kind, { kind, params: {}, pins: pinsFor(kind, n) }, theme);
        expect(layout.H).toBe(2 * n * G);
        expect(layout.Hbody).toBe(8 * G);
        expect(layout.bodyY0).toBe((layout.H - 8 * G) / 2);
        // Body width identical to the 4-input layout: only the back extends.
        expect(layout.bodyRightRaw).toBe(four.bodyRightRaw);
        expect(layout.andRectRight).toBe(four.andRectRight);
        expect(layout.andCapRadius).toBe(four.andCapRadius);
      }
    }
  });

  it('AND family: cap is a semicircle spanning the body (radius Hbody/2) at every arity', () => {
    for (const kind of ['and', 'nand'] as const) {
      for (const n of [2, 3, 4, 6]) {
        const layout = gateLayout(kind, { kind, params: {}, pins: pinsFor(kind, n) }, theme);
        expect(layout.andCapRadius).toBe(layout.Hbody / 2);
        expect(layout.bodyRightRaw).toBe(layout.andRectRight + layout.andCapRadius);
      }
    }
  });

  it('params.outputBubble yields the identical layout to the composed kind', () => {
    for (const [base, composed] of [
      ['and', 'nand'],
      ['or', 'nor'],
      ['buf', 'not'],
    ] as const) {
      const n = base === 'buf' ? 1 : 2;
      const withParam = gateLayout(
        base,
        { kind: base, params: { outputBubble: true }, pins: pinsFor(base, n) },
        theme,
      );
      const literal = gateLayout(
        composed,
        { kind: composed, params: {}, pins: pinsFor(composed, n) },
        theme,
      );
      expect(withParam.bubble).toBe(true);
      expect(withParam.outputTipX).toBe(literal.outputTipX);
      expect(withParam.bounds).toEqual(literal.bounds);
    }
  });

  it('gives NOT/BUF a height of 4G with the input on the output axis', () => {
    const layout = gateLayout('not', { kind: 'not', params: {}, pins: pinsFor('not', 1) }, theme);
    expect(layout.H).toBe(4 * G);
    expect(layout.inputYs[0]!.y).toBe(layout.H / 2);
  });

  it('spaces inputs at 2G pitch, y = G(2i+1), symmetric about the centerline', () => {
    for (const n of [2, 3, 4]) {
      const layout = gateLayout(
        'nand',
        { kind: 'nand', params: {}, pins: pinsFor('nand', n) },
        theme,
      );
      const ys = layout.inputYs.map((p) => p.y);
      expect(ys).toEqual(ys.map((_, i) => G * (2 * i + 1)));
      // Symmetric about the body centerline.
      for (let i = 0; i < ys.length; i++)
        expect(ys[i]! - 0).toBeCloseTo(layout.H - ys[ys.length - 1 - i]!, 6);
    }
  });

  it("M6.6 Phase 6: carries each pin's own width through to inputYs/outputWidth", () => {
    const pins: GeometryInput['pins'] = [
      { name: 'a', dir: 'in', width: 3, role: 'data', order: 0 },
      { name: 'b', dir: 'in', width: 3, role: 'data', order: 1 },
      { name: 'y', dir: 'out', width: 3, role: 'data', order: 0 },
    ];
    const layout = gateLayout('and', { kind: 'and', params: { width: 3 }, pins }, theme);
    expect(layout.inputYs.map((p) => p.width)).toEqual([3, 3]);
    expect(layout.outputWidth).toBe(3);
  });

  it('a gate with an expanded lane still resolves per-bit-pin widths (1)', () => {
    // Mirrors what gates.ts's pins() produces once pinView expands 'a'.
    const pins: GeometryInput['pins'] = [
      { name: 'a2', dir: 'in', width: 1, role: 'data', order: 0 },
      { name: 'a1', dir: 'in', width: 1, role: 'data', order: 1 },
      { name: 'a0', dir: 'in', width: 1, role: 'data', order: 2 },
      { name: 'b', dir: 'in', width: 3, role: 'data', order: 3 },
      { name: 'y', dir: 'out', width: 3, role: 'data', order: 0 },
    ];
    const layout = gateLayout('and', { kind: 'and', params: { width: 3 }, pins }, theme);
    expect(layout.inputYs.map((p) => p.width)).toEqual([1, 1, 1, 3]);
  });

  it('an expanded output gets one row per bit pin, each with its own wire-attach position', () => {
    const pins: GeometryInput['pins'] = [
      { name: 'a', dir: 'in', width: 2, role: 'data', order: 0 },
      { name: 'b', dir: 'in', width: 2, role: 'data', order: 1 },
      { name: 'y1', dir: 'out', width: 1, role: 'data', order: 0 },
      { name: 'y0', dir: 'out', width: 1, role: 'data', order: 1 },
    ];
    const layout = gateLayout('and', { kind: 'and', params: { width: 2 }, pins }, theme);
    expect(layout.outputYs.map((p) => p.name)).toEqual(['y1', 'y0']);
    expect(layout.outputYs.every((p) => p.width === 1)).toBe(true);
    // Two distinct rows -- both wires can actually attach, not just the first.
    const ys = layout.outputYs.map((p) => p.y);
    expect(new Set(ys).size).toBe(2);
    expect(layout.pins.has('y1')).toBe(true);
    expect(layout.pins.has('y0')).toBe(true);
    expect(layout.pins.get('y1')).toEqual({ x: layout.outputTipX, y: ys[0] });
    expect(layout.pins.get('y0')).toEqual({ x: layout.outputTipX, y: ys[1] });
  });

  it('single-output layout is unchanged: outputYs is exactly one row at the shape tip', () => {
    const layout = gateLayout('and', { kind: 'and', params: {}, pins: pinsFor('and', 2) }, theme);
    expect(layout.outputYs).toEqual([{ name: 'y', y: layout.outputY, width: 1 }]);
  });

  it('OR/XOR stubs end on the back arc, never short of it or across the gap', () => {
    for (const kind of ['or', 'xor'] as const) {
      const layout = gateLayout(kind, { kind, params: {}, pins: pinsFor(kind, 3) }, theme);
      const x0 = kind === 'xor' ? layout.bodyX0 - 0.15 * layout.Hbody : layout.bodyX0;
      for (const p of layout.inputYs) {
        expect(p.stubEndX).toBeCloseTo(orBackX(x0, layout.Hbody, p.y), 6);
        // XOR stubs stop at the outer arc: never past the main outline's back.
        if (kind === 'xor') expect(p.stubEndX).toBeLessThanOrEqual(layout.bodyX0);
      }
    }
  });

  it('arity >= 5: wing pins sit on the extension (flat back for AND, tiled arc for OR)', () => {
    const and = gateLayout('and', { kind: 'and', params: {}, pins: pinsFor('and', 6) }, theme);
    for (const p of and.inputYs) expect(p.stubEndX).toBe(and.bodyX0);
    const or = gateLayout('or', { kind: 'or', params: {}, pins: pinsFor('or', 6) }, theme);
    for (const p of or.inputYs) {
      expect(p.stubEndX).toBeCloseTo(orBackXSpan(or.bodyX0, or.Hbody, or.bodyY0, p.y), 6);
      // A wing pin's stub never crosses left of the back line's anchor.
      expect(p.stubEndX).toBeGreaterThanOrEqual(or.bodyX0);
    }
    // Pins keep the 2G pitch symmetric about the output centerline.
    const ys = or.inputYs.map((p) => p.y);
    expect(ys).toEqual(ys.map((_, i) => G * (2 * i + 1)));
  });

  it('orBackXSpan folds into the body band: tiles repeat every Hbody, body range matches orBackX', () => {
    const Hbody = 8 * G;
    const bodyY0 = 2 * G;
    for (const y of [0, G, 3 * G, 7 * G]) {
      expect(orBackXSpan(0, Hbody, bodyY0, bodyY0 + y)).toBeCloseTo(orBackX(0, Hbody, y), 9);
      // One full tile up/down lands on the same x.
      expect(orBackXSpan(0, Hbody, bodyY0, bodyY0 + y - Hbody)).toBeCloseTo(
        orBackX(0, Hbody, y),
        9,
      );
    }
  });

  describe('gateContainsLocalPoint (decision 8, M6.5 shape-accurate hit-test)', () => {
    it('a point inside the OR curve hits', () => {
      const layout = gateLayout('or', { kind: 'or', params: {}, pins: pinsFor('or', 2) }, theme);
      const center = { x: (layout.bodyX0 + layout.bodyRightRaw) / 2, y: layout.H / 2 };
      expect(gateContainsLocalPoint(layout, center, false)).toBe(true);
    });

    it('a point inside the bbox but outside the OR curve (the reported case) misses', () => {
      const layout = gateLayout('or', { kind: 'or', params: {}, pins: pinsFor('or', 2) }, theme);
      const y = layout.H / 4;
      const curveX = orBackX(layout.bodyX0, layout.H, y);
      const inGap = { x: curveX - 2, y };
      const pastCurve = { x: curveX + 2, y };
      expect(inGap.x).toBeGreaterThanOrEqual(layout.bounds.x); // still inside the bbox
      expect(gateContainsLocalPoint(layout, inGap, false)).toBe(false);
      expect(gateContainsLocalPoint(layout, pastCurve, false)).toBe(true);
    });

    it('AND: a point past the flat sides but inside the bbox rect hits; past the rounded cap corner misses', () => {
      const layout = gateLayout('and', { kind: 'and', params: {}, pins: pinsFor('and', 2) }, theme);
      const rectRight = layout.bodyX0 + 0.75 * layout.H;
      const capRadius = layout.H / 2;
      expect(gateContainsLocalPoint(layout, { x: layout.bodyX0 + 1, y: 1 }, false)).toBe(true);
      // Just past the cap's radius from its center, still inside layout.bounds
      // (bounds run to bodyRightRaw+2G past the cap), but outside the semicircle.
      const capCorner = { x: rectRight + capRadius * 0.9, y: 1 };
      expect(Math.hypot(capCorner.x - rectRight, capCorner.y - layout.H / 2)).toBeGreaterThan(
        capRadius,
      );
      expect(gateContainsLocalPoint(layout, capCorner, false)).toBe(false);
    });

    it('AND at arity>=3: a point in the extended straight run (behind the frozen cap) hits, and a point at the old scaled-cap radius (now outside the frozen one) misses', () => {
      const layout = gateLayout('and', { kind: 'and', params: {}, pins: pinsFor('and', 6) }, theme);
      const { andRectRight: rectRight, andCapRadius: capRadius } = layout;
      // Midway down the extended straight run on the right edge: inside the
      // frozen-radius capsule, but at H/2 - capRadius it would be past the
      // OLD (H-scaled) semicircle's edge, proving the freeze narrowed it.
      const midRun = { x: rectRight + capRadius - 1, y: layout.H / 2 };
      expect(gateContainsLocalPoint(layout, midRun, false)).toBe(true);
      // A point at the distance the OLD H/2-radius cap would have reached,
      // straight out from the vertical center -- well past the frozen cap.
      const oldCapEdge = { x: rectRight + layout.H / 2 - 1, y: layout.H / 2 };
      expect(oldCapEdge.x).toBeGreaterThan(rectRight + capRadius);
      expect(gateContainsLocalPoint(layout, oldCapEdge, false)).toBe(false);
    });

    it('NOT: a point just inside the apex hits; just above the top edge near it misses', () => {
      const layout = gateLayout('not', { kind: 'not', params: {}, pins: pinsFor('not', 1) }, theme);
      const nearApex = { x: layout.bodyRightRaw - 2, y: layout.H / 2 };
      expect(gateContainsLocalPoint(layout, nearApex, false)).toBe(true);
      // Above the top edge near the apex: outside the triangle, inside the bbox.
      expect(gateContainsLocalPoint(layout, { x: nearApex.x, y: 1 }, false)).toBe(false);
    });

    it('an output-bubble point hits even though it is past the base body silhouette', () => {
      const layout = gateLayout(
        'nand',
        { kind: 'nand', params: {}, pins: pinsFor('nand', 2) },
        theme,
      );
      const bubbleCenter = bubbleAnchors(layout)[0]!.center;
      expect(gateContainsLocalPoint(layout, bubbleCenter, false)).toBe(false); // ignored when told there's no bubble
      expect(gateContainsLocalPoint(layout, bubbleCenter, true)).toBe(true);
    });

    it('rotated/mirrored placements: a world click on the shape resolves through worldToLocal', () => {
      const layout = gateLayout('or', { kind: 'or', params: {}, pins: pinsFor('or', 2) }, theme);
      // Off-center on purpose (not the bbox center) so rot/mirror actually
      // exercise the transform instead of hitting a fixed point by symmetry.
      const localCenter = { x: (layout.bodyX0 + layout.bodyRightRaw) / 2, y: layout.H / 2 };
      const geo = { bounds: layout.bounds, pins: new Map([['test', localCenter]]) };
      for (const rot of [0, 90, 180, 270] as const) {
        for (const mirror of [false, true]) {
          const placement: Placement = { pos: { x: 5 * G, y: 3 * G }, rot, mirror };
          const { pins } = transformGeometry(geo, placement);
          const worldPt = pins.get('test')!;
          const local = worldToLocal(worldPt, layout.bounds, placement);
          expect(local.x).toBeCloseTo(localCenter.x, 6);
          expect(local.y).toBeCloseTo(localCenter.y, 6);
          expect(gateContainsLocalPoint(layout, local, false)).toBe(true);
        }
      }
    });
  });

  it('every pin lands on a grid intersection', () => {
    for (const kind of GATE_KINDS) {
      for (const n of [2, 3, 4]) {
        const layout = gateLayout(kind, { kind, params: {}, pins: pinsFor(kind, n) }, theme);
        for (const p of layout.pins.values()) {
          expect(p.x % G).toBeCloseTo(0, 6);
          expect(p.y % G).toBeCloseTo(0, 6);
        }
      }
    }
  });

  it('bubble diameter is a fixed 1G regardless of input count, only on NOT/NAND/NOR/XNOR', () => {
    const bubbleKinds: GateKind[] = ['not', 'nand', 'nor', 'xnor'];
    const noBubbleKinds: GateKind[] = ['and', 'or', 'xor', 'buf'];
    for (const kind of bubbleKinds) {
      for (const n of kind === 'not' ? [1] : [2, 3]) {
        const layout = gateLayout(kind, { kind, params: {}, pins: pinsFor(kind, n) }, theme);
        expect(layout.bubble).toBe(true);
        expect(layout.bubbleDiameter).toBe(G);
      }
    }
    for (const kind of noBubbleKinds) {
      const layout = gateLayout(kind, { kind, params: {}, pins: pinsFor(kind, 2) }, theme);
      expect(layout.bubble).toBe(false);
    }
  });

  it('AND-family total glyph width is close to 1.25H before the output stub', () => {
    const layout = gateLayout('and', { kind: 'and', params: {}, pins: pinsFor('and', 2) }, theme);
    expect(layout.bodyRightRaw).toBeCloseTo(layout.bodyX0 + 1.25 * layout.H, 6);
  });

  it('bounds start at local origin and enclose every pin', () => {
    const layout = gateLayout('xor', { kind: 'xor', params: {}, pins: pinsFor('xor', 3) }, theme);
    expect(layout.bounds.x).toBe(0);
    expect(layout.bounds.y).toBe(0);
    for (const p of layout.pins.values()) {
      expect(p.x).toBeGreaterThanOrEqual(layout.bounds.x);
      expect(p.x).toBeLessThanOrEqual(layout.bounds.x + layout.bounds.w);
      expect(p.y).toBeGreaterThanOrEqual(layout.bounds.y);
      expect(p.y).toBeLessThanOrEqual(layout.bounds.y + layout.bounds.h);
    }
  });
});

describe('bubbleAnchors', () => {
  it('output anchor matches the drawn output-bubble center exactly', () => {
    for (const kind of ['and', 'or', 'buf'] as const) {
      const n = kind === 'buf' ? 1 : 2;
      const layout = gateLayout(kind, { kind, params: {}, pins: pinsFor(kind, n) }, theme);
      const anchors = bubbleAnchors(layout);
      const out = anchors[0]!;
      expect(out.pin).toBe('y');
      // Same math drawGate used before the accessor existed: center sits one
      // bubble radius past the body's raw right edge, on the output axis.
      expect(out.center).toEqual({
        x: layout.bodyRightRaw + layout.bubbleDiameter / 2,
        y: layout.outputY,
      });
      expect(out.r).toBe(layout.bubbleDiameter / 2);
    }
  });

  it('input anchors sit one radius inside each stub end, one per input pin', () => {
    const layout = gateLayout('or', { kind: 'or', params: {}, pins: pinsFor('or', 3) }, theme);
    const anchors = bubbleAnchors(layout);
    expect(anchors).toHaveLength(4); // y + a,b,c
    for (const { name, y, stubEndX } of layout.inputYs) {
      const a = anchors.find((x) => x.pin === name)!;
      expect(a.center).toEqual({ x: stubEndX - layout.bubbleDiameter / 2, y });
    }
  });
});

describe('bare bubble (buf + params.bubbleOnly)', () => {
  it('isBareBubble only matches buf with bubbleOnly: true', () => {
    expect(isBareBubble({ kind: 'buf', params: { bubbleOnly: true } })).toBe(true);
    expect(isBareBubble({ kind: 'buf', params: {} })).toBe(false);
    expect(isBareBubble({ kind: 'buf', params: { bubbleOnly: false } })).toBe(false);
    expect(isBareBubble({ kind: 'and', params: { bubbleOnly: true } })).toBe(false);
  });

  it('geometry is a 2G square with a/y pins on grid at the midline edges', () => {
    const geo = bareBubbleGeometry(theme);
    expect(geo.bounds).toEqual({ x: 0, y: 0, w: 2 * G, h: 2 * G });
    expect(geo.pins.get('a')).toEqual({ x: 0, y: G });
    expect(geo.pins.get('y')).toEqual({ x: 2 * G, y: G });
    for (const p of geo.pins.values()) {
      expect(p.x % G).toBe(0);
      expect(p.y % G).toBe(0);
    }
  });

  it('the registered buf geometry routes to the bare-bubble form when flagged', () => {
    const bare = buildLocalGeometry(
      { kind: 'buf', params: { bubbleOnly: true }, pins: pinsFor('buf', 1) },
      theme,
    );
    expect(bare.bounds.w).toBe(2 * G);
    const full = buildLocalGeometry({ kind: 'buf', params: {}, pins: pinsFor('buf', 1) }, theme);
    expect(full.bounds.w).toBeGreaterThan(2 * G);
  });
});

// A gate's rendered bubble count -- one arc() per bubble drawn (drawBubble
// is the only glyph.ts caller of ctx.arc besides the AND-family cap, which
// this counts separately by kind so the bubble delta is unambiguous).
function mockCtx(): CanvasRenderingContext2D & { arcCalls: number } {
  const noop = () => {};
  const ctx = {
    arcCalls: 0,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    quadraticCurveTo: noop,
    fill: noop,
    stroke: noop,
    setLineDash: noop,
    save: noop,
    restore: noop,
    translate: noop,
    rotate: noop,
    scale: noop,
    set strokeStyle(_v: unknown) {},
    set fillStyle(_v: unknown) {},
    set lineWidth(_v: unknown) {},
  } as unknown as CanvasRenderingContext2D & { arcCalls: number };
  (ctx as unknown as { arc: () => void }).arc = () => {
    ctx.arcCalls++;
  };
  return ctx;
}

const placement: Placement = { pos: { x: 0, y: 0 } };

describe('drawGate bubble overrides (Gates workbench)', () => {
  it('draws no bubbles for a plain AND with no overrides (Circuit workbench default)', () => {
    const ctx = mockCtx();
    drawGate(ctx, theme, 'and', { kind: 'and', params: {}, pins: pinsFor('and', 2) }, placement);
    expect(ctx.arcCalls).toBe(1); // just the AND body's rounded cap
  });

  it('an output-bubble override on a plain AND draws one extra bubble', () => {
    const ctx = mockCtx();
    drawGate(ctx, theme, 'and', { kind: 'and', params: {}, pins: pinsFor('and', 2) }, placement, {
      output: true,
    });
    expect(ctx.arcCalls).toBe(2); // AND cap + output bubble
  });

  it('input-bubble overrides draw one arc per flagged input pin, independent of kind', () => {
    const ctx = mockCtx();
    drawGate(ctx, theme, 'or', { kind: 'or', params: {}, pins: pinsFor('or', 2) }, placement, {
      inputs: new Set(['a', 'b']),
    });
    expect(ctx.arcCalls).toBe(2); // one per input bubble, OR body has no cap arc
  });

  it('an explicit output:false override suppresses a kind-derived bubble (nand rendered without one)', () => {
    const ctx = mockCtx();
    drawGate(
      ctx,
      theme,
      'nand',
      { kind: 'nand', params: {}, pins: pinsFor('nand', 2) },
      placement,
      {
        output: false,
      },
    );
    expect(ctx.arcCalls).toBe(1); // AND-family cap only, no output bubble
  });

  it('a bubbleOnly buf draws exactly one arc (the bare bubble), no triangle body', () => {
    const ctx = mockCtx();
    drawGate(
      ctx,
      theme,
      'buf',
      { kind: 'buf', params: { bubbleOnly: true }, pins: pinsFor('buf', 1) },
      placement,
    );
    expect(ctx.arcCalls).toBe(1);
  });
});
