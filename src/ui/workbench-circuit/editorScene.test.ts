import { describe, expect, it } from 'vitest';
import type { ChipDef, ChipLibrary, Component } from '../../core/model/types';
import { builtinChipLibrary } from '../../core/parts/packages';
import { makeTestTheme } from '../../render/theme.fixture';
import type { SignalState } from '../../render/theme';
import {
  gatePendingOutline,
  gateRingWire,
  glyphKey,
  lessonHighlightBoxes,
  lessonOutline,
} from './editorScene';
import '../../core/sim/primitives/registry';

const theme = makeTestTheme();
const def = [...builtinChipLibrary().values()].find((d) => d.appearance?.package)!;
const chip: Component = { id: 'u1', kind: 'chip', defId: def.id, pos: { x: 0, y: 0 } };
const ctx = (
  lib: ChipLibrary,
  pinSignal: (id: string, pin: string) => SignalState | undefined,
) => ({
  chipLib: lib,
  pinSignal,
});
const idle = () => undefined;

describe('glyphKey for chip instances', () => {
  it('is stable while the def object is the same', () => {
    const lib = new Map([[def.id, def]]);
    expect(glyphKey(chip, theme, ctx(lib, idle))).toBe(glyphKey(chip, theme, ctx(lib, idle)));
  });

  it('changes when an edit replaces the def under the same id', () => {
    const before = glyphKey(chip, theme, ctx(new Map([[def.id, def]]), idle));
    const edited: ChipDef = { ...def, name: `${def.name} rev` };
    expect(glyphKey(chip, theme, ctx(new Map([[def.id, edited]]), idle))).not.toBe(before);
  });

  it('follows the live state of the def pins', () => {
    const lib = new Map([[def.id, def]]);
    const pin = def.pins[0]!.name;
    const lit = (_: string, p: string): SignalState | undefined => (p === pin ? '1' : undefined);
    expect(glyphKey(chip, theme, ctx(lib, lit))).not.toBe(glyphKey(chip, theme, ctx(lib, idle)));
  });

  it('differs between a missing def and a loaded one', () => {
    const missing = glyphKey(chip, theme, ctx(new Map(), idle));
    expect(glyphKey(chip, theme, ctx(new Map([[def.id, def]]), idle))).not.toBe(missing);
  });
});

describe('lessonOutline', () => {
  it('rings the bounds dashed in the lesson token, then clears the dash', () => {
    const calls: unknown[][] = [];
    const fake = {
      strokeStyle: '',
      lineWidth: 0,
      setLineDash: (d: number[]) => calls.push(['dash', d]),
      strokeRect: (...r: number[]) => calls.push(['rect', ...r]),
    };
    const t = makeTestTheme();
    lessonOutline(fake as unknown as CanvasRenderingContext2D, t, { x: 0, y: 0, w: 10, h: 10 });
    expect(fake.strokeStyle).toBe(t.colors.lessonHighlight);
    expect(calls[1]).toEqual(['rect', 0, 0, 10, 10]);
    expect((calls[0]![1] as number[]).length).toBe(2);
    expect(calls[2]).toEqual(['dash', []]);
  });
});

describe('lessonHighlightBoxes', () => {
  const t = makeTestTheme();
  const pad = t.gridSchematic * 1.2;
  const part = (x: number, y: number) => ({ x, y, w: 20, h: 20 });

  it('pads a lone part on every side', () => {
    expect(lessonHighlightBoxes([part(0, 0)], t)).toEqual([
      { x: -pad, y: -pad, w: 20 + 2 * pad, h: 20 + 2 * pad },
    ]);
  });

  it('merges parts whose boxes would cross into one box', () => {
    const close = t.gridSchematic * 2;
    const boxes = lessonHighlightBoxes([part(0, 0), part(0, 20 + close)], t);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.y).toBeCloseTo(-pad);
    expect(boxes[0]!.h).toBeCloseTo(40 + close + 2 * pad);
  });

  it('merges boxes a hair apart, which would draw as a doubled line', () => {
    const gap = t.gridSchematic * 0.5;
    expect(lessonHighlightBoxes([part(0, 0), part(0, 20 + 2 * pad + gap)], t)).toHaveLength(1);
  });

  it('keeps distant parts apart and merges a chain of close ones', () => {
    const g = t.gridSchematic;
    const boxes = lessonHighlightBoxes(
      [part(0, 0), part(0, 22 + g), part(0, 44 + 2 * g), part(500, 0)],
      t,
    );
    expect(boxes).toHaveLength(2);
    expect(boxes[0]!.h).toBeCloseTo(64 + 2 * g + 2 * pad);
  });
});

/** Records what a draw helper did to the context, with the style in force at each stroke. */
function recorder() {
  const calls: unknown[][] = [];
  const fake = {
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
    globalAlpha: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
    lineJoin: '',
    lineCap: '',
    save: () => calls.push(['save']),
    restore: () => calls.push(['restore']),
    beginPath: () => {},
    moveTo: (x: number, y: number) => calls.push(['move', x, y]),
    lineTo: (x: number, y: number) => calls.push(['line', x, y]),
    stroke: () => calls.push(['stroke', fake.strokeStyle, fake.lineWidth]),
    setLineDash: (d: number[]) => calls.push(['dash', d]),
    strokeRect: (...r: number[]) => calls.push(['rect', fake.strokeStyle, ...r]),
    fillText: (text: string) => calls.push(['text', fake.fillStyle, text]),
  };
  return { calls, ctx: fake as unknown as CanvasRenderingContext2D };
}

describe('gate step overlay', () => {
  it('rings a changed wire along its route in the ripple token', () => {
    const { calls, ctx } = recorder();
    const t = makeTestTheme();
    gateRingWire(
      ctx,
      t,
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      6,
    );
    expect(calls).toContainEqual(['move', 0, 0]);
    expect(calls).toContainEqual(['line', 10, 0]);
    expect(calls).toContainEqual(['stroke', t.colors.gateRipple, 6]);
    expect(calls.at(-1)).toEqual(['restore']);
  });

  it('outlines a pending part dashed and tags it, in the pending token', () => {
    const { calls, ctx } = recorder();
    const t = makeTestTheme();
    gatePendingOutline(ctx, t, { x: 0, y: 0, w: 10, h: 10 });
    const rect = calls.find((c) => c[0] === 'rect')!;
    expect(rect[1]).toBe(t.colors.gatePending);
    expect(rect[2]).toBeLessThan(0);
    expect(calls).toContainEqual(['text', t.colors.gatePending, 'pending']);
    expect(calls.filter((c) => c[0] === 'dash').at(-1)).toEqual(['dash', []]);
  });
});
