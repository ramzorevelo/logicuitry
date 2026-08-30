import { describe, expect, it } from 'vitest';
import type { Wire } from '../../core/model/types';
import { wire } from '../../core/model/testFixtures';
import { autoPlace } from './autoPlace';
import type { RoutableComponent, RoutablePin } from './autoRoute';

const GRID = 16;

/** 64x64 bodies, `a`/`b` on the left edge and `y` on the right -- enough shape
 *  for placement decisions, same fixture the router tests use. */
function routable(id: string, x: number, y: number, group?: string): RoutableComponent {
  const pins = new Map<string, RoutablePin>([
    ['a', { pos: { x, y: y + 16 }, dir: 'in' }],
    ['b', { pos: { x, y: y + 48 }, dir: 'in' }],
    ['y', { pos: { x: x + 64, y: y + 32 }, dir: 'out' }],
  ]);
  return { id, bounds: { x, y, w: 64, h: 64 }, pins, ...(group ? { group } : {}) };
}

function place(components: RoutableComponent[], wires: Wire[]) {
  return autoPlace({ components, wires, grid: GRID }).moved;
}

function shifted(components: RoutableComponent[], wires: Wire[]): Map<string, RoutableComponent> {
  const moved = place(components, wires);
  return new Map(
    components.map((c) => {
      const off = moved.get(c.id) ?? { x: 0, y: 0 };
      const pins = new Map<string, RoutablePin>();
      for (const [name, p] of c.pins)
        pins.set(name, { dir: p.dir, pos: { x: p.pos.x + off.x, y: p.pos.y + off.y } });
      return [
        c.id,
        { id: c.id, bounds: { ...c.bounds, x: c.bounds.x + off.x, y: c.bounds.y + off.y }, pins },
      ] as const;
    }),
  );
}

describe('autoPlace', () => {
  it('closes the gap between columns the wiring does not need', () => {
    const comps = [routable('sw', 48, 48), routable('g', 600, 64)];
    const after = shifted(comps, [wire('w1', ['sw', 'y'], ['g', 'a'])]);
    const gap = after.get('g')!.bounds.x - (after.get('sw')!.bounds.x + 64);
    expect(gap).toBeLessThan(600 - 112);
    expect(gap).toBeGreaterThan(0);
  });

  it('lines a single-driver body up with its driver, so the wire is straight', () => {
    // sw.y lands at y = 80; g.a sits 16 below g's top, so g wants y = 64.
    const comps = [routable('sw', 48, 48), routable('g', 400, 96)];
    const after = shifted(comps, [wire('w1', ['sw', 'y'], ['g', 'a'])]);
    expect(after.get('g')!.pins.get('a')!.pos.y).toBe(after.get('sw')!.pins.get('y')!.pos.y);
  });

  it('leaves a body alone when its drivers sit rows apart', () => {
    // No y lines both inputs up, and the median would just cost the column its
    // pitch, so the middle body must stay where the author put it.
    const comps = [routable('s1', 48, 48), routable('s2', 48, 448), routable('g', 400, 240)];
    const moved = place(comps, [
      wire('w1', ['s1', 'y'], ['g', 'a']),
      wire('w2', ['s2', 'y'], ['g', 'b']),
    ]);
    expect(moved.get('g')?.y ?? 0).toBe(0);
  });

  it('keeps a column in the order the author drew it', () => {
    const comps = [
      routable('sw', 48, 48),
      routable('top', 400, 48),
      routable('mid', 400, 160),
      routable('bot', 400, 272),
    ];
    const after = shifted(comps, [
      wire('w1', ['sw', 'y'], ['top', 'a']),
      wire('w2', ['sw', 'y'], ['mid', 'a']),
      wire('w3', ['sw', 'y'], ['bot', 'a']),
    ]);
    const ys = ['top', 'mid', 'bot'].map((id) => after.get(id)!.bounds.y);
    expect(ys[0]!).toBeLessThan(ys[1]!);
    expect(ys[1]!).toBeLessThan(ys[2]!);
  });

  it('never overlaps two bodies in one column', () => {
    const comps = [routable('sw', 48, 48), routable('g1', 400, 48), routable('g2', 400, 128)];
    const after = shifted(comps, [
      wire('w1', ['sw', 'y'], ['g1', 'a']),
      wire('w2', ['sw', 'y'], ['g2', 'a']),
    ]);
    const g1 = after.get('g1')!.bounds;
    const g2 = after.get('g2')!.bounds;
    expect(g2.y).toBeGreaterThanOrEqual(g1.y + g1.h);
  });

  it('is idempotent: placing an already-placed board moves nothing', () => {
    const comps = [routable('sw', 48, 48), routable('g', 600, 96), routable('l', 900, 200)];
    const wires = [wire('w1', ['sw', 'y'], ['g', 'a']), wire('w2', ['g', 'y'], ['l', 'a'])];
    const once = shifted(comps, wires);
    expect(place([...once.values()], wires).size).toBe(0);
  });
});

describe('autoPlace groups', () => {
  /** Vertical extent of a group after placement. */
  const extent = (after: Map<string, RoutableComponent>, group: string) => {
    const bs = [...after.values()].filter((c) => c.group === group).map((c) => c.bounds);
    return { top: Math.min(...bs.map((b) => b.y)), bottom: Math.max(...bs.map((b) => b.y + b.h)) };
  };

  it('keeps two groups in bands that do not overlap', () => {
    // Interleaved on the way in, and each group spans two layers -- the case
    // per-layer ordering alone cannot fix, because a group's drawn border is
    // the union over every layer it reaches into.
    const comps = [
      routable('src', 48, 200),
      routable('a1', 400, 48, 'g1'),
      routable('b1', 400, 120, 'g2'),
      routable('a2', 760, 300, 'g1'),
      routable('b2', 760, 180, 'g2'),
    ];
    const after = shifted(comps, [
      wire('w1', ['src', 'y'], ['a1', 'a']),
      wire('w2', ['src', 'y'], ['b1', 'a']),
      wire('w3', ['a1', 'y'], ['a2', 'a']),
      wire('w4', ['b1', 'y'], ['b2', 'a']),
    ]);

    const g1 = extent(after, 'g1');
    const g2 = extent(after, 'g2');
    const overlap = Math.min(g1.bottom, g2.bottom) - Math.max(g1.top, g2.top);
    expect(overlap).toBeLessThanOrEqual(0);
  });

  it('leaves an ungrouped board placed exactly as before', () => {
    const comps = [routable('sw', 48, 48), routable('g', 600, 96)];
    const wires = [wire('w1', ['sw', 'y'], ['g', 'a'])];
    const withoutGroups = shifted(comps, wires);
    expect(withoutGroups.get('g')!.pins.get('a')!.pos.y).toBe(
      withoutGroups.get('sw')!.pins.get('y')!.pos.y,
    );
  });
});
