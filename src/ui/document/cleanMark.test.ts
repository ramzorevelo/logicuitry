import { beforeEach, describe, expect, it } from 'vitest';
import { starterBoard, useCircuitStore } from '../workbench-circuit/circuitStore';
import { isDirtyAgainst, restoredCleanMark } from './cleanMark';

const board = () => useCircuitStore.getState().board;

describe('restoredCleanMark', () => {
  beforeEach(() => useCircuitStore.getState().loadBoard(starterBoard()));

  it('keeps a restored dirty board dirty after the load', () => {
    useCircuitStore.getState().loadBoard(starterBoard());
    const clean = restoredCleanMark(true, board());
    expect(isDirtyAgainst(board(), clean)).toBe(true);
    useCircuitStore.getState().undo();
    expect(isDirtyAgainst(board(), clean)).toBe(true);
  });

  it('marks a restored clean board clean until the next edit', () => {
    useCircuitStore.getState().loadBoard(starterBoard());
    const clean = restoredCleanMark(false, board());
    expect(isDirtyAgainst(board(), clean)).toBe(false);
    useCircuitStore.getState().place('and', { x: 400, y: 200 }, 8);
    expect(isDirtyAgainst(board(), clean)).toBe(true);
  });
});

describe('dirty against the saved board', () => {
  beforeEach(() => useCircuitStore.getState().loadBoard(starterBoard()));

  it('stays clean through powering and running, which only bump rev', () => {
    const clean = board();
    const s = useCircuitStore.getState();
    s.power();
    s.toggleRun();
    s.pump(100_000);
    s.toggleRun();
    s.power();
    expect(useCircuitStore.getState().rev).toBeGreaterThan(0);
    expect(isDirtyAgainst(board(), clean)).toBe(false);
  });

  it('counts edits in an open chip tab, which replacing the board would close', () => {
    const s = useCircuitStore.getState();
    expect(s.hasTabEdits()).toBe(false);
    const def = {
      format: 'lcir.chip' as const,
      formatVersion: 5 as const,
      id: 'mine',
      name: 'mine',
      version: 1,
      pins: [],
      components: [],
      wires: [],
      junctions: [],
    };
    s.commitNewChip(def);
    s.openDefTab('mine', 'mine/', 'mine');
    useCircuitStore.getState().place('not', { x: 200, y: 200 }, 8);
    expect(useCircuitStore.getState().hasTabEdits()).toBe(true);
  });

  it('turns dirty on a timing switch, which the file saves', () => {
    const clean = board();
    useCircuitStore.getState().setTiming({ mode: 'datasheet' });
    expect(isDirtyAgainst(board(), clean)).toBe(true);
  });
});
