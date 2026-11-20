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
  const dropped: string[] = [];
  for (const raw of session.chipTabs ?? []) {
    const def = chipOf(raw.def);
    const saved = chipOf(raw.saved);
    const unsaved = !!def && !!saved && !sameDefIgnoringVersion(def, saved);
    const have = def && st().chipLib.get(def.id);
    // The library copy is the file's newest state: edits made on an older base are not replayed over it.
    const moved =
      unsaved &&
      have !== undefined &&
      !sameDefIgnoringVersion(have, saved) &&
      !sameDefIgnoringVersion(have, def);
    const restoreEdits = unsaved && !moved;
    // A clean tab takes the library's copy, which may be newer than the session's.
    const loaded =
      !!def &&
      !!saved &&
      partStillThere(st().board, raw.prefix) &&
      ((have && (!restoreEdits || sameDefIgnoringVersion(have, def))) ||
        st().loadChipDefs([def]).ok);
    if (!loaded) {
      opened.push(undefined);
      continue;
    }
    if (moved) dropped.push(def.name);
    st().openDefTab(def.id, raw.prefix, raw.breadcrumb);
    if (restoreEdits) st().markChipSaved(def.id, saved);
    else st().markChipSaved(def.id);
    if (raw.file) rememberChipSource(def.id, { kind: 'file', file: raw.file });
    opened.push(st().activeTabId);
  }
  const front = session.activeChipTab === undefined ? undefined : opened[session.activeChipTab];
  st().setActiveTab(front ?? 'board');
  if (dropped.length > 0) noticeDroppedEdits(dropped);
}

function noticeDroppedEdits(names: readonly string[]): void {
  useCircuitStore.setState({
    error: `open: ${names.join(', ')}: unsaved edits from last session were dropped because the file changed since`,
  });
}

/** Dirty chip tabs paired with their chip ids. */
function dirtyChipTabs(): { defId: string; saved: ChipDef }[] {
  const st = useCircuitStore.getState();
  return st.tabs.flatMap((t) =>
    t.kind === 'def' && st.chipTabDirty(t.id) ? [{ defId: t.defId, saved: t.saved }] : [],
  );
}

/** A library load never overwrites a chip tab's unsaved edits in this session. */
export function withoutUnsavedTabs(defs: readonly ChipDef[]): ChipDef[] {
  const dirty = new Set(dirtyChipTabs().map((t) => t.defId));
  return defs.filter((d) => !dirty.has(d.id));
}

/** Names of chips whose unsaved tab edits sit beside a library file that differs from the tab's base. */
export function chipsDivergedFromLibrary(defs: readonly ChipDef[]): string[] {
  const incoming = new Map(defs.map((d) => [d.id, d]));
  return dirtyChipTabs().flatMap((t) => {
    const d = incoming.get(t.defId);
    return d && !sameDefIgnoringVersion(d, t.saved) ? [d.name] : [];
  });
}
