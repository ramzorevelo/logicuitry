// The whole board, unpowered, through the workbench's own renderBoard, so a
// preview can never show a different drawing from the one that opens.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Board, ChipDef, ChipLibrary } from '../../core/model/types';
import { builtinChipLibrary } from '../../core/parts/packages';
import { paintWithoutGlyphCache } from '../../render/glyphCache';
import type { Viewport } from '../../render/scene';
import { backingScale, watchBackingScale } from '../canvasBacking';
import { sharedTheme } from '../theme/sharedTheme';
import { useThemeRevision } from '../theme/useThemeRevision';
import { renderBoard } from '../workbench-circuit/editorScene';
import { circuitDrawnBounds, fitViewport } from '../workbench-circuit/fitView';
import { LruCache, thumbnailKey } from './thumbnailCache';

/** Past this a two-gate board reads as a close-up rather than a whole circuit. */
const MAX_ZOOM = 1.5;
const MIN_ZOOM = 0.01;
const RESIZE_SETTLE_MS = 150;
const NO_SELECTION: ReadonlySet<string> = new Set();
const UNPOWERED = () => undefined;

interface Bitmap {
  board: Board;
  canvas: HTMLCanvasElement;
}

/** Hovering back to a row redraws from here with one drawImage. */
const bitmaps = new LruCache<string, Bitmap>(16);

function libraryWith(chips: readonly ChipDef[] | undefined): ChipLibrary {
  if (!chips?.length) return builtinChipLibrary();
  return new Map([...builtinChipLibrary(), ...chips.map((d): [string, ChipDef] => [d.id, d])]);
}

function paintBoard(
  target: HTMLCanvasElement,
  board: Board,
  chipLib: ChipLibrary,
  cssW: number,
  cssH: number,
  dpr: number,
): void {
  const ctx = target.getContext('2d');
  if (!ctx) return;
  const theme = sharedTheme();
  const bounds = circuitDrawnBounds(board, chipLib, theme);
  const viewport: Viewport = bounds
    ? fitViewport(bounds, cssW, cssH, theme.gridSchematic, MIN_ZOOM, MAX_ZOOM)
    : { panX: 0, panY: 0, zoom: 1 };
  // Not through the shared tile cache: a thumbnail's tiles would evict the
  // open board's, and its part count would resize the cap the board relies on.
  paintWithoutGlyphCache(() =>
    renderBoard(ctx, theme, {
      board,
      chipLib,
      viewport,
      selection: NO_SELECTION,
      pinSignal: UNPOWERED,
      grid: theme.gridSchematic,
      dpr,
    }),
  );
}

function blit(canvas: HTMLCanvasElement, source: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0);
}

/** Fills its CSS box; the parent sets the aspect. */
export function BoardThumbnail({
  board,
  chips,
  className,
}: {
  board: Board;
  chips?: readonly ChipDef[] | undefined;
  className?: string | undefined;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rev = useThemeRevision();
  const chipLib = useMemo(() => libraryWith(chips), [chips]);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const [scale, setScale] = useState(backingScale);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let settle = 0;
    let measured = false;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const w = Math.round(entry.contentRect.width);
      const h = Math.round(entry.contentRect.height);
      const apply = () =>
        setBox((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
      window.clearTimeout(settle);
      // While a splitter drags, the old bitmap stretches with the box; a large
      // board repainted every frame would stall the drag.
      if (measured) settle = window.setTimeout(apply, RESIZE_SETTLE_MS);
      else apply();
      measured = true;
    });
    observer.observe(canvas);
    const unwatch = watchBackingScale(() => setScale(backingScale()));
    return () => {
      window.clearTimeout(settle);
      observer.disconnect();
      unwatch();
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !box || box.w === 0 || box.h === 0) return;
    const pxW = Math.round(box.w * scale);
    const pxH = Math.round(box.h * scale);
    if (canvas.width !== pxW) canvas.width = pxW;
    if (canvas.height !== pxH) canvas.height = pxH;
    const key = thumbnailKey(board.id, rev, pxW, pxH);
    const hit = bitmaps.get(key);
    if (hit && hit.board === board) {
      blit(canvas, hit.canvas);
      return;
    }
    // The previous row's picture must not stand in for this one while it waits.
    canvas.getContext('2d')?.clearRect(0, 0, pxW, pxH);
    const off = document.createElement('canvas');
    off.width = pxW;
    off.height = pxH;
    // Deferred a frame so a hover sweep over large boards only pays for the
    // row it stops on: a prop change cancels the frame before it paints.
    const raf = requestAnimationFrame(() => {
      paintBoard(off, board, chipLib, box.w, box.h, scale);
      blit(canvas, off);
      bitmaps.set(key, { board, canvas: off });
    });
    return () => cancelAnimationFrame(raf);
  }, [board, chipLib, rev, box, scale]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ display: 'block', width: '100%', height: '100%' }}
      aria-hidden="true"
    />
  );
}
