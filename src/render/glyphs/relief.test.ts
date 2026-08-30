import { describe, expect, it, vi } from 'vitest';
import { makeTestTheme } from '../theme.fixture';
import { bodyRectPath, paintBody, paintEmphasis } from './relief';

const rect = { x: 0, y: 0, w: 40, h: 24 };

function fakeCtx() {
  return {
    beginPath: vi.fn(),
    rect: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    clip: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    createPattern: vi.fn(() => null),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    shadowColor: '',
    shadowBlur: 0,
  } as unknown as CanvasRenderingContext2D & Record<string, ReturnType<typeof vi.fn>>;
}

describe('paintBody', () => {
  it('builds the silhouette once for the flat default', () => {
    const ctx = fakeCtx();
    paintBody(ctx, makeTestTheme(), () => ctx.rect(0, 0, 10, 10));
    expect(ctx.rect).toHaveBeenCalledTimes(1);
    expect(ctx.fill).toHaveBeenCalledTimes(1);
    expect(ctx.stroke).toHaveBeenCalledTimes(1);
  });

  it('adds exactly two extra strokes for relief, and none at flat LOD', () => {
    const theme = makeTestTheme({
      glyph: { ...makeTestTheme().glyph, relief: 'bevel' },
    });
    const ctx = fakeCtx();
    paintBody(ctx, theme, () => ctx.rect(0, 0, 10, 10));
    expect(ctx.stroke).toHaveBeenCalledTimes(3);

    const flat = fakeCtx();
    paintBody(flat, { ...theme, lod: 'flat' }, () => flat.rect(0, 0, 10, 10));
    expect(flat.stroke).toHaveBeenCalledTimes(1);
  });

  it('draws the rim line and corner motifs only for a rect body', () => {
    const theme = makeTestTheme({
      glyph: { ...makeTestTheme().glyph, rimLine: 'inset', corners: 'bracket' },
    });
    const withRect = fakeCtx();
    paintBody(withRect, theme, () => withRect.rect(0, 0, 40, 24), { rect });
    const without = fakeCtx();
    paintBody(without, theme, () => without.rect(0, 0, 40, 24));
    expect(vi.mocked(withRect.stroke).mock.calls.length).toBeGreaterThan(
      vi.mocked(without.stroke).mock.calls.length,
    );
  });
});

describe('bodyRectPath', () => {
  it('is a plain rect when corners are sharp, and a polygon otherwise', () => {
    const sharp = fakeCtx();
    bodyRectPath(sharp, makeTestTheme(), rect);
    expect(sharp.rect).toHaveBeenCalledTimes(1);

    const base = makeTestTheme();
    for (const corner of ['clip', 'stair'] as const) {
      const ctx = fakeCtx();
      bodyRectPath(ctx, { ...base, glyph: { ...base.glyph, boxCorner: corner } }, rect);
      expect(ctx.rect, corner).not.toHaveBeenCalled();
      expect(ctx.closePath, corner).toHaveBeenCalled();
    }
  });
});

describe('paintEmphasis', () => {
  it('is silent by default and paints one extra stroke as a halo', () => {
    const base = makeTestTheme();
    const off = fakeCtx();
    paintEmphasis(off, base, '#fff', () => off.rect(0, 0, 4, 4));
    expect(off.stroke).not.toHaveBeenCalled();

    const halo = fakeCtx();
    const theme = { ...base, glyph: { ...base.glyph, emphasis: 'halo' as const } };
    paintEmphasis(halo, theme, '#fff', () => halo.rect(0, 0, 4, 4));
    expect(halo.stroke).toHaveBeenCalledTimes(1);

    const degraded = fakeCtx();
    paintEmphasis(degraded, { ...theme, lod: 'flat' }, '#fff', () => degraded.rect(0, 0, 4, 4));
    expect(degraded.stroke).not.toHaveBeenCalled();
  });

  it('fills with a shadow for bloom, and only at full detail', () => {
    const base = makeTestTheme();
    const theme = { ...base, glyph: { ...base.glyph, emphasis: 'bloom' as const } };
    const full = fakeCtx();
    paintEmphasis(full, theme, '#fff', () => full.rect(0, 0, 4, 4));
    expect(full.fill).toHaveBeenCalled();
    expect(full.shadowBlur).toBeGreaterThan(0);

    // Below full detail it degrades to the cheap halo rather than disappearing:
    // losing the lit cue entirely would be worse than losing the spill.
    const reduced = fakeCtx();
    paintEmphasis(reduced, { ...theme, lod: 'reduced' }, '#fff', () => reduced.rect(0, 0, 4, 4));
    expect(reduced.fill).not.toHaveBeenCalled();
    expect(reduced.stroke).toHaveBeenCalledTimes(1);
    expect(reduced.shadowBlur).toBe(0);
  });

  it('degrades to a halo for anything drawn per frame, whatever the theme asks', () => {
    const base = makeTestTheme();
    const theme = { ...base, glyph: { ...base.glyph, emphasis: 'bloom' as const } };
    const ctx = fakeCtx();
    paintEmphasis(ctx, theme, '#fff', () => ctx.rect(0, 0, 4, 4), false);
    expect(ctx.fill).not.toHaveBeenCalled();
    expect(ctx.stroke).toHaveBeenCalledTimes(1);
  });
});
