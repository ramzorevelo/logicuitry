import { describe, expect, it } from 'vitest';
import { hasPrimitive } from '../../core/sim/primitives/registry';
import { builtinChipLibrary, isBuiltinChipDef, packageEntries } from '../../core/parts/packages';
import { buildLocalGeometry, primitivePins, symbolBounds } from '../../render/glyphs/symbol';
// Side-effect imports: glyph geometry registers at module load.
import '../../render/glyphs/gates';
import '../../render/glyphs/chip';
import '../../render/glyphs/io';
import '../../render/glyphs/power';
import type { Theme } from '../../render/theme';
import { makeTestTheme } from '../../render/theme.fixture';
import {
  PALETTE,
  PALETTE_CHIP_IDS,
  PALETTE_GROUPS,
  PART_SUBGROUPS,
  findAliases,
  matchesFind,
  partCaption,
  partRows,
} from './palette';

const theme: Theme = makeTestTheme();

describe('PALETTE', () => {
  it('every entry is a registered sim primitive with glyph geometry', () => {
    for (const item of PALETTE.filter((i) => !i.defId)) {
      expect(hasPrimitive(item.kind), `primitive '${item.kind}'`).toBe(true);
      const geo = buildLocalGeometry(
        {
          kind: item.kind,
          params: item.params ?? {},
          pins: primitivePins(item.kind, item.params ?? {}),
        },
        theme,
      );
      expect(geo.bounds.w).toBeGreaterThan(0);
      expect(geo.pins.size).toBeGreaterThan(0);
    }
  });

  it('every chip entry places a built-in def with pins', () => {
    const lib = builtinChipLibrary();
    for (const item of PALETTE.filter((i) => i.defId)) {
      const def = lib.get(item.defId!);
      expect(def, item.label).toBeDefined();
      expect(item.kind).toBe('chip');
      expect(isBuiltinChipDef(def!)).toBe(true);
      const geo = symbolBounds(
        { id: 'c', kind: 'chip', defId: def!.id, pos: { x: 0, y: 0 } },
        theme,
        def,
      );
      expect(geo.pins.size, item.label).toBe(def!.pins.length);
    }
  });

  it('every entry lands in a rendered group, and every group has entries', () => {
    for (const item of PALETTE) expect(PALETTE_GROUPS, item.label).toContain(item.group);
    for (const group of PALETTE_GROUPS)
      expect(PALETTE.filter((i) => i.group === group).length, group).toBeGreaterThan(0);
  });

  it('keeps every entry unique by label, since the rail keys on it', () => {
    expect(new Set(PALETTE.map((i) => i.label)).size).toBe(PALETTE.length);
  });

  it('puts Arithmetic between Combinational and Sequential with its four blocks', () => {
    expect(PALETTE_GROUPS).toEqual([
      'Inputs',
      'Outputs',
      'Gates',
      'Combinational',
      'Arithmetic',
      'Sequential',
      'Wiring',
    ]);
    expect(PALETTE.filter((i) => i.group === 'Arithmetic').map((i) => i.label)).toEqual([
      'Half adder',
      'Full adder',
      'Adder',
      'Comparator',
    ]);
    expect([...PALETTE_CHIP_IDS]).toEqual(['half-adder', 'full-adder']);
  });

  it('lists the six Sequential blocks in course order', () => {
    expect(PALETTE.filter((i) => i.group === 'Sequential').map((i) => i.label)).toEqual([
      'SR latch',
      'D latch',
      'DFF',
      'Register',
      'Counter',
      'Shift reg',
    ]);
  });

  it('never lists the hidden parity core', () => {
    expect(PALETTE.some((i) => i.kind === 'parity')).toBe(false);
  });
});

describe('74 series sub-headings', () => {
  const parts = [...builtinChipLibrary().values()].filter(
    (d) => isBuiltinChipDef(d) && !PALETTE_CHIP_IDS.has(d.id),
  );

  it('gives every package a known sub-heading and a caption', () => {
    for (const entry of packageEntries()) {
      expect(PART_SUBGROUPS, entry.part).toContain(entry.group);
      expect(entry.caption, entry.part).toBeTruthy();
    }
  });

  it('lists the 27 parts under seven sub-headings in part-number order', () => {
    const rows = partRows(parts);
    expect(rows.map((r) => r.sub)).toEqual([...PART_SUBGROUPS]);
    expect(Object.fromEntries(rows.map((r) => [r.sub, r.defs.map((d) => d.id.slice(4))]))).toEqual({
      Gates: ['00', '02', '04', '08', '32', '86'],
      'Decoders and encoders': ['138', '139', '148', '154'],
      Multiplexers: ['151', '153', '157'],
      Display: ['47', '48'],
      Arithmetic: ['85', '280', '283'],
      'Flip-flops and registers': ['74', '175', '273', '374', '377'],
      'Counters and shift registers': ['161', '163', '164', '165'],
    });
  });

  it('leaves out a part whose built-in is shadowed', () => {
    const rows = partRows(parts.filter((d) => d.id !== '74LS138'));
    expect(rows.flatMap((r) => r.defs.map((d) => d.id))).not.toContain('74LS138');
  });

  it('captions a part from its package entry', () => {
    expect(partCaption(builtinChipLibrary().get('74LS138')!)).toBe('3-to-8 decoder');
    expect(partCaption(builtinChipLibrary().get('half-adder')!)).toBeUndefined();
  });
});

describe('matchesFind', () => {
  const blockHits = (q: string) =>
    PALETTE.filter((i) => matchesFind(q, i.label, i.defId, ...findAliases(i.label))).map(
      (i) => i.label,
    );
  const partHits = (q: string) =>
    packageEntries()
      .filter((e) => matchesFind(q, e.part, e.caption))
      .map((e) => e.part)
      .sort();

  it('matches on part number', () => {
    expect(blockHits('138')).toEqual([]);
    expect(partHits('138')).toEqual(['74LS138']);
  });

  it('matches label and caption, ignoring case', () => {
    expect(blockHits('mux')).toEqual(['MUX', 'DEMUX']);
    expect(partHits('MUX')).toEqual(['74LS151', '74LS153', '74LS157']);
    expect(blockHits('counter')).toEqual(['Counter']);
    expect(partHits('counter')).toEqual(['74LS161', '74LS163']);
  });

  it("finds a part in the course's '138 notation", () => {
    expect(partHits("'138")).toEqual(['74LS138']);
    expect(partHits('’138')).toEqual(['74LS138']);
    expect(partHits("74LS'00")).toEqual(['74LS00']);
  });

  it('finds a block under the name it is also called by', () => {
    expect(blockHits('flip-flop')).toEqual(['DFF']);
    expect(blockHits('d flip')).toEqual(['DFF']);
    expect(blockHits('register')).toEqual(['Register', 'Shift reg']);
    expect(blockHits('multiplexer')).toEqual(['MUX', 'DEMUX']);
  });

  it('finds a part typed without its family letters or with spaces', () => {
    expect(partHits('7400')).toEqual(['74LS00']);
    expect(partHits('LS 138')).toEqual(['74LS138']);
    expect(partHits('74 ls 00')).toEqual(['74LS00']);
  });

  it('treats a blank query as matching everything, and trims it', () => {
    expect(matchesFind('', 'AND')).toBe(true);
    expect(matchesFind('   ', 'AND')).toBe(true);
    expect(matchesFind(' and ', 'NAND')).toBe(true);
    expect(matchesFind('zzz', 'AND', undefined)).toBe(false);
  });
});
