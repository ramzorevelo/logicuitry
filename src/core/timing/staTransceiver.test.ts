import { describe, expect, it } from 'vitest';
import { compile } from '../model/compile';
import type { ChipLibrary, Component, Wire } from '../model/types';
import { board, chipComp, chipDef, comp, pin, wire } from '../model/testFixtures';
import { builtinChipLibrary } from '../parts/packages';
import { analyzeTiming, TimingError } from './sta';

const noLib: ChipLibrary = new Map();

/** SW -> G1 -> tristate U -> T.a; T.b -> G2 -> LED LB; `dir` decides what drives T.dir. */
function chain(dir: Component) {
  return board({
    components: [
      comp('SW', 'toggle', undefined, 'SW'),
      comp('G1', 'not', undefined, 'G1'),
      comp('en', 'constant', { value: 1 }),
      comp('U', 'tristate', undefined, 'U'),
      comp('T', 'transceiver', { width: 1 }, 'T'),
      dir,
      comp('oe', 'constant', { value: 1 }),
      comp('G2', 'not', undefined, 'G2'),
      comp('LB', 'led', undefined, 'LB'),
    ],
    wires: [
      wire('w1', ['SW', 'y'], ['G1', 'a']),
      wire('w2', ['G1', 'y'], ['U', 'a']),
      wire('w3', ['en', 'y'], ['U', 'en']),
      wire('w4', ['U', 'y'], ['T', 'a']),
      wire(
        'w5',
        [dir.id, dir.kind === 'toggle' || dir.kind === 'constant' ? 'y' : 'p'],
        ['T', 'dir'],
      ),
      wire('w6', ['oe', 'y'], ['T', 'oe']),
      wire('w7', ['T', 'b'], ['G2', 'a']),
      wire('w8', ['G2', 'y'], ['LB', 'a']),
    ],
  });
}

const sta = (b: ReturnType<typeof board>) => analyzeTiming(compile(b, noLib), { column: 'typ' });
const hops = (r: ReturnType<typeof sta>, endpoint: string) =>
  r.endpoints.find((e) => e.endpoint === endpoint)?.critical.map((h) => h.path);

describe('transceiver direction in STA', () => {
  it('times the A to B arc when DIR is tied to VCC', () => {
    const r = sta(chain(comp('V', 'vcc')));
    expect(hops(r, 'main/LB')).toEqual(['main/G1', 'main/U', 'main/T', 'main/G2']);
    expect(r.directionBreaks).toEqual([]);
  });

  it('times the arc a constant DIR selects', () => {
    expect(hops(sta(chain(comp('K', 'constant', { value: 1 }))), 'main/LB')).toEqual([
      'main/G1',
      'main/U',
      'main/T',
      'main/G2',
    ]);
  });

  it('runs no path from A to B when DIR is tied to GND', () => {
    const r = sta(chain(comp('V', 'gnd')));
    expect(hops(r, 'main/LB')).toBeUndefined();
    expect(r.directionBreaks).toEqual([]);
  });

  it('breaks the path at a transceiver whose DIR is on a switch, and says so', () => {
    const r = sta(chain(comp('D', 'toggle', undefined, 'D')));
    expect(r.directionBreaks).toEqual(['main/T']);
    const sideA = r.endpoints.find((e) => e.endpoint === 'main/T.a');
    expect(sideA?.critical.map((h) => h.path)).toEqual(['main/G1', 'main/U']);
    expect(sideA?.startpoint).toBe('main/SW');
    expect(sideA?.shortStartpoint).not.toBe('main/T');
    const led = r.endpoints.find((e) => e.endpoint === 'main/LB');
    expect(led?.critical.map((h) => h.path)).toEqual(['main/G2']);
    expect(led?.startpoint).toBe('main/T');
  });

  it('refuses no board where transceivers share a bus, fixed or not', () => {
    /** T1 drives BUS from a tristate; T2 reads BUS on its b side into an LED. */
    const shared = (dir1: Component, dir2: Component) => {
      const pin = (c: Component) => (c.kind === 'vcc' || c.kind === 'gnd' ? 'p' : 'y');
      const wires: Wire[] = [
        wire('w1', ['SW', 'y'], ['U', 'a']),
        wire('w2', ['en', 'y'], ['U', 'en']),
        wire('w3', ['U', 'y'], ['T1', 'a']),
        wire('w4', ['T1', 'b'], ['T2', 'b']),
        wire('w5', ['T2', 'a'], ['LB', 'a']),
        wire('w6', [dir1.id, pin(dir1)], ['T1', 'dir']),
        wire('w7', [dir2.id, pin(dir2)], ['T2', 'dir']),
        wire('w8', ['en', 'y'], ['T1', 'oe']),
        wire('w9', ['en', 'y'], ['T2', 'oe']),
      ];
      return board({
        components: [
          comp('SW', 'toggle', undefined, 'SW'),
          comp('en', 'constant', { value: 1 }),
          comp('U', 'tristate', undefined, 'U'),
          comp('T1', 'transceiver', { width: 1 }, 'T1'),
          comp('T2', 'transceiver', { width: 1 }, 'T2'),
          dir1,
          dir2,
          comp('LB', 'led', undefined, 'LB'),
        ],
        wires,
      });
    };
    const facing = sta(shared(comp('V', 'vcc'), comp('G', 'gnd')));
    expect(hops(facing, 'main/LB')).toEqual(['main/U', 'main/T1', 'main/T2']);
    const switched = sta(
      shared(comp('D1', 'toggle', undefined, 'D1'), comp('D2', 'toggle', undefined, 'D2')),
    );
    expect(switched.directionBreaks).toEqual(['main/T1', 'main/T2']);
    expect(() =>
      sta(shared(comp('V', 'vcc'), comp('D2', 'toggle', undefined, 'D2'))),
    ).not.toThrow();
  });

  describe("a '245 DIP", () => {
    const lib = builtinChipLibrary();
    /** SW -> A1 of U7, B1 -> LED LB; `dir` drives DIR, /OE is grounded. */
    const dip = (dir: Component) =>
      board({
        components: [
          comp('SW', 'toggle', undefined, 'SW'),
          chipComp('u7', '74LS245', 'U7'),
          comp('V', 'vcc'),
          comp('G', 'gnd'),
          dir,
          comp('LB', 'led', undefined, 'LB'),
        ],
        wires: [
          wire('w1', ['SW', 'y'], ['u7', 'A1']),
          wire('w2', ['V', 'p'], ['u7', 'VCC']),
          wire('w3', ['G', 'p'], ['u7', 'GND']),
          wire('w4', ['G', 'p'], ['u7', '/OE']),
          wire('w5', [dir.id, dir.kind === 'toggle' ? 'y' : 'p'], ['u7', 'DIR']),
          wire('w6', ['u7', 'B1'], ['LB', 'a']),
        ],
      });
    const dipSta = (b: ReturnType<typeof board>) =>
      analyzeTiming(compile(b, lib), { column: 'typ' });

    it('times A1 to B1 at the A to B arc with DIR tied to VCC', () => {
      const r = dipSta(dip(comp('DV', 'vcc')));
      expect(r.directionBreaks).toEqual([]);
      const lb = r.endpoints.find((e) => e.endpoint === 'main/LB')!;
      expect(lb.startpoint).toBe('main/SW');
      expect(lb.totalTpdPs).toBe(8_000);
    });

    it('notes one direction break per chip, not one per section', () => {
      const r = dipSta(dip(comp('D', 'toggle', undefined, 'D')));
      expect(r.directionBreaks).toEqual(['main/U7']);
    });

    /** A user chip `name` whose DIR pin feeds `inner`, placed as W1 with DIR on a switch. */
    const wrapped = (name: string, inner: Component[], innerWires: Wire[]) => {
      const def = chipDef({
        id: 'wrap',
        name,
        pins: [pin('DIR', 'in', 'dirIn', 0)],
        components: [comp('dirIn', 'inport'), comp('V', 'vcc'), comp('G', 'gnd'), ...inner],
        wires: innerWires,
      });
      const b = board({
        components: [comp('D', 'toggle', undefined, 'D'), chipComp('w1', 'wrap', 'W1')],
        wires: [wire('w1', ['D', 'y'], ['w1', 'DIR'])],
      });
      return analyzeTiming(compile(b, new Map([...lib, [def.id, def]])), { column: 'typ' });
    };

    it('reports a DIP nested in a user chip at the DIP instance', () => {
      const r = wrapped(
        'Bus port',
        [chipComp('u7', '74LS245', 'U7')],
        [
          wire('i1', ['dirIn', 'y'], ['u7', 'DIR']),
          wire('i2', ['V', 'p'], ['u7', 'VCC']),
          wire('i3', ['G', 'p'], ['u7', 'GND']),
          wire('i4', ['G', 'p'], ['u7', '/OE']),
        ],
      );
      expect(r.directionBreaks).toEqual(['main/W1:Bus port/U7']);
    });

    it('keeps each transceiver in a user chip named like the part apart', () => {
      const r = wrapped(
        '74LS245',
        [
          comp('T1', 'transceiver', { width: 1 }, 'T1'),
          comp('T2', 'transceiver', { width: 1 }, 'T2'),
        ],
        [
          wire('i1', ['dirIn', 'y'], ['T1', 'dir']),
          wire('i2', ['dirIn', 'y'], ['T2', 'dir']),
          wire('i3', ['V', 'p'], ['T1', 'oe']),
          wire('i4', ['V', 'p'], ['T2', 'oe']),
        ],
      );
      expect(r.directionBreaks).toEqual(['main/W1:74LS245/T1', 'main/W1:74LS245/T2']);
    });
  });

  // SPEC: a loop that is real with the directions fixed is still a cycle; only the
  // transceiver's read-back of its own drive is never one.
  it('still reports a genuine loop through two direction-fixed transceivers', () => {
    const b = board({
      components: [
        comp('T1', 'transceiver', { width: 1 }, 'T1'),
        comp('T2', 'transceiver', { width: 1 }, 'T2'),
        comp('V', 'vcc'),
      ],
      wires: [
        wire('w1', ['T1', 'b'], ['T2', 'a']),
        wire('w2', ['T2', 'b'], ['T1', 'a']),
        wire('w3', ['V', 'p'], ['T1', 'dir']),
        wire('w4', ['V', 'p'], ['T2', 'dir']),
        wire('w5', ['V', 'p'], ['T1', 'oe']),
        wire('w6', ['V', 'p'], ['T2', 'oe']),
      ],
    });
    expect(() => sta(b)).toThrow(TimingError);
  });
});
