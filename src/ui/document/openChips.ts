import type { ChipDef } from '../../core/model/types';
import { docFileWritable } from '../../io/fsAccess';
import { rememberRecentBoard } from '../../io/boardFile';
import type { DocFile } from '../../io/platform';
import { useCircuitStore } from '../workbench-circuit/circuitStore';
import { rememberChipSource } from './chipSave';

export interface PickedChip {
  def: ChipDef;
  file: DocFile;
}

/**
 * Opens chip files as tabs, loaded in one batch so a chip that uses another
 * opens whatever order the files were picked in. Returns the names opened;
 * reasons for the rest go into `failed`.
 */
export function openChipFiles(picked: readonly PickedChip[], failed: string[]): string[] {
  const store = useCircuitStore;
  const st = store.getState();
  const unsaved = (id: string) =>
    st.tabs.some((t) => t.kind === 'def' && t.defId === id && st.chipTabDirty(t.id));
  const seen = new Set<string>();
  const ready = picked.filter(({ def, file }) => {
    if (seen.has(def.id)) {
      failed.push(`${file.name}: another picked file already holds chip ${def.id}`);
      return false;
    }
    seen.add(def.id);
    if (!unsaved(def.id)) return true;
    failed.push(`${def.name} has unsaved edits in its tab; save or close it first`);
    return false;
  });
  if (ready.length === 0) return [];
  const accepted = loadAcceptable(ready, failed);
  if (accepted.length === 0) return [];
  for (const { def, file } of accepted) {
    // Same flow as double-clicking an instance. The board tab is untouched; Save
    // follows whichever tab is in front.
    store.getState().openDefTab(def.id, `${def.id}/`, def.name);
    store.getState().markChipSaved(def.id);
    // Kept even for a read-only upload: the save routing is what tells the two apart.
    rememberChipSource(def.id, { kind: 'file', file });
    if (!docFileWritable(file)) continue;
    void rememberRecentBoard({ name: file.name, file, openedAt: Date.now() }).catch(() => {
      // Convenience only.
    });
  }
  return accepted.map((p) => p.def.name);
}

/** The whole batch at once, else one by one so a cyclic chip is reported and the rest still load. */
function loadAcceptable(ready: readonly PickedChip[], failed: string[]): PickedChip[] {
  const st = useCircuitStore.getState();
  if (st.loadChipDefs(ready.map((p) => p.def)).ok) return [...ready];
  const accepted: PickedChip[] = [];
  for (const p of ready) {
    const result = st.loadChipDefs([...accepted, p].map((q) => q.def));
    if (result.ok) accepted.push(p);
    else failed.push(`${p.def.name}: ${result.error}`);
  }
  return accepted;
}

/** One chip file, reporting a refusal on the notice strip. */
export function openChipFile(def: ChipDef, file: DocFile): void {
  const failed: string[] = [];
  openChipFiles([{ def, file }], failed);
  if (failed.length > 0) useCircuitStore.setState({ error: `open: ${failed.join('; ')}` });
}
