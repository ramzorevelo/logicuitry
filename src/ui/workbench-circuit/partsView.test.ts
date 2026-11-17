import { describe, expect, it } from 'vitest';
import { useCircuitStore } from './circuitStore';
import { gateLabel, packingSummary, problemsLine, withPartChoice } from './partsView';

describe('withPartChoice', () => {
  it('sets, replaces and clears one key', () => {
    const a = withPartChoice(undefined, 'and:2', '74LS08');
    expect(a).toEqual({ 'and:2': '74LS08' });
    expect(withPartChoice(a, 'or:2', '74LS32')).toEqual({ 'and:2': '74LS08', 'or:2': '74LS32' });
    expect(withPartChoice(a, 'and:2', undefined)).toBeUndefined();
  });
});

describe('labels', () => {
  it('names gates and packing', () => {
    expect(gateLabel({ kind: 'nand', inputs: 3 })).toBe('3-input NAND');
    expect(gateLabel({ kind: 'not', inputs: 1 })).toBe('NOT');
    expect(packingSummary({ choice: '74LS08', ics: 2, spare: 3 })).toBe('2 ICs, 3 spare gates');
    expect(packingSummary({})).toBe('');
  });

  it('summarises problems', () => {
    expect(problemsLine([])).toBeNull();
    const p = { component: 'c', name: 'Foo', kind: 'missing' as const, defId: 'foo' };
    expect(problemsLine([p, { ...p, component: 'd' }])).toBe('2 chips not loaded: Foo');
  });
});

describe('setPartChoice and dock tab', () => {
  it('stores the choice, bumps rev, adds no undo entry, and clears', () => {
    const s = () => useCircuitStore.getState();
    const rev = s().rev;
    s().setPartChoice('and:2', '74LS08');
    expect(s().board.partChoices).toEqual({ 'and:2': '74LS08' });
    expect(s().rev).toBe(rev + 1);
    expect(s().canUndo()).toBe(false);
    s().setPartChoice('and:2', undefined);
    expect(s().board.partChoices).toBeUndefined();
  });

  it('accepts the parts tab', () => {
    useCircuitStore.getState().setDockTab('parts');
    expect(useCircuitStore.getState().dockTab).toBe('parts');
    useCircuitStore.getState().setDockTab('waves');
  });
});
