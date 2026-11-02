import { beforeEach, describe, expect, it } from 'vitest';
import { starterBoard, useCircuitStore } from './circuitStore';
import type { Board, ChipDef } from '../../core/model/types';

const st = () => useCircuitStore.getState();

const freshBoard = (over: Partial<Board> = {}): Board => ({ ...starterBoard(), ...over });

/** A user chip: one In port straight to one Out port. */
const passDef: ChipDef = {
  format: 'lcir.chip',
  formatVersion: 8,
  id: 'pass',
  name: 'pass',
  version: 1,
  pins: [
    { id: 'p1', name: 'A', dir: 'in', width: 1, role: 'data', order: 0, boundComponent: 'in1' },
    { id: 'p2', name: 'Y', dir: 'out', width: 1, role: 'data', order: 0, boundComponent: 'out1' },
  ],
  components: [
    { id: 'in1', kind: 'inport', pos: { x: 0, y: 0 }, label: 'A' },
    { id: 'out1', kind: 'outport', pos: { x: 80, y: 0 }, label: 'Y' },
    { id: 'g1', kind: 'and', pos: { x: 40, y: 40 } },
  ],
  wires: [
    {
      id: 'w1',
      a: { kind: 'pin', component: 'in1', pin: 'y' },
      b: { kind: 'pin', component: 'out1', pin: 'a' },
      points: [],
    },
  ],
  junctions: [],
};

describe('silenced checks in the store', () => {
  beforeEach(() => st().loadBoard(freshBoard()));

  it('hides on the board as one undo step, keeping a powered sim running', () => {
    st().power();
    expect(st().powered).toBe(true);
    const before = st().board;
    st().setChecksHidden(['unwired:g1.a', 'unwired:g1.b'], true);
    expect(st().board.hiddenChecks).toEqual(['unwired:g1.a', 'unwired:g1.b']);
    expect(st().board).not.toBe(before);
    expect(st().powered).toBe(true);
    st().setChecksHidden(['unwired:g1.a'], false);
    expect(st().board.hiddenChecks).toEqual(['unwired:g1.b']);
    st().undo();
    expect(st().board.hiddenChecks).toEqual(['unwired:g1.a', 'unwired:g1.b']);
    st().undo();
    expect(st().board.hiddenChecks).toBeUndefined();
    expect(st().powered).toBe(true);
    st().redo();
    expect(st().board.hiddenChecks).toEqual(['unwired:g1.a', 'unwired:g1.b']);
  });

  it('pushes nothing for a hide that changes nothing', () => {
    st().setChecksHidden(['unwired:g1.a'], false);
    expect(st().canUndo()).toBe(false);
  });

  it('hides inside a user chip without a version bump or power loss', () => {
    st().loadChipDefs([passDef]);
    st().openDefTab('pass', 'main/U1:pass/', 'pass');
    st().setChecksHidden(['unwired:g1.a'], true);
    const def = st().chipLib.get('pass')!;
    expect(def.hiddenChecks).toEqual(['unwired:g1.a']);
    expect(def.version).toBe(1);
    st().undo();
    expect(st().chipLib.get('pass')!.hiddenChecks).toBeUndefined();
    expect(st().chipLib.get('pass')!.version).toBe(1);
  });

  it('closes a chip tab whose only change is a hide without asking', () => {
    st().loadChipDefs([passDef]);
    st().openDefTab('pass', 'main/U1:pass/', 'pass');
    const tabId = st().activeTabId;
    st().setChecksHidden(['unwired:g1.a'], true);
    st().closeTab(tabId);
    expect(st().pendingTabClose).toBeNull();
    expect(st().tabs.some((t) => t.id === tabId)).toBe(false);
    expect(st().chipLib.get('pass')!.hiddenChecks).toEqual(['unwired:g1.a']);
  });

  it('selects and reveals what a row points at, and ignores a target that is gone', () => {
    st().revealItems(['g1', 'gone']);
    expect([...st().selection]).toEqual(['g1']);
    const seq = st().revealRequest!.seq;
    st().revealItems(['gone']);
    expect(st().revealRequest!.seq).toBe(seq);
  });

  it('refuses a hide inside a built-in part', () => {
    st().openDefTab('74LS00', '74LS00/', '74LS00');
    st().setChecksHidden(['unwired:u1.a'], true);
    expect(st().chipLib.get('74LS00')!.hiddenChecks).toBeUndefined();
    expect(st().canUndo()).toBe(false);
  });

  it('prunes keys for gone parts and pins on load and before a save', () => {
    st().loadBoard(freshBoard({ hiddenChecks: ['unwired:g1.a', 'unwired:gone.a', 'unused:g1.q'] }));
    expect(st().board.hiddenChecks).toEqual(['unwired:g1.a']);
    useCircuitStore.setState({
      board: { ...st().board, hiddenChecks: ['unwired:g1.a', 'unwired:nope.a'] },
    });
    const saved = st().pruneHiddenChecks();
    expect(saved.hiddenChecks).toEqual(['unwired:g1.a']);
    expect(st().board).toBe(saved);
    expect(st().pruneHiddenChecks()).toBe(saved);
  });

  it('prunes a loaded chip def against the library it joins', () => {
    st().loadChipDefs([{ ...passDef, hiddenChecks: ['unwired:g1.a', 'unwired:x.a'] }]);
    expect(st().chipLib.get('pass')!.hiddenChecks).toEqual(['unwired:g1.a']);
  });

  it('reports fights only while powered', () => {
    expect(st().simFights()).toBeNull();
    st().power();
    expect(st().simFights()!.nets).toEqual([]);
  });

  it('drops the replay cursor when the Checks tab takes the dock', () => {
    useCircuitStore.setState({ replayTimePs: 5 });
    st().setDockTab('checks');
    expect(st().dockTab).toBe('checks');
    expect(st().replayTimePs).toBeNull();
  });
});
