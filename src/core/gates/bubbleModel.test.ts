import { describe, expect, it } from 'vitest';
import {
  composeKind,
  decomposeKind,
  gateInputPins,
  getInputBubbles,
  getOutputBubble,
  importCircuit,
  normalizeGateComponent,
  toggleInputBubble,
  toggleOutputBubble,
} from './bubbleModel';
import type { Component } from '../model/types';

const comp = (over: Partial<Component>): Component => ({
  id: 'g1',
  kind: 'and',
  pos: { x: 0, y: 0 },
  ...over,
});

describe('compose/decompose', () => {
  it('composes base+bubble into the literal kind', () => {
    expect(composeKind('and', true)).toBe('nand');
    expect(composeKind('and', false)).toBe('and');
    expect(composeKind('or', true)).toBe('nor');
    expect(composeKind('buf', true)).toBe('not');
  });
  it('decomposes the literal kind back into base+bubble', () => {
    expect(decomposeKind('nand')).toEqual({ base: 'and', outputBubble: true });
    expect(decomposeKind('nor')).toEqual({ base: 'or', outputBubble: true });
    expect(decomposeKind('not')).toEqual({ base: 'buf', outputBubble: true });
    expect(decomposeKind('and')).toEqual({ base: 'and', outputBubble: false });
  });
});

describe('normalizeGateComponent / importCircuit', () => {
  it('decomposes a literal nand into and+outputBubble param', () => {
    const c = normalizeGateComponent(comp({ kind: 'nand' }));
    expect(c.kind).toBe('and');
    expect(getOutputBubble(c)).toBe(true);
  });
  it('is idempotent on an already-normalized component', () => {
    const once = normalizeGateComponent(comp({ kind: 'nand' }));
    const twice = normalizeGateComponent(once);
    expect(twice).toEqual(once);
  });
  it('leaves non-gate components untouched', () => {
    const c = comp({ kind: 'inport' });
    expect(importCircuit({ components: [c], wires: [], junctions: [] }).components[0]).toBe(c);
  });
});

describe('bubble param round-trip', () => {
  it('toggles output bubble', () => {
    const c = comp({});
    expect(getOutputBubble(c)).toBe(false);
    const on = toggleOutputBubble(c);
    expect(getOutputBubble(on)).toBe(true);
    expect(getOutputBubble(toggleOutputBubble(on))).toBe(false);
  });
  it('toggles input bubbles independently per pin', () => {
    let c = comp({});
    c = toggleInputBubble(c, 'a');
    expect(getInputBubbles(c)).toEqual(new Set(['a']));
    c = toggleInputBubble(c, 'b');
    expect(getInputBubbles(c)).toEqual(new Set(['a', 'b']));
    c = toggleInputBubble(c, 'a');
    expect(getInputBubbles(c)).toEqual(new Set(['b']));
  });
});

describe('gateInputPins', () => {
  it('and/or default to a,b; respects params.inputs', () => {
    expect(gateInputPins(comp({ kind: 'and' }))).toEqual(['a', 'b']);
    expect(gateInputPins(comp({ kind: 'nand', params: { inputs: 3 } }))).toEqual(['a', 'b', 'c']);
  });
  it('buf/not are always single-input', () => {
    expect(gateInputPins(comp({ kind: 'buf' }))).toEqual(['a']);
    expect(gateInputPins(comp({ kind: 'not' }))).toEqual(['a']);
  });
});
