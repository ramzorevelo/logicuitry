import { describe, expect, it } from 'vitest';
import type { Board, ChipLibrary, Component } from '../model/types';
import { board, chipComp, comp, tapWire, wire } from '../model/testFixtures';
import { builtinChipLibrary } from '../parts/packages';
import { compile, CompileError } from '../model/compile';
import { Simulator } from '../sim/kernel';
import { idealDelay } from '../sim/delay';
import {
  checkRows,
  compileErrorRow,
  fightRows,
  oscillationRow,
  parseCheckKey,
  pruneHiddenChecks,
  staticFindings,
} from './checks';

const lib: ChipLibrary = builtinChipLibrary();

const rows = (b: Board, hidden: string[] = []) =>
  checkRows(staticFindings(b, lib), new Set(hidden), b, lib);
const titles = (b: Board, hidden: string[] = []) => rows(b, hidden).shown.map((r) => r.title);
const keysOf = (b: Board) => staticFindings(b, lib).map((f) => f.key);

/** A '08 with both rails wired, so only the check under test speaks. */
const poweredAnd = (extra: Component[] = [], wires: Board['wires'] = []) =>
  board({
    components: [chipComp('u1', '74LS08', 'U1'), comp('v', 'vcc'), comp('g', 'gnd'), ...extra],
    wires: [wire('wv', ['v', 'p'], ['u1', 'VCC']), wire('wg', ['g', 'p'], ['u1', 'GND']), ...wires],
  });

describe('checks: unwired and undriven inputs', () => {
  it('lists every open input of a gate in one row, by pin name', () => {
    const b = board({ components: [comp('g1', 'and')] });
    expect(titles(b)).toContain('g1: pins a, b not wired');
  });

  it('names DIP pins by datasheet number, lowest first, in one row per chip', () => {
    const r = rows(poweredAnd()).shown.find((x) => x.kind === 'unwired')!;
    expect(r.title).toBe('U1 74LS08: pins 1, 2, 4, 5, 9, 10, 12, 13 not wired');
    expect(r.detail).toBe('Reads X. A real chip drifts high.');
    expect(r.components).toEqual(['u1']);
    expect(r.pins).toHaveLength(8);
  });

  it('calls an input wired only to other inputs not driven', () => {
    const b = board({
      components: [comp('g1', 'and'), comp('g2', 'and')],
      wires: [wire('w1', ['g1', 'a'], ['g2', 'a'])],
    });
    expect(titles(b)).toEqual(
      expect.arrayContaining(['g1: pin a not driven', 'g2: pin a not driven']),
    );
  });

  it('treats a free wire end, a lone junction and a lone label as unwired', () => {
    const b = board({
      components: [comp('g1', 'not'), comp('l1', 'netlabel', undefined, 'A')],
      junctions: [{ id: 'j1', pos: { x: 0, y: 0 } }],
      wires: [
        {
          id: 'w1',
          a: { kind: 'pin', component: 'g1', pin: 'a' },
          b: { kind: 'free', pos: { x: 9, y: 9 } },
          points: [],
        },
        {
          id: 'w2',
          a: { kind: 'pin', component: 'l1', pin: 'a' },
          b: { kind: 'junction', junction: 'j1' },
          points: [],
        },
      ],
    });
    expect(titles(b)).toContain('g1: pin a not wired');
  });

  it('joins same-name labels within a group only', () => {
    const b = board({
      groups: [{ id: 'G', name: 'alu' }],
      components: [
        comp('s', 'toggle'),
        comp('l1', 'netlabel', undefined, 'A'),
        { ...comp('l2', 'netlabel', undefined, 'A'), group: 'G' },
        { ...comp('g1', 'not'), group: 'G' },
      ],
      wires: [wire('w1', ['s', 'y'], ['l1', 'a']), wire('w2', ['l2', 'a'], ['g1', 'a'])],
    });
    // A label in another group joins nothing, so g1 is left with only its own label.
    expect(titles(b)).toContain('alu/g1: pin a not wired');
  });

  it('counts pulls, rails, switches, tunnels and taps as drivers', () => {
    const b = board({
      components: [
        comp('p', 'pullup'),
        comp('n1', 'not'),
        comp('t1', 'tunnel', { name: 'T' }),
        comp('t2', 'tunnel', { name: 'T' }),
        comp('s', 'toggle'),
        comp('n2', 'not'),
        comp('bus', 'toggle', { width: 4 }),
        comp('n3', 'not'),
        comp('d', 'busdisplay', { width: 4 }),
      ],
      wires: [
        wire('w1', ['p', 'p'], ['n1', 'a']),
        wire('w2', ['s', 'y'], ['t1', 'p']),
        wire('w3', ['t2', 'p'], ['n2', 'a']),
        wire('wb', ['bus', 'y'], ['d', 'value']),
        tapWire('wt', ['n3', 'a'], 'wb', { hi: 0, lo: 0 }),
      ],
    });
    expect(
      staticFindings(b, lib).filter((f) => f.kind === 'unwired' || f.kind === 'undriven'),
    ).toEqual([]);
  });

  it("skips a package's NC pin, the '47's BI/RBO and a display's segments", () => {
    const keys = keysOf(
      board({
        components: [
          chipComp('u1', '74LS280', 'U1'),
          chipComp('u2', '74LS47', 'U2'),
          comp('ds', 'sevenseg'),
        ],
      }),
    );
    expect(keys).not.toContain('unwired:u1.NC');
    expect(keys).not.toContain('unused:u1.NC');
    expect(keys).not.toContain('unwired:u2./BI_RBO');
    expect(keys).toContain('unwired:u2./LT');
    expect(keys.filter((k) => /^unwired:ds\.(a|b|c|d|e|f|g|dp)$/.test(k))).toEqual([]);
  });

  it('never flags an inout pin as an open input', () => {
    const b = poweredAnd([chipComp('u2', '74LS245', 'U2')]);
    expect(keysOf(b).some((k) => /^(unwired|undriven):u2\.(A|B)\d$/.test(k))).toBe(false);
  });
});

describe('checks: DIP power', () => {
  it('names each open rail with its pin number, and keeps rails out of the input row', () => {
    const b = board({ components: [chipComp('u2', '74LS32', 'U2')] });
    const r = rows(b).shown;
    expect(r.find((x) => x.kind === 'power')!.title).toBe(
      'U2 74LS32: GND (pin 7), VCC (pin 14) not wired',
    );
    expect(r.find((x) => x.kind === 'unwired')!.title).not.toMatch(/\b(7|14)\b/);
  });

  it('is quiet once both rails are driven', () => {
    expect(rows(poweredAnd()).shown.some((x) => x.kind === 'power')).toBe(false);
  });
});

describe('checks: nets that can float', () => {
  /** Two '245 A sides tied to an LED, with the '245s powered. */
  const bus = (extra: Component[] = [], wires: Board['wires'] = []) =>
    board({
      components: [
        chipComp('u1', '74LS245', 'U1'),
        chipComp('u2', '74LS245', 'U2'),
        comp('led', 'led'),
        comp('v', 'vcc'),
        comp('g', 'gnd'),
        comp('l', 'netlabel', undefined, 'BUS'),
        ...extra,
      ],
      wires: [
        wire('w1', ['u1', 'A1'], ['u2', 'A1']),
        wire('w2', ['u2', 'A1'], ['led', 'a']),
        wire('w3', ['l', 'a'], ['led', 'a']),
        ...['u1', 'u2'].flatMap((u) => [
          wire(`${u}v`, ['v', 'p'], [u, 'VCC']),
          wire(`${u}g`, ['g', 'p'], [u, 'GND']),
        ]),
        ...wires,
      ],
    });

  it('flags a net with only three-state drivers, by label, with its wires', () => {
    const r = rows(bus()).shown.find((x) => x.kind === 'float')!;
    expect(r.title).toBe('Net BUS can float');
    expect(r.wires.sort()).toEqual(['w1', 'w2', 'w3']);
    expect(r.keys).toEqual(['float:led.a']);
  });

  it('is quiet with a pull-down, or with a plain driver on the net', () => {
    expect(
      keysOf(bus([comp('pd', 'pulldown')], [wire('wp', ['pd', 'p'], ['led', 'a'])])),
    ).not.toContain('float:led.a');
    expect(
      keysOf(bus([comp('s', 'toggle')], [wire('ws', ['s', 'y'], ['led', 'a'])])),
    ).not.toContain('float:led.a');
  });

  it('flags a contact-to-ground button with no pull-up', () => {
    const b = board({
      components: [comp('b', 'button', { toGround: true }), comp('n', 'not')],
      wires: [wire('w', ['b', 'y'], ['n', 'a'])],
    });
    expect(rows(b).shown.find((x) => x.kind === 'float')!.title).toBe('Net at b pin y can float');
  });

  it("treats a '374 output as three-state and an '08 output as plain", () => {
    const ls374 = board({
      components: [chipComp('u1', '74LS374', 'U1'), comp('n', 'not')],
      wires: [wire('w', ['u1', '1Q'], ['n', 'a'])],
    });
    expect(staticFindings(ls374, lib).some((f) => f.kind === 'float')).toBe(true);
    const ls08 = poweredAnd([comp('n', 'not')], [wire('w', ['u1', '1Y'], ['n', 'a'])]);
    expect(staticFindings(ls08, lib).some((f) => f.kind === 'float')).toBe(false);
  });
});

describe('checks: unused outputs', () => {
  it('reports an output nobody reads as info, one row per part', () => {
    const r = rows(poweredAnd()).shown.find((x) => x.kind === 'unused')!;
    expect(r.severity).toBe('info');
    expect(r.title).toBe('U1 74LS08: pins 3, 6, 8, 11 drive nothing');
  });

  it('does not count a waveform probe as a read', () => {
    const b = board({
      components: [comp('s', 'toggle'), comp('p', 'probe', undefined, 'P')],
      wires: [wire('w', ['s', 'y'], ['p', 'a'])],
    });
    expect(keysOf(b)).toContain('unused:s.y');
  });

  it('skips rails, pulls, splitters and labels', () => {
    const b = board({
      components: [comp('v', 'vcc'), comp('g', 'gnd'), comp('sp', 'split', { width: 2 })],
    });
    expect(staticFindings(b, lib).filter((f) => f.kind === 'unused')).toEqual([]);
  });
});

describe('checks: hiding', () => {
  it('hides a row pin by pin, so a newly open pin shows on its own', () => {
    const b = board({ components: [comp('g1', 'and')] });
    const r = rows(b, ['unwired:g1.a']);
    expect(r.shown.map((x) => x.title)).toContain('g1: pin b not wired');
    expect(r.hidden.map((x) => x.title)).toEqual(['g1: pin a not wired']);
  });

  it('prunes keys whose component or pin is gone, and keeps unknown-def chips', () => {
    const b = board({
      components: [comp('g1', 'and'), chipComp('u9', 'my-chip', 'U9')],
      hiddenChecks: ['unwired:g1.a', 'unwired:g1.zz', 'unused:gone.y', 'unwired:u9.X', 'junk'],
    });
    expect(pruneHiddenChecks(b, lib)).toEqual(['unwired:g1.a', 'unwired:u9.X']);
    expect(pruneHiddenChecks({ ...b, hiddenChecks: ['unwired:g1.a'] }, lib)).toEqual([
      'unwired:g1.a',
    ]);
    expect(pruneHiddenChecks({ ...b, hiddenChecks: ['unused:gone.y'] }, lib)).toBeUndefined();
  });

  it('parses keys back into kind, component and pin', () => {
    expect(parseCheckKey('float:u1./OE')).toEqual({ kind: 'float', component: 'u1', pin: '/OE' });
    expect(parseCheckKey('nonsense')).toBeNull();
  });
});

describe('checks: compile and live rows', () => {
  it('turns a contention refusal into one error row on both parts', () => {
    const b = board({
      components: [chipComp('u1', '74LS08', 'U1'), chipComp('u2', '74LS08', 'U2')],
      wires: [wire('w', ['u1', '1Y'], ['u2', '1Y'])],
    });
    let err: CompileError | undefined;
    try {
      compile(b, lib);
    } catch (e) {
      err = e as CompileError;
    }
    const r = compileErrorRow(b, {
      message: err!.message.slice(err!.path.length + 2),
      path: err!.path,
    });
    expect(r.severity).toBe('error');
    expect(r.title).toBe('Pins U1.1Y and U2.1Y drive the same wire');
    expect(r.detail).toBe('A net takes at most one output that cannot float.');
    expect(r.components.sort()).toEqual(['u1', 'u2']);
    expect(r.keys).toEqual([]);
  });

  it('locates a fighting net on the circuit by its wires', () => {
    const b = board({
      components: [
        comp('a', 'toggle', undefined, 'A'),
        comp('e', 'toggle', { initial: 1 }, 'E'),
        comp('t1', 'tristate'),
        comp('t2', 'tristate'),
        comp('v', 'vcc'),
        comp('led', 'led'),
      ],
      wires: [
        wire('w1', ['a', 'y'], ['t1', 'a']),
        wire('w2', ['v', 'p'], ['t2', 'a']),
        wire('w3', ['e', 'y'], ['t1', 'en']),
        wire('w4', ['e', 'y'], ['t2', 'en']),
        wire('w5', ['t1', 'y'], ['led', 'a']),
        wire('w6', ['t2', 'y'], ['led', 'a']),
      ],
    });
    const compiled = compile(b, lib);
    const sim = new Simulator(compiled, idealDelay);
    sim.powerOn();
    sim.setToggle('main/E', true);
    sim.settle();
    const r = fightRows(b, lib, compiled, sim.fightingNets());
    expect(r).toHaveLength(1);
    expect(r[0]!.title).toBe('Three-state fight on at led pin a');
    expect(r[0]!.wires.sort()).toEqual(['w5', 'w6']);
    expect(r[0]!.live).toBe(true);
  });

  it('finds a fight between grouped chips, by their group-qualified paths', () => {
    const b = board({
      groups: [{ id: 'G', name: 'ALU' }],
      components: [
        { ...chipComp('u1', '74LS374', 'U1'), group: 'G' },
        { ...chipComp('u2', '74LS374', 'U2'), group: 'G' },
        chipComp('u3', '74LS374', 'U1'),
      ],
      wires: [wire('w', ['u1', '1Q'], ['u2', '1Q'])],
    });
    const compiled = compile(b, lib);
    const net = compiled.pathToNet.get('main/ALU/U1.1Q')!;
    const r = fightRows(b, lib, compiled, [net]);
    expect(r).toHaveLength(1);
    expect(r[0]!.wires).toEqual(['w']);
  });

  it('names the looping nets in the oscillation row', () => {
    expect(oscillationRow(['Q', 'QN']).detail).toBe('Q, QN');
  });
});
