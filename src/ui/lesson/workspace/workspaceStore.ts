import { create } from 'zustand';
import {
  areasOf,
  parseStoredLayout,
  presetLayout,
  resetSplit,
  resizeSplit,
  setAreaView,
  viewLabel,
  type LayoutNode,
  type NodePath,
  type PresetId,
  type ViewId,
} from './workspaceLayout';

const STORAGE_KEY = 'logicuitry.lessonWorkspace';
const STORAGE_VERSION = 1;

interface Stored {
  v: number;
  layouts: Partial<Record<PresetId, unknown>>;
}

/** Per-viewer convenience only: storage can be missing or throw, and the preset is always fine. */
function loadLayout(preset: PresetId): LayoutNode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return presetLayout(preset);
    const stored = JSON.parse(raw) as Stored;
    if (stored?.v !== STORAGE_VERSION) return presetLayout(preset);
    return parseStoredLayout(stored.layouts?.[preset], preset) ?? presetLayout(preset);
  } catch {
    return presetLayout(preset);
  }
}

function saveLayouts(layouts: Record<PresetId, LayoutNode>): void {
  try {
    const stored: Stored = { v: STORAGE_VERSION, layouts };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Private window or blocked storage: the layout simply is not remembered.
  }
}

export interface WorkspaceState {
  preset: PresetId;
  layouts: Record<PresetId, LayoutNode>;
  /** Never persisted: a reload or reopen always starts with the whole layout. */
  maxArea: string | null;
  narrow: boolean;
  /** The one area on show while narrow; null shows the Board's area. */
  narrowArea: string | null;
  hoverArea: string | null;
  focusArea: string | null;
  /** Read by a polite live region. */
  announce: string;

  setView(areaId: string, view: ViewId): void;
  /** `base` is the layout a drag started from; the delta is measured from there. */
  resize(path: NodePath, i: number, deltaPx: number, lengthPx: number, base?: LayoutNode): void;
  resetSplit(path: NodePath, i: number): void;
  resetLayout(): void;
  toggleMax(areaId?: string): void;
  restore(): void;
  pickNarrow(areaId: string): void;
  setNarrow(narrow: boolean): void;
  setHover(areaId: string | null): void;
  setFocus(areaId: string | null): void;
  /** Whether the view is on screen now, given maximise and the narrow strip. */
  shown(view: ViewId): boolean;
}

export const currentLayout = (s: Pick<WorkspaceState, 'preset' | 'layouts'>): LayoutNode =>
  s.layouts[s.preset];

export const areaShowing = (
  s: Pick<WorkspaceState, 'preset' | 'layouts'>,
  view: ViewId,
): string | undefined => areasOf(currentLayout(s)).find((a) => a.view === view)?.id;

/** The single area on show while narrow. */
export const narrowShownArea = (
  s: Pick<WorkspaceState, 'preset' | 'layouts' | 'narrowArea'>,
): string | undefined => {
  const ids = areasOf(currentLayout(s)).map((a) => a.id);
  return s.narrowArea && ids.includes(s.narrowArea) ? s.narrowArea : areaShowing(s, 'board');
};

export const useWorkspaceStore = create<WorkspaceState>()((set, get) => {
  const commit = (layout: LayoutNode, extra: Partial<WorkspaceState> = {}) => {
    const s = get();
    if (layout === currentLayout(s) && Object.keys(extra).length === 0) return;
    const layouts = { ...s.layouts, [s.preset]: layout };
    saveLayouts(layouts);
    set({ layouts, ...extra });
  };
  const viewIn = (areaId: string): ViewId | undefined =>
    areasOf(currentLayout(get())).find((a) => a.id === areaId)?.view;

  return {
    preset: 'write',
    layouts: { write: loadLayout('write') },
    maxArea: null,
    narrow: false,
    narrowArea: null,
    hoverArea: null,
    focusArea: null,
    announce: '',

    setView(areaId, view) {
      const before = currentLayout(get());
      const was = viewIn(areaId);
      const next = setAreaView(before, areaId, view);
      if (next === before || !was) return;
      commit(next, { announce: `${viewLabel(view)} and ${viewLabel(was)} swapped areas.` });
    },
    resize(path, i, deltaPx, lengthPx, base) {
      commit(resizeSplit(base ?? currentLayout(get()), path, i, deltaPx, lengthPx));
    },
    resetSplit(path, i) {
      const s = get();
      commit(resetSplit(currentLayout(s), s.preset, path, i));
    },
    resetLayout() {
      commit(presetLayout(get().preset), {
        maxArea: null,
        narrowArea: null,
        announce: 'Layout reset.',
      });
    },
    toggleMax(areaId) {
      const s = get();
      if (s.narrow) return;
      if (s.maxArea) {
        s.restore();
        return;
      }
      const ids = areasOf(currentLayout(s)).map((a) => a.id);
      const id = [areaId, s.hoverArea, s.focusArea, areaShowing(s, 'board')].find(
        (x): x is string => !!x && ids.includes(x),
      );
      if (!id) return;
      set({
        maxArea: id,
        announce: `${viewLabel(viewIn(id)!)} area maximised. Ctrl+Space or Esc restores.`,
      });
    },
    restore() {
      if (!get().maxArea) return;
      set({ maxArea: null, announce: 'Layout restored.' });
    },
    pickNarrow(areaId) {
      set({ narrowArea: areaId });
    },
    setNarrow(narrow) {
      if (get().narrow === narrow) return;
      set(narrow ? { narrow, maxArea: null } : { narrow });
    },
    setHover(areaId) {
      if (get().hoverArea !== areaId) set({ hoverArea: areaId });
    },
    setFocus(areaId) {
      if (get().focusArea !== areaId) set({ focusArea: areaId });
    },
    shown(view) {
      const s = get();
      const id = areaShowing(s, view);
      if (!id) return false;
      if (s.narrow) return narrowShownArea(s) === id;
      return s.maxArea === null || s.maxArea === id;
    },
  };
});
