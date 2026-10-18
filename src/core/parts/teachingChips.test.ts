import { describe, expect, it } from 'vitest';
import { compile } from '../model/compile';
import { board, comp, wire } from '../model/testFixtures';
import { datasheetDelay } from '../sim/delay';
import { Simulator } from '../sim/kernel';
import { builtinChipLibrary, isBuiltinChipDef } from './packages';
import { propagationNs } from './partsDb';
import { run } from './testHarness';

const lib = builtinChipLibrary();

describe('built-in half and full adder', () => {
  it('are read-only built-ins built from bound gates only', () => {
    for (const id of ['half-adder', 'full-adder']) {
      const def = lib.get(id)!;
      expect(isBuiltinChipDef(def)).toBe(true);
      expect(def.appearance?.package).toBeUndefined();
      const kinds = def.components
        .map((c) => c.kind)
        .filter((k) => k !== 'inport' && k !== 'outport');
      expect(
        kinds.every((k) => k === 'xor' || k === 'and' || k === 'or'),
        id,
      ).toBe(true);
      expect(
        def.components.some((c) => c.kind === 'chip'),
        id,
      ).toBe(false);
    }
  });

  it('half adder: S = A xor B, Cout = AB', () => {
    for (const a of [false, true])
      for (const b of [false, true]) {
        const v = run('half-adder', { A: a, B: b });
        expect(v('S'), `${a} ${b}`).toBe(String(Number(a !== b)));
        expect(v('Cout'), `${a} ${b}`).toBe(String(Number(a && b)));
      }
  });

  it('full adder: all eight rows', () => {
    for (let row = 0; row < 8; row++) {
      const [a, b, cin] = [row & 4, row & 2, row & 1].map(Boolean) as [boolean, boolean, boolean];
      const total = Number(a) + Number(b) + Number(cin);
      const v = run('full-adder', { A: a, B: b, Cin: cin });
      expect(v('S'), String(row)).toBe(String(total & 1));
      expect(v('Cout'), String(row)).toBe(String(total >> 1));
    }
  });

  it('in datasheet mode sum and carry arrive after the real gate delays', () => {
    const compiled = compile(
      board({
        components: [
          comp('ta', 'toggle', undefined, 'A'),
          comp('tb', 'toggle', undefined, 'B'),
          comp('tc', 'toggle', undefined, 'Cin'),
          { ...comp('u1', 'chip', undefined, 'U1'), defId: 'full-adder' },
          comp('ps', 'probe', undefined, 'S'),
          comp('pc', 'probe', undefined, 'Cout'),
        ],
        wires: [
          wire('w1', ['ta', 'y'], ['u1', 'A']),
          wire('w2', ['tb', 'y'], ['u1', 'B']),
          wire('w3', ['tc', 'y'], ['u1', 'Cin']),
          wire('w4', ['u1', 'S'], ['ps', 'a']),
          wire('w5', ['u1', 'Cout'], ['pc', 'a']),
        ],
      }),
      lib,
    );
    const sim = new Simulator(compiled, datasheetDelay('typ'));
    sim.powerOn();
    sim.setToggle('main/A', true);
    sim.setToggle('main/B', false);
    sim.setToggle('main/Cin', false);
    sim.settle();

    const cinNet = compiled.primitives[compiled.pathToPrimitive.get('main/Cin')!]!.outputs[0]!;
    const t0 = sim.time;
    sim.setToggle('main/Cin', true);
    sim.settle();
    const records = sim.traceRecords().filter((r) => r.time > t0);
    const at = (path: string) => records.find((r) => r.net === compiled.pathToNet.get(path))!.time;
    // From the input net's edge: the toggle is unbound and adds its own delay.
    const edge = records.find((r) => r.net === cinNet)!.time;

    // A xor B is already 1: Cin rising makes S fall through one '86, and
    // Cout rise through one '08 then one '32.
    const ps = (ns: number) => ns * 1000;
    expect(at('main/S') - edge).toBe(ps(propagationNs('74LS86', 'hl', 'typ')!));
    expect(at('main/Cout') - edge).toBe(
      ps(propagationNs('74LS08', 'lh', 'typ')! + propagationNs('74LS32', 'lh', 'typ')!),
    );
  });
});
