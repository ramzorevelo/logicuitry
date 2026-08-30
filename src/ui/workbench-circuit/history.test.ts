import { describe, expect, it } from 'vitest';
import { History, applyToCircuit, diffCircuits, type ApplyFn } from './history';
import type { Circuit, Component } from '../../core/model/types';

const comp = (id: string, x = 0): Component => ({ id, kind: 'and', pos: { x, y: 0 } });
const circuit = (components: Component[]): Circuit => ({ components, wires: [], junctions: [] });
const clone = (c: Circuit): Circuit => JSON.parse(JSON.stringify(c)) as Circuit;

describe('history diff + apply', () => {
  it('diffs an add into one picked item and skips unchanged entities', () => {
    const before = circuit([comp('a')]);
    const after = circuit([comp('a'), comp('b')]);
    const cmd = diffCircuits(before, after, 'place');
    expect(cmd.items).toHaveLength(1);
    expect(cmd.items[0]).toMatchObject({ kind: 'component', id: 'b', before: null });
  });

  it('undo reverts an add, redo reapplies it, as one step', () => {
    const state = circuit([comp('a')]);
    const before = clone(state);
    applyToCircuit(state, 'component', 'b', comp('b'));
    const cmd = diffCircuits(before, state, 'place');

    const history = new History();
    history.commit(cmd);
    const apply: ApplyFn = (kind, id, value) =>
      applyToCircuit(state, kind, id, value as Component | null);

    history.undo(apply);
    expect(state.components.map((c) => c.id)).toEqual(['a']);
    history.redo(apply);
    expect(state.components.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('a move (modify) round-trips through undo/redo', () => {
    const state = circuit([comp('a', 0)]);
    const before = clone(state);
    applyToCircuit(state, 'component', 'a', comp('a', 40));
    const history = new History();
    history.commit(diffCircuits(before, state, 'move'));
    const apply: ApplyFn = (kind, id, value) =>
      applyToCircuit(state, kind, id, value as Component | null);
    history.undo(apply);
    expect(state.components[0]!.pos.x).toBe(0);
    history.redo(apply);
    expect(state.components[0]!.pos.x).toBe(40);
  });

  it('committing clears the redo stack', () => {
    const history = new History();
    history.commit({
      label: 'a',
      items: [{ kind: 'component', id: 'x', before: null, after: comp('x') }],
    });
    history.undo(() => {});
    expect(history.canRedo).toBe(true);
    history.commit({
      label: 'b',
      items: [{ kind: 'component', id: 'y', before: null, after: comp('y') }],
    });
    expect(history.canRedo).toBe(false);
  });
});
