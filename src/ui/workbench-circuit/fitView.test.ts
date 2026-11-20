import { describe, expect, it } from 'vitest';
import type { Circuit } from '../../core/model/types';
import { builtinChipLibrary } from '../../core/parts/packages';
import { makeTestTheme } from '../../render/theme.fixture';
import { circuitDrawnBounds, fitViewport } from './fitView';
import '../../core/sim/primitives/registry';
import '../../render/glyphs/gates';
import '../../render/glyphs/io';

const theme = makeTestTheme();

describe('fitViewport', () => {
  it('centers the bounds in the view at the fitting zoom', () => {
    const vp = fitViewport({ x: 100, y: 50, w: 200, h: 100 }, 400, 400, 0, 0.01, 10);
    expect(vp.zoom).toBe(2);
    expect(vp.panX).toBe(100);
    // 400 px tall at zoom 2 shows 200 world units; the 100-unit board sits in the middle.
    expect(vp.panY).toBe(0);
  });

  it('never zooms past the cap, and keeps a small board centered', () => {
    const vp = fitViewport({ x: 0, y: 0, w: 10, h: 10 }, 400, 300, 0, 0.01, 1.5);
    expect(vp.zoom).toBe(1.5);
    expect(vp.panX + 400 / vp.zoom / 2).toBeCloseTo(5);
    expect(vp.panY + 300 / vp.zoom / 2).toBeCloseTo(5);
  });

  it('leaves the margin on the limiting side', () => {
    const vp = fitViewport({ x: 0, y: 0, w: 80, h: 10 }, 100, 100, 10, 0.01, 10);
    expect(vp.zoom).toBe(1);
    expect(vp.panX).toBe(-10);
  });
});

describe('circuitDrawnBounds', () => {
  const empty: Circuit = { components: [], wires: [], junctions: [] };

  it('is null for a circuit with no parts', () => {
    expect(circuitDrawnBounds(empty, builtinChipLibrary(), theme)).toBeNull();
  });

  it('reaches a free wire end beyond every part', () => {
    const circuit = {
      ...empty,
      components: [{ id: 'g', kind: 'and', pos: { x: 0, y: 0 } }],
      wires: [
        {
          id: 'w',
          a: { kind: 'pin', component: 'g', pin: 'y' },
          b: { kind: 'free', pos: { x: 1000, y: 500 } },
          points: [],
        },
      ],
    } as unknown as Circuit;
    const b = circuitDrawnBounds(circuit, builtinChipLibrary(), theme)!;
    expect(b.x + b.w).toBe(1000);
    expect(b.y + b.h).toBe(500);
  });

  it('includes a group frame and its name box around the members', () => {
    const circuit = {
      ...empty,
      groups: [{ id: 'grp', name: 'A very long group name here' }],
      components: [{ id: 'g', kind: 'and', pos: { x: 0, y: 0 }, group: 'grp' }],
    } as unknown as Circuit;
    const plain = circuitDrawnBounds({ ...circuit, groups: [] }, builtinChipLibrary(), theme)!;
    const b = circuitDrawnBounds(circuit, builtinChipLibrary(), theme)!;
    const g = theme.gridSchematic;
    expect(b.x).toBeLessThanOrEqual(plain.x - 1.5 * g);
    expect(b.y).toBeLessThanOrEqual(plain.y - 1.5 * g - theme.glyphText);
    expect(b.x + b.w).toBeGreaterThanOrEqual(b.x + 27 * theme.glyphText * 0.6);
  });
});
