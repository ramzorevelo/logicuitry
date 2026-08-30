import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCircuitStore } from './circuitStore';
import { componentPaths } from '../../core/model/compile';
import { analysisTablesOf, type OutputAnalysis } from '../../core/gates/verify';
import { permuteTableInputs, type TruthTable } from '../../core/boolean/truthTable';
import {
  buildKmap,
  implicantTerm,
  isLegalGroup,
  minimalCover,
  MAX_KMAP_INPUTS,
  MIN_KMAP_INPUTS,
  type ImplicantLiteral,
  type KmapAxisLayout,
} from '../../core/boolean/kmap';
import { compressTable, type CompressedRow } from '../../core/boolean/compress';
import {
  drawKmap,
  kmapCellAt,
  kmapGroupAt,
  layoutKmap,
  type KmapGroupDraw,
  type KmapLayout,
} from '../../render/kmap';
import { readTheme } from '../../render/theme';
import { sizeCanvas, watchBackingScale } from '../canvasBacking';
import { isFullyKnown } from '../../core/value/busValue';

// Analyze drawer: per-output truth tables (reachable,
// net-deduped inputs) plus an interactive K-map for 2-4 inputs. Circles and
// cursor are drawer-local UI state, never board state -- not in undo history,
// not persisted. Grouping is Ctrl-only: Ctrl+click/drag toggles cells into the
// candidate, releasing Ctrl commits it; plain clicks only touch outlines.

/** The terminal's own name, without its scope: a grouped component's path is
 *  `main/<group>/<name>`, and repeating the group in every truth-table column
 *  header buries the one letter the reader is there for. The group is shown
 *  once, as the heading over the table. */
const displayName = (path: string): string =>
  path
    .replace(/\.(y|a)(\[\d+\])?$/, '$2')
    .replace(/^main\//, '')
    .replace(/^.*\//, '');

/** A terminal path without its pin suffix, which is how components are keyed. */
const basePath = (path: string): string => path.replace(/\.(y|a)(\[\d+\])?$/, '');

/** The group a terminal path is scoped to, or '' for a board-level one. */
const groupOfPath = (path: string): string => {
  const rest = path.replace(/\.(y|a)(\[\d+\])?$/, '$2').replace(/^main\//, '');
  const cut = rest.lastIndexOf('/');
  return cut < 0 ? '' : rest.slice(0, cut);
};

interface Circle {
  minterms: number[];
  color: number;
}

/** Display char for one table cell: 'X' = instructor-marked don't-care,
 *  '–' = circuit-unknown (X/Z), else '0'/'1'. */
function bitChar(t: TruthTable, row: number, col: number, dc?: ReadonlySet<number>): string {
  if (dc?.has(row)) return 'X';
  const v = t.rows[row]![col]!;
  if (!isFullyKnown(v, 1)) return '–';
  return (v.v & 1) === 1 ? '1' : '0';
}

/** Owner-locked layout lists (no AC pairing for 3-var). */
function layoutOptions(n: number): KmapAxisLayout[] {
  if (n === 2)
    return [
      { cols: [0], rows: [1] },
      { cols: [1], rows: [0] },
    ];
  if (n === 3)
    return [
      { cols: [0, 1], rows: [2] },
      { cols: [0], rows: [1, 2] },
      { cols: [1, 2], rows: [0] },
      { cols: [2], rows: [0, 1] },
    ];
  return [
    { cols: [0, 1], rows: [2, 3] },
    { cols: [2, 3], rows: [0, 1] },
  ];
}

const lowestUnusedColor = (circles: readonly Circle[]): number => {
  let c = 0;
  while (circles.some((g) => g.color === c)) c++;
  return c;
};

const groupVar = (color: number): string => `var(--kmap-g${(color % 8) + 1})`;

function Term({
  term,
  nameOf,
}: {
  term: readonly ImplicantLiteral[];
  /** Board-backed display name; a path may carry a disambiguating id. */
  nameOf: (path: string) => string;
}) {
  if (term.length === 0) return <span>1</span>;
  return (
    <span>
      {term.map((l, i) => (
        <span key={i} style={l.negated ? { textDecoration: 'overline' } : undefined}>
          {nameOf(l.var)}
        </span>
      ))}
    </span>
  );
}

export function AnalyzeDrawer({ onClose }: { onClose: () => void }) {
  const rev = useCircuitStore((s) => s.rev);
  const board = useCircuitStore((s) => s.board);
  const chipLib = useCircuitStore((s) => s.chipLib);

  const analyses: {
    outputs: OutputAnalysis[];
    error: string | null;
  } = useMemo(() => {
    try {
      const outputs = analysisTablesOf(board, chipLib);
      if (outputs.length === 0) throw new RangeError('no output terminal (output/LED/probe)');
      return { outputs, error: null };
    } catch (e) {
      return { outputs: [], error: e instanceof Error ? e.message : String(e) };
    }
    // rev is the store's mutation counter; board identity may be stable.
  }, [rev, board, chipLib]);
  const outputs = analyses.outputs;

  /** Terminal path -> what to call it on screen.
   *
   *  Read from the board, not parsed out of the path: a path is an identity
   *  and may have fallen back to a component id to stay unique (a switch and
   *  the LED it drives may share a name), which is not what the reader should
   *  see. `A` stays `A`. */
  const shown = useMemo(() => {
    const paths = componentPaths(board, 'main/');
    const byPath = new Map<string, { name: string; group: string }>();
    for (const c of board.components) {
      const g = c.group ? (board.groups?.find((x) => x.id === c.group)?.name ?? '') : '';
      byPath.set(paths.get(c.id)!, { name: c.label || c.id, group: g });
    }
    return byPath;
  }, [board]);

  /** Bare terminal name for a column header. */
  const nameOfPath = (path: string): string => shown.get(basePath(path))?.name ?? displayName(path);

  /** `<group>: <name>` for an output tab, and just the one where the group is
   *  named after the very expression the output is labelled with -- repeating
   *  it says nothing twice. */
  const tabLabel = (path: string): string => {
    const at = shown.get(basePath(path));
    const name = at?.name ?? displayName(path);
    const group = at?.group ?? groupOfPath(path);
    return !group || group === name ? name || group : `${group}: ${name}`;
  };

  const [outputIndex, setOutputIndex] = useState(0);
  const outIdx = Math.max(0, Math.min(outputIndex, outputs.length - 1));
  const current = outputs[outIdx];
  const outPath = current?.outputPath ?? '';

  // Circles keyed by output path; each output drops its own circles when its
  // reachable-input signature shifts (per-output tables).
  const [circles, setCircles] = useState<Record<string, Circle[]>>({});
  // Don't-care minterms per output, drawer-local like circles (owner decision
  // 1): never persisted, dropped exactly when that output's circles drop.
  const [dcSets, setDcSets] = useState<Record<string, Set<number>>>({});
  const [layoutSel, setLayoutSel] = useState<Record<string, number>>({});
  /** Drawer-local input column order per output (reorder buttons). */
  const [inputOrder, setInputOrder] = useState<Record<string, string[]>>({});

  const orderedPaths = useCallback(
    (path: string, paths: readonly string[]): string[] => {
      const kept = (inputOrder[path] ?? []).filter((p) => paths.includes(p));
      return [...kept, ...paths.filter((p) => !kept.includes(p))];
    },
    [inputOrder],
  );
  // The displayed table: the core table with columns permuted to the chosen
  // order. Minterm indexing follows the view order, so a reorder reads as an
  // input-signature change (circles drop -- their indices would lie).
  const viewTableOf = useCallback(
    (o: OutputAnalysis): TruthTable | null => {
      if (!o.table) return null;
      const order = orderedPaths(o.outputPath, o.table.inputPaths).map((p) =>
        o.table!.inputPaths.indexOf(p),
      );
      return order.every((v, i) => v === i) ? o.table : permuteTableInputs(o.table, order);
    },
    [orderedPaths],
  );
  const table = useMemo(() => (current ? viewTableOf(current) : null), [current, viewTableOf]);
  const [reveal, setReveal] = useState(false);
  const [cursor, setCursor] = useState<number | null>(null);
  const [candidate, setCandidate] = useState<Set<number> | null>(null);
  const [illegalFlash, setIllegalFlash] = useState(false);
  const [hoverGroup, setHoverGroup] = useState<number | null>(null);
  /** Centered focus view: the whole K-map section in a screen-center panel. */
  const [maximized, setMaximized] = useState(false);
  /** Read-only auto-derived compressed truth-table view (Fig 2.29), full-table
   *  (n<=4) only; recomputes on reorder like the table itself. */
  const [compressed, setCompressed] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<{ outPath: string; index: number } | null>(
    null,
  );
  const anchorRef = useRef<number | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sigsRef = useRef<Record<string, string>>({});

  useEffect(() => {
    const sigs: Record<string, string> = {};
    for (const o of outputs) sigs[o.outputPath] = viewTableOf(o)?.inputPaths.join('|') ?? '';
    const changed = Object.keys(sigs).filter((p) => sigsRef.current[p] !== sigs[p]);
    sigsRef.current = sigs;
    setCircles((prev) => {
      const next: Record<string, Circle[]> = {};
      for (const [path, groups] of Object.entries(prev)) {
        const o = outputs.find((x) => x.outputPath === path);
        const view = o ? viewTableOf(o) : null;
        if (!view) continue;
        if (changed.includes(path)) continue; // input set/order shifted: drop all
        // Same input indexing: silently drop only the now-illegal circles.
        next[path] = groups.filter((g) => isLegalGroup(view, 0, g.minterms, dcSets[path]));
      }
      return next;
    });
    // Minterm indices are view-order, so a reorder already reads as a
    // signature change above -- DC marks drop with it, same as circles.
    setDcSets((prev) => {
      const next: Record<string, Set<number>> = {};
      for (const [path, dc] of Object.entries(prev)) {
        const o = outputs.find((x) => x.outputPath === path);
        const view = o ? viewTableOf(o) : null;
        if (!view) continue;
        if (changed.includes(path)) continue;
        next[path] = dc;
      }
      return next;
    });
    if (changed.length > 0) {
      setLayoutSel((prev) => {
        const next = { ...prev };
        for (const p of changed) delete next[p];
        return next;
      });
      setCandidate(null);
      setCursor(null);
      setSelectedGroup(null);
      setHoverGroup(null);
    }
  }, [outputs, viewTableOf]);

  const n = table?.inputPaths.length ?? 0;
  const kmapEligible = table !== null && n >= MIN_KMAP_INPUTS && n <= MAX_KMAP_INPUTS;
  const myCircles = useMemo(() => circles[outPath] ?? [], [circles, outPath]);
  const myDcs = useMemo(() => dcSets[outPath] ?? new Set<number>(), [dcSets, outPath]);
  const layouts = useMemo(() => (kmapEligible ? layoutOptions(n) : []), [kmapEligible, n]);
  const layoutIdx = Math.min(layoutSel[outPath] ?? 0, Math.max(0, layouts.length - 1));

  const layout: KmapLayout | null = useMemo(() => {
    if (!kmapEligible || !table) return null;
    // Maximized: scale the cell to the viewport (sampled at toggle time) so
    // the map actually fills the focus panel instead of staying drawer-sized.
    const metrics = maximized
      ? (() => {
          const cell = Math.max(64, Math.min(160, Math.floor(window.innerHeight / 8)));
          return { cell, labelW: Math.round(cell * 1.3), labelH: Math.round(cell * 0.9) };
        })()
      : undefined;
    return layoutKmap(buildKmap(table, 0, layouts[layoutIdx], myDcs), 0, 0, metrics);
  }, [kmapEligible, table, layouts, layoutIdx, maximized, myDcs]);

  const revealGroups: number[][] = useMemo(() => {
    if (!reveal || !kmapEligible || !table) return [];
    return minimalCover(table, 0, myDcs);
  }, [reveal, kmapEligible, table, myDcs]);

  const compressedRows: readonly CompressedRow[] = useMemo(() => {
    if (!table || n > 4) return [];
    return compressTable(table, 0, myDcs);
  }, [table, n, myDcs]);

  const names = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of table?.inputPaths ?? []) m.set(p, nameOfPath(p));
    return m;
  }, [table]);

  const ones = useMemo(() => {
    // Real 1s only -- a DC-marked minterm is never "uncovered" (owner rule).
    if (!table) return new Set<number>();
    const s = new Set<number>();
    for (let r = 0; r < table.rows.length; r++) if (bitChar(table, r, 0, myDcs) === '1') s.add(r);
    return s;
  }, [table, myDcs]);
  const uncovered = useMemo(() => {
    const covered = new Set(myCircles.flatMap((g) => g.minterms));
    let c = 0;
    for (const m of ones) if (!covered.has(m)) c++;
    return c;
  }, [ones, myCircles]);

  // A DC toggle can make an existing user circle illegal (or legal); the
  // signature-change effect above only fires on input-set/order changes, so
  // this mirrors it for the narrower "this output's own DC set changed" case.
  useEffect(() => {
    if (!table) return;
    setCircles((prev) => {
      const groups = prev[outPath];
      if (!groups) return prev;
      const kept = groups.filter((g) => isLegalGroup(table, 0, g.minterms, myDcs));
      if (kept.length === groups.length) return prev;
      return { ...prev, [outPath]: kept };
    });
  }, [myDcs, table, outPath]);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const maxPanelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // Keyboard stays drawer-scoped: focus the focus-view panel (inside the
    // drawer's keydown root) so arrows/Enter/Esc keep working maximized.
    if (maximized) maxPanelRef.current?.focus();
  }, [maximized]);
  const drawGroups: KmapGroupDraw[] = useMemo(
    () => [
      ...myCircles.map((g, i) => ({
        minterms: g.minterms,
        style: 'user' as const,
        color: g.color,
        inset: i,
      })),
      // Reveal cover: a group identical to a user circle shares its color
      // (and takes the next inset step so both outlines stay visible); the
      // rest take the lowest colors no user circle owns, in cover order.
      ...(() => {
        const userColors = new Set(myCircles.map((c) => c.color));
        let nextColor = 0;
        return revealGroups.map((g, i) => {
          const key = g.join(',');
          const match = myCircles.findIndex((c) => c.minterms.join(',') === key);
          if (match !== -1)
            return {
              minterms: g,
              style: 'reveal' as const,
              color: myCircles[match]!.color,
              inset: match + 1,
            };
          while (userColors.has(nextColor)) nextColor++;
          return {
            minterms: g,
            style: 'reveal' as const,
            color: nextColor++,
            inset: myCircles.length + i,
          };
        });
      })(),
    ],
    [myCircles, revealGroups],
  );
  const emphasis = useMemo(() => {
    const s = new Set<number>();
    if (hoverGroup !== null) s.add(hoverGroup);
    if (selectedGroup && selectedGroup.outPath === outPath) s.add(selectedGroup.index);
    return s;
  }, [hoverGroup, selectedGroup, outPath]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !layout) return;
    const w = layout.width + 8;
    const h = layout.height + 8;
    const ctx = sizeCanvas(canvas, w, h);
    if (!ctx) return;
    const theme = readTheme();
    ctx.clearRect(0, 0, w, h);
    drawKmap(ctx, theme, layout, {
      names,
      outName: nameOfPath(outPath),
      groups: drawGroups,
      candidate,
      candidateIllegal: illegalFlash,
      cursor,
      emphasis,
    });
  }, [layout, names, outPath, drawGroups, candidate, illegalFlash, cursor, emphasis]);

  useEffect(() => {
    draw();
  }, [draw]);
  useEffect(() => {
    // Redraw on theme flips (tokens change, no React state involved).
    const obs = new MutationObserver(() => draw());
    obs.observe(document.documentElement, { attributes: true });
    return () => obs.disconnect();
  }, [draw]);
  // Backing-scale changes (zoom, DPR flips, pinch) redraw via the shared helper.
  useEffect(() => watchBackingScale(() => draw()), [draw]);
  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    },
    [],
  );

  const commitCandidate = useCallback(
    (cells: Set<number>) => {
      if (!table || cells.size === 0) return;
      const minterms = [...cells].sort((a, b) => a - b);
      if (isLegalGroup(table, 0, minterms, myDcs)) {
        setCircles((prev) => {
          const mine = prev[outPath] ?? [];
          return {
            ...prev,
            [outPath]: [...mine, { minterms, color: lowestUnusedColor(mine) }],
          };
        });
        setCandidate(null);
        setIllegalFlash(false);
      } else {
        setIllegalFlash(true);
        if (flashTimer.current) clearTimeout(flashTimer.current);
        flashTimer.current = setTimeout(() => {
          setIllegalFlash(false);
          setCandidate(null);
        }, 600);
      }
    },
    [table, outPath, myDcs],
  );

  // Ctrl-release commits the candidate; window blur too so a candidate never
  // sticks when focus leaves mid-gesture.
  const candidateRef = useRef<Set<number> | null>(null);
  candidateRef.current = candidate;
  useEffect(() => {
    const commitPending = () => {
      gestureRef.current = null;
      if (candidateRef.current && candidateRef.current.size > 0)
        commitCandidate(candidateRef.current);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Control') commitPending();
    };
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', commitPending);
    return () => {
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', commitPending);
    };
  }, [commitCandidate]);

  const canvasPoint = (e: React.PointerEvent): { x: number; y: number } => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  /** Cells already toggled by the current press-drag pass (no flutter);
   *  `mode` mirrors Ctrl-grouping vs Alt-don't-care so one drag pass never
   *  mixes the two gestures. */
  const gestureRef = useRef<{ mode: 'group' | 'dc'; cells: Set<number> } | null>(null);

  // Pointer path never moves the keyboard cursor -- a Ctrl gesture leaving a
  // cursor square behind read as a stuck selection.
  const toggleCell = (m: number) => {
    setIllegalFlash(false);
    setCandidate((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(m)) next.delete(m);
      else next.add(m);
      return next;
    });
  };

  // Don't-care marking commits immediately per cell (no staging/candidate --
  // it's authoring, not a circled answer), and is never gated by hideAnswers.
  const toggleDc = (m: number) => {
    setDcSets((prev) => {
      const mine = new Set(prev[outPath] ?? []);
      if (mine.has(m)) mine.delete(m);
      else mine.add(m);
      return { ...prev, [outPath]: mine };
    });
  };

  const userGroupAt = (x: number, y: number): number | undefined => {
    if (!layout) return undefined;
    // Hit-test user circles only: a reveal outline drawn on top (identical or
    // overlapping group) must not shadow the user circle underneath.
    return kmapGroupAt(layout, drawGroups.slice(0, myCircles.length), x, y);
  };

  const deleteGroup = (index: number) => {
    setCircles((prev) => ({
      ...prev,
      [outPath]: (prev[outPath] ?? []).filter((_, i) => i !== index),
    }));
    setSelectedGroup(null);
    setHoverGroup(null);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!layout) return;
    const p = canvasPoint(e);
    if (e.altKey) {
      // Alt don't-care sweep: toggle the pressed cell, start a drag pass.
      // Checked before Ctrl so Alt always wins if both are somehow held --
      // Alt never touches the candidate or outlines.
      e.preventDefault(); // Alt alone has browser menu-focus meaning.
      const m = kmapCellAt(layout, p.x, p.y);
      if (m === undefined) return;
      gestureRef.current = { mode: 'dc', cells: new Set([m]) };
      toggleDc(m);
      (e.target as Element).setPointerCapture(e.pointerId);
      return;
    }
    if (e.ctrlKey) {
      // Ctrl grouping: toggle the pressed cell, start a drag pass.
      const m = kmapCellAt(layout, p.x, p.y);
      if (m === undefined) return;
      gestureRef.current = { mode: 'group', cells: new Set([m]) };
      toggleCell(m);
      (e.target as Element).setPointerCapture(e.pointerId);
      return;
    }
    // Plain click: outlines only (decision 4). Shift+click deletes the hit
    // group; plain click selects it (highlight persists).
    const hit = userGroupAt(p.x, p.y);
    if (hit !== undefined) {
      if (e.shiftKey) deleteGroup(hit);
      else setSelectedGroup({ outPath, index: hit });
      return;
    }
    setSelectedGroup(null);
    setCursor(null);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!layout) return;
    const p = canvasPoint(e);
    if (gestureRef.current?.mode === 'dc' && e.altKey) {
      const m = kmapCellAt(layout, p.x, p.y);
      if (m === undefined || gestureRef.current.cells.has(m)) return;
      gestureRef.current.cells.add(m);
      toggleDc(m);
      return;
    }
    if (gestureRef.current?.mode === 'group' && e.ctrlKey) {
      const m = kmapCellAt(layout, p.x, p.y);
      if (m === undefined || gestureRef.current.cells.has(m)) return;
      gestureRef.current.cells.add(m);
      toggleCell(m);
      return;
    }
    const hit = userGroupAt(p.x, p.y);
    setHoverGroup(hit ?? null);
  };
  const onPointerUp = () => {
    // The gesture pass ends; the candidate stays live until Ctrl is released
    // (DC marks already committed live, nothing pending to keep).
    gestureRef.current = null;
  };
  const onPointerLeave = () => setHoverGroup(null);

  const moveCursor = (dr: number, dc: number, grow: boolean) => {
    if (!layout) return;
    const g = layout.grid;
    let r = 0;
    let c = 0;
    outer: for (r = 0; r < g.rowCodes.length; r++)
      for (c = 0; c < g.colCodes.length; c++) if (g.cells[r]![c]!.minterm === cursor) break outer;
    if (cursor === null) {
      r = 0;
      c = 0;
    }
    const nr = Math.max(0, Math.min(g.rowCodes.length - 1, r + dr));
    const nc = Math.max(0, Math.min(g.colCodes.length - 1, c + dc));
    const m = g.cells[nr]![nc]!.minterm;
    setCursor(m);
    if (grow) {
      if (anchorRef.current === null) anchorRef.current = cursor ?? m;
      // Rectangle between the anchor and the cursor, in grid coordinates.
      let ar = 0;
      let ac = 0;
      findA: for (ar = 0; ar < g.rowCodes.length; ar++)
        for (ac = 0; ac < g.colCodes.length; ac++)
          if (g.cells[ar]![ac]!.minterm === anchorRef.current) break findA;
      const cells = new Set<number>();
      for (let rr = Math.min(ar, nr); rr <= Math.max(ar, nr); rr++)
        for (let cc = Math.min(ac, nc); cc <= Math.max(ac, nc); cc++)
          cells.add(g.cells[rr]![cc]!.minterm);
      setCandidate(cells);
    } else {
      anchorRef.current = null;
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!layout) {
      if (e.key === 'Escape') onClose();
      return;
    }
    const arrows: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    if (e.key in arrows) {
      e.preventDefault();
      const [dr, dc] = arrows[e.key]!;
      moveCursor(dr, dc, e.shiftKey);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (candidate) commitCandidate(candidate);
      anchorRef.current = null;
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      if (selectedGroup && selectedGroup.outPath === outPath) {
        deleteGroup(selectedGroup.index);
        return;
      }
      if (cursor === null) return;
      setCircles((prev) => {
        const groups = prev[outPath] ?? [];
        const idx = groups.findIndex((grp) => grp.minterms.includes(cursor));
        if (idx === -1) return prev;
        return { ...prev, [outPath]: groups.filter((_, i) => i !== idx) };
      });
    } else if (e.key.toLowerCase() === 'x') {
      // Keyboard equivalent of the Alt sweep: toggle don't-care at the cursor.
      e.preventDefault();
      if (cursor !== null) toggleDc(cursor);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (candidate) {
        setCandidate(null);
        setIllegalFlash(false);
        anchorRef.current = null;
      } else if (selectedGroup) {
        setSelectedGroup(null);
      } else if (maximized) {
        setMaximized(false);
      } else onClose();
    }
  };

  if (!current || !table) {
    return (
      <div className="analyze-drawer" tabIndex={0} onKeyDown={onKeyDown}>
        <h3>Analyze</h3>
        {outputs.length > 1 && (
          <div className="analyze-outputs" role="tablist">
            {outputs.map((o, i) => (
              <button
                key={o.outputPath}
                type="button"
                className={`tool-btn${i === outIdx ? ' tool-btn--active' : ''}`}
                onClick={() => setOutputIndex(i)}
              >
                {tabLabel(o.outputPath)}
              </button>
            ))}
          </div>
        )}
        <p className="analyze-error">analyze: {current?.error ?? analyses.error}</p>
      </div>
    );
  }

  const termStyle = (index: number, color: number): React.CSSProperties => ({
    color: groupVar(color),
    fontWeight: emphasis.has(index) ? 700 : 400,
  });

  const moveInput = (i: number, dir: -1 | 1) => {
    const order = [...table.inputPaths];
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j]!, order[i]!];
    setInputOrder((prev) => ({ ...prev, [outPath]: order }));
  };

  const layoutLabel = (l: KmapAxisLayout): string => {
    const nameOf = (i: number) => names.get(table.inputPaths[i]!) ?? table.inputPaths[i]!;
    return `${l.cols.map(nameOf).join('')}×${l.rows.map(nameOf).join('')}`;
  };

  const fullTable = n <= 4;
  const outputTabs = outputs.length > 1 && (
    <div className="analyze-outputs" role="tablist">
      {outputs.map((o, i) => (
        <button
          key={o.outputPath}
          type="button"
          className={`tool-btn${i === outIdx ? ' tool-btn--active' : ''}`}
          onClick={() => {
            setOutputIndex(i);
            setCandidate(null);
            setReveal(false);
            setSelectedGroup(null);
            setHoverGroup(null);
          }}
        >
          {tabLabel(o.outputPath)}
        </button>
      ))}
    </div>
  );
  const kmapSection =
    kmapEligible && layout ? (
      <>
        <div className="analyze-kmap-bar">
          {layouts.length > 1 && (
            <div className="analyze-layouts" role="radiogroup">
              {layouts.map((l, i) => (
                <button
                  key={i}
                  type="button"
                  className={`tool-btn${i === layoutIdx ? ' tool-btn--active' : ''}`}
                  onClick={() => setLayoutSel((prev) => ({ ...prev, [outPath]: i }))}
                >
                  {layoutLabel(l)}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            className="tool-btn"
            aria-pressed={maximized}
            title={maximized ? 'Back to the drawer (Esc)' : 'Focus the K-map screen-center'}
            onClick={() => setMaximized((v) => !v)}
          >
            {maximized ? 'Restore' : 'Maximize'}
          </button>
        </div>
        <canvas
          ref={canvasRef}
          className="analyze-kmap"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerLeave}
        />
        <div className="analyze-sop">
          {myCircles.length === 0 ? (
            <span className="analyze-muted">Ctrl+click or Ctrl+drag cells to circle a group.</span>
          ) : (
            <span>
              {nameOfPath(outPath)} ={' '}
              {myCircles.map((g, i) => (
                <span key={i} style={termStyle(i, g.color)}>
                  {i > 0 && <span style={{ color: 'inherit', fontWeight: 400 }}> + </span>}
                  <Term term={implicantTerm(table, g.minterms)} nameOf={nameOfPath} />
                </span>
              ))}
            </span>
          )}
        </div>
        <div className="analyze-status">
          {uncovered > 0
            ? `${uncovered} one${uncovered === 1 ? '' : 's'} still uncovered`
            : ones.size > 0
              ? 'all ones covered'
              : 'constant 0'}
        </div>
        <div className="analyze-reveal">
          <button
            type="button"
            className="tool-btn"
            aria-pressed={reveal}
            onClick={() => setReveal((v) => !v)}
          >
            {reveal ? 'Hide minimal cover' : 'Reveal minimal cover'}
          </button>
          {reveal && (
            <span className="analyze-sop">
              {revealGroups.length === 0 ? (
                '0'
              ) : (
                <span>
                  {revealGroups.map((g, i) => (
                    <span
                      key={i}
                      style={{ color: groupVar(drawGroups[myCircles.length + i]?.color ?? i) }}
                    >
                      {i > 0 && ' + '}
                      <Term term={implicantTerm(table, g)} nameOf={nameOfPath} />
                    </span>
                  ))}
                </span>
              )}
            </span>
          )}
        </div>
      </>
    ) : (
      <p className="analyze-muted">K-map view supports up to 4 inputs.</p>
    );

  return (
    <div className="analyze-drawer" tabIndex={0} onKeyDown={onKeyDown}>
      <h3>Analyze</h3>
      {outputTabs}
      {fullTable && (
        <div className="analyze-table-bar">
          <button
            type="button"
            className="tool-btn"
            aria-pressed={compressed}
            onClick={() => setCompressed((v) => !v)}
          >
            {compressed ? 'Full rows' : 'Compress rows'}
          </button>
        </div>
      )}
      {fullTable ? (
        <table className="analyze-table">
          <thead>
            <tr>
              {table.inputPaths.map((p, i) => (
                <th key={p}>
                  <button
                    type="button"
                    className="analyze-col-move"
                    disabled={i === 0}
                    title="Move column left"
                    onClick={() => moveInput(i, -1)}
                  >
                    ‹
                  </button>
                  {nameOfPath(p)}
                  <button
                    type="button"
                    className="analyze-col-move"
                    disabled={i === n - 1}
                    title="Move column right"
                    onClick={() => moveInput(i, 1)}
                  >
                    ›
                  </button>
                </th>
              ))}
              <th className="analyze-table__out">{nameOfPath(outPath)}</th>
            </tr>
          </thead>
          <tbody>
            {compressed
              ? compressedRows.map((row, r) => (
                  <tr key={r}>
                    {row.bits.map((b, i) => (
                      <td key={i} className={b === null ? 'analyze-table__x' : undefined}>
                        {b === null ? 'X' : b}
                      </td>
                    ))}
                    <td className="analyze-table__out">
                      {row.value === 'x' ? 'X' : row.value === null ? '–' : row.value}
                    </td>
                  </tr>
                ))
              : table.rows.map((_, r) => (
                  <tr key={r}>
                    {table.inputPaths.map((p, i) => (
                      <td key={p}>{(r >> (n - 1 - i)) & 1}</td>
                    ))}
                    <td className="analyze-table__out">{bitChar(table, r, 0, myDcs)}</td>
                  </tr>
                ))}
          </tbody>
        </table>
      ) : (
        <div
          className="analyze-heatstrip"
          title={`${table.rows.length} rows, one cell per row (MSB-first inputs)`}
        >
          {table.rows.map((_, r) => {
            const ch = bitChar(table, r, 0, myDcs);
            return (
              <span
                key={r}
                className={`analyze-heatcell analyze-heatcell--${ch === '–' ? 'u' : ch}`}
                title={`row ${r}`}
              />
            );
          })}
        </div>
      )}
      {!maximized && kmapSection}
      {maximized && (
        <div className="analyze-max-overlay">
          <div className="analyze-max-panel" ref={maxPanelRef} tabIndex={-1}>
            {outputTabs}
            {kmapSection}
          </div>
        </div>
      )}
    </div>
  );
}
