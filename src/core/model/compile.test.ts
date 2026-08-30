import { describe, expect, it } from 'vitest';
import { CompileError, compile } from './compile';
import type { ChipLibrary } from './types';
import { board, chipDef, comp, pin, srLatchDef, wire } from './testFixtures';

const lib = (...defs: ReturnType<typeof chipDef>[]): ChipLibrary =>
  new Map(defs.map((d) => [d.id, d]));

describe('compile / flatten', () => {
  it('flattens a chip instance into its primitives with hierarchical paths', () => {
    const b = board({
      components: [
        comp('t1', 'toggle', undefined, 'SN'),
        comp('t2', 'toggle', undefined, 'RN'),
        { ...comp('u1', 'chip', undefined, 'U1'), defId: 'sr-latch' },
      ],
      wires: [wire('w1', ['t1', 'y'], ['u1', 'sn']), wire('w2', ['t2', 'y'], ['u1', 'rn'])],
    });
    const c = compile(b, lib(srLatchDef()));

    const kinds = c.primitives.map((p) => p.kind).sort();
    expect(kinds).toEqual(['nand', 'nand', 'toggle', 'toggle']);
    expect(c.pathToPrimitive.has('main/U1:sr-latch/g1')).toBe(true);
    expect(c.pathToPrimitive.has('main/SN')).toBe(true);

    // Boundary stitching: the toggle output and g1's 'a' input share one net.
    const g1 = c.primitives[c.pathToPrimitive.get('main/U1:sr-latch/g1')!]!;
    const sn = c.primitives[c.pathToPrimitive.get('main/SN')!]!;
    expect(g1.inputs[0]).toBe(sn.outputs[0]);

    // Cross-coupling: g1.y feeds g2.b and vice versa.
    const g2 = c.primitives[c.pathToPrimitive.get('main/U1:sr-latch/g2')!]!;
    expect(g2.inputs[1]).toBe(g1.outputs[0]);
    expect(g1.inputs[1]).toBe(g2.outputs[0]);
  });

  it('one definition placed twice becomes two disjoint primitive sets', () => {
    const b = board({
      components: [
        { ...comp('u1', 'chip'), defId: 'sr-latch' },
        { ...comp('u2', 'chip'), defId: 'sr-latch' },
      ],
    });
    const c = compile(b, lib(srLatchDef()));
    expect(c.primitives.filter((p) => p.kind === 'nand')).toHaveLength(4);
    const nets1 = c.primitives[c.pathToPrimitive.get('main/u1:sr-latch/g1')!]!.outputs;
    const nets2 = c.primitives[c.pathToPrimitive.get('main/u2:sr-latch/g1')!]!.outputs;
    expect(nets1[0]).not.toBe(nets2[0]);
  });

  it('rejects recursive chip references with the cycle in the message', () => {
    const selfRef = chipDef({
      id: 'ouroboros',
      name: 'ouroboros',
      pins: [pin('a', 'in', 'inA', 0)],
      components: [comp('inA', 'inport'), { ...comp('child', 'chip'), defId: 'ouroboros' }],
    });
    const b = board({ components: [{ ...comp('u1', 'chip'), defId: 'ouroboros' }] });
    expect(() => compile(b, lib(selfRef))).toThrow(/recursive chip reference/);
  });

  it('rejects width mismatches at edit-compile time', () => {
    const b = board({
      components: [comp('c4', 'constant', { width: 4, value: 5 }), comp('g', 'not')],
      wires: [wire('w1', ['c4', 'y'], ['g', 'a'])],
    });
    expect(() => compile(b, lib())).toThrow(CompileError);
    expect(() => compile(b, lib())).toThrow(/width mismatch/);
  });

  it('tunnels union same-name nets; probes alias net paths', () => {
    const b = board({
      components: [
        comp('t1', 'toggle'),
        comp('tunA', 'tunnel', { name: 'sig' }),
        comp('tunB', 'tunnel', { name: 'sig' }),
        comp('g', 'not'),
        comp('p1', 'probe', undefined, 'OUT'),
      ],
      wires: [
        wire('w1', ['t1', 'y'], ['tunA', 'p']),
        wire('w2', ['tunB', 'p'], ['g', 'a']),
        wire('w3', ['g', 'y'], ['p1', 'a']),
      ],
    });
    const c = compile(b, lib());
    const toggle = c.primitives[c.pathToPrimitive.get('main/t1')!]!;
    const notGate = c.primitives[c.pathToPrimitive.get('main/g')!]!;
    expect(notGate.inputs[0]).toBe(toggle.outputs[0]);
    expect(c.pathToNet.get('main/OUT')).toBe(notGate.outputs[0]);
  });

  it('records pulls on nets and rejects conflicting pulls', () => {
    const pulled = board({
      components: [comp('pu', 'pullup'), comp('g', 'not')],
      wires: [wire('w1', ['pu', 'p'], ['g', 'a'])],
    });
    const c = compile(pulled, lib());
    const g = c.primitives[c.pathToPrimitive.get('main/g')!]!;
    expect(c.nets[g.inputs[0]!]!.pull).toBe(1);

    const conflict = board({
      components: [comp('pu', 'pullup'), comp('pd', 'pulldown')],
      wires: [wire('w1', ['pu', 'p'], ['pd', 'p'])],
    });
    expect(() => compile(conflict, lib())).toThrow(/conflicting pull/);
  });

  it('rejects two non-tristate outputs wired onto the same net, naming the pins', () => {
    const b = board({
      components: [comp('g1', 'not'), comp('g2', 'not')],
      wires: [wire('w1', ['g1', 'y'], ['g2', 'y'])],
    });
    expect(() => compile(b, lib())).toThrow(/pins main\/g1\.y and main\/g2\.y drive the same wire/);
  });

  it('treats top-level input/output pins as pure labels: aliased nets, no primitives', () => {
    const b = board({
      components: [
        comp('in1', 'inport'),
        comp('in2', 'inport'),
        comp('g', 'and'),
        comp('o', 'outport'),
      ],
      wires: [
        wire('w1', ['in1', 'y'], ['g', 'a']),
        wire('w2', ['in2', 'y'], ['g', 'b']),
        wire('w3', ['g', 'y'], ['o', 'a']),
      ],
    });
    const c = compile(b, lib());
    expect(c.primitives.map((p) => p.kind)).toEqual(['and']);
    const g = c.primitives[0]!;
    expect(c.pathToNet.get('main/in1.y')).toBe(g.inputs[0]);
    expect(c.pathToNet.get('main/o.a')).toBe(g.outputs[0]);
  });

  it('allows two In ports sharing one net (the packaging repro)', () => {
    const b = board({
      components: [comp('in1', 'inport'), comp('in2', 'inport'), comp('g', 'and')],
      wires: [wire('w1', ['in1', 'y'], ['g', 'a']), wire('w2', ['in2', 'y'], ['g', 'a'])],
    });
    expect(() => compile(b, lib())).not.toThrow();
  });

  it('allows multiple tristate outputs sharing one net', () => {
    const b = board({
      components: [comp('t1', 'tristate'), comp('t2', 'tristate')],
      wires: [wire('w1', ['t1', 'y'], ['t2', 'y'])],
    });
    expect(() => compile(b, lib())).not.toThrow();
  });

  it('fails loudly on wires to unknown pins', () => {
    const b = board({
      components: [comp('g', 'not')],
      wires: [wire('w1', ['g', 'nope'], ['g', 'a'])],
    });
    expect(() => compile(b, lib())).toThrow(/unknown pin/);
  });
});

describe('netlabel (local net labels)', () => {
  const label = (id: string, name: string) => comp(id, 'netlabel', undefined, name);

  /** Net index a component's pin resolves to. Nets are addressed by index,
   *  not by a `<comp>.<pin>` path (only ports/probes/labels alias by name),
   *  so identity has to be read off the compiled primitive itself. */
  const netOf = (c: ReturnType<typeof compile>, componentId: string, pin: 'in' | 'out'): number => {
    const pi = c.componentToPrimitive.get(`main/${componentId}`);
    expect(pi).toBeDefined();
    const prim = c.primitives[pi!]!;
    const nets = pin === 'in' ? prim.inputs : prim.outputs;
    expect(nets.length).toBeGreaterThan(0);
    return nets[0]!;
  };

  it('joins two nets that share a label name, with no wire between them', () => {
    const b = board({
      components: [comp('sw', 'toggle'), label('L1', 'CLK'), label('L2', 'CLK'), comp('g', 'buf')],
      wires: [wire('w1', ['sw', 'y'], ['L1', 'a']), wire('w2', ['L2', 'a'], ['g', 'a'])],
    });
    const c = compile(b, new Map());
    expect(netOf(c, 'g', 'in')).toBe(netOf(c, 'sw', 'out'));
  });

  it('scopes the join to one circuit, so a def may reuse a board name', () => {
    const def = chipDef({
      id: 'd1',
      name: 'd1',
      pins: [pin('a', 'in', 'i1', 0), pin('y', 'out', 'o1', 0)],
      components: [
        comp('i1', 'inport'),
        comp('o1', 'outport'),
        label('L1', 'CLK'),
        comp('b1', 'buf'),
      ],
      wires: [wire('w1', ['i1', 'y'], ['b1', 'a']), wire('w2', ['b1', 'y'], ['o1', 'a'])],
    });
    const b = board({
      components: [
        comp('sw', 'toggle'),
        label('L2', 'CLK'),
        { id: 'u1', kind: 'chip', defId: 'd1', pos: { x: 0, y: 0 } },
      ],
      wires: [wire('w1', ['sw', 'y'], ['L2', 'a'])],
    });
    // The def's own CLK label is unwired inside; joining across the boundary
    // would be a hierarchy leak. Compiling at all is the assertion here.
    expect(() => compile(b, lib(def))).not.toThrow();
  });

  it('does not join two different names', () => {
    const b = board({
      components: [comp('sw', 'toggle'), label('L1', 'CLK'), label('L2', 'RST'), comp('g', 'buf')],
      wires: [wire('w1', ['sw', 'y'], ['L1', 'a']), wire('w2', ['L2', 'a'], ['g', 'a'])],
    });
    const c = compile(b, new Map());
    expect(netOf(c, 'g', 'in')).not.toBe(netOf(c, 'sw', 'out'));
  });

  it('joins nothing when the label has no name yet', () => {
    const b = board({
      components: [comp('sw', 'toggle'), label('L1', ''), label('L2', ''), comp('g', 'buf')],
      wires: [wire('w1', ['sw', 'y'], ['L1', 'a']), wire('w2', ['L2', 'a'], ['g', 'a'])],
    });
    const c = compile(b, new Map());
    expect(netOf(c, 'g', 'in')).not.toBe(netOf(c, 'sw', 'out'));
  });

  it('takes the width of the net it lands on rather than declaring one', () => {
    const b = board({
      components: [
        comp('sw', 'toggle', { width: 4 }),
        label('L1', 'BUS'),
        label('L2', 'BUS'),
        comp('d', 'probe', { width: 4 }),
      ],
      wires: [wire('w1', ['sw', 'y'], ['L1', 'a']), wire('w2', ['L2', 'a'], ['d', 'a'])],
    });
    const c = compile(b, new Map());
    const net = netOf(c, 'sw', 'out');
    expect(c.nets[net]!.width).toBe(4);
    expect(netOf(c, 'd', 'in')).toBe(net);
  });

  it('works with the label declared before the wide pin it takes its width from', () => {
    const b = board({
      components: [
        label('L1', 'BUS'),
        label('L2', 'BUS'),
        comp('sw', 'toggle', { width: 4 }),
        comp('d', 'probe', { width: 4 }),
      ],
      wires: [wire('w1', ['sw', 'y'], ['L1', 'a']), wire('w2', ['L2', 'a'], ['d', 'a'])],
    });
    const c = compile(b, new Map());
    expect(c.nets[netOf(c, 'sw', 'out')]!.width).toBe(4);
  });

  it('emits no primitive of its own -- a label is neither driver nor sink', () => {
    const b = board({
      components: [comp('sw', 'toggle'), label('L1', 'A'), label('L2', 'A'), comp('g', 'buf')],
      wires: [wire('w1', ['sw', 'y'], ['L1', 'a']), wire('w2', ['L2', 'a'], ['g', 'a'])],
    });
    expect(compile(b, new Map()).primitives.some((p) => p.kind === 'netlabel')).toBe(false);
  });

  it('names the joined net, so it is addressable by the label the user typed', () => {
    const b = board({
      components: [comp('sw', 'toggle'), label('L1', 'CLK'), label('L2', 'CLK'), comp('g', 'buf')],
      wires: [wire('w1', ['sw', 'y'], ['L1', 'a']), wire('w2', ['L2', 'a'], ['g', 'a'])],
    });
    const c = compile(b, new Map());
    expect(c.pathToNet.get('main/CLK')).toBe(netOf(c, 'sw', 'out'));
  });

  it('raises the usual width error when two same-name labels disagree', () => {
    const b = board({
      components: [
        comp('sw', 'toggle', { width: 4 }),
        comp('d', 'probe', { width: 1 }),
        label('L1', 'BUS'),
        label('L2', 'BUS'),
      ],
      wires: [wire('w1', ['sw', 'y'], ['L1', 'a']), wire('w2', ['d', 'a'], ['L2', 'a'])],
    });
    expect(() => compile(b, new Map())).toThrow(CompileError);
  });
});
