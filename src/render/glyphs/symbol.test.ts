import { describe, expect, it, vi } from 'vitest';
import {
  buildLocalGeometry,
  drawStubBusBadge,
  glyphBodyName,
  measureMonoBlock,
  captionAwareBounds,
  captionPad,
  drawUprightText,
  namePlacement,
  oneLine,
  resolveComponentPins,
  snap,
  symbolBounds,
  textLineHeight,
  transformGeometry,
  worldToLocal,
  type SymbolGeometry,
} from './symbol';
import './io'; // registers probe/busdisplay/etc. geometry builders as a side effect
import './chip'; // registers mux/demux/decoder/encoder/dff/dlatch/register/chip box geometry
import type { ChipDef, ChipInstance, Component } from '../../core/model/types';
import type { Theme } from '../theme';
import { makeTestTheme } from '../theme.fixture';

const G = 8;

function rectGeo(w: number, h: number): SymbolGeometry {
  return {
    bounds: { x: 0, y: 0, w, h },
    pins: new Map([
      ['a', { x: 0, y: 0 }],
      ['b', { x: w, y: h }],
    ]),
  };
}

describe('snap', () => {
  it('rounds to the nearest grid multiple', () => {
    expect(snap(0, G)).toBe(0);
    expect(snap(3, G)).toBe(0);
    expect(snap(5, G)).toBe(8);
    expect(snap(20, G)).toBe(24);
  });
});

describe('transformGeometry', () => {
  it('identity placement keeps bounds and pins in world space unchanged', () => {
    const geo = rectGeo(3 * G, 2 * G);
    const { bounds, pins } = transformGeometry(geo, { pos: { x: 40, y: 16 } });
    expect(bounds).toEqual({ x: 40, y: 16, w: 24, h: 16 });
    expect(pins.get('a')).toEqual({ x: 40, y: 16 });
    expect(pins.get('b')).toEqual({ x: 64, y: 32 });
  });

  it('90deg rotation swaps bounds width/height', () => {
    const geo = rectGeo(3 * G, 2 * G);
    const { bounds } = transformGeometry(geo, { pos: { x: 0, y: 0 }, rot: 90 });
    expect(bounds.w).toBe(2 * G);
    expect(bounds.h).toBe(3 * G);
  });

  it('180deg rotation keeps bounds size, moves pins to the opposite corner', () => {
    const geo = rectGeo(2 * G, 2 * G);
    const { bounds, pins } = transformGeometry(geo, { pos: { x: 0, y: 0 }, rot: 180 });
    expect(bounds.w).toBe(2 * G);
    expect(bounds.h).toBe(2 * G);
    // 'a' started at the local top-left; after a 180 it lands at the bottom-right.
    expect(pins.get('a')).toEqual({ x: 2 * G, y: 2 * G });
    expect(pins.get('b')).toEqual({ x: 0, y: 0 });
  });

  it('mirror flips x within the bounds, leaves y untouched', () => {
    const geo = rectGeo(2 * G, 2 * G);
    const { pins } = transformGeometry(geo, { pos: { x: 0, y: 0 }, mirror: true });
    expect(pins.get('a')).toEqual({ x: 2 * G, y: 0 });
    expect(pins.get('b')).toEqual({ x: 0, y: 2 * G });
  });

  it('grid-aligned local pins stay grid-aligned after any rot/mirror when pos is grid-aligned', () => {
    const geo = rectGeo(3 * G, 4 * G);
    for (const rot of [0, 90, 180, 270] as const) {
      for (const mirror of [false, true]) {
        const { pins } = transformGeometry(geo, { pos: { x: 5 * G, y: 2 * G }, rot, mirror });
        for (const p of pins.values()) {
          expect(p.x % G).toBeCloseTo(0, 6);
          expect(p.y % G).toBeCloseTo(0, 6);
        }
      }
    }
  });
});

describe('worldToLocal', () => {
  it('round-trips through transformGeometry for every rot/mirror combo', () => {
    const bounds = { x: 0, y: 0, w: 3 * G, h: 4 * G };
    const geo: SymbolGeometry = { bounds, pins: new Map([['a', { x: G, y: 2 * G }]]) };
    for (const rot of [0, 90, 180, 270] as const) {
      for (const mirror of [false, true]) {
        const placement = { pos: { x: 5 * G, y: 2 * G }, rot, mirror };
        const { pins } = transformGeometry(geo, placement);
        const worldA = pins.get('a')!;
        const local = worldToLocal(worldA, bounds, placement);
        expect(local.x).toBeCloseTo(G, 6);
        expect(local.y).toBeCloseTo(2 * G, 6);
      }
    }
  });

  it('identity placement is a no-op modulo translation', () => {
    const bounds = { x: 0, y: 0, w: 2 * G, h: 2 * G };
    const local = worldToLocal({ x: 40 + G, y: 16 + G }, bounds, { pos: { x: 40, y: 16 } });
    expect(local).toEqual({ x: G, y: G });
  });
});

const theme: Theme = makeTestTheme();

function fakeCtx() {
  return {
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fillText: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    rotate: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
}

describe('drawStubBusBadge (M6.6 Phase 6: collapsed multi-bit pin marker)', () => {
  it('is a no-op for a 1-bit pin', () => {
    const ctx = fakeCtx();
    drawStubBusBadge(ctx, theme, { pos: { x: 0, y: 0 } }, { x: 0, y: 0 }, { x: 2 * G, y: 0 }, 1);
    expect(ctx.stroke).not.toHaveBeenCalled();
    expect(ctx.fillText).not.toHaveBeenCalled();
  });

  it('draws a slash + the bit-count badge for a wide pin', () => {
    const ctx = fakeCtx();
    drawStubBusBadge(ctx, theme, { pos: { x: 0, y: 0 } }, { x: 0, y: 0 }, { x: 2 * G, y: 0 }, 5);
    expect(ctx.stroke).toHaveBeenCalledTimes(1);
    expect(ctx.fillText).toHaveBeenCalledWith('5', 0, 0);
  });

  it('undoes rotation for the badge number at rot 90 (stays upright)', () => {
    const ctx = fakeCtx();
    drawStubBusBadge(
      ctx,
      theme,
      { pos: { x: 0, y: 0 }, rot: 90 },
      { x: 0, y: 0 },
      { x: 2 * G, y: 0 },
      5,
    );
    expect(ctx.rotate).toHaveBeenCalledWith((-90 * Math.PI) / 180);
    expect(ctx.fillText).toHaveBeenCalledWith('5', 0, 0);
  });
});

describe('probe geometry bounds (Task 2: hit body matches drawn tag)', () => {
  it("an unlabeled probe sizes its bounds off the component id, matching drawProbe's own fallback", () => {
    const pins = [{ name: 'a', dir: 'in' as const, width: 1, role: 'data' as const, order: 0 }];
    const shortId = buildLocalGeometry({ kind: 'probe', params: {}, pins, id: 'p1' }, theme);
    const longId = buildLocalGeometry(
      { kind: 'probe', params: {}, pins, id: 'a-much-longer-probe-id' },
      theme,
    );
    // drawProbe's label falls back to comp.label ?? comp.id -- a longer id must
    // widen the hit-testable bounds the same way it widens the drawn rect.
    expect(longId.bounds.w).toBeGreaterThan(shortId.bounds.w);
  });

  it('a labeled probe sizes its bounds off the label, not the id', () => {
    const pins = [{ name: 'a', dir: 'in' as const, width: 1, role: 'data' as const, order: 0 }];
    const geo = buildLocalGeometry(
      { kind: 'probe', params: {}, pins, name: 'sig', id: 'a-much-longer-probe-id' },
      theme,
    );
    const short = buildLocalGeometry({ kind: 'probe', params: {}, pins, name: 'sig' }, theme);
    expect(geo.bounds.w).toBeCloseTo(short.bounds.w, 6);
  });
});

describe('namePlacement (Task 2: per-edge awareness)', () => {
  const bounds = { x: 0, y: 0, w: 40, h: 24 };

  it('defaults to above-center when the top edge is free (the common gate/box case)', () => {
    const { anchor, inward } = namePlacement(
      bounds,
      { top: false, bottom: false, left: true, right: true },
      8,
    );
    expect(anchor).toEqual({ x: 20, y: -4 });
    expect(inward).toEqual({ x: 0, y: -1 }); // extends UPWARD, away from the body
  });

  it('moves to below-center when the top edge carries pins and the bottom does not (mux selSide: top)', () => {
    const { anchor, inward } = namePlacement(
      bounds,
      { top: true, bottom: false, left: true, right: true },
      8,
    );
    expect(anchor).toEqual({ x: 20, y: 28 }); // bounds.y + bounds.h + 0.5*g
    expect(inward).toEqual({ x: 0, y: 1 }); // extends DOWNWARD, away from the body
  });

  it('falls back to above-left, outside the box, only when every side already has a pin', () => {
    const { anchor, inward } = namePlacement(
      bounds,
      { top: true, bottom: true, left: true, right: true },
      8,
    );
    expect(anchor).toEqual({ x: -8, y: -8 });
    expect(inward).toEqual({ x: -1, y: -1 }); // extends further up-left, away from the box
  });

  it('exposes a rect sized off the text width, growing in the inward direction', () => {
    const { anchor, rect } = namePlacement(
      bounds,
      { top: false, bottom: false, left: true, right: true },
      8,
      'mux1',
      10,
    );
    expect(rect.h).toBe(10);
    expect(rect.w).toBeGreaterThan(0);
    // Above-center: text grows upward, so the rect's bottom edge sits at anchor.y.
    expect(rect.y + rect.h).toBeCloseTo(anchor.y);
    expect(rect.x + rect.w / 2).toBeCloseTo(anchor.x);
  });

  it('a nameOffset (Task 2b seam) shifts both anchor and rect by exactly that amount', () => {
    const plain = namePlacement(
      bounds,
      { top: false, bottom: false, left: true, right: true },
      8,
      'mux1',
      10,
    );
    const offset = namePlacement(
      bounds,
      { top: false, bottom: false, left: true, right: true },
      8,
      'mux1',
      10,
      { x: 5, y: -3 },
    );
    expect(offset.anchor).toEqual({ x: plain.anchor.x + 5, y: plain.anchor.y - 3 });
    expect(offset.rect.x).toBeCloseTo(plain.rect.x + 5);
    expect(offset.rect.y).toBeCloseTo(plain.rect.y - 3);
  });

  it('no offset renders byte-identically to before Task 2b', () => {
    const withoutOffsetArg = namePlacement(
      bounds,
      { top: false, bottom: false, left: true, right: true },
      8,
      'mux1',
      10,
    );
    const withUndefinedOffset = namePlacement(
      bounds,
      { top: false, bottom: false, left: true, right: true },
      8,
      'mux1',
      10,
      undefined,
    );
    expect(withUndefinedOffset).toEqual(withoutOffsetArg);
  });
});

describe('resolveComponentPins', () => {
  it('degrades to zero pins for a chip instance with no resolvable ChipDef, never throws (P0.6)', () => {
    const ghost: ChipInstance = {
      id: '__ghost',
      kind: 'chip',
      defId: 'missing',
      pos: { x: 0, y: 0 },
    };
    expect(() => resolveComponentPins(ghost, undefined)).not.toThrow();
    expect(resolveComponentPins(ghost, undefined)).toEqual([]);
  });
});

describe('glyphBodyName (Task 1: a box glyph body never shows the user label)', () => {
  it('fixes non-chip box kinds to their kind string regardless of label', () => {
    for (const kind of ['mux', 'demux', 'decoder', 'encoder', 'dff', 'dlatch', 'register']) {
      expect(glyphBodyName(kind, 'myCustomName', undefined)).toBe(kind);
      expect(glyphBodyName(kind, undefined, undefined)).toBe(kind);
    }
  });

  it('fixes a chip instance to its def name, never the instance label', () => {
    expect(glyphBodyName('chip', 'myCustomName', 'Adder4')).toBe('Adder4');
    expect(glyphBodyName('chip', undefined, 'Adder4')).toBe('Adder4');
  });

  it('leaves gate/io kinds showing the label as before', () => {
    expect(glyphBodyName('and', 'g1', undefined)).toBe('g1');
    expect(glyphBodyName('probe', 'p1', undefined)).toBe('p1');
    expect(glyphBodyName('and', undefined, undefined)).toBeUndefined();
  });
});

describe('symbolBounds (Task 1: box width is label-independent)', () => {
  const muxPins: Record<string, number> = { selectBits: 2 };

  function muxComponent(label?: string): Component {
    const base: Component = { id: 'mux1', kind: 'mux', pos: { x: 0, y: 0 }, params: muxPins };
    return label === undefined ? base : { ...base, label };
  }

  it('a labeled and an unlabeled mux have identical bounds', () => {
    const unlabeled = symbolBounds(muxComponent(undefined), theme);
    const labeled = symbolBounds(muxComponent('a-very-long-instance-name'), theme);
    expect(labeled.bounds).toEqual(unlabeled.bounds);
  });

  it('symbolBounds and geometryInput-equivalent glyphBodyName agree for a mux', () => {
    const comp = muxComponent('sel1');
    const bounds = symbolBounds(comp, theme);
    // geometryInput's own resolution (editorScene.ts) must produce the same
    // body name symbolBounds used, or the two paths would size differently.
    expect(glyphBodyName(comp.kind, comp.label, undefined)).toBe('mux');
    expect(bounds.bounds.w).toBeGreaterThan(0);
  });

  it('a chip instance is byte-for-byte unchanged: def name inside, label outside only', () => {
    const def: ChipDef = {
      format: 'lcir.chip',
      formatVersion: 3,
      id: 'def1',
      name: 'Adder4',
      version: 1,
      components: [],
      wires: [],
      junctions: [],
      pins: [
        { id: 'p1', name: 'a', dir: 'in', width: 1, role: 'data', order: 0, boundComponent: 'i1' },
      ],
    };
    const instance: Component = {
      id: 'c1',
      kind: 'chip',
      defId: 'def1',
      pos: { x: 0, y: 0 },
      label: 'adder1',
    };
    const unlabeledInstance: Component = { ...instance };
    delete unlabeledInstance.label;
    const withLabel = symbolBounds(instance, theme, def);
    const withoutLabel = symbolBounds(unlabeledInstance, theme, def);
    expect(withLabel.bounds).toEqual(withoutLabel.bounds);
  });
});

describe('multi-line captions', () => {
  it('measures the widest line, not the whole string', () => {
    const one = measureMonoBlock('A + AB', 13);
    const two = measureMonoBlock('A + AB\nAB', 13);
    expect(two.lines).toBe(2);
    expect(two.w).toBe(one.w);
  });

  it('draws one row per line, stacked from the baseline', () => {
    const drawn: [string, number, number][] = [];
    const ctx = {
      font: '13px mono',
      textAlign: 'left',
      textBaseline: 'top',
      fillText: (t: string, x: number, y: number) => drawn.push([t, x, y]),
      save: () => {},
      restore: () => {},
      translate: () => {},
      rotate: () => {},
      scale: () => {},
    } as unknown as CanvasRenderingContext2D;
    drawUprightText(ctx, {} as never, 'top\nbottom', { x: 0, y: 0 }, { x: 1, y: 1 });
    expect(drawn.map((d) => d[0])).toEqual(['top', 'bottom']);
    expect(drawn[1]![2] - drawn[0]![2]).toBe(textLineHeight(ctx));
  });

  it('flattens a caption for the layouts that hold one row', () => {
    expect(oneLine('AB + AC\nand more')).toBe('AB + AC and more');
    expect(oneLine('unchanged')).toBe('unchanged');
  });
});

describe('captionPad', () => {
  it('covers a caption longer than the cache tile default', () => {
    // The consensus board's LED: 13 characters at 13px was cut off by the
    // cache's fixed 96-unit slack.
    expect(captionPad("AB + A'C + BC", 13, 8)).toBeGreaterThan(96);
  });

  it('grows with the number of rows and is zero when unlabelled', () => {
    expect(captionPad('two\nrows', 13, 8)).toBeGreaterThan(captionPad('two', 13, 8));
    expect(captionPad('', 13, 8)).toBe(0);
  });
});

describe('captionAwareBounds', () => {
  const theme = { glyphText: 10 } as never;
  const box = { x: 100, y: 100, w: 40, h: 20 };

  it('leaves an unlabelled component exactly as it is', () => {
    expect(captionAwareBounds(box, undefined, theme)).toEqual(box);
    expect(captionAwareBounds(box, '', theme)).toEqual(box);
  });

  it('grows by the measured caption, so a longer name takes more room', () => {
    const short = captionAwareBounds(box, 'A', theme);
    const long = captionAwareBounds(box, 'CARRY_OUT', theme);
    expect(long.w).toBeGreaterThan(short.w);
    expect(short.w).toBeGreaterThan(box.w);
    // Centred on the original box: same growth either side.
    expect(box.x - short.x).toBeCloseTo(short.x + short.w - (box.x + box.w));
  });

  // The point of the whole helper: a board's bounds come out asymmetric
  // because the union takes the extreme on each side, so a short label on the
  // left and a long one on the right give a short left margin and a long
  // right one.
  it('unions to asymmetric board bounds', () => {
    const left = captionAwareBounds({ x: 0, y: 0, w: 20, h: 20 }, 'A', theme);
    const right = captionAwareBounds({ x: 200, y: 0, w: 20, h: 20 }, 'CARRY_OUT', theme);
    const leftMargin = 0 - left.x;
    const rightMargin = right.x + right.w - 220;
    expect(rightMargin).toBeGreaterThan(leftMargin * 2);
  });

  it('a multi-line caption grows the vertical extent per line', () => {
    const one = captionAwareBounds(box, 'A', theme);
    const two = captionAwareBounds(box, 'A\nB', theme);
    expect(two.h).toBeGreaterThan(one.h);
  });
});
