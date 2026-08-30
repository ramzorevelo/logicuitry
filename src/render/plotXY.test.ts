import { describe, expect, it } from 'vitest';
import { makeProjection, type PlotSpec } from './plotXY';

const spec: PlotSpec = {
  size: { w: 200, h: 132 },
  x: { min: 0, max: 5, label: 'Vin' },
  y: { min: 0, max: 5, label: 'Vout' },
  series: [],
};

describe('plotXY projection', () => {
  it('maps axis endpoints to the plot rect corners (y inverted)', () => {
    const p = makeProjection(spec);
    expect(p.x(0)).toBeCloseTo(p.area.x, 6);
    expect(p.x(5)).toBeCloseTo(p.area.x + p.area.w, 6);
    expect(p.y(0)).toBeCloseTo(p.area.y + p.area.h, 6); // 0 at the bottom
    expect(p.y(5)).toBeCloseTo(p.area.y, 6); // max at the top
  });

  it('is linear at the midpoint', () => {
    const p = makeProjection(spec);
    expect(p.x(2.5)).toBeCloseTo(p.area.x + p.area.w / 2, 6);
    expect(p.y(2.5)).toBeCloseTo(p.area.y + p.area.h / 2, 6);
  });
});
