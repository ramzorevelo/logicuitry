import { describe, expect, it } from 'vitest';
import {
  busLabelGeometry,
  busLabelHitPoints,
  pinKeysOfWires,
  shouldShowPinBusBadge,
  type BusBadgeContext,
} from './busBadge';
import { pointAlongPolyline } from './wireGeom';
import type { Vec2 } from '../../render/scene';
import { occupancyKey } from './pinTargets';
import type { Wire } from '../../core/model/types';

const ctx = (over: Partial<BusBadgeContext> = {}): BusBadgeContext => ({
  wired: new Set<string>(),
  mismatched: new Set<string>(),
  alwaysShow: false,
  ...over,
});

const pinWire = (id: string, a: [string, string], b: [string, string]): Wire => ({
  id,
  a: { kind: 'pin', component: a[0], pin: a[1] },
  b: { kind: 'pin', component: b[0], pin: b[1] },
  points: [],
});

describe('shouldShowPinBusBadge', () => {
  const key = occupancyKey('g1', 'y');

  it('never marks a 1-bit pin, wired or not', () => {
    expect(shouldShowPinBusBadge(1, key, ctx())).toBe(false);
    expect(shouldShowPinBusBadge(1, key, ctx({ alwaysShow: true }))).toBe(false);
  });

  it('marks an unwired wide pin: nothing else states its width', () => {
    expect(shouldShowPinBusBadge(8, key, ctx())).toBe(true);
  });

  it('drops the badge once the pin is wired, since the wire carries one', () => {
    expect(shouldShowPinBusBadge(8, key, ctx({ wired: new Set([key]) }))).toBe(false);
  });

  it('keeps it on a wired pin when the preference asks', () => {
    expect(shouldShowPinBusBadge(8, key, ctx({ wired: new Set([key]), alwaysShow: true }))).toBe(
      true,
    );
  });

  it('keeps it on a width-mismatched wire, where both widths are the point', () => {
    expect(
      shouldShowPinBusBadge(8, key, ctx({ wired: new Set([key]), mismatched: new Set([key]) })),
    ).toBe(true);
  });
});

describe('pinKeysOfWires', () => {
  const wires = [
    pinWire('w1', ['g1', 'y'], ['led1', 'a']),
    pinWire('w2', ['sw1', 'y'], ['g1', 'a']),
  ];

  it('is empty for no ids', () => {
    expect(pinKeysOfWires(wires, undefined).size).toBe(0);
    expect(pinKeysOfWires(wires, new Set()).size).toBe(0);
  });

  it('collects both ends of only the named wires', () => {
    const keys = pinKeysOfWires(wires, new Set(['w1']));
    expect([...keys].sort()).toEqual([occupancyKey('g1', 'y'), occupancyKey('led1', 'a')].sort());
  });

  it('ignores non-pin ends', () => {
    const free: Wire = {
      id: 'w3',
      a: { kind: 'pin', component: 'g1', pin: 'y' },
      b: { kind: 'free', pos: { x: 0, y: 0 } },
      points: [],
    };
    expect([...pinKeysOfWires([free], new Set(['w3']))]).toEqual([occupancyKey('g1', 'y')]);
  });
});

describe('busLabelGeometry / busLabelHitPoints', () => {
  const straight: Vec2[] = [
    { x: 0, y: 0 },
    { x: 80, y: 0 },
  ];
  const G = 8;

  it('centres the mark on the requested point, not the segment midpoint', () => {
    const at = pointAlongPolyline(straight, 0.25);
    const { slashA, slashB } = busLabelGeometry(at, G);
    expect((slashA.x + slashB.x) / 2).toBeCloseTo(20, 6);
    expect((slashA.y + slashB.y) / 2).toBeCloseTo(0, 6);
  });

  it('offsets the number perpendicular to the wire so it never sits on the line', () => {
    const { badgePos } = busLabelGeometry(pointAlongPolyline(straight, 0.5), G);
    expect(badgePos.x).toBeCloseTo(40, 6);
    expect(Math.abs(badgePos.y)).toBeCloseTo(G, 6);
  });

  it('offers both the slash and the number as grab points', () => {
    const [slash, badge] = busLabelHitPoints(straight, 0.5, G);
    expect(slash).toEqual({ x: 40, y: 0 });
    expect(badge!.x).toBeCloseTo(40, 6);
    expect(slash).not.toEqual(badge);
  });

  it('defaults an unset position to the midpoint', () => {
    expect(busLabelHitPoints(straight, undefined, G)[0]).toEqual(
      busLabelHitPoints(straight, 0.5, G)[0],
    );
  });

  it('follows the corner segment on a bent wire', () => {
    const bent: Vec2[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ];
    // Past the corner, the mark rides the vertical leg, so its perpendicular
    // offset is horizontal.
    const { badgePos } = busLabelGeometry(pointAlongPolyline(bent, 0.75), G);
    expect(badgePos.y).toBeCloseTo(50, 6);
    expect(Math.abs(badgePos.x - 100)).toBeCloseTo(G, 6);
  });
});
