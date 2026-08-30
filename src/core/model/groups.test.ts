// A group is a named sub-circuit sharing a board. It scopes NAME-based
// joining and name uniqueness, and nothing else: a wire is explicit and always
// connects, whichever side of a border it starts on.
//
// The point of the scope is that two unconnected sub-circuits may each name a
// net `A`, which is what lets a circuit be imported into a board that
// already uses those names, and what lets one board carry a simplified and an
// unsimplified form of the same expression without either borrowing the
// other's outputs.

import { describe, expect, it } from 'vitest';
import { compile } from './compile';
import type { Board, ChipLibrary } from './types';
import '../sim/primitives/registry';

const EMPTY: ChipLibrary = new Map();

function board(components: Board['components'], wires: Board['wires'] = []): Board {
  return {
    format: 'lcir.board',
    formatVersion: 5,
    id: 'b',
    name: 'b',
    components,
    wires,
    junctions: [],
    groups: [
      { id: 'g1', name: 'Left' },
      { id: 'g2', name: 'Right' },
    ],
    probes: [],
    view: { x: 0, y: 0, zoom: 1 },
    timing: { mode: 'ideal', datasheet: 'typ' },
  };
}

/** Nets that carry at least one primitive pin, as sorted endpoint sets. */
function netSets(b: Board): string[][] {
  const c = compile(b, EMPTY);
  const ends = c.nets.map((): string[] => []);
  c.primitives.forEach((p) => {
    p.inputs.forEach((n, i) => ends[n]?.push(`${p.componentId}.in${i}`));
    p.outputs.forEach((n, i) => ends[n]?.push(`${p.componentId}.out${i}`));
  });
  return ends.filter((e) => e.length > 0).map((e) => e.sort());
}

describe('groups scope net-label joining', () => {
  it('does not join same-named labels in different groups', () => {
    const b = board(
      [
        { id: 't1', kind: 'toggle', group: 'g1', pos: { x: 0, y: 0 } },
        { id: 'n1', kind: 'netlabel', group: 'g1', label: 'A', pos: { x: 40, y: 0 } },
        { id: 'l1', kind: 'led', group: 'g1', pos: { x: 80, y: 0 } },
        { id: 't2', kind: 'toggle', group: 'g2', pos: { x: 0, y: 200 } },
        { id: 'n2', kind: 'netlabel', group: 'g2', label: 'A', pos: { x: 40, y: 200 } },
        { id: 'l2', kind: 'led', group: 'g2', pos: { x: 80, y: 200 } },
      ],
      [
        {
          id: 'w1',
          a: { kind: 'pin', component: 't1', pin: 'y' },
          b: { kind: 'pin', component: 'n1', pin: 'a' },
          points: [],
        },
        {
          id: 'w2',
          a: { kind: 'pin', component: 't2', pin: 'y' },
          b: { kind: 'pin', component: 'n2', pin: 'a' },
          points: [],
        },
      ],
    );

    const nets = netSets(b);
    // Each toggle drives its own net; the two `A` labels must not merge them.
    const merged = nets.some(
      (n) => n.some((e) => e.startsWith('main/t1')) && n.some((e) => e.startsWith('main/t2')),
    );
    expect(merged).toBe(false);
  });

  it('still joins same-named labels inside one group', () => {
    const b = board(
      [
        { id: 't1', kind: 'toggle', group: 'g1', pos: { x: 0, y: 0 } },
        { id: 'n1', kind: 'netlabel', group: 'g1', label: 'A', pos: { x: 40, y: 0 } },
        { id: 'n2', kind: 'netlabel', group: 'g1', label: 'A', pos: { x: 40, y: 80 } },
        { id: 'l1', kind: 'led', group: 'g1', pos: { x: 80, y: 80 } },
      ],
      [
        {
          id: 'w1',
          a: { kind: 'pin', component: 't1', pin: 'y' },
          b: { kind: 'pin', component: 'n1', pin: 'a' },
          points: [],
        },
        {
          id: 'w2',
          a: { kind: 'pin', component: 'n2', pin: 'a' },
          b: { kind: 'pin', component: 'l1', pin: 'a' },
          points: [],
        },
      ],
    );

    const joined = netSets(b).some(
      (n) => n.some((e) => e.startsWith('main/t1')) && n.some((e) => e.startsWith('main/l1')),
    );
    expect(joined).toBe(true);
  });

  it('leaves ungrouped labels joining board-wide, as before groups existed', () => {
    const b = board(
      [
        { id: 't1', kind: 'toggle', pos: { x: 0, y: 0 } },
        { id: 'n1', kind: 'netlabel', label: 'A', pos: { x: 40, y: 0 } },
        { id: 'n2', kind: 'netlabel', label: 'A', pos: { x: 40, y: 80 } },
        { id: 'l1', kind: 'led', pos: { x: 80, y: 80 } },
      ],
      [
        {
          id: 'w1',
          a: { kind: 'pin', component: 't1', pin: 'y' },
          b: { kind: 'pin', component: 'n1', pin: 'a' },
          points: [],
        },
        {
          id: 'w2',
          a: { kind: 'pin', component: 'n2', pin: 'a' },
          b: { kind: 'pin', component: 'l1', pin: 'a' },
          points: [],
        },
      ],
    );
    const joined = netSets(b).some(
      (n) => n.some((e) => e.startsWith('main/t1')) && n.some((e) => e.startsWith('main/l1')),
    );
    expect(joined).toBe(true);
  });

  it('connects a wire that crosses a group border', () => {
    // A wire is explicit. Only NAME-based joining is scoped, so drawing a wire
    // between two groups connects them exactly as it would anywhere else.
    const b = board(
      [
        { id: 't1', kind: 'toggle', group: 'g1', pos: { x: 0, y: 0 } },
        { id: 'l2', kind: 'led', group: 'g2', pos: { x: 200, y: 0 } },
      ],
      [
        {
          id: 'w1',
          a: { kind: 'pin', component: 't1', pin: 'y' },
          b: { kind: 'pin', component: 'l2', pin: 'a' },
          points: [],
        },
      ],
    );
    const joined = netSets(b).some(
      (n) => n.some((e) => e.startsWith('main/t1')) && n.some((e) => e.startsWith('main/l2')),
    );
    expect(joined).toBe(true);
  });

  it('names a grouped net path after its group, so probes stay distinguishable', () => {
    const b = board([
      { id: 'n1', kind: 'netlabel', group: 'g1', label: 'A', pos: { x: 0, y: 0 } },
      { id: 'n2', kind: 'netlabel', group: 'g2', label: 'A', pos: { x: 0, y: 200 } },
    ]);
    const paths = compile(b, EMPTY).nets.flatMap((n) => n.paths);
    expect(paths).toContain('main/Left/A');
    expect(paths).toContain('main/Right/A');
  });
});
