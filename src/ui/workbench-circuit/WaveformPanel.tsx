// Bottom-docked collapsible waveform panel (design-system slot). Renders the
// sim's trace ring buffer via core/timing/traceView + render/waveform; the
// cursor drives store-level scrub-replay so the schematic recolors in sync.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCircuitStore } from './circuitStore';
import {
  buildTraceView,
  canonicalTrackForNet,
  eventTimes,
  expandTrackByBit,
  type TraceView,
} from '../../core/timing/traceView';
import {
  chevronRect,
  defaultWaveformMetrics,
  drawWaveform,
  laneOriginPath,
  layoutWaveform,
  tickStepPs,
  waveformOrderKey,
  type WaveAnnotation,
  type WaveformLayout,
  type WaveformRow,
} from '../../render/waveform';
import { readTheme } from '../../render/theme';
import { getPart } from '../../core/parts/partsDb';
import { sizeCanvas, watchBackingScale } from '../canvasBacking';
import { getPrefs } from '../prefs';
import { useCompact } from '../compact';
import { effectiveWindow, type Win } from './waveWindow';

/** Pending Δt measure: first clicked edge, waiting for the second. */
interface MeasureState {
  t0: number;
}

export function WaveformPanel() {
  const store = useCircuitStore;
  const open = useCircuitStore((s) => s.waveformOpen);
  const powered = useCircuitStore((s) => s.powered);
  const running = useCircuitStore((s) => s.running);
  const timing = useCircuitStore((s) => s.timing);
  const replayTime = useCircuitStore((s) => s.replayTimePs);
  const hoverTrackPath = useCircuitStore((s) => s.hoverTrackPath);
  const staReport = useCircuitStore((s) => s.staReport);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // Window model. `win` is the frozen window; whether it is used at all, and
  // whether its right edge tracks the trace end, is what the two toggles say.
  //   autoFit  on  -> always the whole trace, span included
  //   autoFit  off -> the span is the user's and never changes on its own
  //   autoScroll on-> the right edge follows the newest sample
  const [win, setWin] = useState<Win | null>(null);
  const [autoFit, setAutoFit] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const [thresholdNs, setThresholdNs] = useState(() => getPrefs().glitchThresholdNs);
  const [measure, setMeasure] = useState<MeasureState | null>(null);
  const [annotations, setAnnotations] = useState<WaveAnnotation[]>([]);
  // Session-only view-state (owner decision): row order + hidden signals live
  // in the panel, not the board doc; unknown paths keep board order, appended.
  const [trackOrder, setTrackOrder] = useState<string[]>([]);
  const [hiddenTracks, setHiddenTracks] = useState<ReadonlySet<string>>(new Set());
  // Task 5: paths of width>1 tracks currently split into per-bit lane rows;
  // session-only view-state, same as row order/hiding.
  const [expandedTracks, setExpandedTracks] = useState<ReadonlySet<string>>(new Set());
  const [signalsOpen, setSignalsOpen] = useState(false);
  const signalsRef = useRef<HTMLSpanElement>(null);
  const [showArrows, setShowArrows] = useState(() => getPrefs().waveformArrows);
  // Session-only panel height (drag the top edge); null = CSS default (40vh cap).
  const [panelH, setPanelH] = useState<number | null>(null);
  const resizeRef = useRef<{ startY: number; startH: number } | null>(null);
  const compact = useCompact();
  // Paths already given their default visibility, so a user's re-check sticks.
  const defaultedRef = useRef(new Set<string>());
  // Net -> path that already claimed the visible default for that net. Nets
  // renumber on every compile and can MERGE two previously-separate tracks
  // (e.g. labelSync inheriting a name onto a new wire) -- a track's default
  // is decided once (defaultedRef) and never revisited, so without this a
  // late-arriving track re-runs the rank comparison against the CURRENT set
  // and can default visible even though an older track already won that net.
  const canonicalNetRef = useRef(new Map<number, string>());
  const dragRef = useRef<
    { kind: 'scrub' | 'pan'; lastX: number } | { kind: 'reorder'; path: string } | null
  >(null);
  // Live cursor Y (canvas-local) while a reorder drag is active -- draw()
  // uses this to render the dragged row stuck to the cursor instead of its
  // list-order slot, while every OTHER row already reflects the live
  // (row-boundary-crossing) reorder underneath it.
  const dragCursorYRef = useRef<number | null>(null);
  // Chevron press starts a group reorder drag immediately (dragRef); this
  // just tracks whether it actually moved anywhere, so a plain click (press
  // + release, nothing dragged) still toggles expand/collapse at pointerup
  // instead of always counting as a drag.
  const chevronDragRef = useRef<{ path: string; moved: boolean } | null>(null);
  const [chevronHoverGroup, setChevronHoverGroup] = useState<string | null>(null);
  const layoutRef = useRef<WaveformLayout | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Touch gestures on the plot. One finger is the time cursor, which is what
  // a tap on a waveform should mean; two fingers pan and pinch, because time
  // panning otherwise lives on a 14px scrollbar no finger can take, and the
  // wheel that zooms does not exist here either.
  const touchRef = useRef(new Map<number, { x: number; y: number }>());
  const gestureRef = useRef<{ dist: number; midX: number } | null>(null);

  const twoFinger = () => [...touchRef.current.values()];
  const gesture = () => {
    const [a, b] = twoFinger();
    if (!a || !b) return null;
    return { dist: Math.max(1, Math.abs(a.x - b.x)), midX: (a.x + b.x) / 2 };
  };
  // The last scrollLeft this component wrote. A one-shot boolean cannot do
  // this job: the browser coalesces and re-fires scroll events, so the flag
  // gets consumed by the wrong one and a programmatic write is then read back
  // as a user pan -- which, once the window follows the trace end, rewrites
  // the bar and loops. Comparing against the target is idempotent.
  const scrollSyncRef = useRef<number | null>(null);

  const column = timing.mode === 'datasheet' ? timing.datasheet : undefined;

  // Click outside the Signals popover closes it, same rule as every other
  // popup in this workbench (param overlay, label-conflict dialog).
  useEffect(() => {
    if (!signalsOpen) return;
    const onDocPointerDown = (e: PointerEvent) => {
      if (signalsRef.current && !signalsRef.current.contains(e.target as Node)) {
        setSignalsOpen(false);
      }
    };
    document.addEventListener('pointerdown', onDocPointerDown, true);
    return () => document.removeEventListener('pointerdown', onDocPointerDown, true);
  }, [signalsOpen]);

  // Rebuilding the view copies the whole trace ring buffer and re-segments
  // every track, so it must NOT run per rev bump: while free-running, pump()
  // bumps rev every animation frame and the panel dragged the whole app down.
  // `viewLen` (monotonic record count) gates the rebuild: immediate while
  // paused, throttled to ~4 Hz while running.
  const traceLen = useCircuitStore((s) => (s.rev >= 0 ? s.simTraceLength() : 0));
  const [viewLen, setViewLen] = useState(0);
  const lastBuildRef = useRef(0);
  useEffect(() => {
    if (traceLen === viewLen) return;
    const since = performance.now() - lastBuildRef.current;
    const THROTTLE_MS = 250;
    if (!running || since >= THROTTLE_MS) {
      lastBuildRef.current = performance.now();
      setViewLen(traceLen);
      return;
    }
    const t = setTimeout(() => {
      lastBuildRef.current = performance.now();
      setViewLen(useCircuitStore.getState().simTraceLength());
    }, THROTTLE_MS - since);
    return () => clearTimeout(t);
  }, [traceLen, viewLen, running]);

  // Recomputed on the same trigger as `view` (viewLen), never read live: the
  // view is rebuilt at 4 Hz while running, and a live full-span against a
  // throttled view is what put a scrollbar on screen right after a Fit.
  // t1 is the sim clock, not the last record: records only mark changes, so a
  // settled board's newest state lies past the final transition.
  const fullSpan = useMemo((): Win => {
    const st = store.getState();
    const trace = st.simTrace();
    const recs = trace?.records ?? [];
    const first = recs.length ? recs[0]!.time : 0;
    const last = recs.length ? recs[recs.length - 1]!.time : 0;
    const end = Math.max(st.simNow(), last, first + 1);
    // A level that begins exactly at the right edge has zero width, so the
    // newest state was invisible and the one before it read as current: flip a
    // switch on a settled board and the trace still showed it low. That is the
    // normal case, not an edge one, because the last record IS the settle the
    // clock stopped at. Give it a slice of the window to be seen in.
    const tail = end === last ? Math.max(1, Math.round((end - first) * 0.02)) : 0;
    return { t0: first, t1: end + tail };
    // viewLen and powered are the same inputs `view` uses.
  }, [viewLen, powered, store]);

  /** The window actually drawn, from the frozen one and the two toggles. */
  const effectiveWin = useMemo(
    () => effectiveWindow(win, fullSpan, autoFit, autoScroll),
    [autoFit, autoScroll, win, fullSpan],
  );

  const view: TraceView | null = useMemo(() => {
    if (!open) return null;
    const st = store.getState();
    const trace = st.simTrace();
    if (!trace) return null;
    return buildTraceView(st.board, trace.compiled, trace.records, {
      ...(effectiveWin ? { t0: effectiveWin.t0, t1: effectiveWin.t1 } : {}),
      spanEnd: st.simNow(),
      ...(column ? { column } : {}),
      glitchThresholdPs: Math.max(1, Math.round(thresholdNs * 1000)),
      // Pass-through suppression window: real critical-path t_pd when STA ran.
      ...(staReport?.report.worst ? { glitchWindowPs: staReport.report.worst.totalTpdPs } : {}),
    });
  }, [open, viewLen, effectiveWin, column, thresholdNs, powered, store, staReport]);

  // Owner decision (generalized, Task 1d follow-up): only ONE track per net
  // starts checked -- the same canonical pick the glitch scan already hosts
  // its marker on (probe wins, else board order) -- every other track
  // sharing that net (an LED sharing a probe's net; a named gate/decoder
  // output sharing a net with an LED it drives, ...) starts unchecked but
  // stays individually checkable in Signals.
  useEffect(() => {
    if (!view) return;
    const canonical = canonicalTrackForNet(view.tracks, store.getState().simTrace()?.compiled);
    const add: string[] = [];
    for (const t of view.tracks) {
      if (defaultedRef.current.has(t.path)) continue;
      defaultedRef.current.add(t.path);
      if (canonicalNetRef.current.has(t.net)) {
        // This net's visible default was already claimed by an earlier
        // track -- never re-litigate by rank, just hide the newcomer.
        add.push(t.path);
        continue;
      }
      if (canonical.get(t.net) !== t) add.push(t.path);
      else canonicalNetRef.current.set(t.net, t.path);
    }
    if (add.length) setHiddenTracks((prev) => new Set([...prev, ...add]));
  }, [view]);

  /** view.tracks with each expanded width>1 track's N derived per-bit lane
   *  rows (Task 5) spliced in RIGHT AFTER it -- the origin track itself
   *  always stays (the "folder" row: shows the combined value, owns the
   *  chevron, and is what a group drag/reorder actually moves), collapsed
   *  or not. Every other consumer (order/hide/layout) works off this list
   *  so a lane row is just another path to them. Built in board order --
   *  `orderKeyFor` below is what actually places a lane group at its
   *  parent's chosen position, not this list's own order. */
  const expandedList = useMemo(() => {
    if (!view) return [];
    return view.tracks.flatMap((t) =>
      t.width > 1 && expandedTracks.has(t.path) ? [t, ...expandTrackByBit(t)] : [t],
    );
  }, [view, expandedTracks]);

  // Every row a hovered chevron's drag would move together: just the origin
  // when collapsed, or the origin plus its currently-visible lane rows.
  const chevronHighlightPaths = useMemo(() => {
    if (!chevronHoverGroup) return undefined;
    if (!expandedTracks.has(chevronHoverGroup)) return new Set([chevronHoverGroup]);
    return new Set(
      expandedList
        .filter((t) => t.path === chevronHoverGroup || laneOriginPath(t.path) === chevronHoverGroup)
        .map((t) => t.path),
    );
  }, [chevronHoverGroup, expandedTracks, expandedList]);

  const boardOrder = useMemo(() => view?.tracks.map((t) => t.path) ?? [], [view]);
  const orderKeyFor = useCallback(
    (path: string): number => waveformOrderKey(path, boardOrder, trackOrder),
    [boardOrder, trackOrder],
  );

  /** View tracks in user order, hidden rows removed (drives layout + hit-tests). */
  const visibleTracks = useMemo(() => {
    return expandedList
      .map((t) => ({ t, k: orderKeyFor(t.path) }))
      .sort((a, b) => a.k - b.k)
      .map((e) => e.t)
      .filter((t) => !hiddenTracks.has(t.path));
  }, [expandedList, orderKeyFor, hiddenTracks]);

  // Setup/hold window shading around capture-clock edges on DFF d-input
  // tracks: derived (not user-added), so it recomputes with the view.
  const setupHoldAnnotations = useMemo((): WaveAnnotation[] => {
    if (!view || !column) return [];
    const st = store.getState();
    const trace = st.simTrace();
    if (!trace) return [];
    const out: WaveAnnotation[] = [];
    for (const comp of st.board.components) {
      if (comp.kind !== 'dff') continue;
      const part = typeof comp.params?.['part'] === 'string' ? comp.params['part'] : '74LS74';
      const entry = getPart(part);
      if (!entry?.setup_min && !entry?.hold_min) continue;
      const clkNet = st.netOfPin(comp.id, 'clk');
      const dNet = st.netOfPin(comp.id, 'd');
      if (clkNet === undefined || dNet === undefined) continue;
      const dTrack = view.tracks.find((t) => t.net === dNet);
      if (!dTrack) continue;
      // Rising clock edges inside the window.
      let prev = 0;
      for (const r of trace.records) {
        if (r.net !== clkNet) continue;
        const v = r.value.x | r.value.z ? -1 : r.value.v & 1;
        if (prev === 0 && v === 1 && r.time >= view.t0 && r.time <= view.t1) {
          const su = (entry.setup_min ?? 0) * 1000;
          const ho = (entry.hold_min ?? 0) * 1000;
          if (su)
            out.push({
              kind: 'window',
              trackPath: dTrack.path,
              t0: r.time - su,
              t1: r.time,
              style: 'ok',
            });
          if (ho)
            out.push({
              kind: 'window',
              trackPath: dTrack.path,
              t0: r.time,
              t1: r.time + ho,
              style: 'warn',
            });
        }
        prev = v === 1 ? 1 : 0;
      }
    }
    return out;
  }, [view, column, store]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap || !view) return;
    const theme = readTheme();
    const cssW = Math.max(320, wrap.clientWidth - 2);
    // A user-dragged panel height stretches the rows to fill it (min stays the
    // default row height; the body scrolls if it still doesn't fit).
    const base = {
      ...defaultWaveformMetrics,
      tickSpacing: defaultWaveformMetrics.tickSpacing / theme.wave.gridDensity,
    };
    let metrics = base;
    if (panelH !== null && visibleTracks.length) {
      const m = base;
      const avail = panelH - m.axisH - m.topPad - 26; // body padding + time scrollbar
      const rowH = Math.min(
        140,
        Math.max(m.rowH, Math.floor(avail / visibleTracks.length) - m.rowGap),
      );
      metrics = { ...m, rowH, levelPad: Math.round(rowH * 0.2) };
    }
    const layout = layoutWaveform(visibleTracks, { t0: view.t0, t1: view.t1 }, cssW, metrics);
    layoutRef.current = layout;
    const ctx = sizeCanvas(canvas, cssW, Math.max(layout.height, 60));
    if (!ctx) return;
    const cursor = replayTime;
    // Built off expandedList (not the core valuesAt/view.tracks) so a
    // derived per-bit lane row -- absent from the compiled net-keyed replay
    // -- still gets a cursor readout, straight off its own precomputed
    // segments.
    const cursorValues =
      cursor !== null
        ? new Map(
            expandedList
              .map((tr) => {
                const seg = tr.segments.find((s) => cursor >= s.t0 && cursor <= s.t1);
                return seg ? ([tr.path, seg.label] as const) : null;
              })
              .filter((e): e is readonly [string, string] => e !== null),
          )
        : null;
    // Draw-only: the actively-dragged row renders stuck to the live cursor Y
    // instead of its list-order slot (every other row already reflects the
    // live reorder underneath it via trackOrder) -- layoutRef.current above
    // stays the UN-overridden layout, since hit-testing (rowFromEvent et al)
    // must keep reading each row's real slot to detect row-boundary crossing.
    const dragRow = dragRef.current;
    const drawLayout =
      dragRow?.kind === 'reorder' && dragCursorYRef.current !== null
        ? (() => {
            const idx = layout.rows.findIndex((r) => r.track.path === dragRow.path);
            if (idx < 0) return layout;
            const row = layout.rows[idx]!;
            const minY = layout.plot.y;
            const maxY = layout.plot.y + layout.plot.h - row.rect.h;
            const y = Math.min(maxY, Math.max(minY, dragCursorYRef.current! - row.rect.h / 2));
            const dy = y - row.rect.y;
            const rows = layout.rows.slice();
            rows[idx] = {
              ...row,
              rect: { ...row.rect, y },
              high: row.high + dy,
              low: row.low + dy,
              mid: row.mid + dy,
            };
            return { ...layout, rows };
          })()
        : layout;
    drawWaveform(ctx, theme, drawLayout, {
      cursor,
      cursorValues,
      glitches: view.glitches,
      // Hidden endpoints drop out naturally: their rows are not in the layout.
      arrows: showArrows ? view.arrows : [],
      hoverPath: hoverTrackPath,
      highlightPaths: chevronHighlightPaths,
      // A hidden track's scoped annotation would fall back to full-height.
      annotations: [...setupHoldAnnotations, ...annotations].filter(
        (a) => !a.trackPath || !hiddenTracks.has(a.trackPath),
      ),
      expandedTracks,
    });
  }, [
    view,
    visibleTracks,
    expandedList,
    expandedTracks,
    replayTime,
    hoverTrackPath,
    chevronHighlightPaths,
    annotations,
    setupHoldAnnotations,
    hiddenTracks,
    showArrows,
    panelH,
  ]);

  useEffect(() => {
    draw();
  }, [draw]);
  useEffect(() => watchBackingScale(() => draw()), [draw]);
  useEffect(() => {
    const obs = new MutationObserver(() => draw());
    obs.observe(document.documentElement, { attributes: true });
    const ro = new ResizeObserver(() => draw());
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => {
      obs.disconnect();
      ro.disconnect();
    };
  }, [draw]);

  // Time scrollbar: a native scrollbar under the plot whose thumb reflects the
  // zoom window against the full trace span. The spacer width is
  // plotWidth * (fullSpan / windowSpan), so at no zoom the bar disappears.
  useEffect(() => {
    const el = scrollRef.current;
    const spacer = el?.firstElementChild as HTMLElement | undefined;
    if (!el || !spacer || !view) return;
    const full = fullSpan;
    const fullLen = Math.max(1, full.t1 - full.t0);
    const winLen = Math.max(1, view.t1 - view.t0);
    const w = Math.max(1, el.clientWidth);
    const spacerW = Math.max(w, Math.round((w * fullLen) / winLen));
    spacer.style.width = `${spacerW}px`;
    const target = Math.round(((view.t0 - full.t0) / fullLen) * spacerW);
    if (Math.abs(el.scrollLeft - target) > 1) {
      scrollSyncRef.current = target;
      el.scrollLeft = target;
    }
  }, [view, fullSpan]);

  const onTimeScroll = () => {
    const el = scrollRef.current;
    const spacer = el?.firstElementChild as HTMLElement | undefined;
    if (!el || !spacer || !view) return;
    // Our own write, echoed back. The target is never cleared: one write can
    // raise several events.
    if (scrollSyncRef.current !== null && Math.abs(el.scrollLeft - scrollSyncRef.current) <= 1)
      return;
    const full = fullSpan;
    const fullLen = Math.max(1, full.t1 - full.t0);
    const winLen = view.t1 - view.t0;
    const t0 = Math.round(full.t0 + (el.scrollLeft / Math.max(1, spacer.offsetWidth)) * fullLen);
    setAutoFit(false);
    setAutoScroll(false);
    setWin({ t0, t1: t0 + winLen });
  };

  const zoomAt = useCallback(
    (t: number, factor: number) => {
      const cur = effectiveWin ?? view ?? fullSpan;
      const span = Math.max(10, (cur.t1 - cur.t0) * factor);
      const frac = (t - cur.t0) / Math.max(1, cur.t1 - cur.t0);
      const t0 = Math.max(0, Math.round(t - frac * span));
      setAutoFit(false);
      setWin({ t0, t1: t0 + Math.round(span) });
    },
    [effectiveWin, view, fullSpan],
  );

  const cursorFromEvent = (e: React.PointerEvent): number | null => {
    const layout = layoutRef.current;
    const canvas = canvasRef.current;
    if (!layout || !canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x < layout.metrics.labelW) return null;
    const t = Math.round(layout.xToTime(x));
    return Math.max(layout.window.t0, Math.min(layout.window.t1, t));
  };

  const rowFromEvent = (e: React.PointerEvent): WaveformRow | null => {
    const layout = layoutRef.current;
    const canvas = canvasRef.current;
    if (!layout || !canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const y = e.clientY - rect.top;
    return layout.rows.find((r) => y >= r.rect.y && y <= r.rect.y + r.rect.h) ?? null;
  };

  const trackFromEvent = (e: React.PointerEvent): string | null =>
    rowFromEvent(e)?.track.path ?? null;

  /** The bus path a chevron click at this row would toggle: only the
   *  "folder" row itself (the origin's own width>1 track, which always
   *  stays rendered per expandedList's comment, expanded or not) draws one
   *  -- a lane child row never does, the folder owns the group. */
  const chevronPathFor = (row: WaveformRow): string | null =>
    row.track.width > 1 ? row.track.path : null;

  /** The chevron group path under the cursor, if it lands exactly on the
   *  chevron glyph -- shared by pointerdown-arm and hover-highlight so the
   *  hit geometry can't drift between the two. */
  const chevronPathAt = (e: React.PointerEvent): string | null => {
    const layout = layoutRef.current;
    const canvas = canvasRef.current;
    if (!layout || !canvas) return null;
    const canvasRect = canvas.getBoundingClientRect();
    if (e.clientX - canvasRect.left >= layout.metrics.labelW) return null;
    const row = rowFromEvent(e);
    if (!row) return null;
    const chevronPath = chevronPathFor(row);
    if (!chevronPath) return null;
    const cx = e.clientX - canvasRect.left;
    const cy = e.clientY - canvasRect.top;
    const r = chevronRect(row.rect);
    return cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h ? chevronPath : null;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    canvasRef.current?.setPointerCapture(e.pointerId);
    canvasRef.current?.focus();
    if (e.button === 1 || e.shiftKey) {
      dragRef.current = { kind: 'pan', lastX: e.clientX };
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    // Label-column press: chevron toggle first (Task 5), else drag the row
    // up/down to reorder (owner decision) -- the chevron sits inside the
    // same label column, so it must win before the reorder branch claims
    // every press there.
    const layout = layoutRef.current;
    const canvas = canvasRef.current;
    if (
      layout &&
      canvas &&
      e.clientX - canvas.getBoundingClientRect().left < layout.metrics.labelW
    ) {
      dragCursorYRef.current = e.clientY - canvas.getBoundingClientRect().top;
      const chevronPath = chevronPathAt(e);
      if (chevronPath) {
        // Drag starts immediately (same reorder mechanism as any other row,
        // moving the whole group since lanes inherit the folder's sort key)
        // -- `moved` only tracks whether a real reorder happened, to decide
        // at pointerup whether this was actually just a click-to-toggle.
        chevronDragRef.current = { path: chevronPath, moved: false };
        dragRef.current = { kind: 'reorder', path: chevronPath };
        draw();
        return;
      }
      const row = rowFromEvent(e);
      const path = row?.track.path ?? null;
      if (path) {
        dragRef.current = { kind: 'reorder', path };
        draw();
      }
      return;
    }
    const t = cursorFromEvent(e);
    if (t === null) return;
    if (e.altKey) {
      // Alt+click: Δt measure -- first edge arms, second commits an interval.
      if (!measure) setMeasure({ t0: t });
      else {
        setAnnotations((a) => [...a, { kind: 'interval', t0: measure.t0, t1: t }]);
        setMeasure(null);
      }
      return;
    }
    dragRef.current = { kind: 'scrub', lastX: e.clientX };
    store.getState().setReplayTime(t);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const chevronDrag = chevronDragRef.current;
    const drag = dragRef.current;
    if (drag?.kind === 'reorder') {
      // Live cursor Y, always current regardless of React state timing --
      // draw() reads this directly to keep the dragged row visually stuck to
      // the cursor even between the discrete row-boundary-crossing swaps
      // below.
      const canvasEl = canvasRef.current;
      if (canvasEl) dragCursorYRef.current = e.clientY - canvasEl.getBoundingClientRect().top;
      const overRow = rowFromEvent(e);
      const over = overRow?.track.path ?? null;
      // A lane only reorders among its own siblings; a folder/plain row
      // (no group of its own) can never be dropped in the middle of ANY
      // folder's children either -- one rule covers both: the drop target's
      // group must match the dragged item's own group (null only matches
      // another non-lane row).
      const origin = laneOriginPath(drag.path);
      const overOrigin = over ? laneOriginPath(over) : null;
      if (overOrigin !== origin) {
        draw();
        return;
      }
      if (over && overRow && over !== drag.path) {
        // Dragging a folder pulls its own children along: they're excluded
        // from the explicit order entirely (rather than repositioned
        // individually) so they re-inherit the folder's new slot instead of
        // freezing wherever they happened to sit before the drag.
        const ownChildren = expandedTracks.has(drag.path)
          ? new Set(
              expandedList.filter((t) => laneOriginPath(t.path) === drag.path).map((t) => t.path),
            )
          : null;
        // Full order (hidden included) so hides don't scramble the sequence;
        // orderKeyFor (not a plain trackOrder-or-board-order fallback) so a
        // still-unordered lane row's CURRENT displayed position -- inherited
        // from its parent's slot -- is what the drag inserts relative to.
        const full = expandedList
          .map((t) => ({ p: t.path, k: orderKeyFor(t.path) }))
          .sort((a, b) => a.k - b.k)
          .map((e2) => e2.p)
          .filter((p) => p !== drag.path && !ownChildren?.has(p));
        const at = full.indexOf(over);
        if (at >= 0) {
          // Insert before or after the hovered row depending on which half
          // of it the cursor sits in -- always inserting before meant the
          // dragged row could approach the LAST row but never actually pass
          // it (there's nothing after the last slot to push it into), so
          // "drag to bottommost" silently capped one short while "drag to
          // topmost" worked (pushing the old first row down has somewhere
          // to go).
          const cursorY = e.clientY - (canvasEl?.getBoundingClientRect().top ?? 0);
          const pastMid = cursorY > overRow.rect.y + overRow.rect.h / 2;
          full.splice(pastMid ? at + 1 : at, 0, drag.path);
          setTrackOrder(full);
          if (chevronDrag) chevronDrag.moved = true;
        }
      }
      draw();
      return;
    }
    if (!drag && !chevronDrag) {
      const hover = chevronPathAt(e);
      setChevronHoverGroup((prev) => (prev === hover ? prev : hover));
    } else if (chevronHoverGroup !== null) {
      setChevronHoverGroup(null);
    }
    if (drag?.kind === 'pan') {
      const layout = layoutRef.current;
      if (!layout) return;
      const cur = effectiveWin ?? view ?? fullSpan;
      const dt = Math.round(
        ((drag.lastX - e.clientX) / Math.max(1, layout.plot.w)) * (cur.t1 - cur.t0),
      );
      drag.lastX = e.clientX;
      const t0 = Math.max(0, cur.t0 + dt);
      // Dragging the plot is the user saying where to look; both toggles are
      // automatic behaviour they have just overridden.
      setAutoFit(false);
      setAutoScroll(false);
      setWin({ t0, t1: t0 + (cur.t1 - cur.t0) });
      return;
    }
    if (drag?.kind === 'scrub') {
      const t = cursorFromEvent(e);
      if (t !== null) store.getState().setReplayTime(t);
      return;
    }
    store.getState().setHoverTrack(trackFromEvent(e));
  };

  const onPointerUp = () => {
    const chevronDrag = chevronDragRef.current;
    chevronDragRef.current = null;
    // Never promoted to a drag: a plain click, so toggle expand/collapse.
    if (chevronDrag && !chevronDrag.moved) {
      setExpandedTracks((prev) => {
        const next = new Set(prev);
        if (next.has(chevronDrag.path)) next.delete(chevronDrag.path);
        else next.add(chevronDrag.path);
        return next;
      });
    }
    dragRef.current = null;
    dragCursorYRef.current = null;
    draw();
  };

  const onWheel = (e: React.WheelEvent) => {
    const layout = layoutRef.current;
    const canvas = canvasRef.current;
    if (!layout || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const t = layout.xToTime(e.clientX - rect.left);
    zoomAt(t, e.deltaY > 0 ? 1.25 : 0.8);
  };

  const stepCursor = (dir: 1 | -1, coarse: boolean) => {
    if (!view) return;
    const st = store.getState();
    const cur = st.replayTimePs ?? (dir > 0 ? view.t0 - 1 : view.t1 + 1);
    if (coarse) {
      const step = tickStepPs(view.t1 - view.t0, 10);
      st.setReplayTime(Math.max(view.t0, Math.min(view.t1, cur + dir * step)));
      return;
    }
    const times = eventTimes(view);
    const next = dir > 0 ? times.find((t) => t > cur) : [...times].reverse().find((t) => t < cur);
    if (next !== undefined) st.setReplayTime(next);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Panel-scoped keys only; the global grammar (Space/./Enter/Esc...) stays
    // with the workbench when the panel is unfocused.
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      stepCursor(e.key === 'ArrowRight' ? 1 : -1, e.shiftKey);
    } else if (e.key === '+' || e.key === '=') {
      e.stopPropagation();
      const c = replayTime ?? (view ? (view.t0 + view.t1) / 2 : 0);
      zoomAt(c, 0.8);
    } else if (e.key === '-') {
      e.stopPropagation();
      const c = replayTime ?? (view ? (view.t0 + view.t1) / 2 : 0);
      zoomAt(c, 1.25);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      if (measure) setMeasure(null);
      else if (replayTime !== null) store.getState().setReplayTime(null);
      else canvasRef.current?.blur();
    }
  };

  const hasBands = !!view?.tracks.some((t) => t.bands.length);

  return (
    <div className={`wave-panel${open ? ' wave-panel--open' : ''}`}>
      {open && (
        <div
          className="wave-panel__resize"
          title="Drag to resize the panel"
          onPointerDown={(e) => {
            resizeRef.current = {
              startY: e.clientY,
              startH: panelH ?? wrapRef.current?.clientHeight ?? 200,
            };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const r = resizeRef.current;
            if (!r) return;
            const max = Math.round(window.innerHeight * 0.8);
            setPanelH(Math.min(max, Math.max(120, r.startH + (r.startY - e.clientY))));
          }}
          onPointerUp={() => {
            resizeRef.current = null;
          }}
        />
      )}
      <div className="wave-panel__header">
        <button
          type="button"
          className="tool-btn"
          title="Toggle the waveform panel"
          onClick={() => store.getState().setWaveformOpen(!open)}
        >
          {open ? '▾ Waveforms' : '▸ Waveforms'}
        </button>
        {open && (
          <>
            <label className="wave-panel__toggle" title="Keep the whole recorded trace in view">
              <input
                type="checkbox"
                checked={autoFit}
                onChange={(e) => {
                  const on = e.target.checked;
                  // Turning it off freezes the span exactly where it looks
                  // right now, so unchecking never re-zooms.
                  if (!on && view) setWin({ t0: view.t0, t1: view.t1 });
                  setAutoFit(on);
                }}
              />
              Autofit
            </label>
            <label
              className="wave-panel__toggle"
              title="Keep the newest sample in view; off holds the time you scrolled to"
            >
              <input
                type="checkbox"
                checked={autoScroll}
                disabled={autoFit}
                onChange={(e) => setAutoScroll(e.target.checked)}
              />
              Autoscroll
            </label>
            <button
              type="button"
              className="tool-btn"
              disabled={annotations.length === 0}
              title="Clear Δt measures"
              onClick={() => setAnnotations([])}
            >
              Clear Δt
            </button>
            <span className="wave-panel__signals" ref={signalsRef}>
              <button
                type="button"
                className="tool-btn"
                title="Choose which signals display (drag a row's label to reorder)"
                onClick={() => setSignalsOpen((v) => !v)}
              >
                Signals{hiddenTracks.size ? ` (${hiddenTracks.size} hidden)` : ''}
              </button>
              {signalsOpen && view && (
                <div className="wave-panel__signals-pop">
                  {view.tracks.map((t) => (
                    <label key={t.path}>
                      <input
                        type="checkbox"
                        checked={!hiddenTracks.has(t.path)}
                        onChange={() =>
                          setHiddenTracks((prev) => {
                            const next = new Set(prev);
                            if (next.has(t.path)) next.delete(t.path);
                            else next.add(t.path);
                            return next;
                          })
                        }
                      />
                      {t.label}
                    </label>
                  ))}
                </div>
              )}
            </span>
            <button
              type="button"
              className="tool-btn"
              aria-pressed={showArrows}
              title="Show cause arrows between tracks (H&H Fig 2.69)"
              onClick={() => setShowArrows((v) => !v)}
            >
              Arrows
            </button>
            {column && (
              <label className="wave-panel__threshold">
                glitch &lt;
                <input
                  type="number"
                  min={1}
                  value={thresholdNs}
                  onChange={(e) => setThresholdNs(Math.max(1, Number(e.target.value) || 1))}
                />
                ns
              </label>
            )}
            {measure && <span className="wave-panel__hint">Δt: Alt+click the second edge…</span>}
            {replayTime !== null && (
              <span className="wave-panel__hint">
                {compact ? 'replay' : 'replay · Esc or Space/step returns to live'}
              </span>
            )}
            {hasBands && (
              <span className="wave-panel__footnote">t_cd estimated (0.35 × t_pd typ)</span>
            )}
          </>
        )}
      </div>
      {open && (
        <div
          className="wave-panel__body"
          ref={wrapRef}
          style={panelH !== null ? { height: panelH, maxHeight: panelH } : undefined}
        >
          {view && view.tracks.length > 0 ? (
            <>
              <canvas
                ref={canvasRef}
                className="wave-panel__canvas"
                tabIndex={0}
                onPointerDown={(e) => {
                  if (e.pointerType === 'touch') {
                    touchRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
                    if (touchRef.current.size === 2) {
                      // The second finger turns a cursor drag into a pan.
                      dragRef.current = null;
                      gestureRef.current = gesture();
                      return;
                    }
                  }
                  onPointerDown(e);
                }}
                onPointerMove={(e) => {
                  if (e.pointerType === 'touch' && touchRef.current.has(e.pointerId)) {
                    touchRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
                    if (touchRef.current.size >= 2) {
                      const now = gesture();
                      const was = gestureRef.current;
                      const layout = layoutRef.current;
                      const canvas = canvasRef.current;
                      if (now && was && layout && canvas) {
                        const rect = canvas.getBoundingClientRect();
                        if (Math.abs(now.dist - was.dist) > 1) {
                          zoomAt(layout.xToTime(now.midX - rect.left), was.dist / now.dist);
                        }
                        const el = scrollRef.current;
                        if (el) el.scrollLeft -= now.midX - was.midX;
                        gestureRef.current = now;
                      }
                      return;
                    }
                  }
                  onPointerMove(e);
                }}
                onPointerUp={(e) => {
                  if (e.pointerType === 'touch') {
                    touchRef.current.delete(e.pointerId);
                    if (touchRef.current.size < 2) gestureRef.current = null;
                  }
                  onPointerUp();
                }}
                onPointerCancel={(e) => {
                  touchRef.current.delete(e.pointerId);
                  gestureRef.current = null;
                }}
                onPointerLeave={() => store.getState().setHoverTrack(null)}
                onWheel={onWheel}
                onKeyDown={onKeyDown}
                // One-shot fit; deliberately does not touch either toggle.
                onDoubleClick={() => setWin({ ...fullSpan })}
              />
              <div
                ref={scrollRef}
                className="wave-panel__timescroll"
                style={{ marginLeft: defaultWaveformMetrics.labelW }}
                onScroll={onTimeScroll}
              >
                <div />
              </div>
            </>
          ) : (
            <div className="wave-panel__empty">
              {powered
                ? 'No tracks: add a probe, clock, or I/O device.'
                : 'Power on to record a trace.'}
              {running ? '' : ''}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
