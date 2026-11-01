import { beforeEach, describe, expect, it } from 'vitest';
import { useCircuitStore } from './circuitStore';
import { board } from '../../core/model/testFixtures';
import { clampParamValue, paramKeysFor } from './paramSpecs';
import { pinViewGroupsFor } from './pinViewUI';
import '../../render/glyphs/chip';

const ramParams = () => {
  const c = useCircuitStore.getState().board.components.find((x) => x.kind === 'ram')!;
  return { id: c.id, params: c.params ?? {} };
};

describe('RAM param edits', () => {
  beforeEach(() => {
    useCircuitStore.setState({
      board: board({}),
      chipLib: new Map(),
      tabs: [{ id: 'board', kind: 'board' }],
      activeTabId: 'board',
      staleInstances: new Set(),
      selection: new Set(),
      powered: false,
      error: null,
    });
    useCircuitStore
      .getState()
      .place('ram', { x: 0, y: 0 }, 8, { width: 8, addressBits: 2, preload: '0A FF 3C 11' });
  });

  it('an overlay commit keeps the preload when the size is unchanged', () => {
    const { id } = ramParams();
    const s = useCircuitStore.getState();
    expect(
      s.setComponentParamsBatch([{ id, params: { width: 8, addressBits: 2, pinView: '' } }]),
    ).toBe(true);
    expect(ramParams().params['preload']).toBe('0A FF 3C 11');
  });

  it('a width and addressBits edit rewrites the preload in the same undo step', () => {
    const { id } = ramParams();
    const s = useCircuitStore.getState();
    s.setComponentParamsBatch([{ id, params: { width: 4, addressBits: 1 } }]);
    expect(ramParams().params).toMatchObject({ width: 4, addressBits: 1, preload: 'A F' });
    useCircuitStore.getState().undo();
    expect(ramParams().params).toMatchObject({ width: 8, addressBits: 2, preload: '0A FF 3C 11' });
    useCircuitStore.getState().redo();
    expect(ramParams().params).toMatchObject({ width: 4, addressBits: 1, preload: 'A F' });
  });

  it('growing addressBits keeps every cell, the new ones X', () => {
    const { id } = ramParams();
    useCircuitStore.getState().setComponentParamsBatch([{ id, params: { addressBits: 4 } }]);
    expect(ramParams().params['preload']).toBe('0A FF 3C 11');
  });
});

describe('RAM overlay fields', () => {
  it('offers width and addressBits, addressBits clamped to 1..8', () => {
    const keys = paramKeysFor('ram', { width: 8, addressBits: 4 });
    expect(keys.has('width')).toBe(true);
    expect(keys.has('addressBits')).toBe(true);
    expect(clampParamValue('ram', 'addressBits', 12)).toBe(8);
    expect(clampParamValue('ram', 'addressBits', 0)).toBe(1);
    expect(clampParamValue('decoder', 'addressBits', 12)).toBe(4);
  });

  it('offers a, d and q lane groups when they are wider than one bit', () => {
    expect(pinViewGroupsFor('ram', { width: 8, addressBits: 4 }).map((g) => g.key)).toEqual([
      'a',
      'd',
      'q',
    ]);
    expect(pinViewGroupsFor('ram', { width: 1, addressBits: 1 })).toEqual([]);
  });
});
