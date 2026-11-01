import { describe, expect, it } from 'vitest';
import { toString } from '../value/busValue';
import { compile, CompileError } from './compile';
import type { Board, ChipDef, ChipLibrary } from './types';
import { board, chipComp, chipDef, comp, memChipDef, memWrapDef, wire } from './testFixtures';
import { Simulator } from '../sim/kernel';
import { idealDelay } from '../sim/delay';
import type { RamState } from '../sim/primitives/ram';
import { printPreload } from '../sim/primitives/ramPreload';

const libOf = (...defs: ChipDef[]): ChipLibrary => new Map(defs.map((d) => [d.id, d]));

/** Instances of `defId` labelled U1, U2, ... sharing one address switch `A`, each read on a probe. */
function placed(defId: string, contents: (Record<string, string> | undefined)[]): Board {
  return board({
    components: [
      comp('a', 'toggle', undefined, 'A'),
      ...contents.map((c, i) => chipComp(`u${i + 1}`, defId, `U${i + 1}`, c)),
      ...contents.map((_, i) => comp(`p${i + 1}`, 'probe', { width: 8 }, `P${i + 1}`)),
    ],
    wires: contents.flatMap((_, i) => [
      wire(`wa${i + 1}`, ['a', 'y'], [`u${i + 1}`, 'A']),
      wire(`wq${i + 1}`, [`u${i + 1}`, 'Q'], [`p${i + 1}`, 'a']),
    ]),
  });
}

function readAll(b: Board, lib: ChipLibrary, address: 0 | 1): string[] {
  const sim = new Simulator(compile(b, lib), idealDelay);
  sim.powerOn();
  sim.setToggle('main/A', address === 1);
  sim.settle();
  return b.components
    .filter((c) => c.kind === 'probe')
    .map((c) => toString(sim.netValueByPath(`main/${c.label!}`), 8));
}

function cellsAt(b: Board, lib: ChipLibrary, path: string): string {
  const compiled = compile(b, lib);
  const sim = new Simulator(compiled, idealDelay);
  sim.powerOn();
  const pi = compiled.pathToPrimitive.get(path);
  if (pi === undefined) throw new Error(`no primitive at ${path}`);
  return printPreload((sim.primitiveStateAt(pi) as RamState).cells, 8);
}

describe('chip instance contents', () => {
  it('gives two placed copies of one def their own programs', () => {
    const b = placed('mem', [{ r1: '11 22' }, { r1: 'AA' }]);
    const lib = libOf(memChipDef());
    expect(readAll(b, lib, 0)).toEqual(['00010001', '10101010']);
    expect(readAll(b, lib, 1)).toEqual(['00100010', 'XXXXXXXX']);
    expect(cellsAt(b, lib, 'main/U1:mem/r1')).toBe('11 22');
    expect(cellsAt(b, lib, 'main/U2:mem/r1')).toBe('AA');
  });

  it('leaves a copy without contents on the preload stored in the def', () => {
    const b = placed('mem', [undefined, { r1: 'AA' }]);
    expect(cellsAt(b, libOf(memChipDef()), 'main/U1:mem/r1')).toBe('01 02');
  });

  it('lets the outermost instance win over an inner preload and an inner instance', () => {
    const inner = { r1: '03' };
    const outer = placed('wrap', [{ 'M/r1': '04' }, undefined]);
    const lib = libOf(memChipDef(), memWrapDef(inner));
    expect(cellsAt(outer, lib, 'main/U1:wrap/M:mem/r1')).toBe('04');
    // No outer entry: the inner instance's contents beat the def's preload.
    expect(cellsAt(outer, lib, 'main/U2:wrap/M:mem/r1')).toBe('03');
    expect(cellsAt(outer, libOf(memChipDef(), memWrapDef()), 'main/U2:wrap/M:mem/r1')).toBe(
      '01 02',
    );
  });

  it('keys a RAM by label where it has one, matching the flattened path', () => {
    const labelled = memChipDef();
    labelled.components = labelled.components.map((c) =>
      c.id === 'r1' ? { ...c, label: 'MEM' } : c,
    );
    const b = placed('mem', [{ MEM: '0F', r1: '01' }]);
    const compiled = compile(b, libOf(labelled));
    expect(compiled.staleContents).toEqual([
      { instance: 'main/U1', instanceId: 'main/u1', key: 'r1', reason: 'missing' },
    ]);
    expect(cellsAt(b, libOf(labelled), 'main/U1:mem/MEM')).toBe('0F');
  });

  it('records on each nested RAM where the top level sets it', () => {
    const lib = libOf(memChipDef(), memWrapDef());
    const compiled = compile(placed('wrap', [undefined]), lib);
    const ram = compiled.primitives.find((p) => p.kind === 'ram')!;
    expect(ram.contentsSlot).toEqual({ instance: 'main/u1', key: 'M/r1' });
    const top = compile(board({ components: [comp('r', 'ram', { width: 8 })] }), lib);
    expect(top.primitives[0]!.contentsSlot).toBeUndefined();
  });

  it('reports a key that names no RAM and leaves the live keys alone', () => {
    const lib = libOf(memChipDef(), memWrapDef({ r1: '03', gone: '1' }));
    const b = placed('wrap', [{ 'M/r1': '04', 'M/old': '05', M: '06' }]);
    expect(compile(b, lib).staleContents).toEqual([
      { instance: 'main/U1', instanceId: 'main/u1', key: 'M/old', reason: 'missing' },
      { instance: 'main/U1', instanceId: 'main/u1', key: 'M', reason: 'missing' },
      { instance: 'main/U1:wrap/M', instanceId: 'main/U1:wrap/m1', key: 'gone', reason: 'missing' },
    ]);
  });

  it('keeps an entry too big for a RAM the def shrank and runs on the def preload', () => {
    const b = placed('mem', [{ r1: '1 2 3' }, { r1: '1FF' }]);
    const lib = libOf(memChipDef());
    expect(compile(b, lib).staleContents).toEqual([
      { instance: 'main/U1', instanceId: 'main/u1', key: 'r1', reason: 'misfit' },
      { instance: 'main/U2', instanceId: 'main/u2', key: 'r1', reason: 'misfit' },
    ]);
    expect(cellsAt(b, lib, 'main/U1:mem/r1')).toBe('01 02');
  });

  it('refuses at compile a malformed contents entry', () => {
    const b = placed('mem', [{ r1: '1 G' }]);
    expect(() => compile(b, libOf(memChipDef()))).toThrow(CompileError);
    expect(() => compile(b, libOf(memChipDef()))).toThrow(/RAM contents set on U1: /);
  });

  it('refuses a group and a chip of one name that hand two RAMs one key', () => {
    const clash = chipDef({
      id: 'clash',
      name: 'clash',
      pins: [],
      groups: [{ id: 'g1', name: 'M' }],
      components: [
        { ...comp('r1', 'ram', { width: 8, addressBits: 1 }), group: 'g1' },
        chipComp('m1', 'mem', 'M'),
      ],
    });
    const b = board({ components: [chipComp('u1', 'clash', 'U1')] });
    expect(() => compile(b, libOf(memChipDef(), clash))).toThrow(
      'contents key M/r1 on U1 names two RAMs',
    );
  });
});
