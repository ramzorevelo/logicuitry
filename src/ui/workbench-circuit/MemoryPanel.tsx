// Memory tab of the docked panel: one card per RAM on the board. Off, the grid
// edits the preload; powered, it is a live read-only view polled each frame,
// because a write changes no net and so raises no net-change event.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useCircuitStore, offeredRun } from './circuitStore';
import {
  cellDigits,
  changedAddresses,
  hasRam,
  lastWritten,
  ramCells,
  typedValue,
  withBitFlipped,
  withCell,
  type RamEntry,
} from '../../core/model/ramView';
import type { BusValue } from '../../core/value/busValue';
import {
  drawMemoryGrid,
  layoutMemoryGrid,
  memoryCellAt,
  memoryGridMetrics,
  rowTop,
} from '../../render/memoryGrid';
import { readTheme } from '../../render/theme';
import { sizeCanvas, watchBackingScale } from '../canvasBacking';
import { useThemeRevision } from '../theme/useThemeRevision';
import { useCompact } from '../compact';

/** The Memory tab exists on the board tab of a board holding a RAM. */
export function useMemoryAvailable(): boolean {
  const board = useCircuitStore((s) => s.board);
  const chipLib = useCircuitStore((s) => s.chipLib);
  const onBoardTab = useCircuitStore(
    (s) => (s.tabs.find((t) => t.id === s.activeTabId) ?? s.tabs[0])?.kind === 'board',
  );
  return useMemo(() => onBoardTab && hasRam(board, chipLib), [onBoardTab, board, chipLib]);
}

interface LiveRam {
  cells: readonly BusValue[];
  address: number | null;
  written: number | null;
}

export function MemoryPanel() {
  const store = useCircuitStore;
  const board = useCircuitStore((s) => s.board);
  const chipLib = useCircuitStore((s) => s.chipLib);
  const powered = useCircuitStore((s) => s.powered);
  const result = useMemo(() => {
    void board;
    void chipLib;
    void powered;
    return store.getState().memoryRams();
  }, [store, board, chipLib, powered]);
  const rams = 'rams' in result ? result.rams : null;
  const [live, setLive] = useState<ReadonlyMap<number, LiveRam>>(new Map());

  useEffect(() => {
    setLive(new Map());
    if (!powered || !rams) return;
    let prev = new Map<number, LiveRam>();
    let raf = 0;
    const tick = () => {
      let changed = false;
      const next = new Map(prev);
      for (const e of rams) {
        const now = store.getState().ramLive(e.index);
        if (!now) continue;
        const was = prev.get(e.index);
        if (was && was.cells === now.cells && was.address === now.address) continue;
        const written =
          was && was.cells !== now.cells
            ? (lastWritten(was.cells, now.cells) ?? was.written)
            : (was?.written ?? null);
        next.set(e.index, { ...now, written });
        changed = true;
      }
      if (changed) {
        prev = next;
        setLive(next);
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [powered, rams, store]);

  if (!rams) {
    return (
      <div className="wave-panel__empty">
        The board does not compile, so its memory cannot be shown:{' '}
        {'error' in result && result.error}
      </div>
    );
  }
  return (
    <div className="memory-panel">
      {rams.map((e) => (
        <MemoryCard key={e.componentId} entry={e} powered={powered} live={live.get(e.index)} />
      ))}
    </div>
  );
}

const HEX_KEY = /^[0-9a-fA-F]$/;
const GRID_KEYS = new Set([
  'Enter',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Delete',
  'Backspace',
]);
/** Travel past which a press on the grid is a scroll, not a bit tap. */
const TAP_SLOP_PX = 6;
const HEX_PAD = '0123456789ABCDEF'.split('');

function MemoryCard({
  entry,
  powered,
  live,
}: {
  entry: RamEntry;
  powered: boolean;
  live: LiveRam | undefined;
}) {
  const store = useCircuitStore;
  const compact = useCompact();
  const offered = useCircuitStore((s) => offeredRun(s, entry.componentId));
  const held = useCircuitStore((s) => {
    void s.rev;
    return s.heldRamIds().has(entry.componentId);
  });
  const editable = !powered && !entry.misfit;
  const rows = 1 << entry.addressBits;
  const digits = cellDigits(entry.width);

  const [selected, setSelected] = useState(0);
  const [pending, setPending] = useState('');
  const [focused, setFocused] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const preloadCells = useMemo(() => ramCells(entry), [entry]);
  const cells = powered && live ? live.cells : preloadCells;
  const keepCount = useMemo(
    () => (offered ? changedAddresses(preloadCells, offered, entry.width).length : 0),
    [offered, preloadCells, entry.width],
  );

  useEffect(() => {
    if (powered) setPending('');
  }, [powered]);
  const row = Math.min(selected, rows - 1);

  // Drawn in px, so presentation's root font scale is followed by hand.
  const themeRev = useThemeRevision();
  const [touchH, setTouchH] = useState(0);
  const scale = useMemo(() => {
    void themeRev;
    return parseFloat(getComputedStyle(document.documentElement).fontSize) / 16 || 1;
  }, [themeRev]);
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setTouchH(
      compact ? parseFloat(getComputedStyle(canvas).getPropertyValue('--touch-h')) || 0 : 0,
    );
  }, [compact, themeRev]);
  const layout = useMemo(
    () =>
      layoutMemoryGrid(
        { width: entry.width, addressBits: entry.addressBits, invertedOut: entry.invertedOut },
        memoryGridMetrics(scale, touchH),
      ),
    [entry.width, entry.addressBits, entry.invertedOut, scale, touchH],
  );

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = sizeCanvas(canvas, layout.width, layout.height);
    if (!ctx) return;
    ctx.clearRect(0, 0, layout.width, layout.height);
    drawMemoryGrid(ctx, readTheme(), layout, {
      cells,
      selected: editable ? row : null,
      pending,
      current: powered ? (live?.address ?? null) : null,
      written: powered ? (live?.written ?? null) : null,
      focused,
    });
  }, [layout, cells, editable, row, pending, powered, live, focused]);

  useEffect(() => draw(), [draw]);
  useEffect(() => {
    // Theme flips change tokens without any React state.
    const obs = new MutationObserver(() => draw());
    obs.observe(document.documentElement, { attributes: true });
    return () => obs.disconnect();
  }, [draw]);
  useEffect(() => watchBackingScale(() => draw()), [draw]);

  const scrollRowIntoView = (r: number) => {
    const canvas = canvasRef.current;
    const body = canvas?.closest('.wave-panel__body');
    if (!canvas || !body) return;
    const top = canvas.getBoundingClientRect().top + rowTop(layout, r);
    const bottom = top + layout.metrics.rowH;
    const box = body.getBoundingClientRect();
    if (top < box.top) body.scrollTop -= box.top - top;
    else if (bottom > box.bottom) body.scrollTop += bottom - box.bottom;
  };

  const write = (text: string) => store.getState().setRamPreload(entry, text);

  /** Commits typed digits; the entry as it now stands, since the store's copy
   *  only reaches this card on the next render. */
  const commitPending = (): RamEntry => {
    const value = typedValue(pending, entry.width);
    setPending('');
    if (value === null) return entry;
    const preload = withCell(entry, row, value);
    write(preload);
    return { ...entry, preload };
  };

  const moveTo = (r: number) => {
    commitPending();
    const next = Math.max(0, Math.min(rows - 1, r));
    setSelected(next);
    scrollRowIntoView(next);
  };

  const typeDigit = (d: string) => {
    const buf = pending + d.toUpperCase();
    if (buf.length < digits) {
      setPending(buf);
      return;
    }
    setPending('');
    write(withCell(entry, row, typedValue(buf, entry.width)));
  };

  const clearRow = () => {
    setPending('');
    write(withCell(entry, row, null));
  };

  // Not pushModalKeys: that would silence Space, P and T too. Handled keys stop
  // here, and the board's handler already ignores a prevented event.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLCanvasElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === 'Escape') {
      handled();
      if (pending) setPending('');
      else e.currentTarget.blur();
      return;
    }
    // Space powers on, and a powered board refuses the write.
    if (e.key === ' ' && pending) commitPending();
    if (!HEX_KEY.test(e.key) && !GRID_KEYS.has(e.key)) return;
    // A read-only grid still owns these: Delete would otherwise delete board parts.
    handled();
    if (!editable) return;
    if (HEX_KEY.test(e.key)) typeDigit(e.key);
    else if (e.key === 'Enter') moveTo(row + 1);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp')
      moveTo(row + (e.key === 'ArrowDown' ? 1 : -1));
    else if (e.key === 'Backspace' && pending) setPending(pending.slice(0, -1));
    else if (e.key === 'Delete' || e.key === 'Backspace') clearRow();
  };

  // A bit flips on release, and only if the pointer stayed put: on a phone the
  // grid sits in a scrolling dock, and a swipe that starts on a bit is a scroll.
  const pressRef = useRef<{ id: number; x: number; y: number } | null>(null);
  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.focus({ preventScroll: true });
    pressRef.current = e.button === 0 ? { id: e.pointerId, x: e.clientX, y: e.clientY } : null;
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const press = pressRef.current;
    pressRef.current = null;
    if (!press || press.id !== e.pointerId || !editable) return;
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > TAP_SLOP_PX) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const hit = memoryCellAt(layout, e.clientX - rect.left, e.clientY - rect.top);
    if (!hit) return;
    const current = commitPending();
    setSelected(hit.row);
    if (hit.bit !== undefined) write(withBitFlipped(current, hit.row, hit.bit));
  };

  const hint = entry.misfit
    ? 'The saved contents no longer fit this RAM. They are kept, so the grid is read-only until the RAM fits them again.'
    : powered
      ? 'Live, read-only while powered.'
      : held
        ? 'Held from the last run until power-on. An edit here drops it.'
        : 'Preload, loaded at power-on. Blank cells are X.';
  const editHint = compact
    ? 'Tap a bit to flip it, or type on the keypad.'
    : 'Click a bit to flip it, or type 0 to F. Delete clears to X.';

  return (
    <section className="memory-card" aria-label={`${entry.title} contents`}>
      <div className="memory-card__head">
        <span className="memory-card__title">{entry.title}</span>
        <span className="memory-card__size">
          {rows} × {entry.width}
        </span>
      </div>
      <span className="memory-card__hint">{hint}</span>
      {!powered && keepCount > 0 && (
        <div className="memory-card__keep">
          <button
            type="button"
            className="tool-btn"
            onClick={() => store.getState().keepLastRun(entry)}
          >
            Keep last run as preload
          </button>
          <span className="memory-card__hint">
            The last run changed {keepCount} {keepCount === 1 ? 'cell' : 'cells'}.
          </span>
        </div>
      )}
      {editable && <span className="memory-card__hint">{editHint}</span>}
      {editable && compact && (
        <div className="memory-card__keypad" onPointerDown={(e) => e.preventDefault()}>
          {HEX_PAD.map((d) => (
            <button key={d} type="button" className="tool-btn" onClick={() => typeDigit(d)}>
              {d}
            </button>
          ))}
          <button type="button" className="tool-btn" onClick={clearRow}>
            Clear
          </button>
          <button type="button" className="tool-btn" onClick={() => moveTo(row + 1)}>
            Next
          </button>
        </div>
      )}
      <div className="memory-card__grid">
        <canvas
          ref={canvasRef}
          className="memory-card__canvas"
          tabIndex={0}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerCancel={() => (pressRef.current = null)}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            if (pending) commitPending();
          }}
        />
      </div>
    </section>
  );
}
