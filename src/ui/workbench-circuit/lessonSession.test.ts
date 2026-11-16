import { beforeEach, describe, expect, it } from 'vitest';
import { useCircuitStore } from './circuitStore';
import { board, comp, wire } from '../../core/model/testFixtures';
import { usePrefsStore } from '../prefs';

const st = () => useCircuitStore.getState();

beforeEach(() => {
  usePrefsStore.getState().setPref('keepSwitchesAcrossPower', true);
  st().loadBoard(
    board({
      components: [comp('sw', 'toggle', undefined, 'S'), comp('l', 'led', undefined, 'L')],
      wires: [wire('w1', ['sw', 'y'], ['l', 'a'])],
    }),
  );
});

describe('setSessionTiming', () => {
  it('restarts the sim on the new mode but leaves the board object alone', () => {
    const before = st().board;
    st().power();
    st().setSessionTiming('datasheet');
    expect(st().timing.mode).toBe('datasheet');
    expect(st().powered).toBe(false);
    expect(st().board).toBe(before);
    expect(st().board.timing.mode).toBe('ideal');
  });

  it('is not an undo step', () => {
    st().setSessionTiming('datasheet');
    expect(st().canUndo()).toBe(false);
  });
});

describe('resetForLesson', () => {
  it('drops the sim and every remembered switch position', () => {
    const before = st().board;
    st().power();
    st().toggleInput('sw');
    st().power(); // off: the position is held for the next power-on
    st().resetForLesson();
    st().power();
    expect(st().pinSignal('sw', 'y')).toBe('0');
    expect(st().board).toBe(before);
  });

  it('powers off, stops Run and goes back to the board timing', () => {
    st().power();
    st().toggleRun();
    st().setSessionTiming('datasheet');
    st().power();
    st().resetForLesson();
    expect(st().powered).toBe(false);
    expect(st().running).toBe(false);
    expect(st().timing.mode).toBe('ideal');
  });

  it('a loaded board clears the lesson highlight and counts the load', () => {
    st().setLessonHighlight(['sw']);
    const loads = st().boardLoads;
    st().loadBoard(st().board);
    expect(st().lessonHighlight.size).toBe(0);
    expect(st().boardLoads).toBe(loads + 1);
  });
});
