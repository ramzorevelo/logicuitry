import { describe, expect, it } from 'vitest';
import type { ChipLibrary, Circuit } from '../../core/model/types';
import { wireDisplayInfo } from './wireDisplay';
import '../../core/sim/primitives/registry';

const lib: ChipLibrary = new Map();

/** Switch -> dot -> LED, so the middle-to-LED run is not the only path to a
 *  pin, and a dot-to-dot run has no pin end at all. */
function board(): Circuit {
  return {
    components: [
      { id: 'sw', kind: 'toggle', pos: { x: 0, y: 0 }, params: { width: 4 } },
      { id: 'led', kind: 'led', pos: { x: 200, y: 0 }, params: { width: 4 } },
    ],
    junctions: [
      { id: 'j1', pos: { x: 80, y: 0 } },
      { id: 'j2', pos: { x: 120, y: 0 } },
    ],
    wires: [
      {
        id: 'w1',
        a: { kind: 'pin', component: 'sw', pin: 'y' },
        b: { kind: 'junction', junction: 'j1' },
        points: [],
      },
      {
        id: 'w2',
        a: { kind: 'junction', junction: 'j1' },
        b: { kind: 'junction', junction: 'j2' },
        points: [],
      },
      {
        id: 'w3',
        a: { kind: 'junction', junction: 'j2' },
        b: { kind: 'pin', component: 'led', pin: 'a' },
        points: [],
      },
      {
        id: 'w4',
        a: { kind: 'free', pos: { x: 0, y: 80 } },
        b: { kind: 'free', pos: { x: 40, y: 80 } },
        points: [],
      },
    ],
  };
}

describe('wireDisplayInfo', () => {
  it('reads a pin end directly, and walks the net for a wire with none', () => {
    const info = wireDisplayInfo(board(), lib);
    expect(info.get('w1')).toMatchObject({ width: 4, readPin: { component: 'sw', pin: 'y' } });
    expect(info.get('w2')!.width).toBe(4);
    expect(info.get('w2')!.readPin).toMatchObject({ component: 'sw', pin: 'y' });
    expect(info.get('w4')).toEqual({ width: 1, readPin: undefined });
  });

  it('is reused for the same arrays and rebuilt when they change', () => {
    const b = board();
    const first = wireDisplayInfo(b, lib);
    expect(wireDisplayInfo(b, lib)).toBe(first);
    expect(wireDisplayInfo(b, new Map())).not.toBe(first);
  });

  it('keeps the result through a move, which only changes positions and bends', () => {
    const b = board();
    const first = wireDisplayInfo(b, lib);
    const moved: Circuit = {
      ...b,
      components: b.components.map((c) => ({ ...c, pos: { x: c.pos.x + 40, y: c.pos.y } })),
      wires: b.wires.map((w) => (w.id === 'w1' ? { ...w, points: [{ x: 40, y: 20 }] } : w)),
    };
    expect(wireDisplayInfo(moved, lib)).toBe(first);
    const recoloured = { ...b, wires: b.wires.map((w) => ({ ...w, color: 'g1' as const })) };
    expect(wireDisplayInfo(recoloured, lib)).toBe(first);
  });

  it('rebuilds when connectivity or a parameter changes', () => {
    const b = board();
    wireDisplayInfo(b, lib);
    const wider: Circuit = {
      ...b,
      components: b.components.map((c) => (c.id === 'sw' ? { ...c, params: { width: 8 } } : c)),
    };
    expect(wireDisplayInfo(wider, lib).get('w2')!.width).toBe(8);
    const settled = wireDisplayInfo(b, lib);
    const freeMoved: Circuit = {
      ...b,
      wires: b.wires.map((w) =>
        w.id === 'w4' ? { ...w, b: { kind: 'free', pos: { x: 60, y: 80 } } } : w,
      ),
    };
    expect(wireDisplayInfo(freeMoved, lib)).not.toBe(settled);
    const again = wireDisplayInfo(b, lib);
    expect(wireDisplayInfo({ ...b, wires: b.wires.slice(1) }, lib)).not.toBe(again);
  });
});
