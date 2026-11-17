import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import {
  areasOf,
  isArea,
  PRESETS,
  SPLIT_KEY_STEP,
  isNarrow,
  VIEWS,
  viewLabel,
  type AreaNode,
  type LayoutNode,
  type NodePath,
  type ViewId,
} from './workspaceLayout';
import { currentLayout, narrowShownArea, useWorkspaceStore } from './workspaceStore';
import './workspace.css';

/** The view elements live in `.circuit-body` beside this overlay; each carries `data-ws-view`. */
const viewEl = (body: Element, view: ViewId): HTMLElement | null =>
  body.querySelector<HTMLElement>(`:scope > [data-ws-view="${view}"]`);

function place(el: HTMLElement, r: DOMRect, origin: DOMRect, shown: boolean): void {
  el.style.position = 'absolute';
  el.style.left = `${r.left - origin.left}px`;
  el.style.top = `${r.top - origin.top}px`;
  el.style.width = `${r.width}px`;
  el.style.height = `${r.height}px`;
  el.style.visibility = shown ? '' : 'hidden';
  el.inert = !shown;
}

const PLACED = ['position', 'left', 'top', 'width', 'height', 'visibility'];

function unplace(el: HTMLElement): void {
  for (const p of PLACED) el.style.removeProperty(p);
  el.inert = false;
}

/** Plain keys a header or splitter must not hand on to the board or the app (P, T, Space, `.`). */
const keepKeyLocal = (e: KeyboardEvent) => {
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) e.stopPropagation();
};

/**
 * The lesson editor's workspace chrome: tab row, area headers, splitters and the narrow strip.
 * It draws no view itself. It measures each area's body and moves the view elements onto it,
 * because the board's canvas wrap must never change parent.
 */
export function LessonWorkspace() {
  const rootRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const preset = useWorkspaceStore((s) => s.preset);
  const layout = useWorkspaceStore(currentLayout);
  const maxArea = useWorkspaceStore((s) => s.maxArea);
  const narrow = useWorkspaceStore((s) => s.narrow);
  const narrowId = useWorkspaceStore(narrowShownArea);
  const focusArea = useWorkspaceStore((s) => s.focusArea);
  const announce = useWorkspaceStore((s) => s.announce);
  const ws = useWorkspaceStore.getState;

  const applyRects = () => {
    const root = rootRef.current;
    const body = root?.parentElement;
    const tree = treeRef.current;
    if (!root || !body || !tree) return;
    const origin = body.getBoundingClientRect();
    const whole = tree.getBoundingClientRect();
    for (const { id: view } of VIEWS) {
      const el = viewEl(body, view);
      if (!el) continue;
      const area = areasOf(currentLayout(ws())).find((a) => a.view === view);
      const slot = area && root.querySelector(`[data-area-id="${area.id}"] .ws-area__body`);
      const shown = !!slot && ws().shown(view);
      // A hidden view keeps the whole tree's box: a 0 x 0 canvas would lose its camera on return.
      place(el, shown ? slot.getBoundingClientRect() : whole, origin, shown);
    }
  };

  useLayoutEffect(applyRects);

  // Maximise and restore rebuild the tree, so the pressed button is gone; land on the area shown.
  const lastMax = useRef(maxArea);
  useLayoutEffect(() => {
    if (lastMax.current === maxArea) return;
    const was = lastMax.current;
    lastMax.current = maxArea;
    if (document.activeElement !== document.body) return;
    const id = maxArea ?? was;
    rootRef.current
      ?.querySelector<HTMLElement>(`[data-area-id="${id}"] .ws-area__head button`)
      ?.focus();
  }, [maxArea]);

  useEffect(() => {
    const root = rootRef.current;
    const body = root?.parentElement;
    if (!root || !body) return;
    const ro = new ResizeObserver(() => {
      ws().setNarrow(isNarrow(body.clientWidth));
      applyRects();
    });
    ro.observe(body);
    ws().setNarrow(isNarrow(body.clientWidth));
    const areaAt = (x: number, y: number): string | null => {
      for (const el of root.querySelectorAll<HTMLElement>('[data-area-id]')) {
        const r = el.getBoundingClientRect();
        if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) return el.dataset.areaId!;
      }
      return null;
    };
    const onMove = (e: globalThis.PointerEvent) => ws().setHover(areaAt(e.clientX, e.clientY));
    const onLeave = () => ws().setHover(null);
    const onFocus = (e: FocusEvent) => {
      const t = e.target as Element;
      const head = t.closest<HTMLElement>('[data-area-id]');
      if (head) return ws().setFocus(head.dataset.areaId!);
      const view = t.closest<HTMLElement>('[data-ws-view]')?.dataset.wsView;
      const area = areasOf(currentLayout(ws())).find((a) => a.view === view);
      if (area) ws().setFocus(area.id);
    };
    body.addEventListener('pointermove', onMove, { passive: true });
    body.addEventListener('pointerleave', onLeave);
    body.addEventListener('focusin', onFocus);
    return () => {
      ro.disconnect();
      body.removeEventListener('pointermove', onMove);
      body.removeEventListener('pointerleave', onLeave);
      body.removeEventListener('focusin', onFocus);
      for (const { id } of VIEWS) {
        const el = viewEl(body, id);
        if (el) unplace(el);
      }
      // Play, Back from Play and close all start from the whole layout.
      ws().restore();
      ws().setHover(null);
    };
  }, []);

  const areaSection = (a: AreaNode, grow: number) => {
    const isMax = maxArea === a.id;
    return (
      <section
        key={a.id}
        className={`ws-area${focusArea === a.id ? ' ws-area--focus' : ''}`}
        data-area-id={a.id}
        style={{ flexGrow: grow }}
        aria-label={`${viewLabel(a.view)} area`}
      >
        <div className="ws-area__head" onKeyDown={keepKeyLocal}>
          <select
            aria-label="View in this area"
            value={a.view}
            onChange={(e) => ws().setView(a.id, e.target.value as ViewId)}
          >
            {VIEWS.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
          <span className="ws-grow" />
          {!narrow && (
            <button
              type="button"
              className="tool-btn"
              aria-pressed={isMax}
              title={
                isMax
                  ? 'Restore the layout (Ctrl+Space, Esc)'
                  : 'Fill the editor with this area (Ctrl+Space)'
              }
              onClick={() => ws().toggleMax(a.id)}
            >
              {isMax ? 'Restore' : 'Maximise'}
            </button>
          )}
        </div>
        <div className="ws-area__body" />
      </section>
    );
  };

  const node = (n: LayoutNode, path: NodePath, grow: number): JSX.Element => {
    if (isArea(n)) return areaSection(n, grow);
    const kids: JSX.Element[] = [];
    n.kids.forEach((kid, i) => {
      if (i > 0)
        kids.push(<Splitter key={`s${i}`} path={path} index={i - 1} dir={n.dir} sizes={n.sizes} />);
      kids.push(node(kid, path === '' ? String(i) : `${path}.${i}`, n.sizes[i]!));
    });
    return (
      <div key={path} className={`ws-box ws-box--${n.dir}`} style={{ flexGrow: grow }}>
        {kids}
      </div>
    );
  };

  const areas = areasOf(layout);
  const maxed = maxArea ? areas.find((a) => a.id === maxArea) : undefined;
  const narrowArea = areas.find((a) => a.id === narrowId) ?? areas[0]!;
  let tree: JSX.Element;
  if (narrow) tree = areaSection(narrowArea, 1);
  else if (maxed) tree = areaSection(maxed, 1);
  else tree = node(layout, '', 1);

  return (
    <div className="ws" ref={rootRef}>
      <div className="ws-tabs" role="group" aria-label="Workspace" onKeyDown={keepKeyLocal}>
        {PRESETS.map((p) => (
          <button key={p.id} type="button" className="tool-btn" aria-pressed={preset === p.id}>
            {p.label}
          </button>
        ))}
        <span className="ws-grow" />
        <button
          type="button"
          className="tool-btn"
          title="Put this workspace back to its preset"
          onClick={() => ws().resetLayout()}
        >
          Reset layout
        </button>
      </div>
      {narrow && (
        <div
          className="ws-strip"
          role="group"
          aria-label="Areas in this workspace"
          onKeyDown={keepKeyLocal}
        >
          {areas.map((a, i) => (
            <button
              key={a.id}
              type="button"
              className="tool-btn"
              aria-pressed={a.id === narrowArea.id}
              onClick={() => ws().pickNarrow(a.id)}
            >
              {i + 1}: {viewLabel(a.view)}
            </button>
          ))}
        </div>
      )}
      <div className="ws-tree" ref={treeRef}>
        {tree}
      </div>
      <div className="ws-live" aria-live="polite">
        {announce}
      </div>
    </div>
  );
}

interface SplitterProps {
  path: NodePath;
  index: number;
  dir: 'row' | 'col';
  sizes: number[];
}

/** Pair length in px: the two areas' rendered sizes over their share of the parent. */
function pairLengthPx(el: HTMLElement, dir: 'row' | 'col', sharePct: number): number {
  const prev = el.previousElementSibling?.getBoundingClientRect();
  const next = el.nextElementSibling?.getBoundingClientRect();
  if (!prev || !next || sharePct <= 0) return 0;
  const px = dir === 'row' ? prev.width + next.width : prev.height + next.height;
  return (px / sharePct) * 100;
}

function Splitter({ path, index, dir, sizes }: SplitterProps) {
  const drag = useRef<{ base: LayoutNode; start: number; last: number; length: number } | null>(
    null,
  );
  const frame = useRef<number | null>(null);
  const ws = useWorkspaceStore.getState;
  const share = sizes[index]! + sizes[index + 1]!;
  const coord = (e: PointerEvent) => (dir === 'row' ? e.clientX : e.clientY);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    // Capture, so a drag across the board starts no wire, pan or marquee there.
    e.currentTarget.setPointerCapture(e.pointerId);
    const length = pairLengthPx(e.currentTarget, dir, share);
    drag.current = { base: currentLayout(ws()), start: coord(e), last: coord(e), length };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    d.last = coord(e);
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const cur = drag.current;
      if (!cur) return;
      // From the drag's start, so a pointer pulled past the minimum and back lands where it is.
      ws().resize(path, index, cur.last - cur.start, cur.length, cur.base);
    });
  };
  const endDrag = () => {
    const d = drag.current;
    drag.current = null;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    if (d) ws().resize(path, index, d.last - d.start, d.length, d.base);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const back = dir === 'row' ? 'ArrowLeft' : 'ArrowUp';
    const fwd = dir === 'row' ? 'ArrowRight' : 'ArrowDown';
    if (e.key === back || e.key === fwd) {
      const length = pairLengthPx(e.currentTarget, dir, share);
      const step = (SPLIT_KEY_STEP / 100) * length;
      ws().resize(path, index, e.key === fwd ? step : -step, length);
    } else if (e.key === 'Enter') ws().resetSplit(path, index);
    else return keepKeyLocal(e);
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div
      className={`ws-split ws-split--${dir}`}
      role="separator"
      tabIndex={0}
      aria-orientation={dir === 'row' ? 'vertical' : 'horizontal'}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(sizes[index]!)}
      aria-label="Resize areas"
      title="Drag to resize; double-click or Enter to reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => ws().resetSplit(path, index)}
      onKeyDown={onKeyDown}
    />
  );
}
