import { describe, expect, it } from 'vitest';
import { compile } from '../model/compile';
import type { Board, ChipLibrary, Component, Wire } from '../model/types';
import { board, comp, wire } from '../model/testFixtures';
import { toString } from '../value/busValue';
import { idealDelay } from '../sim/delay';
import { Simulator } from '../sim/kernel';
import { buildPackageChipDef, builtinChipLibrary, packageEntries } from './packages';
import { getPart, propagationNs, typPublished } from './partsDb';

const goldens = import.meta.glob('./chips/*.chip.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>;

const lib: ChipLibrary = builtinChipLibrary();

describe('74-series package pinouts', () => {
  it('every entry is datasheet-verified and cites its source', () => {
    for (const e of packageEntries()) {
      expect(e.verified, e.part).toBe(true);
      expect(e.source.length, e.part).toBeGreaterThan(0);
    }
  });

  it('numbers pins 1..N with exactly one VCC and one GND', () => {
    for (const e of packageEntries()) {
      const width = Number(e.package.replace(/\D/g, ''));
      expect(
        e.pins.map((p) => p.pin).sort((a, b) => a - b),
        e.part,
      ).toEqual(Array.from({ length: width }, (_, i) => i + 1));
      expect(e.pins.filter((p) => p.fn === 'vcc').length, e.part).toBe(1);
      expect(e.pins.filter((p) => p.fn === 'gnd').length, e.part).toBe(1);
    }
  });

  it("the '47 and '48 are pin-identical, as both datasheets have them", () => {
    const names = (part: string) =>
      packageEntries()
        .find((e) => e.part === part)!
        .pins.map((p) => `${p.pin}:${p.name}`);
    expect(names('74LS47')).toEqual(names('74LS48'));
  });
});

describe('generated ChipDefs', () => {
  it('match the committed goldens', () => {
    for (const e of packageEntries()) {
      expect(buildPackageChipDef(e), e.part).toEqual(goldens[`./chips/${e.part}.chip.json`]);
    }
  });

  it('expose one boundary pin per package pin, in pin order', () => {
    for (const e of packageEntries()) {
      const def = lib.get(e.part)!;
      expect(
        def.pins.map((p) => p.name),
        e.part,
      ).toEqual([...e.pins].sort((a, b) => a.pin - b.pin).map((p) => p.name));
      expect(def.appearance?.package, e.part).toBe(e.package);
    }
  });

  it('bind every boundary pin to a port component that exists', () => {
    for (const e of packageEntries()) {
      const def = lib.get(e.part)!;
      for (const pin of def.pins) {
        const port = def.components.find((c) => c.id === pin.boundComponent);
        expect(port, `${e.part} ${pin.name}`).toBeDefined();
        expect(port!.kind).toBe(pin.dir === 'out' ? 'outport' : 'inport');
      }
    }
  });

  it('compiles every part without error', () => {
    for (const e of packageEntries())
      expect(() => compile(lib.get(e.part)!, lib), e.part).not.toThrow();
  });
});

/** One chip on a board, its pins driven by toggles and read by probes. */
function chipBoard(part: string, drive: Record<string, boolean | null>): Board {
  const def = lib.get(part)!;
  const comps: Component[] = [{ ...comp('u1', 'chip', undefined, 'U1'), defId: part }];
  const wires: Wire[] = [];
  let n = 0;
  for (const [pin, value] of Object.entries(drive)) {
    if (value === null) continue;
    const id = `t${++n}`;
    comps.push(comp(id, 'toggle', undefined, `IN${n}`));
    wires.push(wire(`wi${n}`, [id, 'y'], ['u1', pin]));
  }
  for (const pin of def.pins.filter((p) => p.dir === 'out')) {
    const id = `pr${++n}`;
    comps.push(comp(id, 'probe', undefined, pin.name));
    wires.push(wire(`wo${n}`, ['u1', pin.name], [id, 'a']));
  }
  return board({ components: comps, wires });
}

function run(part: string, drive: Record<string, boolean | null>): (pin: string) => string {
  const sim = new Simulator(compile(chipBoard(part, drive), lib), idealDelay);
  // powerOn re-runs every primitive's init, so the switches have to be set
  // after it, not before.
  sim.powerOn();
  for (const [pin, value] of Object.entries(drive)) {
    if (value === null) continue;
    const idx =
      Object.keys(drive)
        .filter((k) => drive[k] !== null)
        .indexOf(pin) + 1;
    sim.setToggle(`main/IN${idx}`, value);
  }
  sim.settle();
  return (pin: string) => toString(sim.netValueByPath(`main/${pin}`), 1);
}

describe('power gating', () => {
  it('floats every output to Z with no rails wired', () => {
    const v = run('74LS08', { '1A': true, '1B': true, VCC: null, GND: null });
    expect(v('1Y')).toBe('Z');
  });

  it('floats every output when only GND is wired', () => {
    const v = run('74LS08', { '1A': true, '1B': true, GND: false, VCC: null });
    expect(v('1Y')).toBe('Z');
  });

  it('drives the gate once both rails are wired', () => {
    const v = run('74LS08', { '1A': true, '1B': true, VCC: true, GND: false });
    expect(v('1Y')).toBe('1');
  });

  it('floats again when VCC is pulled low', () => {
    const v = run('74LS08', { '1A': true, '1B': true, VCC: false, GND: false });
    expect(v('1Y')).toBe('Z');
  });
});

describe('gate packages', () => {
  const cases: [string, string, string, boolean, boolean, string][] = [
    ['74LS00', '1A', '1B', true, true, '0'],
    ['74LS00', '1A', '1B', true, false, '1'],
    ['74LS02', '1A', '1B', false, false, '1'],
    ['74LS02', '1A', '1B', true, false, '0'],
    ['74LS08', '1A', '1B', true, false, '0'],
    ['74LS32', '1A', '1B', true, false, '1'],
    ['74LS86', '1A', '1B', true, true, '0'],
    ['74LS86', '1A', '1B', true, false, '1'],
  ];
  for (const [part, a, b, va, vb, want] of cases) {
    it(`${part} ${a}=${Number(va)} ${b}=${Number(vb)} -> ${want}`, () => {
      const v = run(part, { [a]: va, [b]: vb, VCC: true, GND: false });
      expect(v('1Y')).toBe(want);
    });
  }

  it('74LS04 inverts', () => {
    expect(run('74LS04', { '1A': true, VCC: true, GND: false })('1Y')).toBe('0');
    expect(run('74LS04', { '1A': false, VCC: true, GND: false })('1Y')).toBe('1');
  });

  it('drives each of a quad package four gates independently', () => {
    const v = run('74LS08', {
      '1A': true,
      '1B': true,
      '2A': true,
      '2B': false,
      VCC: true,
      GND: false,
    });
    expect(v('1Y')).toBe('1');
    expect(v('2Y')).toBe('0');
  });
});

describe('parts DB timing for the display decoders', () => {
  for (const part of ['74LS47', '74LS48']) {
    it(`${part} publishes a max column only`, () => {
      const entry = getPart(part)!;
      expect(entry.paths!['a_to_seg']!.tplh.typ).toBeUndefined();
      expect(typPublished(part)).toBe(false);
      // Asking for typ falls back to the published max rather than inventing one.
      expect(propagationNs(part, 'lh', 'typ')).toBe(100);
      expect(propagationNs(part, 'lh', 'max')).toBe(100);
    });
  }

  it('still reports a real typ for a part that publishes one', () => {
    expect(typPublished('74LS00')).toBe(true);
    expect(propagationNs('74LS00', 'lh', 'typ')).toBe(9);
  });
});
