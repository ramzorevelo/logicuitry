import { describe, expect, it } from 'vitest';
import {
  smartConnect,
  smartConnectChain,
  smartConnectChainWithin,
  smartConnectSingleSource,
  type ChainComp,
} from './smartConnect';
import type { PinTarget } from './pinTargets';

const src = (id: string, over: Partial<PinTarget> = {}): PinTarget => ({
  componentId: id,
  pinName: 'y',
  width: 1,
  role: 'data',
  order: 0,
  dir: 'out',
  worldPos: { x: 0, y: 0 },
  free: true,
  ...over,
});

const tgt = (name: string, order: number, over: Partial<PinTarget> = {}): PinTarget => ({
  componentId: 'mux',
  pinName: name,
  width: 1,
  role: 'data',
  order,
  dir: 'in',
  worldPos: { x: 0, y: 0 },
  free: true,
  ...over,
});

describe('smartConnect', () => {
  it('maps sources in spatial order onto target pins in declared order', () => {
    const sources = [src('s0'), src('s1'), src('s2')];
    const targets = [tgt('d0', 0), tgt('d1', 1), tgt('d2', 2)];
    const { pairs, unmatched } = smartConnect(sources, targets);
    expect(unmatched).toHaveLength(0);
    expect(pairs.map((p) => [p.source.componentId, p.target.pinName])).toEqual([
      ['s0', 'd0'],
      ['s1', 'd1'],
      ['s2', 'd2'],
    ]);
  });

  it('matches by role first: a clock source never lands on a data pin', () => {
    const sources = [src('clk', { role: 'clock' }), src('d')];
    const targets = [tgt('data', 0), tgt('clkPin', 1, { role: 'clock' })];
    const { pairs } = smartConnect(sources, targets);
    const clk = pairs.find((p) => p.source.componentId === 'clk');
    expect(clk?.target.pinName).toBe('clkPin');
  });

  it('reports a source with no eligible target as unmatched, not mis-wired', () => {
    const sources = [src('clk', { role: 'clock' })];
    const targets = [tgt('data', 0)];
    const { pairs, unmatched } = smartConnect(sources, targets);
    expect(pairs).toHaveLength(0);
    expect(unmatched.map((u) => u.componentId)).toEqual(['clk']);
  });

  it('wires switches onto a mux select pin once every data pin is taken', () => {
    const sources = [
      src('sw0', { worldPos: { x: 0, y: 0 } }),
      src('sw1', { worldPos: { x: 0, y: 40 } }),
    ];
    // d0..d3 already wired, so only the select pins are free.
    const targets = [
      tgt('s0', 4, { role: 'select', worldPos: { x: 100, y: 60 } }),
      tgt('s1', 5, { role: 'select', worldPos: { x: 120, y: 60 } }),
    ];
    const { pairs, unmatched } = smartConnect(sources, targets);
    expect(unmatched).toHaveLength(0);
    expect(pairs.map((p) => p.target.pinName).sort()).toEqual(['s0', 's1']);
  });

  it('reads a stacked source column top-down onto select pins left-to-right', () => {
    // Switches stacked vertically, x deliberately staggered so an x-order
    // reading of the sources would pair them the other way round.
    const sources = [
      src('sw0', { worldPos: { x: 20, y: 0 } }),
      src('sw1', { worldPos: { x: 0, y: 40 } }),
    ];
    // Select pins render MSB leftmost: s1 then s0.
    const targets = [
      tgt('s1', 5, { role: 'select', worldPos: { x: 100, y: 60 } }),
      tgt('s0', 4, { role: 'select', worldPos: { x: 120, y: 60 } }),
    ];
    const { pairs } = smartConnect(sources, targets);
    expect(pairs.map((p) => [p.source.componentId, p.target.pinName])).toEqual([
      ['sw0', 's1'],
      ['sw1', 's0'],
    ]);
  });

  it('fills a mux data pin before falling back to its select pins', () => {
    const sources = [src('sw0')];
    const targets = [
      tgt('d0', 0, { worldPos: { x: 100, y: 0 } }),
      tgt('s0', 4, { role: 'select', worldPos: { x: 100, y: 60 } }),
    ];
    const { pairs } = smartConnect(sources, targets);
    expect(pairs.map((p) => p.target.pinName)).toEqual(['d0']);
  });

  it('filters width mismatch within a role', () => {
    const sources = [src('s', { width: 4 })];
    const targets = [tgt('d', 0, { width: 1 })];
    expect(smartConnect(sources, targets).unmatched).toHaveLength(1);
  });

  it('rotation shifts the assignment inside a role queue by one, wrapping', () => {
    const sources = [src('s0'), src('s1')];
    const targets = [tgt('d0', 0), tgt('d1', 1)];
    const rotated = smartConnect(sources, targets, 1);
    expect(rotated.pairs.map((p) => p.target.pinName)).toEqual(['d1', 'd0']);
  });

  it("does not let a later component's low pin `order` jump ahead of an earlier one's (M4.2 regression)", () => {
    // `order` only disambiguates pins within one component -- a mux's a/b/sel
    // (order 0/1/2) and a lone LED input (order 0) collide on raw `order`.
    // The caller has already put targetPins in the right spatial sequence
    // (mux.a, mux.b, mux.sel, led.a); smartConnect must preserve that, not
    // re-sort globally by `order` and let led.a (order 0) jump ahead of
    // mux.b/mux.sel (order 1/2).
    const sources = [src('s0'), src('s1'), src('s2'), src('s3')];
    const targets = [
      tgt('a', 0, { componentId: 'mux' }),
      tgt('b', 1, { componentId: 'mux' }),
      tgt('sel', 2, { componentId: 'mux' }),
      tgt('a', 0, { componentId: 'led' }),
    ];
    const { pairs } = smartConnect(sources, targets);
    expect(pairs.map((p) => [p.target.componentId, p.target.pinName])).toEqual([
      ['mux', 'a'],
      ['mux', 'b'],
      ['mux', 'sel'],
      ['led', 'a'],
    ]);
  });

  it('never assigns an occupied target pin twice', () => {
    const sources = [src('s0'), src('s1')];
    const targets = [tgt('d0', 0), tgt('d1', 1, { free: false })];
    const { pairs, unmatched } = smartConnect(sources, targets);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.target.pinName).toBe('d0');
    expect(unmatched).toHaveLength(1);
  });
});

describe('smartConnectSingleSource (1-to-many pick-one-and-cycle)', () => {
  it('defaults to the first unclaimed candidate, in spatial order', () => {
    const s = src('lbl');
    const candidates = [
      tgt('a', 0, { worldPos: { x: 0, y: 0 } }),
      tgt('b', 1, { worldPos: { x: 0, y: 10 } }),
      tgt('c', 2, { worldPos: { x: 0, y: 20 } }),
    ];
    const pair = smartConnectSingleSource(s, candidates, 0, () => false);
    expect(pair?.target.pinName).toBe('a');
  });

  it('skips already-label-claimed candidates for the default pick', () => {
    const s = src('lbl');
    const candidates = [
      tgt('a', 0, { worldPos: { x: 0, y: 0 } }),
      tgt('b', 1, { worldPos: { x: 0, y: 10 } }),
      tgt('c', 2, { worldPos: { x: 0, y: 20 } }),
    ];
    const pair = smartConnectSingleSource(s, candidates, 0, (t) => t.pinName === 'a');
    expect(pair?.target.pinName).toBe('b');
  });

  it('scroll cycles through every candidate (not capped at 1, unlike the permutation path), wrapping', () => {
    const s = src('lbl');
    const candidates = [
      tgt('a', 0, { worldPos: { x: 0, y: 0 } }),
      tgt('b', 1, { worldPos: { x: 0, y: 10 } }),
      tgt('c', 2, { worldPos: { x: 0, y: 20 } }),
    ];
    expect(smartConnectSingleSource(s, candidates, 1, () => false)?.target.pinName).toBe('b');
    expect(smartConnectSingleSource(s, candidates, 2, () => false)?.target.pinName).toBe('c');
    expect(smartConnectSingleSource(s, candidates, 3, () => false)?.target.pinName).toBe('a');
  });

  it('excludes candidates that are neither free nor role/width-matching', () => {
    const s = src('lbl', { role: 'data', width: 1 });
    const candidates = [
      tgt('a', 0, { free: false }),
      tgt('b', 1, { role: 'clock' }),
      tgt('c', 2, { width: 2 }),
    ];
    expect(smartConnectSingleSource(s, candidates, 0, () => false)).toBeNull();
  });
});

describe('smartConnectChain (Item 4b: gate/chip-priority chain routing)', () => {
  const pin = (
    componentId: string,
    pinName: string,
    dir: 'in' | 'out',
    x: number,
    y: number,
    over: Partial<PinTarget> = {},
  ): PinTarget => ({
    componentId,
    pinName,
    width: 1,
    role: 'data',
    order: 0,
    dir,
    worldPos: { x, y },
    free: true,
    ...over,
  });

  it('rotated-OR reference scenario: two sources above pair without crossing (b left, a right)', () => {
    const leftSw: ChainComp = {
      id: 'sw1',
      pos: { x: 0, y: 0 },
      center: { x: 0, y: 25 },
      hasAnyInputPinSpec: false,
      freeIns: [],
      freeOuts: [pin('sw1', 'y', 'out', 0, 50)],
    };
    const rightSw: ChainComp = {
      id: 'sw2',
      pos: { x: 100, y: 0 },
      center: { x: 100, y: 25 },
      hasAnyInputPinSpec: false,
      freeIns: [],
      freeOuts: [pin('sw2', 'y', 'out', 100, 50)],
    };
    const gate: ChainComp = {
      id: 'or1',
      pos: { x: 50, y: 100 },
      center: { x: 50, y: 110 },
      hasAnyInputPinSpec: true,
      freeIns: [pin('or1', 'b', 'in', 40, 90), pin('or1', 'a', 'in', 60, 90)],
      freeOuts: [],
    };
    const { pairs } = smartConnectChain([leftSw, rightSw, gate]);
    expect(pairs).toHaveLength(2);
    const bPair = pairs.find((p) => p.target.pinName === 'b')!;
    const aPair = pairs.find((p) => p.target.pinName === 'a')!;
    expect(bPair.source.componentId).toBe('sw1'); // left source -> left (b) pin
    expect(aPair.source.componentId).toBe('sw2'); // right source -> right (a) pin
  });

  it('routes switch -> gate.in -> LED.in through a middle gate, no direct switch->LED', () => {
    const sw: ChainComp = {
      id: 'sw',
      pos: { x: 0, y: 0 },
      center: { x: 8, y: 0 },
      hasAnyInputPinSpec: false,
      freeIns: [],
      freeOuts: [pin('sw', 'y', 'out', 16, 0)],
    };
    const gate: ChainComp = {
      id: 'g1',
      pos: { x: 100, y: 0 },
      center: { x: 108, y: 0 },
      hasAnyInputPinSpec: true,
      freeIns: [pin('g1', 'a', 'in', 90, 0)],
      freeOuts: [pin('g1', 'y', 'out', 116, 0)],
    };
    const led: ChainComp = {
      id: 'led',
      pos: { x: 200, y: 0 },
      center: { x: 208, y: 0 },
      hasAnyInputPinSpec: true,
      freeIns: [pin('led', 'a', 'in', 190, 0)],
      freeOuts: [],
    };
    const { pairs } = smartConnectChain([sw, gate, led]);
    expect(pairs).toHaveLength(2);
    expect(pairs.some((p) => p.source.componentId === 'sw' && p.target.componentId === 'g1')).toBe(
      true,
    );
    expect(pairs.some((p) => p.source.componentId === 'g1' && p.target.componentId === 'led')).toBe(
      true,
    );
    expect(pairs.some((p) => p.source.componentId === 'sw' && p.target.componentId === 'led')).toBe(
      false,
    );
  });

  it('falls back to a direct switch->LED connection when the gate has no free inputs (saturated)', () => {
    const sw: ChainComp = {
      id: 'sw',
      pos: { x: 0, y: 0 },
      center: { x: 8, y: 0 },
      hasAnyInputPinSpec: false,
      freeIns: [],
      freeOuts: [pin('sw', 'y', 'out', 16, 0)],
    };
    const gate: ChainComp = {
      id: 'g1',
      pos: { x: 100, y: 0 },
      center: { x: 108, y: 0 },
      hasAnyInputPinSpec: true, // declares an input pin, but it's already wired
      freeIns: [],
      freeOuts: [pin('g1', 'y', 'out', 116, 0)],
    };
    const led: ChainComp = {
      id: 'led',
      pos: { x: 200, y: 0 },
      center: { x: 208, y: 0 },
      hasAnyInputPinSpec: true,
      freeIns: [pin('led', 'a', 'in', 190, 0)],
      freeOuts: [],
    };
    const { pairs } = smartConnectChain([sw, gate, led]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.source.componentId).toBe('sw');
    expect(pairs[0]!.target.componentId).toBe('led');
  });

  it('resolves a switch -> gate1 -> gate2 -> LED chain in stages', () => {
    const sw: ChainComp = {
      id: 'sw',
      pos: { x: 0, y: 0 },
      center: { x: 8, y: 0 },
      hasAnyInputPinSpec: false,
      freeIns: [],
      freeOuts: [pin('sw', 'y', 'out', 16, 0)],
    };
    const g1: ChainComp = {
      id: 'g1',
      pos: { x: 100, y: 0 },
      center: { x: 108, y: 0 },
      hasAnyInputPinSpec: true,
      freeIns: [pin('g1', 'a', 'in', 90, 0)],
      freeOuts: [pin('g1', 'y', 'out', 116, 0)],
    };
    const g2: ChainComp = {
      id: 'g2',
      pos: { x: 200, y: 0 },
      center: { x: 208, y: 0 },
      hasAnyInputPinSpec: true,
      freeIns: [pin('g2', 'a', 'in', 190, 0)],
      freeOuts: [pin('g2', 'y', 'out', 216, 0)],
    };
    const led: ChainComp = {
      id: 'led',
      pos: { x: 300, y: 0 },
      center: { x: 308, y: 0 },
      hasAnyInputPinSpec: true,
      freeIns: [pin('led', 'a', 'in', 290, 0)],
      freeOuts: [],
    };
    const { pairs } = smartConnectChain([sw, g1, g2, led]);
    expect(pairs).toHaveLength(3);
    const of = (fromId: string) =>
      pairs.find((p) => p.source.componentId === fromId)!.target.componentId;
    expect(of('sw')).toBe('g1');
    expect(of('g1')).toBe('g2');
    expect(of('g2')).toBe('led');
  });

  it('resolves the same switch -> gate -> LED case laid out vertically', () => {
    const sw: ChainComp = {
      id: 'sw',
      pos: { x: 0, y: 0 },
      center: { x: 0, y: 8 },
      hasAnyInputPinSpec: false,
      freeIns: [],
      freeOuts: [pin('sw', 'y', 'out', 0, 16)],
    };
    const gate: ChainComp = {
      id: 'g1',
      pos: { x: 0, y: 100 },
      center: { x: 0, y: 108 },
      hasAnyInputPinSpec: true,
      freeIns: [pin('g1', 'a', 'in', 0, 90)],
      freeOuts: [pin('g1', 'y', 'out', 0, 116)],
    };
    const led: ChainComp = {
      id: 'led',
      pos: { x: 0, y: 200 },
      center: { x: 0, y: 208 },
      hasAnyInputPinSpec: true,
      freeIns: [pin('led', 'a', 'in', 0, 190)],
      freeOuts: [],
    };
    const { pairs } = smartConnectChain([sw, gate, led]);
    expect(pairs).toHaveLength(2);
    expect(pairs.some((p) => p.source.componentId === 'sw' && p.target.componentId === 'g1')).toBe(
      true,
    );
    expect(pairs.some((p) => p.source.componentId === 'g1' && p.target.componentId === 'led')).toBe(
      true,
    );
  });

  it('chains switches onto a mux select group when no data pin is free', () => {
    const sw0: ChainComp = {
      id: 'sw0',
      pos: { x: 0, y: 0 },
      center: { x: 8, y: 8 },
      hasAnyInputPinSpec: false,
      freeIns: [],
      freeOuts: [pin('sw0', 'y', 'out', 16, 8)],
    };
    const sw1: ChainComp = {
      id: 'sw1',
      pos: { x: 0, y: 60 },
      center: { x: 8, y: 68 },
      hasAnyInputPinSpec: false,
      freeIns: [],
      freeOuts: [pin('sw1', 'y', 'out', 16, 68)],
    };
    const mux: ChainComp = {
      id: 'mux',
      pos: { x: 100, y: 0 },
      center: { x: 120, y: 30 },
      hasAnyInputPinSpec: true,
      freeIns: [
        pin('mux', 's0', 'in', 110, 60, { role: 'select' }),
        pin('mux', 's1', 'in', 130, 60, { role: 'select' }),
      ],
      freeOuts: [pin('mux', 'y', 'out', 140, 30)],
    };
    const { pairs } = smartConnectChain([sw0, sw1, mux]);
    expect(pairs.map((p) => p.target.pinName).sort()).toEqual(['s0', 's1']);
  });

  it('never pairs a clock output onto a data input (role mismatch)', () => {
    const clk: ChainComp = {
      id: 'clk',
      pos: { x: 0, y: 0 },
      center: { x: 8, y: 0 },
      hasAnyInputPinSpec: false,
      freeIns: [],
      freeOuts: [pin('clk', 'y', 'out', 16, 0, { role: 'clock' })],
    };
    const dff: ChainComp = {
      id: 'dff',
      pos: { x: 100, y: 0 },
      center: { x: 108, y: 10 },
      hasAnyInputPinSpec: true,
      freeIns: [pin('dff', 'clk', 'in', 90, 0, { role: 'clock' }), pin('dff', 'd', 'in', 90, 20)],
      freeOuts: [],
    };
    const { pairs } = smartConnectChain([clk, dff]);
    const dPair = pairs.find((p) => p.target.pinName === 'd');
    expect(dPair).toBeUndefined(); // no data-role source available
    const clkPair = pairs.find((p) => p.target.pinName === 'clk');
    expect(clkPair?.source.componentId).toBe('clk');
  });

  it('returns no pairs when the selection has neither a pure source nor a pure sink', () => {
    const middleOnly: ChainComp = {
      id: 'm',
      pos: { x: 0, y: 0 },
      center: { x: 8, y: 0 },
      hasAnyInputPinSpec: true,
      freeIns: [pin('m', 'a', 'in', 0, 0)],
      freeOuts: [pin('m', 'y', 'out', 16, 0)],
    };
    expect(smartConnectChain([middleOnly]).pairs).toHaveLength(0);
  });

  it('a middle consumer prefers adjacent switches over a distant already-used gate output (no tier)', () => {
    // Two muxes (modeled as pureSources -- all their own inputs are already
    // wired) each feed their own LED; an OR gate with two nearby switches
    // sits off to the side with its own LED. The OR's free inputs must come
    // from the near switches, not the far mux outputs -- M4.5 drops the old
    // middle-consumer tier so proximity alone decides.
    // All on one flow line (y=0) so the global flow axis stays 'x' -- the OR
    // cluster sits far downstream in x of both mux/LED pairs, so mux1/mux2
    // remain the only upstream candidates for led1/led2, while the switches
    // (much closer to or1 than either mux output) are the only sane pick for
    // or1's own inputs.
    const mux1: ChainComp = {
      id: 'mux1',
      pos: { x: 0, y: 0 },
      center: { x: 8, y: 0 },
      hasAnyInputPinSpec: true,
      freeIns: [],
      freeOuts: [pin('mux1', 'y', 'out', 16, 0)],
    };
    const led1: ChainComp = {
      id: 'led1',
      pos: { x: 100, y: 0 },
      center: { x: 108, y: 0 },
      hasAnyInputPinSpec: true,
      freeIns: [pin('led1', 'a', 'in', 90, 0)],
      freeOuts: [],
    };
    const mux2: ChainComp = {
      id: 'mux2',
      pos: { x: 200, y: 0 },
      center: { x: 208, y: 0 },
      hasAnyInputPinSpec: true,
      freeIns: [],
      freeOuts: [pin('mux2', 'y', 'out', 216, 0)],
    };
    const led2: ChainComp = {
      id: 'led2',
      pos: { x: 300, y: 0 },
      center: { x: 308, y: 0 },
      hasAnyInputPinSpec: true,
      freeIns: [pin('led2', 'a', 'in', 290, 0)],
      freeOuts: [],
    };
    const sw3: ChainComp = {
      id: 'sw3',
      pos: { x: 520, y: 0 },
      center: { x: 528, y: 0 },
      hasAnyInputPinSpec: false,
      freeIns: [],
      freeOuts: [pin('sw3', 'y', 'out', 536, 0)],
    };
    const sw4: ChainComp = {
      id: 'sw4',
      pos: { x: 540, y: 0 },
      center: { x: 548, y: 0 },
      hasAnyInputPinSpec: false,
      freeIns: [],
      freeOuts: [pin('sw4', 'y', 'out', 556, 0)],
    };
    const or1: ChainComp = {
      id: 'or1',
      pos: { x: 560, y: 0 },
      center: { x: 578, y: 0 },
      hasAnyInputPinSpec: true,
      freeIns: [pin('or1', 'a', 'in', 550, 0), pin('or1', 'b', 'in', 570, 0)],
      freeOuts: [pin('or1', 'y', 'out', 586, 0)],
    };
    const ledOr: ChainComp = {
      id: 'ledOr',
      pos: { x: 600, y: 0 },
      center: { x: 608, y: 0 },
      hasAnyInputPinSpec: true,
      freeIns: [pin('ledOr', 'a', 'in', 590, 0)],
      freeOuts: [],
    };
    const { pairs } = smartConnectChain([mux1, led1, mux2, led2, sw3, sw4, or1, ledOr]);
    const orInputs = pairs.filter((p) => p.target.componentId === 'or1');
    expect(orInputs).toHaveLength(2);
    expect(
      orInputs.every((p) => p.source.componentId === 'sw3' || p.source.componentId === 'sw4'),
    ).toBe(true);
    const led1Pair = pairs.find((p) => p.target.componentId === 'led1')!;
    const led2Pair = pairs.find((p) => p.target.componentId === 'led2')!;
    const ledOrPair = pairs.find((p) => p.target.componentId === 'ledOr')!;
    expect(led1Pair.source.componentId).toBe('mux1');
    expect(led2Pair.source.componentId).toBe('mux2');
    expect(ledOrPair.source.componentId).toBe('or1');
  });

  it('mux a/b/sel top-down: 3 stacked switches map index-to-index by visual order (4a ordered mapping)', () => {
    const s0 = pin('sw0', 'y', 'out', 0, 0);
    const s1 = pin('sw1', 'y', 'out', 0, 50);
    const s2 = pin('sw2', 'y', 'out', 0, 100);
    const a = pin('mux', 'a', 'in', 100, 0, { order: 0 });
    const b = pin('mux', 'b', 'in', 100, 50, { order: 1 });
    const sel = pin('mux', 'sel', 'in', 100, 100, { order: 2 });
    const { pairs } = smartConnect([s0, s1, s2], [a, b, sel]);
    expect(pairs.map((p) => [p.source.componentId, p.target.pinName])).toEqual([
      ['sw0', 'a'],
      ['sw1', 'b'],
      ['sw2', 'sel'],
    ]);
  });

  it('scroll never orphans: mux+3 switches+LED keeps every switch used once and mux.y->LED intact across rotations', () => {
    const mux: ChainComp = {
      id: 'mux',
      pos: { x: 100, y: 50 },
      center: { x: 125, y: 50 },
      hasAnyInputPinSpec: true,
      freeIns: [
        pin('mux', 'a', 'in', 100, 0),
        pin('mux', 'b', 'in', 100, 50),
        pin('mux', 'sel', 'in', 100, 100),
      ],
      freeOuts: [pin('mux', 'y', 'out', 150, 50)],
    };
    const sw0: ChainComp = {
      id: 'sw0',
      pos: { x: 0, y: 0 },
      center: { x: 8, y: 0 },
      hasAnyInputPinSpec: false,
      freeIns: [],
      freeOuts: [pin('sw0', 'y', 'out', 16, 0)],
    };
    const sw1: ChainComp = {
      id: 'sw1',
      pos: { x: 0, y: 50 },
      center: { x: 8, y: 50 },
      hasAnyInputPinSpec: false,
      freeIns: [],
      freeOuts: [pin('sw1', 'y', 'out', 16, 50)],
    };
    const sw2: ChainComp = {
      id: 'sw2',
      pos: { x: 0, y: 100 },
      center: { x: 8, y: 100 },
      hasAnyInputPinSpec: false,
      freeIns: [],
      freeOuts: [pin('sw2', 'y', 'out', 16, 100)],
    };
    const led: ChainComp = {
      id: 'led',
      pos: { x: 250, y: 50 },
      center: { x: 258, y: 50 },
      hasAnyInputPinSpec: true,
      freeIns: [pin('led', 'a', 'in', 240, 50)],
      freeOuts: [],
    };
    const comps = [mux, sw0, sw1, sw2, led];
    for (let rot = 0; rot < 14; rot++) {
      const { pairs } = smartConnectChain(comps, rot);
      expect(pairs).toHaveLength(4);
      const ledPair = pairs.find((p) => p.target.componentId === 'led')!;
      expect(ledPair.source.componentId).toBe('mux');
      const srcKeys = pairs.map((p) => `${p.source.componentId}.${p.source.pinName}`);
      expect(new Set(srcKeys).size).toBe(srcKeys.length); // no source used twice
      const switchSrcs = pairs
        .filter((p) => p.target.componentId === 'mux')
        .map((p) => p.source.componentId)
        .sort();
      expect(switchSrcs).toEqual(['sw0', 'sw1', 'sw2']);
    }
  });

  it('chips-plus-LEDs, no sources: every output goes to an LED, never into another chip input', () => {
    // Owner-reported live regression: 2 mux2 + 1 dff + 4 LEDs, chips with
    // open inputs -- chip outputs used to feed other chips' inputs and steal
    // outputs the LEDs needed. Sinks-first + the leftover/alignment gate must
    // leave all chip inputs open here (every output is sink-consumed).
    const mux1: ChainComp = {
      id: 'mux1',
      pos: { x: 0, y: 0 },
      center: { x: 25, y: 20 },
      hasAnyInputPinSpec: true,
      freeIns: [pin('mux1', 'a', 'in', -10, 10), pin('mux1', 'b', 'in', -10, 30)],
      freeOuts: [pin('mux1', 'y', 'out', 50, 20)],
    };
    const mux2: ChainComp = {
      id: 'mux2',
      pos: { x: 60, y: 100 },
      center: { x: 85, y: 120 },
      hasAnyInputPinSpec: true,
      freeIns: [pin('mux2', 'a', 'in', 50, 110), pin('mux2', 'b', 'in', 50, 130)],
      freeOuts: [pin('mux2', 'y', 'out', 110, 120)],
    };
    const dff: ChainComp = {
      id: 'dff',
      pos: { x: 120, y: 200 },
      center: { x: 145, y: 220 },
      hasAnyInputPinSpec: true,
      freeIns: [pin('dff', 'd', 'in', 110, 210)],
      freeOuts: [pin('dff', 'q', 'out', 170, 210), pin('dff', 'qn', 'out', 170, 230)],
    };
    const led = (id: string, y: number): ChainComp => ({
      id,
      pos: { x: 300, y },
      center: { x: 305, y },
      hasAnyInputPinSpec: true,
      freeIns: [pin(id, 'a', 'in', 290, y)],
      freeOuts: [],
    });
    const leds = [led('led1', 20), led('led2', 120), led('led3', 210), led('led4', 230)];
    const { pairs } = smartConnectChain([mux1, mux2, dff, ...leds]);
    expect(pairs).toHaveLength(4);
    const chipIds = new Set(['mux1', 'mux2', 'dff']);
    expect(pairs.some((p) => chipIds.has(p.target.componentId))).toBe(false);
    const targetIds = pairs.map((p) => p.target.componentId).sort();
    expect(targetIds).toEqual(['led1', 'led2', 'led3', 'led4']);
    const srcKeys = pairs.map((p) => `${p.source.componentId}.${p.source.pinName}`).sort();
    expect(srcKeys).toEqual(['dff.q', 'dff.qn', 'mux1.y', 'mux2.y']);
  });

  it('aligned chip pair with a leftover output chains chip1 -> chip2 -> LED', () => {
    // chip1 left of chip2 (both unrotated, inputs on the left), one LED right
    // of chip2: the LED consumes chip2.y; chip1.y is a genuine leftover and
    // chip1 sits on chip2's input side, so the chip-to-chip link is allowed.
    const chip1: ChainComp = {
      id: 'chip1',
      pos: { x: 0, y: 0 },
      center: { x: 20, y: 10 },
      hasAnyInputPinSpec: true,
      freeIns: [pin('chip1', 'a', 'in', -10, 10)],
      freeOuts: [pin('chip1', 'y', 'out', 50, 10)],
    };
    const chip2: ChainComp = {
      id: 'chip2',
      pos: { x: 100, y: 0 },
      center: { x: 120, y: 10 },
      hasAnyInputPinSpec: true,
      freeIns: [pin('chip2', 'a', 'in', 90, 10)],
      freeOuts: [pin('chip2', 'y', 'out', 150, 10)],
    };
    const led: ChainComp = {
      id: 'led',
      pos: { x: 200, y: 0 },
      center: { x: 215, y: 10 },
      hasAnyInputPinSpec: true,
      freeIns: [pin('led', 'a', 'in', 190, 10)],
      freeOuts: [],
    };
    const { pairs } = smartConnectChain([chip1, chip2, led]);
    expect(pairs).toHaveLength(2);
    expect(
      pairs.some((p) => p.source.componentId === 'chip2' && p.target.componentId === 'led'),
    ).toBe(true);
    expect(
      pairs.some((p) => p.source.componentId === 'chip1' && p.target.componentId === 'chip2'),
    ).toBe(true);
  });

  it('misaligned chip pair: leftover output stays unconnected, chip inputs stay open', () => {
    // chip1 sits to the RIGHT of chip2 while chip2's inputs face left --
    // vertical flow (LED far below) keeps chip1 flowCoord-upstream of chip2,
    // so only the alignment gate can (and must) reject chip1.y -> chip2.a.
    // Owner default: never force a misaligned chip-to-chip connection.
    const chip2: ChainComp = {
      id: 'chip2',
      pos: { x: 0, y: 100 },
      center: { x: 20, y: 110 },
      hasAnyInputPinSpec: true,
      freeIns: [pin('chip2', 'a', 'in', -10, 110)],
      freeOuts: [pin('chip2', 'y', 'out', 50, 110)],
    };
    const chip1: ChainComp = {
      id: 'chip1',
      pos: { x: 200, y: 0 },
      center: { x: 220, y: 10 },
      hasAnyInputPinSpec: true,
      freeIns: [pin('chip1', 'a', 'in', 190, 10)],
      freeOuts: [pin('chip1', 'y', 'out', 250, 10)],
    };
    const led: ChainComp = {
      id: 'led',
      pos: { x: 0, y: 300 },
      center: { x: 15, y: 310 },
      hasAnyInputPinSpec: true,
      freeIns: [pin('led', 'a', 'in', -10, 310)],
      freeOuts: [],
    };
    const { pairs } = smartConnectChain([chip1, chip2, led]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.source.componentId).toBe('chip2'); // LED takes the nearest output
    expect(pairs[0]!.target.componentId).toBe('led');
  });

  it('rotated chips: output facing down feeds inputs facing up when stacked vertically', () => {
    const chip1: ChainComp = {
      id: 'chip1',
      pos: { x: 0, y: 0 },
      center: { x: 10, y: 20 },
      hasAnyInputPinSpec: true,
      freeIns: [pin('chip1', 'a', 'in', 10, -10)],
      freeOuts: [pin('chip1', 'y', 'out', 10, 50)], // faces down (+y off center)
    };
    const chip2: ChainComp = {
      id: 'chip2',
      pos: { x: 0, y: 100 },
      center: { x: 10, y: 120 },
      hasAnyInputPinSpec: true,
      freeIns: [pin('chip2', 'a', 'in', 10, 90)], // faces up (-y off center)
      freeOuts: [pin('chip2', 'y', 'out', 10, 150)],
    };
    const led: ChainComp = {
      id: 'led',
      pos: { x: 0, y: 300 },
      center: { x: 10, y: 310 },
      hasAnyInputPinSpec: true,
      freeIns: [pin('led', 'a', 'in', 10, 290)],
      freeOuts: [],
    };
    const { pairs } = smartConnectChain([chip1, chip2, led]);
    expect(pairs).toHaveLength(2);
    expect(
      pairs.some((p) => p.source.componentId === 'chip1' && p.target.componentId === 'chip2'),
    ).toBe(true);
    expect(
      pairs.some((p) => p.source.componentId === 'chip2' && p.target.componentId === 'led'),
    ).toBe(true);
  });

  it('rule-5 exception: a source co-aligned (flow-axis) with a misaligned feeder lets the feeder output chain into an open input', () => {
    // Horizontal flow. sw and chip1 sit at the same x-depth, stacked
    // vertically (sw above, chip1 below) so their x-extents overlap -- sw
    // vouches for chip1. chip1's free input uses role 'clock' so it can
    // never itself draw sw's output (keeps the repro unambiguous). chip2's
    // inputs face +x (toward chip1/sw, the "wrong" way -- a normal left-
    // facing input would be aligned already), so only the exception can let
    // chip1.y reach chip2; a control run without sw (see next test) confirms
    // that.
    const sw: ChainComp = {
      id: 'sw',
      pos: { x: 0, y: 0 },
      center: { x: 8, y: 0 },
      hasAnyInputPinSpec: false,
      freeIns: [],
      freeOuts: [pin('sw', 'y', 'out', 16, 0)],
    };
    const chip1: ChainComp = {
      id: 'chip1',
      pos: { x: 0, y: 200 },
      center: { x: 20, y: 210 },
      hasAnyInputPinSpec: true,
      freeIns: [pin('chip1', 'a', 'in', -10, 210, { role: 'clock' })],
      freeOuts: [pin('chip1', 'y', 'out', 50, 210)],
    };
    const chip2: ChainComp = {
      id: 'chip2',
      pos: { x: 150, y: 100 },
      center: { x: 170, y: 110 },
      hasAnyInputPinSpec: true,
      freeIns: [pin('chip2', 'a', 'in', 200, 105), pin('chip2', 'b', 'in', 200, 115)],
      freeOuts: [pin('chip2', 'y', 'out', 220, 110)],
    };
    const led: ChainComp = {
      id: 'led',
      pos: { x: 300, y: 100 },
      center: { x: 315, y: 110 },
      hasAnyInputPinSpec: true,
      freeIns: [pin('led', 'a', 'in', 290, 110)],
      freeOuts: [],
    };
    const { pairs } = smartConnectChain([sw, chip1, chip2, led]);
    expect(pairs).toHaveLength(3);
    expect(
      pairs.some((p) => p.source.componentId === 'sw' && p.target.componentId === 'chip2'),
    ).toBe(true);
    expect(
      pairs.some((p) => p.source.componentId === 'chip1' && p.target.componentId === 'chip2'),
    ).toBe(true);
    expect(
      pairs.some((p) => p.source.componentId === 'chip2' && p.target.componentId === 'led'),
    ).toBe(true);
  });

  it('rule-5 exception single open input: closer of source vs feeder-output wins the lone input', () => {
    // Same sw/chip1/chip2 shape as above but chip2 has ONE open input,
    // placed near sw's y-level (y=10) so sw.y (dist ~184) is closer than
    // chip1.y (dist ~250) -- sw must win the lone slot; chip1 stays
    // unpaired even though it's vouched-for (a candidate, just not the
    // closest one).
    const sw: ChainComp = {
      id: 'sw',
      pos: { x: 0, y: 0 },
      center: { x: 8, y: 0 },
      hasAnyInputPinSpec: false,
      freeIns: [],
      freeOuts: [pin('sw', 'y', 'out', 16, 0)],
    };
    const chip1: ChainComp = {
      id: 'chip1',
      pos: { x: 0, y: 200 },
      center: { x: 20, y: 210 },
      hasAnyInputPinSpec: true,
      freeIns: [pin('chip1', 'a', 'in', -10, 210, { role: 'clock' })],
      freeOuts: [pin('chip1', 'y', 'out', 50, 210)],
    };
    const chip2: ChainComp = {
      id: 'chip2',
      pos: { x: 150, y: 0 },
      center: { x: 170, y: 10 },
      hasAnyInputPinSpec: true,
      freeIns: [pin('chip2', 'a', 'in', 200, 10)],
      freeOuts: [pin('chip2', 'y', 'out', 220, 10)],
    };
    const led: ChainComp = {
      id: 'led',
      pos: { x: 300, y: 10 },
      center: { x: 315, y: 10 },
      hasAnyInputPinSpec: true,
      freeIns: [pin('led', 'a', 'in', 290, 10)],
      freeOuts: [],
    };
    const { pairs } = smartConnectChain([sw, chip1, chip2, led]);
    expect(pairs).toHaveLength(2);
    expect(
      pairs.some((p) => p.source.componentId === 'sw' && p.target.componentId === 'chip2'),
    ).toBe(true);
    expect(pairs.some((p) => p.source.componentId === 'chip1')).toBe(false);
  });

  it('rule-5 exception does NOT fire when the source is inline-upstream, not co-aligned', () => {
    // sw sits far to the left of chip1 (x-extent [-300,-284] vs chip1's
    // [0,40]) -- strictly upstream in flow but with no flow-axis overlap, so
    // it can't vouch. chip1's output stays misaligned with chip2's (+x-
    // facing) inputs and, with no vouching source, must stay unconnected.
    const sw: ChainComp = {
      id: 'sw',
      pos: { x: -300, y: 0 },
      center: { x: -292, y: 0 },
      hasAnyInputPinSpec: false,
      freeIns: [],
      freeOuts: [pin('sw', 'y', 'out', -284, 0)],
    };
    const chip1: ChainComp = {
      id: 'chip1',
      pos: { x: 0, y: 200 },
      center: { x: 20, y: 210 },
      hasAnyInputPinSpec: true,
      freeIns: [pin('chip1', 'a', 'in', -10, 210, { role: 'clock' })],
      freeOuts: [pin('chip1', 'y', 'out', 50, 210)],
    };
    const chip2: ChainComp = {
      id: 'chip2',
      pos: { x: 150, y: 100 },
      center: { x: 170, y: 110 },
      hasAnyInputPinSpec: true,
      freeIns: [pin('chip2', 'a', 'in', 200, 105)],
      freeOuts: [pin('chip2', 'y', 'out', 220, 110)],
    };
    const led: ChainComp = {
      id: 'led',
      pos: { x: 300, y: 100 },
      center: { x: 315, y: 110 },
      hasAnyInputPinSpec: true,
      freeIns: [pin('led', 'a', 'in', 290, 110)],
      freeOuts: [],
    };
    const { pairs } = smartConnectChain([sw, chip1, chip2, led]);
    expect(pairs.some((p) => p.source.componentId === 'chip1')).toBe(false);
  });
});

describe('smartConnectChain: In-label onto an already-wired input', () => {
  const pin = (
    componentId: string,
    pinName: string,
    dir: 'in' | 'out',
    x: number,
    y: number,
    over: Partial<PinTarget> = {},
  ): PinTarget => ({
    componentId,
    pinName,
    width: 1,
    role: 'data',
    order: 0,
    dir,
    worldPos: { x, y },
    free: true,
    ...over,
  });

  it('an unused In-label source pairs with a consumer input already driven by something else', () => {
    // in1's own free output has nothing else to pair with (no free consumer
    // input anywhere) -- it should still additionally name sw's already-wired
    // target input, matching the hover path's existing relaxation.
    const in1: ChainComp = {
      id: 'in1',
      pos: { x: 0, y: 0 },
      center: { x: 10, y: 10 },
      hasAnyInputPinSpec: false,
      freeIns: [],
      freeOuts: [pin('in1', 'y', 'out', 20, 10)],
      isInPort: true,
    };
    const gate: ChainComp = {
      id: 'gate',
      pos: { x: 200, y: 0 },
      center: { x: 210, y: 10 },
      hasAnyInputPinSpec: true,
      freeIns: [],
      freeOuts: [],
      wiredIns: [pin('gate', 'a', 'in', 200, 10, { free: false })],
    };
    const { pairs } = smartConnectChain([in1, gate]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.source.componentId).toBe('in1');
    expect(pairs[0]!.target.componentId).toBe('gate');
    expect(pairs[0]!.target.pinName).toBe('a');
  });

  it('two labels never land on the same already-wired pin, and read in visual order', () => {
    // Both labels sit below the gate, so each independently picked the pin
    // nearest to it -- the same one -- and the second pair was a duplicate.
    const label = (id: string, y: number): ChainComp => ({
      id,
      pos: { x: 0, y },
      center: { x: 10, y: y + 10 },
      hasAnyInputPinSpec: false,
      freeIns: [],
      freeOuts: [pin(id, 'y', 'out', 20, y + 10)],
      isInPort: true,
    });
    const gate: ChainComp = {
      id: 'gate',
      pos: { x: 200, y: 0 },
      center: { x: 210, y: 20 },
      hasAnyInputPinSpec: true,
      freeIns: [],
      freeOuts: [],
      wiredIns: [
        pin('gate', 'a', 'in', 200, 10, { free: false }),
        pin('gate', 'b', 'in', 200, 30, { free: false }),
      ],
    };
    const { pairs } = smartConnectChain([label('in1', 100), label('in2', 140), gate]);
    expect(pairs).toHaveLength(2);
    expect(new Set(pairs.map((p) => p.target.pinName)).size).toBe(2);
    expect(pairs.map((p) => `${p.source.componentId}->${p.target.pinName}`)).toEqual([
      'in1->a',
      'in2->b',
    ]);
  });

  it('a non-In-label source never pairs onto an already-wired input', () => {
    const sw: ChainComp = {
      id: 'sw',
      pos: { x: 0, y: 0 },
      center: { x: 10, y: 10 },
      hasAnyInputPinSpec: false,
      freeIns: [],
      freeOuts: [pin('sw', 'y', 'out', 20, 10)],
      // isInPort omitted -- a plain switch, not a label.
    };
    const gate: ChainComp = {
      id: 'gate',
      pos: { x: 200, y: 0 },
      center: { x: 210, y: 10 },
      hasAnyInputPinSpec: true,
      freeIns: [],
      freeOuts: [],
      wiredIns: [pin('gate', 'a', 'in', 200, 10, { free: false })],
    };
    const { pairs } = smartConnectChain([sw, gate]);
    expect(pairs).toHaveLength(0);
  });

  it('an In-label source that already found a free target does not also claim a wired one', () => {
    const in1: ChainComp = {
      id: 'in1',
      pos: { x: 0, y: 0 },
      center: { x: 10, y: 10 },
      hasAnyInputPinSpec: false,
      freeIns: [],
      freeOuts: [pin('in1', 'y', 'out', 20, 10)],
      isInPort: true,
    };
    const gate: ChainComp = {
      id: 'gate',
      pos: { x: 200, y: 0 },
      center: { x: 210, y: 10 },
      hasAnyInputPinSpec: true,
      freeIns: [pin('gate', 'a', 'in', 200, 10)],
      freeOuts: [],
    };
    const { pairs } = smartConnectChain([in1, gate]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.target.free).toBe(true);
  });
});

describe('smartConnect scroll permutation-cycling (hover path, M4.5)', () => {
  const pin = (
    componentId: string,
    pinName: string,
    x: number,
    y: number,
    over: Partial<PinTarget> = {},
  ): PinTarget => ({
    componentId,
    pinName,
    width: 1,
    role: 'data',
    order: 0,
    dir: 'in',
    worldPos: { x, y },
    free: true,
    ...over,
  });

  it('cycles through 6 distinct valid permutations for 3 sources/3 pins, then wraps', () => {
    const sources = [
      pin('s0', 'y', 0, 0, { dir: 'out' }),
      pin('s1', 'y', 50, 0, { dir: 'out' }),
      pin('s2', 'y', 100, 0, { dir: 'out' }),
    ];
    const targets = [
      pin('d', 'a', 0, 100, { order: 0 }),
      pin('d', 'b', 50, 100, { order: 1 }),
      pin('d', 'c', 100, 100, { order: 2 }),
    ];
    const seen = new Set<string>();
    let first: string | undefined;
    for (let rot = 0; rot < 6; rot++) {
      const { pairs } = smartConnect(sources, targets, rot);
      expect(pairs).toHaveLength(3);
      const key = JSON.stringify(pairs.map((p) => [p.source.componentId, p.target.pinName]));
      if (rot === 0) first = key;
      seen.add(key);
    }
    expect(seen.size).toBe(6);
    const wrapped = smartConnect(sources, targets, 6);
    const wrappedKey = JSON.stringify(
      wrapped.pairs.map((p) => [p.source.componentId, p.target.pinName]),
    );
    expect(wrappedKey).toBe(first);
  });
});

describe('smartConnectChainWithin (no-hover F: selection first, board as fallback)', () => {
  const pin = (
    componentId: string,
    pinName: string,
    dir: 'in' | 'out',
    x: number,
    y: number,
    over: Partial<PinTarget> = {},
  ): PinTarget => ({
    componentId,
    pinName,
    width: 1,
    role: 'data',
    order: 0,
    dir,
    worldPos: { x, y },
    free: true,
    ...over,
  });

  const sw = (id: string, y: number): ChainComp => ({
    id,
    pos: { x: 0, y },
    center: { x: 10, y: y + 10 },
    hasAnyInputPinSpec: false,
    freeIns: [],
    freeOuts: [pin(id, 'y', 'out', 20, y + 10)],
  });
  const gate: ChainComp = {
    id: 'gate',
    pos: { x: 200, y: 0 },
    center: { x: 220, y: 30 },
    hasAnyInputPinSpec: true,
    freeIns: [pin('gate', 'a', 'in', 200, 10), pin('gate', 'b', 'in', 200, 50)],
    freeOuts: [pin('gate', 'y', 'out', 240, 30)],
  };
  const led: ChainComp = {
    id: 'led',
    pos: { x: 400, y: 20 },
    center: { x: 410, y: 30 },
    hasAnyInputPinSpec: true,
    freeIns: [pin('led', 'a', 'in', 400, 30)],
    freeOuts: [],
  };

  it('reaches an unselected consumer when the selection alone has none', () => {
    // Two switches selected, the gate they should drive left unselected: the
    // selection is all sources, so resolving within it can only ever be empty.
    const { pairs } = smartConnectChainWithin(
      [sw('sw1', 0), sw('sw2', 40), gate, led],
      new Set(['sw1', 'sw2']),
    );
    expect(pairs.map((p) => `${p.source.componentId}->${p.target.pinName}`)).toEqual([
      'sw1->a',
      'sw2->b',
    ]);
  });

  it('drops a widened pair that touches nothing selected', () => {
    // gate->led resolves on the wide pass but belongs to neither selected part.
    const { pairs } = smartConnectChainWithin(
      [sw('sw1', 0), sw('sw2', 40), gate, led],
      new Set(['sw1', 'sw2']),
    );
    expect(pairs.some((p) => p.target.componentId === 'led')).toBe(false);
  });

  it('leaves a selection that already resolves exactly as it was', () => {
    const all = [sw('sw1', 0), sw('sw2', 40), gate, led];
    const within = smartConnectChainWithin(all, new Set(['sw1', 'sw2', 'gate', 'led']));
    expect(within.pairs).toEqual(smartConnectChain([...all], 0).pairs);
    expect(within.pairs.some((p) => p.target.componentId === 'led')).toBe(true);
  });
});
