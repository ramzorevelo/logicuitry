// loadChipLibrary against a fake directory handle: the real File System Access
// API needs a browser, but the folder-walking rules (missing subdir, a bad
// file, a non-chip document) are ours and must not depend on one.

import { describe, expect, it } from 'vitest';
import { loadChipLibrary } from './fsAccess';
import type { LibraryDir } from './platform';
import { serializeDocument } from './library';
import type { ChipDef } from '../core/model/types';

const chip = (id: string): ChipDef => ({
  format: 'lcir.chip',
  formatVersion: 3,
  id,
  name: id,
  version: 1,
  pins: [],
  components: [],
  wires: [],
  junctions: [],
});

/** Minimal stand-in: only the members fsAccess actually calls. */
function fakeRoot(files: Record<string, string> | null): LibraryDir {
  return {
    getDirectoryHandle: async (name: string) => {
      if (files === null || name !== 'chips') throw new Error('NotFoundError');
      return {
        [Symbol.asyncIterator]: async function* () {
          for (const key of Object.keys(files)) yield [key, { kind: 'file' }];
        },
        getFileHandle: async (fileName: string) => ({
          getFile: async () => ({ text: async () => files[fileName]! }),
        }),
      } as unknown as LibraryDir;
    },
  } as unknown as LibraryDir;
}

describe('loadChipLibrary', () => {
  it('reads every chip document in chips/', async () => {
    const root = fakeRoot({
      'a.lcirc': serializeDocument(chip('a')),
      'b.lcirc': serializeDocument(chip('b')),
    });
    const { chips, skipped } = await loadChipLibrary(root);
    expect(chips.map((c) => c.id)).toEqual(['a', 'b']);
    expect(skipped).toEqual([]);
  });

  it('treats a library with no chips/ folder as empty, not an error', async () => {
    await expect(loadChipLibrary(fakeRoot(null))).resolves.toEqual({ chips: [], skipped: [] });
  });

  it('skips an unreadable file instead of losing the whole library', async () => {
    const root = fakeRoot({
      'good.lcirc': serializeDocument(chip('good')),
      'broken.lcirc': '{ not json',
    });
    const { chips, skipped } = await loadChipLibrary(root);
    expect(chips.map((c) => c.id)).toEqual(['good']);
    expect(skipped).toEqual(['broken.lcirc']);
  });

  it('migrates an older chip on the way in', async () => {
    const v1 = {
      ...chip('legacy'),
      formatVersion: 1,
      components: [{ id: 'in1', kind: 'input', pos: { x: 0, y: 0 } }],
    };
    const { chips } = await loadChipLibrary(fakeRoot({ 'legacy.lcirc': JSON.stringify(v1) }));
    expect(chips[0]!.formatVersion).toBe(3);
    expect(chips[0]!.components[0]!.kind).toBe('inport');
  });
});
