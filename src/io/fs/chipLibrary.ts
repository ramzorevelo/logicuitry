// The chips/ folder walk, shared by both file backends: the rules are ours,
// not the platform's, so they must not be written twice and drift.

import type { ChipDef } from '../../core/model/types';
import type { LibraryDoc } from '../library';
import type { LibraryDir } from '../platform';

export interface ChipLibraryReader {
  listFiles(root: LibraryDir, sub: 'chips'): Promise<string[]>;
  readDoc(root: LibraryDir, sub: 'chips', name: string): Promise<LibraryDoc>;
}

/**
 * Every chip def in the library's `chips/` folder. A missing folder is an
 * empty library, not an error (a fresh library folder has no subdirs yet),
 * and one unreadable file is skipped rather than failing the whole load --
 * a single hand-edited JSON must not cost the instructor every other chip.
 */
export async function loadChipLibraryWith(
  fs: ChipLibraryReader,
  root: LibraryDir,
): Promise<{ chips: ChipDef[]; skipped: string[] }> {
  let names: string[];
  try {
    names = await fs.listFiles(root, 'chips');
  } catch {
    return { chips: [], skipped: [] };
  }
  const chips: ChipDef[] = [];
  const skipped: string[] = [];
  for (const name of names) {
    try {
      const doc = await fs.readDoc(root, 'chips', name);
      if (doc.format === 'lcir.chip') chips.push(doc);
      else skipped.push(name);
    } catch {
      skipped.push(name);
    }
  }
  return { chips, skipped };
}
