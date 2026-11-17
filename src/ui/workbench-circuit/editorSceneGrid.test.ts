import { describe, expect, it } from 'vitest';
import { builtinChipLibrary } from '../../core/parts/packages';
import { makeTestTheme } from '../../render/theme.fixture';
import { renderBoard } from './editorScene';

/** Records 1 x 1 fills, which is how the dot grid draws; every other call is a no-op. */
function recordingContext(width: number, height: number) {
  const dots: number[][] = [];
  const target: Record<string, unknown> = {
    canvas: { width, height },
    fillRect: (...a: number[]) => {
      if (a[2] === 1 && a[3] === 1) dots.push(a);
    },
    measureText: () => ({ width: 0 }),
    getTransform: () => ({ a: 1 }),
    createLinearGradient: () => ({ addColorStop: () => undefined }),
  };
  const ctx = new Proxy(target, {
    get: (t, key: string) => (key in t ? t[key] : () => undefined),
    set: (t, key: string, value) => {
      t[key] = value;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, dots };
}

describe('renderBoard grid', () => {
  const draw = (hideGrid?: boolean) => {
    const theme = makeTestTheme();
    const { ctx, dots } = recordingContext(200, 100);
    renderBoard(ctx, theme, {
      board: { components: [], wires: [], junctions: [] },
      chipLib: builtinChipLibrary(),
      viewport: { panX: 0, panY: 0, zoom: 1 },
      selection: new Set(),
      pinSignal: () => undefined,
      grid: 10,
      ...(hideGrid === undefined ? {} : { hideGrid }),
    });
    return dots.length;
  };

  it('draws the dot grid by default', () => {
    expect(draw()).toBeGreaterThan(0);
  });

  it('leaves it out when asked, for an export', () => {
    expect(draw(true)).toBe(0);
  });
});
