import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChipDef } from '../../core/model/types';
import type { DocFile, LibraryDir } from '../../io/platform';
import { PermissionLapsedError } from '../../io/fsAccess';
import { CURRENT_VERSION } from '../../io/migrations';
import { useCircuitStore } from '../workbench-circuit/circuitStore';
import { unsavedDetail } from './useBoardDocument';
import {
  chipFileName,
  chipSaveRoute,
  chipSourceOf,
  rememberChipSource,
  saveChip,
  type ChipSaveIo,
} from './chipSave';

const pins = [
  { name: 'AIR', dir: 'in', width: 1, boundComponent: 'air' },
  { name: 'SAFE', dir: 'out', width: 1, boundComponent: 'safe' },
] as unknown as ChipDef['pins'];

let n = 0;
const chip = (version = 3): ChipDef => ({
  format: 'lcir.chip',
  formatVersion: 8,
  id: `lcst-mixtank-p4-interlock-${++n}`,
  name: 'P4 interlock',
  version,
  pins,
  components: [],
  wires: [],
  junctions: [],
});

const handle = (name: string): DocFile => ({ name });
const upload = (name: string): DocFile => new File(['{}'], name);
const dir: LibraryDir = { name: 'library' };

function fakeIo(opts: { pickers?: boolean; picked?: DocFile } = {}) {
  const written: { file: DocFile; doc: ChipDef }[] = [];
  const library: { dir: LibraryDir; name: string; doc: ChipDef }[] = [];
  const downloads: { name: string; doc: ChipDef }[] = [];
  const picks: string[] = [];
  const io: ChipSaveIo = {
    pickersSupported: () => opts.pickers ?? true,
    writable: (f) => !(f instanceof File),
    writeFile: async (file, text) => {
      written.push({ file, doc: JSON.parse(text) as ChipDef });
    },
    writeLibrary: async (d, name, doc) => {
      library.push({ dir: d, name, doc });
    },
    pickSavePath: async (name) => {
      picks.push(name);
      return opts.picked;
    },
    download: (doc, name) => downloads.push({ name, doc }),
  };
  return { io, written, library, downloads, picks };
}

describe('chipSaveRoute', () => {
  const io = (pickers: boolean) => ({
    pickersSupported: () => pickers,
    writable: (f: DocFile) => !(f instanceof File),
  });

  it('writes back to a writable handle', () => {
    expect(chipSaveRoute({ kind: 'file', file: handle('a.lcirc') }, io(true), false)).toBe('file');
  });

  it('asks where for a read-only upload, or downloads without a save picker', () => {
    const src = { kind: 'file', file: upload('a.lcirc') } as const;
    expect(chipSaveRoute(src, io(true), false)).toBe('pick');
    expect(chipSaveRoute(src, io(false), false)).toBe('download');
  });

  it('asks where for a chip with no file at all', () => {
    expect(chipSaveRoute(undefined, io(true), false)).toBe('pick');
    expect(chipSaveRoute(undefined, io(false), false)).toBe('download');
  });

  it('writes a library chip back into the library', () => {
    expect(chipSaveRoute({ kind: 'library', dir, name: 'x.lcirc' }, io(true), false)).toBe(
      'library',
    );
  });

  it('Save As always asks, even with a writable handle', () => {
    expect(chipSaveRoute({ kind: 'file', file: handle('a.lcirc') }, io(true), true)).toBe('pick');
  });
});

describe('saveChip', () => {
  it('writes to the opened file with the same id, pins and version, at the current format', async () => {
    const def = chip(4);
    const file = handle('p4-interlock.lcirc');
    rememberChipSource(def.id, { kind: 'file', file });
    const fake = fakeIo();
    expect(await saveChip(def, fake.io)).toEqual({
      kind: 'written',
      source: { kind: 'file', file },
    });
    expect(fake.written).toHaveLength(1);
    const doc = fake.written[0]!.doc;
    expect(fake.written[0]!.file).toBe(file);
    expect(doc.id).toBe(def.id);
    expect(doc.version).toBe(4);
    expect(doc.pins).toEqual(pins);
    expect(doc.formatVersion).toBe(CURRENT_VERSION['lcir.chip']);
  });

  it('saving twice stays one file with one id', async () => {
    const def = chip(2);
    const file = handle('p4.lcirc');
    rememberChipSource(def.id, { kind: 'file', file });
    const fake = fakeIo();
    await saveChip(def, fake.io);
    await saveChip({ ...def, version: 3 }, fake.io);
    expect(fake.written.map((w) => [w.file, w.doc.id, w.doc.version])).toEqual([
      [file, def.id, 2],
      [file, def.id, 3],
    ]);
    expect(fake.picks).toEqual([]);
  });

  it('an upload asks where, suggesting <id>.lcirc, and then writes there next time', async () => {
    const def = chip();
    rememberChipSource(def.id, { kind: 'file', file: upload('starter.lcirc') });
    const picked = handle('chosen.lcirc');
    const fake = fakeIo({ picked });
    await saveChip(def, fake.io);
    expect(fake.picks).toEqual([`${def.id}.lcirc`]);
    expect(fake.written[0]!.file).toBe(picked);
    expect(chipSourceOf(def.id)).toEqual({ kind: 'file', file: picked });
    await saveChip(def, fake.io);
    expect(fake.picks).toHaveLength(1);
  });

  it('an upload without a save picker downloads <id>.lcirc, id unchanged', async () => {
    const def = chip();
    rememberChipSource(def.id, { kind: 'file', file: upload('starter.lcirc') });
    const fake = fakeIo({ pickers: false });
    expect(await saveChip(def, fake.io)).toEqual({ kind: 'downloaded' });
    expect(fake.downloads.map((d) => [d.name, d.doc.id])).toEqual([[chipFileName(def), def.id]]);
  });

  it('a dismissed picker saves nothing', async () => {
    const def = chip();
    const fake = fakeIo();
    expect(await saveChip(def, fake.io)).toEqual({ kind: 'cancelled' });
    expect(fake.written).toEqual([]);
  });

  it('a library chip saves under its own file name', async () => {
    const def = chip();
    rememberChipSource(def.id, { kind: 'library', dir, name: 'renamed.lcirc' });
    const fake = fakeIo();
    await saveChip(def, fake.io);
    expect(fake.library.map((l) => [l.dir, l.name, l.doc.id])).toEqual([
      [dir, 'renamed.lcirc', def.id],
    ]);
  });

  it('a lapsed permission falls back to the picker', async () => {
    const def = chip();
    const file = handle('old.lcirc');
    rememberChipSource(def.id, { kind: 'file', file });
    const picked = handle('new.lcirc');
    const fake = fakeIo({ picked });
    const write = vi
      .fn()
      .mockRejectedValueOnce(new PermissionLapsedError())
      .mockResolvedValue(undefined);
    await saveChip(def, { ...fake.io, writeFile: write });
    expect(write.mock.calls.map((c) => c[0])).toEqual([file, picked]);
  });
});

describe('chip tab dirty mark', () => {
  const def: ChipDef = {
    format: 'lcir.chip',
    formatVersion: 8,
    id: 'mine',
    name: 'mine',
    version: 1,
    pins: [],
    components: [],
    wires: [],
    junctions: [],
  };

  beforeEach(() => {
    const s = useCircuitStore.getState();
    s.loadBoard({ ...s.board, components: [], wires: [], junctions: [] });
    s.commitNewChip(structuredClone(def));
    s.openDefTab('mine', 'mine/', 'mine');
  });

  it('goes dirty on an edit and clean once saved, carrying the bumped version', () => {
    const tabId = useCircuitStore.getState().activeTabId;
    expect(useCircuitStore.getState().chipTabDirty(tabId)).toBe(false);
    useCircuitStore.getState().place('not', { x: 200, y: 200 }, 8);
    expect(useCircuitStore.getState().chipTabDirty(tabId)).toBe(true);
    expect(useCircuitStore.getState().chipLib.get('mine')!.version).toBeGreaterThan(1);
    useCircuitStore.getState().markChipSaved('mine');
    expect(useCircuitStore.getState().chipTabDirty(tabId)).toBe(false);
    expect(useCircuitStore.getState().hasTabEdits()).toBe(false);
  });

  it('closes a saved tab without asking, and asks for an unsaved one', () => {
    const tabId = useCircuitStore.getState().activeTabId;
    useCircuitStore.getState().place('not', { x: 200, y: 200 }, 8);
    useCircuitStore.getState().closeTab(tabId);
    expect(useCircuitStore.getState().pendingTabClose).toBe(tabId);
    useCircuitStore.getState().cancelTabClose();
    useCircuitStore.getState().markChipSaved('mine');
    useCircuitStore.getState().closeTab(tabId);
    expect(useCircuitStore.getState().pendingTabClose).toBeNull();
    expect(useCircuitStore.getState().tabs.some((t) => t.id === tabId)).toBe(false);
  });

  it('Discard after a save goes back to what was saved, not to how the tab opened', () => {
    const tabId = useCircuitStore.getState().activeTabId;
    useCircuitStore.getState().place('not', { x: 200, y: 200 }, 8);
    useCircuitStore.getState().markChipSaved('mine');
    useCircuitStore.getState().place('and', { x: 400, y: 200 }, 8);
    useCircuitStore.getState().closeTab(tabId);
    useCircuitStore.getState().resolveTabClose('discard');
    const kinds = useCircuitStore
      .getState()
      .chipLib.get('mine')!
      .components.map((c) => c.kind);
    expect(kinds).toEqual(['not']);
  });

  it('marks the def that was written, so an edit made during the write stays unsaved', () => {
    const tabId = useCircuitStore.getState().activeTabId;
    const written = useCircuitStore.getState().chipLib.get('mine')!;
    useCircuitStore.getState().place('not', { x: 200, y: 200 }, 8);
    useCircuitStore.getState().markChipSaved('mine', written);
    expect(useCircuitStore.getState().chipTabDirty(tabId)).toBe(true);
  });

  it('the board tab is never a dirty chip', () => {
    expect(useCircuitStore.getState().chipTabDirty('board')).toBe(false);
  });
});

describe('unsavedDetail', () => {
  it('names what a replace would lose', () => {
    expect(unsavedDetail(true, false)).toBe('This board has unsaved changes.');
    expect(unsavedDetail(false, true)).toBe('An open chip has unsaved changes.');
    expect(unsavedDetail(true, true)).toBe('This board and an open chip have unsaved changes.');
  });
});
