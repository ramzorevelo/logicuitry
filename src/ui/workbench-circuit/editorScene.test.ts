import { describe, expect, it } from 'vitest';
import type { ChipDef, ChipLibrary, Component } from '../../core/model/types';
import { builtinChipLibrary } from '../../core/parts/packages';
import { makeTestTheme } from '../../render/theme.fixture';
import type { SignalState } from '../../render/theme';
import { glyphKey } from './editorScene';
import '../../core/sim/primitives/registry';

const theme = makeTestTheme();
const def = [...builtinChipLibrary().values()].find((d) => d.appearance?.package)!;
const chip: Component = { id: 'u1', kind: 'chip', defId: def.id, pos: { x: 0, y: 0 } };
const ctx = (
  lib: ChipLibrary,
  pinSignal: (id: string, pin: string) => SignalState | undefined,
) => ({
  chipLib: lib,
  pinSignal,
});
const idle = () => undefined;

describe('glyphKey for chip instances', () => {
  it('is stable while the def object is the same', () => {
    const lib = new Map([[def.id, def]]);
    expect(glyphKey(chip, theme, ctx(lib, idle))).toBe(glyphKey(chip, theme, ctx(lib, idle)));
  });

  it('changes when an edit replaces the def under the same id', () => {
    const before = glyphKey(chip, theme, ctx(new Map([[def.id, def]]), idle));
    const edited: ChipDef = { ...def, name: `${def.name} rev` };
    expect(glyphKey(chip, theme, ctx(new Map([[def.id, edited]]), idle))).not.toBe(before);
  });

  it('follows the live state of the def pins', () => {
    const lib = new Map([[def.id, def]]);
    const pin = def.pins[0]!.name;
    const lit = (_: string, p: string): SignalState | undefined => (p === pin ? '1' : undefined);
    expect(glyphKey(chip, theme, ctx(lib, lit))).not.toBe(glyphKey(chip, theme, ctx(lib, idle)));
  });

  it('differs between a missing def and a loaded one', () => {
    const missing = glyphKey(chip, theme, ctx(new Map(), idle));
    expect(glyphKey(chip, theme, ctx(new Map([[def.id, def]]), idle))).not.toBe(missing);
  });
});
