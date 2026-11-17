import { describe, expect, it } from 'vitest';
import type { Circuit, Component } from '../../core/model/types';
import { fitScale, MAX_AREA_PX, MAX_SIDE_PX, selectionSubset } from './exportPicture';

const part = (id: string, group?: string): Component =>
  ({ id, kind: 'and', pos: { x: 0, y: 0 }, ...(group ? { group } : {}) }) as Component;

const circuit: Circuit = {
  components: [part('g1', 'inner'), part('g2'), part('g3')],
  junctions: [{ id: 'j1', pos: { x: 5, y: 5 } }] as Circuit['junctions'],
  wires: [
    {
      id: 'w12',
      a: { kind: 'pin', component: 'g1', pin: 'Y' },
      b: { kind: 'pin', component: 'g2', pin: 'A' },
      points: [],
    },
    {
      id: 'w13',
      a: { kind: 'pin', component: 'g1', pin: 'Y' },
      b: { kind: 'pin', component: 'g3', pin: 'A' },
      points: [],
    },
    {
      id: 'wj',
      a: { kind: 'pin', component: 'g1', pin: 'Y' },
      b: { kind: 'junction', junction: 'j1' },
      points: [],
    },
    {
      id: 'wf',
      a: { kind: 'pin', component: 'g2', pin: 'Y' },
      b: { kind: 'free', pos: { x: 9, y: 9 } },
      points: [],
    },
  ] as Circuit['wires'],
  groups: [
    { id: 'outer', name: 'Outer' },
    { id: 'inner', name: 'Inner', parent: 'outer' },
    { id: 'other', name: 'Other' },
  ] as NonNullable<Circuit['groups']>,
};

describe('selectionSubset', () => {
  it('keeps a wire only when both its ends stay', () => {
    const sub = selectionSubset(circuit, new Set(['g1', 'g2']));
    expect(sub.components.map((c) => c.id)).toEqual(['g1', 'g2']);
    expect(sub.wires.map((w) => w.id)).toEqual(['w12']);
  });

  it('keeps a junction wire with its junction, and a free end only when the wire is selected', () => {
    expect(selectionSubset(circuit, new Set(['g1', 'j1'])).wires.map((w) => w.id)).toEqual(['wj']);
    expect(selectionSubset(circuit, new Set(['g2'])).wires).toEqual([]);
    expect(selectionSubset(circuit, new Set(['g2', 'wf'])).wires.map((w) => w.id)).toEqual(['wf']);
  });

  it('keeps the groups of kept parts and their ancestors', () => {
    const sub = selectionSubset(circuit, new Set(['g1']));
    expect(sub.groups?.map((g) => g.id)).toEqual(['outer', 'inner']);
  });
});

describe('fitScale', () => {
  it('keeps the asked scale when it fits', () => {
    expect(fitScale(800, 600, 3)).toEqual({ scale: 3, reduced: false });
  });

  it('drops the scale on a long side', () => {
    const { scale, reduced } = fitScale(4000, 500, 3);
    expect(reduced).toBe(true);
    expect(4000 * scale).toBeLessThanOrEqual(MAX_SIDE_PX);
  });

  it('drops the scale on a large area', () => {
    const { scale, reduced } = fitScale(5000, 5000, 2);
    expect(reduced).toBe(true);
    expect(5000 * scale * 5000 * scale).toBeLessThanOrEqual(MAX_AREA_PX);
    expect(5000 * scale).toBeLessThanOrEqual(MAX_SIDE_PX);
  });
});
