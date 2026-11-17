import { beforeEach, describe, expect, it } from 'vitest';
import { starterBoard, useCircuitStore } from './circuitStore';
import { board, comp, wire } from '../../core/model/testFixtures';
import { usePrefsStore } from '../prefs';

const st = () => useCircuitStore.getState();

beforeEach(() => {
  usePrefsStore.getState().setPref('keepSwitchesAcrossPower', false);
  useCircuitStore.setState({ selection: new Set(), powered: false, running: false });
  st().loadBoard(starterBoard());
  st().power();
});

describe('a paused input change stays pending', () => {
  it('a switch flip leaves the gate behind until stepped', () => {
    st().toggleInput('sw1');
    st().toggleInput('sw2');
    expect(st().pinSignal('led1', 'a')).toBe('0');
    expect(st().canSettle()).toBe(true);
    expect(st().gateStatus()).toBe('Paused: gate steps pending');
  });

  it('Gate step walks it from t = 0 and ends settled', () => {
    st().toggleInput('sw1');
    st().settle();
    st().toggleInput('sw2');
    st().gateStep();
    expect(st().gateStatus()).toMatch(/^t = 0 gate delays/);
    for (let i = 0; i < 20 && st().canSettle(); i++) st().gateStep();
    expect(st().pinSignal('led1', 'a')).toBe('1');
    expect(st().canSettle()).toBe(false);
  });

  it('Settle finishes it at once', () => {
    st().toggleInput('sw1');
    st().toggleInput('sw2');
    st().settle();
    expect(st().pinSignal('led1', 'a')).toBe('1');
  });

  it('two flips of one switch before stepping cancel out', () => {
    st().toggleInput('sw1');
    st().toggleInput('sw1');
    expect(st().canSettle()).toBe(true);
    st().settle();
    expect(st().pinSignal('sw1', 'y')).toBe('0');
  });

  it('a paused flip clears a loop reported earlier', () => {
    useCircuitStore.setState({ oscillation: ['x'] });
    st().toggleInput('sw1');
    expect(st().oscillation).toBeNull();
    expect(st().gateStatus()).toBe('Paused: gate steps pending');
  });

  it('Run takes a pending change', () => {
    st().toggleInput('sw1');
    st().toggleInput('sw2');
    st().toggleRun();
    st().toggleRun();
    st().settle();
    expect(st().pinSignal('led1', 'a')).toBe('1');
  });
});

describe('a paused button click', () => {
  beforeEach(() => {
    st().loadBoard(
      board({
        components: [
          comp('ck', 'button', undefined, 'CK'),
          comp('ff', 'dff'),
          comp('d', 'toggle', undefined, 'D'),
          comp('q', 'led', undefined, 'Q'),
        ],
        wires: [
          wire('w1', ['ck', 'y'], ['ff', 'clk']),
          wire('w2', ['d', 'y'], ['ff', 'd']),
          wire('w3', ['ff', 'q'], ['q', 'a']),
        ],
      }),
    );
    st().power();
  });

  it('lands its press before the release, so a quick click still clocks', () => {
    st().toggleInput('d');
    st().settle();
    st().setButtonHeld('ck', true);
    st().setButtonHeld('ck', false);
    st().settle();
    expect(st().pinSignal('q', 'a')).toBe('1');
    expect(st().buttonHeld('ck')).toBe(false);
  });
});

describe('a paused sequence row', () => {
  beforeEach(() => {
    st().loadBoard(
      board({
        components: [comp('a', 'toggle', { width: 4 }, 'A'), comp('y', 'led', { width: 4 }, 'Y')],
        wires: [wire('w1', ['a', 'y'], ['y', 'a'])],
        sequence: {
          inputs: ['a'],
          expect: ['y'],
          rows: [
            { set: [5], expect: [5] },
            { set: [3], expect: [3] },
          ],
          advance: { mode: 'key' },
          hideExpected: false,
        },
      }),
    );
    st().power();
  });

  it('is judged once Gate step settles it, not when applied', () => {
    st().applySequenceRow(0);
    expect(st().sequenceRun()?.pending).toBe(0);
    for (let i = 0; i < 20 && st().canSettle(); i++) st().gateStep();
    expect(st().sequenceRun()).toMatchObject({ pending: null, results: [true] });
  });

  it('moving to the next row lets the last one finish first', () => {
    st().applySequenceRow(0);
    st().applySequenceRow(1);
    expect(st().sequenceRun()).toMatchObject({ cursor: 1, pending: 1, results: [true] });
  });

  it('a click on a pending row judges the row first, as it stood', () => {
    st().applySequenceRow(0);
    st().toggleInput('a');
    expect(st().sequenceRun()).toMatchObject({ pending: null, results: [true] });
    expect(st().canSettle()).toBe(true);
  });

  it('a lesson row settles and is judged at once', () => {
    st().applySequenceRow(0, true);
    expect(st().pinRawValue('y', 'a')?.v).toBe(5);
    expect(st().sequenceRun()).toMatchObject({ pending: null, results: [true] });
  });
});
