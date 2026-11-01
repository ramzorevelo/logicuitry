import { beforeEach, describe, expect, it } from 'vitest';
import { starterBoard, useCircuitStore } from './circuitStore';
import { board, chipComp, memChipDef } from '../../core/model/testFixtures';
import { isChipInstance, type Component } from '../../core/model/types';
import { parseBoard } from '../../io/boardFile';
import { serializeDocument } from '../../io/library';

const PROGRAM = { r1: '11 22' };

const contentsOf = (c: Component | undefined) => (c && isChipInstance(c) ? c.contents : undefined);
const instance = (id = 'u1') =>
  contentsOf(useCircuitStore.getState().board.components.find((c) => c.id === id));

function loadMemBoard(contents: Record<string, string>): void {
  const s = useCircuitStore.getState();
  s.loadChipDefs([memChipDef()]);
  s.loadBoard(board({ components: [chipComp('u1', 'mem', 'U1', contents)] }));
}

describe('instance contents in the store', () => {
  beforeEach(() => {
    useCircuitStore.getState().loadBoard(starterBoard());
    useCircuitStore.setState({ selection: new Set(), powered: false, error: null });
  });

  it('names a misfit entry apart from a missing one and still powers', () => {
    loadMemBoard({ r1: '1 2 3', gone: '1' });
    expect(useCircuitStore.getState().error).toBe(
      'contents: no RAM at U1/gone now; U1/r1 no longer fits its RAM; the saved memory is kept',
    );
    useCircuitStore.getState().power();
    expect(useCircuitStore.getState().powered).toBe(true);
    expect(instance()).toEqual({ r1: '1 2 3', gone: '1' });
  });

  it('reports a stale key once on load, not again on the next compiles', () => {
    loadMemBoard({ r1: '05', gone: '1' });
    expect(useCircuitStore.getState().error).toBe(
      'contents: no RAM at U1/gone now; the saved memory is kept',
    );
    useCircuitStore.setState({ error: null });
    useCircuitStore.getState().power();
    expect(useCircuitStore.getState().powered).toBe(true);
    expect(useCircuitStore.getState().error).toBeNull();
    useCircuitStore.getState().power();
    useCircuitStore.getState().renameComponent('u1', 'U9');
    expect(useCircuitStore.getState().error).toBeNull();
    expect(instance()).toEqual({ r1: '05', gone: '1' });
  });

  it('shows the notice again when another board brings stale keys', () => {
    loadMemBoard({ gone: '1' });
    useCircuitStore.setState({ error: null });
    loadMemBoard({ gone: '1' });
    expect(useCircuitStore.getState().error).toMatch(/^contents: no RAM at U1\/gone/);
  });

  it('stays quiet when every key names a RAM', () => {
    loadMemBoard(PROGRAM);
    useCircuitStore.getState().power();
    expect(useCircuitStore.getState().error).toBeNull();
  });

  it('keeps contents through rename, move, mirror and undo/redo', () => {
    loadMemBoard(PROGRAM);
    const s = useCircuitStore.getState();
    s.renameComponent('u1', 'U7');
    useCircuitStore.setState({ selection: new Set(['u1']) });
    useCircuitStore.getState().moveSelection(16, 0);
    useCircuitStore.getState().mirrorSelection();
    expect(instance()).toEqual(PROGRAM);
    for (let i = 0; i < 3; i++) useCircuitStore.getState().undo();
    expect(instance()).toEqual(PROGRAM);
    for (let i = 0; i < 3; i++) useCircuitStore.getState().redo();
    expect(instance()).toEqual(PROGRAM);
  });

  it('keeps contents through group and ungroup', () => {
    loadMemBoard(PROGRAM);
    useCircuitStore.setState({ selection: new Set(['u1']) });
    useCircuitStore.getState().groupSelection('Memory');
    expect(instance()).toEqual(PROGRAM);
    useCircuitStore.getState().ungroupSelection();
    expect(instance()).toEqual(PROGRAM);
  });

  it('copies contents with a duplicated or pasted instance', () => {
    loadMemBoard(PROGRAM);
    const source = useCircuitStore.getState().board.components[0]!;
    useCircuitStore
      .getState()
      .commitDuplicate({ components: [source], wires: [], junctions: [] }, { x: 0, y: 64 });
    const [copyId] = [...useCircuitStore.getState().selection];
    expect(copyId).not.toBe('u1');
    expect(instance(copyId)).toEqual(PROGRAM);
  });

  it('keeps contents across a save and reload of the board', () => {
    loadMemBoard(PROGRAM);
    const text = serializeDocument(useCircuitStore.getState().board);
    useCircuitStore.getState().loadBoard(parseBoard(text));
    expect(instance()).toEqual(PROGRAM);
  });
});
