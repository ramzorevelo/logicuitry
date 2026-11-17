import type { Board, ChipDef } from '../../core/model/types';
import { parseDocument, serializeDocument } from '../../io/library';
import type { DocFile } from '../../io/platform';
import type { Session, SessionChipTab } from '../../io/sessionStore';
import {
  sameDefIgnoringVersion,
  useCircuitStore,
  type Tab,
} from '../workbench-circuit/circuitStore';
import { chipSourceOf, rememberChipSource } from './chipSave';

interface ChipTabState {
  tabs: readonly Tab[];
  activeTabId: string;
  chipLib: ReadonlyMap<string, ChipDef>;
}

/** The open chip tabs as the session keeps them. */
export function chipTabsOf(
  s: ChipTabState,
  fileOf: (defId: string) => DocFile | undefined,
): Pick<Session, 'chipTabs' | 'activeChipTab'> {
  const chipTabs: SessionChipTab[] = [];
  let active: number | undefined;
  for (const tab of s.tabs) {
    if (tab.kind !== 'def') continue;
    const def = s.chipLib.get(tab.defId);
    if (!def) continue;
    if (tab.id === s.activeTabId) active = chipTabs.length;
    const file = fileOf(tab.defId);
    chipTabs.push({
      def,
      saved: tab.saved,
      prefix: tab.prefix,
      breadcrumb: tab.breadcrumb,
      ...(file ? { file } : {}),
    });
  }
  return { chipTabs, ...(active === undefined ? {} : { activeChipTab: active }) };
}

export function openChipFileOf(defId: string): DocFile | undefined {
  const source = chipSourceOf(defId);
  return source?.kind === 'file' ? source.file : undefined;
}

/** A tab opened from a part on the board names that part first in its prefix. */
function partStillThere(board: Board, prefix: string): boolean {
  if (!prefix.startsWith('main/')) return true;
  const colon = prefix.indexOf(':');
  const id = prefix.slice('main/'.length, colon < 0 ? undefined : colon);
  return board.components.some((c) => c.id === id);
}

/** Through the file pipeline, like any document: a stored session is never trusted as is. */
function chipOf(raw: ChipDef): ChipDef | undefined {
  try {
    const doc = parseDocument(serializeDocument(raw));
    return doc.format === 'lcir.chip' ? doc : undefined;
  } catch {
    return undefined;
  }
}

/** Reopens the session's chip tabs over the restored board; one that no longer fits is skipped. */
export function restoreChipTabs(session: Session): void {
  const st = useCircuitStore.getState;
  const opened: (string | undefined)[] = [];
  for (const raw of session.chipTabs ?? []) {
    const def = chipOf(raw.def);
    const saved = chipOf(raw.saved);
    const unsaved = !!def && !!saved && !sameDefIgnoringVersion(def, saved);
    const have = def && st().chipLib.get(def.id);
    // A clean tab takes the library's copy, which may be newer than the session's.
    const loaded =
      !!def &&
      !!saved &&
      partStillThere(st().board, raw.prefix) &&
      ((have && (!unsaved || sameDefIgnoringVersion(have, def))) || st().loadChipDefs([def]).ok);
    if (!loaded) {
      opened.push(undefined);
      continue;
    }
    st().openDefTab(def.id, raw.prefix, raw.breadcrumb);
    if (unsaved) st().markChipSaved(def.id, saved);
    else st().markChipSaved(def.id);
    if (raw.file) rememberChipSource(def.id, { kind: 'file', file: raw.file });
    opened.push(st().activeTabId);
  }
  const front = session.activeChipTab === undefined ? undefined : opened[session.activeChipTab];
  st().setActiveTab(front ?? 'board');
}

/** Library defs that would overwrite a chip tab's unsaved edits stay out of a library load. */
export function withoutUnsavedTabs(defs: readonly ChipDef[]): ChipDef[] {
  const st = useCircuitStore.getState();
  const unsaved = new Set(
    st.tabs.flatMap((t) => (t.kind === 'def' && st.chipTabDirty(t.id) ? [t.defId] : [])),
  );
  return defs.filter((d) => !unsaved.has(d.id));
}
