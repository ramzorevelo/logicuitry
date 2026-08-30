import { describe, expect, it } from 'vitest';
import {
  collectPinTargets,
  labelExempt,
  nearestCompatiblePin,
  occupancyKey,
  smartConnectTargets,
  wiredPinKeys,
  wireWidth,
  type PinTarget,
} from './pinTargets';
import type { Component, ComponentKind, Wire } from '../../core/model/types';
import type { Theme } from '../../render/theme';
import { makeTestTheme } from '../../render/theme.fixture';
// Side-effect imports: register glyph geometry so symbolBounds resolves.
import '../../render/glyphs/gates';
import '../../render/glyphs/io';
import '../../render/glyphs/chip';

const theme: Theme = makeTestTheme({ strokes: { min: 1.5, wire: 2, bus: 4, cornerRadius: 3 } });

const comp = (id: string, kind: ComponentKind, x: number, y: number): Component => ({
  id,
  kind,
  pos: { x, y },
});

const pin = (over: Partial<PinTarget>): PinTarget => ({
  componentId: 'c',
  pinName: 'y',
  width: 1,
  role: 'data',
  order: 0,
  dir: 'out',
  worldPos: { x: 0, y: 0 },
  free: true,
  ...over,
});

describe('collectPinTargets', () => {
  it('resolves world pin positions and marks wired input pins occupied', () => {
    const components = [comp('g', 'and', 0, 0), comp('t', 'toggle', 100, 0)];
    const wires: Wire[] = [
      {
        id: 'w',
        a: { kind: 'pin', component: 't', pin: 'y' },
        b: { kind: 'pin', component: 'g', pin: 'a' },
        points: [],
      },
    ];
    const targets = collectPinTargets(components, wires, theme, new Map());
    const gy = targets.find((t) => t.componentId === 'g' && t.pinName === 'y');
    const ga = targets.find((t) => t.componentId === 'g' && t.pinName === 'a');
    const ty = targets.find((t) => t.componentId === 't' && t.pinName === 'y');
    expect(gy?.free).toBe(true);
    expect(ga?.free).toBe(false); // wired input: at most one driver
    expect(ty?.free).toBe(true); // wired output: fan-out to more inputs is fine
    expect(Number.isFinite(gy!.worldPos.x)).toBe(true);
  });

  it('lets one output fan out to many inputs, still occupying each input', () => {
    const components = [
      comp('t', 'toggle', 0, 0),
      comp('g1', 'and', 100, 0),
      comp('g2', 'and', 100, 100),
    ];
    const wires: Wire[] = [
      {
        id: 'w1',
        a: { kind: 'pin', component: 't', pin: 'y' },
        b: { kind: 'pin', component: 'g1', pin: 'a' },
        points: [],
      },
      {
        id: 'w2',
        a: { kind: 'pin', component: 't', pin: 'y' },
        b: { kind: 'pin', component: 'g2', pin: 'a' },
        points: [],
      },
    ];
    const targets = collectPinTargets(components, wires, theme, new Map());
    const ty = targets.find((t) => t.componentId === 't' && t.pinName === 'y');
    const g1a = targets.find((t) => t.componentId === 'g1' && t.pinName === 'a');
    const g2a = targets.find((t) => t.componentId === 'g2' && t.pinName === 'a');
    expect(ty?.free).toBe(true); // still offerable to a third input
    expect(g1a?.free).toBe(false);
    expect(g2a?.free).toBe(false);
  });
});

describe('wiredPinKeys', () => {
  it('keys every pin end of a wire, excluding junction/tap/free ends', () => {
    const wires: Wire[] = [
      {
        id: 'w1',
        a: { kind: 'pin', component: 'g1', pin: 'a' },
        b: { kind: 'pin', component: 'g2', pin: 'y' },
        points: [],
      },
      {
        id: 'w2',
        a: { kind: 'pin', component: 'g3', pin: 'b' },
        b: { kind: 'free', pos: { x: 10, y: 10 } },
        points: [],
      },
      {
        id: 'w3',
        a: { kind: 'junction', junction: 'j1' },
        b: { kind: 'tap', wire: 'w1', range: { hi: 0, lo: 0 }, pos: { x: 0, y: 0 } },
        points: [],
      },
    ];
    const keys = wiredPinKeys(wires);
    expect(keys).toEqual(
      new Set([occupancyKey('g1', 'a'), occupancyKey('g2', 'y'), occupancyKey('g3', 'b')]),
    );
  });
});

describe('smartConnectTargets', () => {
  it('keeps an already-wired output offerable but drops an already-wired input', () => {
    const components = [
      comp('t', 'toggle', 0, 0),
      comp('g1', 'and', 100, 0),
      comp('led2', 'led', 200, 0),
    ];
    const wires: Wire[] = [
      {
        id: 'w1',
        a: { kind: 'pin', component: 't', pin: 'y' },
        b: { kind: 'pin', component: 'g1', pin: 'a' },
        points: [],
      },
    ];
    const targets = collectPinTargets(components, wires, theme, new Map());
    const avail = smartConnectTargets(targets, wires);
    // Output already driving g1.a still appears -- fan-out to a second sink.
    expect(avail.some((t) => t.componentId === 't' && t.pinName === 'y')).toBe(true);
    // Input already fed by the toggle must not be re-suggested.
    expect(avail.some((t) => t.componentId === 'g1' && t.pinName === 'a')).toBe(false);
  });
});

describe('nearestCompatiblePin', () => {
  const cursor = { x: 0, y: 0 };
  it('picks the nearest free opposite-direction pin of matching width', () => {
    const targets = [
      pin({ componentId: 'a', dir: 'in', worldPos: { x: 5, y: 0 } }),
      pin({ componentId: 'b', dir: 'in', worldPos: { x: 3, y: 0 } }),
    ];
    expect(nearestCompatiblePin(targets, cursor, { width: 1, dir: 'out' }, 1)?.componentId).toBe(
      'b',
    );
  });

  it('rejects same-direction, occupied, and width-mismatched pins', () => {
    expect(
      nearestCompatiblePin([pin({ dir: 'out' })], cursor, { width: 1, dir: 'out' }, 1),
    ).toBeUndefined();
    expect(
      nearestCompatiblePin([pin({ dir: 'in', free: false })], cursor, { width: 1, dir: 'out' }, 1),
    ).toBeUndefined();
    expect(
      nearestCompatiblePin([pin({ dir: 'in', width: 4 })], cursor, { width: 1, dir: 'out' }, 1),
    ).toBeUndefined();
  });

  it('ignores pins outside the loose radius', () => {
    expect(
      nearestCompatiblePin(
        [pin({ dir: 'in', worldPos: { x: 999, y: 0 } })],
        cursor,
        { width: 1, dir: 'out' },
        1,
      ),
    ).toBeUndefined();
  });
});

describe('wireWidth', () => {
  it("reads a wire's width off whichever end resolves to a real pin", () => {
    const components: Component[] = [
      { id: 'c8', kind: 'constant', pos: { x: 0, y: 0 }, params: { width: 8, value: 0 } },
      { id: 'o8', kind: 'outport', pos: { x: 100, y: 0 }, params: { width: 8 } },
    ];
    const wire: Wire = {
      id: 'w',
      a: { kind: 'pin', component: 'c8', pin: 'y' },
      b: { kind: 'pin', component: 'o8', pin: 'a' },
      points: [],
    };
    expect(wireWidth(wire, components, new Map())).toBe(8);
  });

  it('resolves off whichever end is a pin when the other is a junction/free/tap', () => {
    const components: Component[] = [
      { id: 'o4', kind: 'outport', pos: { x: 0, y: 0 }, params: { width: 4 } },
    ];
    const wire: Wire = {
      id: 'w',
      a: { kind: 'junction', junction: 'j1' },
      b: { kind: 'pin', component: 'o4', pin: 'a' },
      points: [],
    };
    expect(wireWidth(wire, components, new Map())).toBe(4);
  });

  it('returns undefined when neither end resolves to a known pin', () => {
    const wire: Wire = {
      id: 'w',
      a: { kind: 'free', pos: { x: 0, y: 0 } },
      b: { kind: 'junction', junction: 'j1' },
      points: [],
    };
    expect(wireWidth(wire, [], new Map())).toBeUndefined();
  });
});

describe('labelExempt', () => {
  const target = (componentId: string, pinName: string): PinTarget =>
    pin({ componentId, pinName, dir: 'in', free: false });

  it('exempts an occupied target when the FROM side is an In/Out label', () => {
    const components = [comp('in1', 'inport', 0, 0), comp('g', 'and', 100, 0)];
    expect(labelExempt(components, [], 'in1', target('g', 'a'))).toBe(true);
  });

  it('exempts an occupied target whose EXISTING driver is an In/Out label', () => {
    const components = [
      comp('sw', 'toggle', 0, 0),
      comp('g', 'and', 100, 0),
      comp('in1', 'inport', 200, 0),
    ];
    const wires: Wire[] = [
      {
        id: 'w1',
        a: { kind: 'pin', component: 'in1', pin: 'y' },
        b: { kind: 'pin', component: 'g', pin: 'a' },
        points: [],
      },
    ];
    expect(labelExempt(components, wires, 'sw', target('g', 'a'))).toBe(true);
  });

  it('does not exempt when neither side is a label (two real drivers)', () => {
    const components = [
      comp('sw1', 'toggle', 0, 0),
      comp('g', 'and', 100, 0),
      comp('sw2', 'toggle', 200, 0),
    ];
    const wires: Wire[] = [
      {
        id: 'w1',
        a: { kind: 'pin', component: 'sw2', pin: 'y' },
        b: { kind: 'pin', component: 'g', pin: 'a' },
        points: [],
      },
    ];
    expect(labelExempt(components, wires, 'sw1', target('g', 'a'))).toBe(false);
  });

  it('does not exempt a pin that already has a REAL driver, even when a label ALSO shares it', () => {
    // Bug: a pin driven by sw1 AND named by an In label should still reject
    // a second real driver (sw2) -- the old logic short-circuited true the
    // moment it found the label-driven wire, without checking whether
    // another wire on the same pin was a real (non-label) driver too.
    const components = [
      comp('sw1', 'toggle', 0, 0),
      comp('g', 'and', 100, 0),
      comp('in1', 'inport', 200, 0),
      comp('sw2', 'toggle', 300, 0),
    ];
    const wires: Wire[] = [
      {
        id: 'w1',
        a: { kind: 'pin', component: 'sw1', pin: 'y' },
        b: { kind: 'pin', component: 'g', pin: 'a' },
        points: [],
      },
      {
        id: 'w2',
        a: { kind: 'pin', component: 'in1', pin: 'y' },
        b: { kind: 'pin', component: 'g', pin: 'a' },
        points: [],
      },
    ];
    expect(labelExempt(components, wires, 'sw2', target('g', 'a'))).toBe(false);
  });
});

describe('a passive (net label) pin is a wiring wildcard', () => {
  const t = (over: Partial<PinTarget>): PinTarget => ({
    componentId: 'c',
    pinName: 'a',
    dir: 'in',
    width: 1,
    role: 'data',
    order: 0,
    free: true,
    worldPos: { x: 0, y: 0 },
    ...over,
  });

  it('accepts a label pin from an output of any width', () => {
    const targets = [t({ componentId: 'L1', dir: 'passive', width: 1 })];
    for (const width of [1, 4, 32]) {
      const hit = nearestCompatiblePin(targets, { x: 0, y: 0 }, { width, dir: 'out' }, 1);
      expect(hit?.componentId).toBe('L1');
    }
  });

  it('accepts an input or an output when the wire starts at a label', () => {
    for (const dir of ['in', 'out'] as const) {
      const targets = [t({ componentId: 'g', dir, width: 4 })];
      const hit = nearestCompatiblePin(targets, { x: 0, y: 0 }, { width: 1, dir: 'passive' }, 1);
      expect(hit?.componentId).toBe('g');
    }
  });

  it('still rejects a same-direction, different-width pair between real pins', () => {
    const targets = [t({ componentId: 'g', dir: 'out', width: 4 })];
    expect(
      nearestCompatiblePin(targets, { x: 0, y: 0 }, { width: 4, dir: 'out' }, 1),
    ).toBeUndefined();
    expect(
      nearestCompatiblePin(targets, { x: 0, y: 0 }, { width: 1, dir: 'in' }, 1),
    ).toBeUndefined();
  });

  it('smartConnectTargets drops label pins -- a label joins by name, not a wire', () => {
    const targets = [t({ componentId: 'L1', dir: 'passive' }), t({ componentId: 'g', dir: 'in' })];
    expect(smartConnectTargets(targets, []).map((x) => x.componentId)).toEqual(['g']);
  });
});
