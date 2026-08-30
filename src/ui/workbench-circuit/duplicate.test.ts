import { describe, expect, it } from 'vitest';
import { extractInternalSelection } from './duplicate';
import type { Circuit } from '../../core/model/types';

function circuit(): Circuit {
  return {
    components: [
      { id: 'a', kind: 'toggle', pos: { x: 0, y: 0 } },
      { id: 'b', kind: 'not', pos: { x: 40, y: 0 } },
      { id: 'c', kind: 'led', pos: { x: 80, y: 0 } },
    ],
    junctions: [{ id: 'j1', pos: { x: 20, y: 0 } }],
    wires: [
      // Fully inside {a, b}: kept.
      {
        id: 'w1',
        a: { kind: 'pin', component: 'a', pin: 'y' },
        b: { kind: 'pin', component: 'b', pin: 'a' },
        points: [],
      },
      // Leaves the selection (c not picked): dropped.
      {
        id: 'w2',
        a: { kind: 'pin', component: 'b', pin: 'y' },
        b: { kind: 'pin', component: 'c', pin: 'a' },
        points: [],
      },
      // Junction end, junction picked: kept.
      {
        id: 'w3',
        a: { kind: 'pin', component: 'a', pin: 'y' },
        b: { kind: 'junction', junction: 'j1' },
        points: [],
      },
    ],
  };
}

describe('extractInternalSelection', () => {
  it('keeps only components/junctions in the set and wires fully inside it', () => {
    const result = extractInternalSelection(circuit(), new Set(['a', 'b', 'j1']));
    expect(result.components.map((c) => c.id).sort()).toEqual(['a', 'b']);
    expect(result.junctions.map((j) => j.id)).toEqual(['j1']);
    expect(result.wires.map((w) => w.id).sort()).toEqual(['w1', 'w3']);
  });

  it('drops a wire whose only picked end is a free/tap end (never carries over)', () => {
    const c = circuit();
    c.wires.push({
      id: 'w4',
      a: { kind: 'pin', component: 'a', pin: 'y' },
      b: { kind: 'free', pos: { x: 5, y: 5 } },
      points: [],
    });
    const result = extractInternalSelection(c, new Set(['a']));
    expect(result.wires.find((w) => w.id === 'w4')).toBeUndefined();
  });

  it('returns nothing for an empty selection', () => {
    const result = extractInternalSelection(circuit(), new Set());
    expect(result.components).toHaveLength(0);
    expect(result.junctions).toHaveLength(0);
    expect(result.wires).toHaveLength(0);
  });
});
