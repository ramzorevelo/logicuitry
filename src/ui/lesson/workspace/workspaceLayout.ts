/** A view an area can show. Each is shown by at most one area, since the board has one canvas. */
export type ViewId = 'steps' | 'board' | 'insp';
export type PresetId = 'write';
export type SplitDir = 'row' | 'col';

export interface AreaNode {
  id: string;
  view: ViewId;
}

export interface SplitNode {
  dir: SplitDir;
  /** Percent shares of the parent's length, one per kid, summing to 100. */
  sizes: number[];
  kids: LayoutNode[];
}

export type LayoutNode = AreaNode | SplitNode;

/** Dot-joined kid indices from the root; '' is the root itself. */
export type NodePath = string;

export const VIEWS: readonly { id: ViewId; label: string }[] = [
  { id: 'steps', label: 'Steps' },
  { id: 'board', label: 'Board' },
  { id: 'insp', label: 'Inspector' },
];

export const PRESETS: readonly { id: PresetId; label: string }[] = [
  { id: 'write', label: 'Write' },
];

export const MIN_AREA_PX = 160;
/** Smallest stored share accepted: 160 px of an 8K-wide body is 2.1%, so only true slivers go below it. */
export const MIN_STORED_SHARE_PCT = 1.5;
/** Below this body width the workspace shows one area at a time. */
export const NARROW_BELOW_PX = 1000;
/** One arrow-key press on a focused splitter, in percent of the parent. */
export const SPLIT_KEY_STEP = 2;

export const viewLabel = (view: ViewId): string => VIEWS.find((v) => v.id === view)?.label ?? view;

export const isArea = (n: LayoutNode): n is AreaNode => 'view' in n;

export function presetLayout(preset: PresetId): LayoutNode {
  switch (preset) {
    case 'write':
      return {
        dir: 'row',
        sizes: [19, 51, 30],
        kids: [
          { id: 'a1', view: 'steps' },
          { id: 'a2', view: 'board' },
          { id: 'a3', view: 'insp' },
        ],
      };
  }
}

export const isNarrow = (bodyWidth: number): boolean => bodyWidth < NARROW_BELOW_PX;

export function areasOf(n: LayoutNode): AreaNode[] {
  return isArea(n) ? [n] : n.kids.flatMap(areasOf);
}

export function nodeAt(root: LayoutNode, path: NodePath): LayoutNode | undefined {
  if (path === '') return root;
  let n: LayoutNode | undefined = root;
  for (const part of path.split('.')) {
    if (!n || isArea(n)) return undefined;
    n = n.kids[Number(part)];
  }
  return n;
}

function replaceAt(root: LayoutNode, path: NodePath, next: LayoutNode): LayoutNode {
  if (path === '') return next;
  if (isArea(root)) return root;
  const [head, ...rest] = path.split('.');
  const i = Number(head);
  return {
    ...root,
    kids: root.kids.map((k, j) => (j === i ? replaceAt(k, rest.join('.'), next) : k)),
  };
}

function mapAreas(n: LayoutNode, f: (a: AreaNode) => AreaNode): LayoutNode {
  return isArea(n) ? f(n) : { ...n, kids: n.kids.map((k) => mapAreas(k, f)) };
}

/**
 * Shows `view` in area `areaId`. If another area already shows it, that area takes the view this
 * one had, so every view stays on show exactly once.
 */
export function setAreaView(root: LayoutNode, areaId: string, view: ViewId): LayoutNode {
  const target = areasOf(root).find((a) => a.id === areaId);
  if (!target || target.view === view) return root;
  const old = target.view;
  return mapAreas(root, (a) => {
    if (a.id === areaId) return { ...a, view };
    if (a.view === view) return { ...a, view: old };
    return a;
  });
}

/**
 * Moves the boundary between kids `i` and `i + 1` of the split at `path` by `deltaPx`, keeping
 * both at least `minPx` (or their current size, if already smaller). Only that pair changes.
 */
export function resizeSplit(
  root: LayoutNode,
  path: NodePath,
  i: number,
  deltaPx: number,
  lengthPx: number,
  minPx = MIN_AREA_PX,
): LayoutNode {
  const n = nodeAt(root, path);
  if (!n || isArea(n) || i < 0 || i + 1 >= n.sizes.length || lengthPx <= 0) return root;
  const a = n.sizes[i]!;
  const b = n.sizes[i + 1]!;
  const pair = a + b;
  const minPct = (minPx / lengthPx) * 100;
  const lo = Math.min(minPct, a);
  const hi = pair - Math.min(minPct, b);
  const next = Math.min(hi, Math.max(lo, a + (deltaPx / lengthPx) * 100));
  if (next === a) return root;
  const sizes = n.sizes.slice();
  sizes[i] = next;
  sizes[i + 1] = pair - next;
  return replaceAt(root, path, { ...n, sizes });
}

/** Puts the pair around splitter `i` of the split at `path` back to the preset's shares. */
export function resetSplit(
  root: LayoutNode,
  preset: PresetId,
  path: NodePath,
  i: number,
): LayoutNode {
  const n = nodeAt(root, path);
  const p = nodeAt(presetLayout(preset), path);
  if (!n || isArea(n) || !p || isArea(p) || p.sizes.length !== n.sizes.length) return root;
  if (i < 0 || i + 1 >= n.sizes.length) return root;
  const pair = n.sizes[i]! + n.sizes[i + 1]!;
  const presetPair = p.sizes[i]! + p.sizes[i + 1]!;
  const sizes = n.sizes.slice();
  sizes[i] = (p.sizes[i]! / presetPair) * pair;
  sizes[i + 1] = pair - sizes[i]!;
  return replaceAt(root, path, { ...n, sizes });
}

/** Same nesting, directions and area ids as the preset, so a stored tree only differs in sizes and views. */
function sameShape(a: LayoutNode, b: LayoutNode): boolean {
  if (isArea(a) || isArea(b)) return isArea(a) && isArea(b) && a.id === b.id;
  return (
    a.dir === b.dir &&
    a.kids.length === b.kids.length &&
    a.kids.every((k, i) => sameShape(k, b.kids[i]!))
  );
}

function parseNode(raw: unknown): LayoutNode | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if ('view' in o) {
    if (typeof o.id !== 'string' || !VIEWS.some((v) => v.id === o.view)) return null;
    return { id: o.id, view: o.view as ViewId };
  }
  if ((o.dir !== 'row' && o.dir !== 'col') || !Array.isArray(o.kids) || !Array.isArray(o.sizes))
    return null;
  if (o.kids.length < 2 || o.sizes.length !== o.kids.length) return null;
  if (
    !o.sizes.every((s) => typeof s === 'number' && Number.isFinite(s) && s >= MIN_STORED_SHARE_PCT)
  )
    return null;
  const sum = (o.sizes as number[]).reduce((t, s) => t + s, 0);
  if (Math.abs(sum - 100) > 0.5) return null;
  const kids = o.kids.map(parseNode);
  if (kids.some((k) => k === null)) return null;
  return { dir: o.dir, sizes: o.sizes as number[], kids: kids as LayoutNode[] };
}

/**
 * A stored tree, if it still fits the preset: same shape, every view on show once. Anything else
 * (corrupt, from an older shape, a view since removed) is null and the caller uses the preset.
 */
export function parseStoredLayout(raw: unknown, preset: PresetId): LayoutNode | null {
  const n = parseNode(raw);
  if (!n || !sameShape(n, presetLayout(preset))) return null;
  const views = areasOf(n).map((a) => a.view);
  if (new Set(views).size !== views.length) return null;
  return n;
}
