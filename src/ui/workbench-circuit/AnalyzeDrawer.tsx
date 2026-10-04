import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCircuitStore } from './circuitStore';
import { componentPaths } from '../../core/model/compile';
import { analysisTablesOf, type OutputAnalysis } from '../../core/gates/verify';
import { SEGMENT_NAMES } from '../../core/sim/primitives/display';
import { permuteTableInputs, type TruthTable } from '../../core/boolean/truthTable';
import {
  buildKmap,
  checkGroups,
  diagnoseGroup,
  essentialPrimes,
  groupTerm,
  isLegalGroup,
  minimumCovers,
  primeImplicants,
  MAX_KMAP_INPUTS,
  MIN_KMAP_INPUTS,
  type GroupCheck,
  type ImplicantLiteral,
  type KmapAxisLayout,
  type KmapPolarity,
} from '../../core/boolean/kmap';
import { sigmaOf } from '../../core/boolean/canonical';
import { compressTable, type CompressedRow } from '../../core/boolean/compress';
import { printExpr } from '../../core/boolean/expr';
import { exprOfCover, exprOfPosCover } from '../../core/boolean/synthesize';
import { compareOutputs } from '../../core/boolean/compare';
import { gateExpressions } from '../../core/gates/subexpr';
import { BoolExpr } from '../components/BoolExpr';
import { Toggle } from '../components/Toggle';
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
import { LONG_PRESS_MS, TAP_SLOP } from './touchGestures';
import { useCoarsePointer } from '../pointerKind';
import { usePrefsStore } from '../prefs';
import { ToolIcon } from '../components/ToolIcon';
import { cellKeyAction, nextCell } from './buildGrid';
import { dontCaresOf, tableOfFunction, TYPED_OUTPUT_PATH, useTypedFunction } from './typedFunction';
import { TypedEntry } from './TypedEntry';
import {
  dontCareDisagreements,
  functionLine,
  groupingRules,
  refusalMessage,
  summarizeForm,
} from './kmapText';

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

/** Both halves: removal is what a user wants the moment a circle exists. */
function groupHint(coarse: boolean): string {
  return coarse
    ? 'Long-press a cell, then drag, to circle a group. Long-press a circle to remove it.'
    : 'Ctrl+click or Ctrl+drag cells to circle a group. Shift+click a circle to remove it.';
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
  sum,
}: {
  term: readonly ImplicantLiteral[];
  /** Board-backed display name; a path may carry a disambiguating id. */
  nameOf: (path: string) => string;
  /** A POS factor: literals joined by +, parenthesised when there are several. */
  sum?: boolean;
}) {
  if (term.length === 0) return <span>{sum ? '0' : '1'}</span>;
  const lits = term.map((l, i) => (
    <span key={i}>
      {sum && i > 0 && ' + '}
      <span style={l.negated ? { textDecoration: 'overline' } : undefined}>{nameOf(l.var)}</span>
    </span>
  ));
  return <span>{sum && term.length > 1 ? <>({lits})</> : lits}</span>;
}

const circleKey = (path: string, polarity: KmapPolarity): string =>
  polarity === 'zeros' ? `${path}#0` : path;

interface RevealGroup {
  minterms: number[];
  solid: boolean;
}

const REVEAL_LABELS = ['Reveal primes', 'Mark essentials', 'Show minimum cover', 'Hide reveal'];

export function AnalyzeDrawer({
  onClose,
  onBuild,
}: {
  onClose: () => void;
  onBuild?: (expression: string) => void;
}) {
  const rev = useCircuitStore((s) => s.rev);
  const board = useCircuitStore((s) => s.board);
  const chipLib = useCircuitStore((s) => s.chipLib);

  const typed = useTypedFunction();
  const usingTyped = typed.source === 'typed';
  const boardAnalyses: {
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
  // Each output's function as wired, before any simplification.
  const asBuilt = useMemo(() => {
    try {
      return gateExpressions(board, chipLib).outputs;
    } catch {
      return new Map<string, never>();
    }
  }, [rev, board, chipLib]);
  const typedOutputs = useMemo<OutputAnalysis[]>(
    () => [{ outputPath: TYPED_OUTPUT_PATH, table: tableOfFunction(typed.fn), error: null }],
    [typed.fn],
  );
  const analyses = usingTyped ? { outputs: typedOutputs, error: null } : boardAnalyses;
  const outputs = analyses.outputs;
  const cellRefs = useRef<(HTMLButtonElement | null)[]>([]);

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

  /** Terminal path -> the segment pin it addresses, for a 7-segment display.
   *
   *  Read from the board rather than matched off the path, because `.a` alone
   *  is ambiguous: an out port's data pin is called `a` too, and stripping it
   *  as one turned every segment of a display into the display's own name. */
  const segments = useMemo(() => {
    const paths = componentPaths(board, 'main/');
    const bySeg = new Map<string, string>();
    for (const c of board.components) {
      if (c.kind !== 'sevenseg') continue;
      for (const s of SEGMENT_NAMES) bySeg.set(`${paths.get(c.id)!}.${s}`, s);
    }
    return bySeg;
  }, [board]);

  const baseOf = (path: string): string => {
    const seg = segments.get(path);
    return seg ? path.slice(0, -(seg.length + 1)) : basePath(path);
  };

  /** Bare terminal name for a column header. A display's segments are their
   *  own boolean functions, so each column is the segment, not the part. */
  const nameOfPath = (path: string): string =>
    segments.get(path) ?? shown.get(baseOf(path))?.name ?? displayName(path);

  /** `<group>: <name>` for an output tab, and just the one where the group is
   *  named after the very expression the output is labelled with -- repeating
   *  it says nothing twice. A segment tab carries the display it belongs to,
   *  since seven bare letters would not say which part they are on. */
  const tabLabel = (path: string): string => {
    const at = shown.get(baseOf(path));
    const seg = segments.get(path);
    const own = at?.name ?? displayName(baseOf(path));
    const name = seg ? `${own} ${seg}` : own;
    const group = at?.group ?? groupOfPath(path);
    return !group || group === name ? name || group : `${group}: ${name}`;
  };

  const [outputIndex, setOutputIndex] = useState(0);
  const outIdx = Math.max(0, Math.min(outputIndex, outputs.length - 1));
  /** Compare panel: the two outputs lined up, or null while closed. */
  const [comparing, setComparing] = useState<{ a: number; b: number } | null>(null);
  const current = outputs[outIdx];
  const outPath = current?.outputPath ?? '';

  // Circles keyed by output path; each output drops its own circles when its
  // reachable-input signature shifts (per-output tables).
  const [circles, setCircles] = useState<Record<string, Circle[]>>({});
  // Don't-care minterms per output, drawer-local like circles (owner decision
  // 1): never persisted, dropped exactly when that output's circles drop.
  const [boardDcSets, setDcSets] = useState<Record<string, Set<number>>>({});
  // A typed function keeps its don't-cares in its own cells, so the Alt sweep
  // and the typed entry edit one set.
  const dcSets = useMemo(
    () => (usingTyped ? { [TYPED_OUTPUT_PATH]: dontCaresOf(typed.fn) } : boardDcSets),
    [usingTyped, typed.fn, boardDcSets],
  );
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
  const kmapCellNumbers = usePrefsStore((st) => st.prefs.kmapCellNumbers);
  const kmapRulesOpen = usePrefsStore((st) => st.prefs.kmapRulesOpen);
  const setPref = usePrefsStore((st) => st.setPref);
  const [polarity, setPolarity] = useState<KmapPolarity>('ones');
  const otherPolarity: KmapPolarity = polarity === 'ones' ? 'zeros' : 'ones';
  const myKey = circleKey(outPath, polarity);
  /** Reveal stage per polarity: 0 off, 1 primes, 2 essentials, 3 minimum cover. */
  const [revealStage, setRevealStage] = useState<Record<KmapPolarity, number>>({
    ones: 0,
    zeros: 0,
  });
  const [coverIdx, setCoverIdx] = useState(0);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [checkResult, setCheckResult] = useState<GroupCheck | null>(null);
  const stage = revealStage[polarity];
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
      for (const [key, groups] of Object.entries(prev)) {
        const path = key.replace(/#0$/, '');
        const pol: KmapPolarity = key.endsWith('#0') ? 'zeros' : 'ones';
        const o = outputs.find((x) => x.outputPath === path);
        const view = o ? viewTableOf(o) : null;
        if (!view) continue;
        if (changed.includes(path)) continue; // input set/order shifted: drop all
        // Same input indexing: silently drop only the now-illegal circles.
        next[key] = groups.filter((g) => isLegalGroup(view, 0, g.minterms, dcSets[path], pol));
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
      setRefusal(null);
    }
  }, [outputs, viewTableOf]);

  const n = table?.inputPaths.length ?? 0;
  const kmapEligible = table !== null && n >= MIN_KMAP_INPUTS && n <= MAX_KMAP_INPUTS;
  const myCircles = useMemo(() => circles[myKey] ?? [], [circles, myKey]);
  const myDcs = useMemo(() => dcSets[outPath] ?? new Set<number>(), [dcSets, outPath]);
  const layouts = useMemo(() => (kmapEligible ? layoutOptions(n) : []), [kmapEligible, n]);
  const msbSide = usePrefsStore((st) => st.prefs.kmapMsbSide);
  // 'side' picks the option whose rows hold the first (most significant) input.
  const defaultLayoutIdx = Math.max(
    0,
    msbSide === 'side' ? layouts.findIndex((l) => l.rows.includes(0)) : 0,
  );
  const layoutIdx = Math.min(
    layoutSel[outPath] ?? defaultLayoutIdx,
    Math.max(0, layouts.length - 1),
  );

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

  const primeGroups = useMemo(
    () => (stage >= 1 && kmapEligible && table ? primeImplicants(table, 0, myDcs, polarity) : []),
    [stage, kmapEligible, table, myDcs, polarity],
  );
  const essentialKeys = useMemo(
    () =>
      new Set(
        (stage === 2 && kmapEligible && table
          ? essentialPrimes(table, 0, myDcs, polarity)
          : []
        ).map((g) => g.join(',')),
      ),
    [stage, kmapEligible, table, myDcs, polarity],
  );
  const covers = useMemo(
    () => (stage >= 3 && kmapEligible && table ? minimumCovers(table, 0, myDcs, polarity) : []),
    [stage, kmapEligible, table, myDcs, polarity],
  );
  const cover = covers.length > 0 ? covers[coverIdx % covers.length]! : [];
  const revealGroups: RevealGroup[] = useMemo(() => {
    if (stage === 3) return cover.map((g) => ({ minterms: g, solid: false }));
    return primeGroups.map((g) => ({ minterms: g, solid: essentialKeys.has(g.join(',')) }));
  }, [stage, cover, primeGroups, essentialKeys]);
  /** The other polarity's first minimum cover, for the comparison line. */
  const otherCover = useMemo(
    () =>
      revealStage.ones === 3 && revealStage.zeros === 3 && kmapEligible && table
        ? (minimumCovers(table, 0, myDcs, otherPolarity, 1)[0] ?? [])
        : null,
    [revealStage, kmapEligible, table, myDcs, otherPolarity],
  );

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
    // Real targets only -- a DC-marked minterm is never "uncovered" (owner rule).
    if (!table) return new Set<number>();
    const want = polarity === 'ones' ? '1' : '0';
    const s = new Set<number>();
    for (let r = 0; r < table.rows.length; r++) if (bitChar(table, r, 0, myDcs) === want) s.add(r);
    return s;
  }, [table, myDcs, polarity]);
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
      let next = prev;
      for (const pol of ['ones', 'zeros'] as const) {
        const key = circleKey(outPath, pol);
        const groups = prev[key];
        if (!groups) continue;
        const kept = groups.filter((g) => isLegalGroup(table, 0, g.minterms, myDcs, pol));
        if (kept.length !== groups.length) next = { ...next, [key]: kept };
      }
      return next;
    });
  }, [myDcs, table, outPath]);

  // A Check result describes the circles as they were when it ran.
  useEffect(() => setCheckResult(null), [myCircles, myDcs, polarity, outPath]);

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
        return revealGroups.map((rg, i) => {
          const g = rg.minterms;
          const key = g.join(',');
          const match = myCircles.findIndex((c) => c.minterms.join(',') === key);
          if (match !== -1)
            return {
              minterms: g,
              style: 'reveal' as const,
              color: myCircles[match]!.color,
              inset: match + 1,
              solid: rg.solid,
            };
          while (userColors.has(nextColor)) nextColor++;
          return {
            minterms: g,
            style: 'reveal' as const,
            color: nextColor++,
            inset: myCircles.length + i,
            solid: rg.solid,
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

  const flagged = useMemo(() => {
    const s = new Set<number>();
    checkResult?.circles.forEach((c, i) => {
      if (c.notPrime || c.redundant) s.add(i);
    });
    return s;
  }, [checkResult]);

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
      flagged,
      cellNumbers: kmapCellNumbers,
      polarity,
    });
  }, [
    layout,
    names,
    outPath,
    drawGroups,
    candidate,
    illegalFlash,
    cursor,
    emphasis,
    flagged,
    kmapCellNumbers,
    polarity,
  ]);

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
      const diagnosis = diagnoseGroup(table, 0, minterms, myDcs, polarity);
      if (diagnosis === 'ok') {
        setCircles((prev) => {
          const mine = prev[myKey] ?? [];
          return {
            ...prev,
            [myKey]: [...mine, { minterms, color: lowestUnusedColor(mine) }],
          };
        });
        setCandidate(null);
        setIllegalFlash(false);
        setRefusal(null);
      } else {
        // Outlives the flash: 600 ms is too short to read across a room.
        setRefusal(refusalMessage(diagnosis, polarity));
        setIllegalFlash(true);
        if (flashTimer.current) clearTimeout(flashTimer.current);
        flashTimer.current = setTimeout(() => {
          setIllegalFlash(false);
          setCandidate(null);
        }, 600);
      }
    },
    [table, myKey, myDcs, polarity],
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
  const coarse = useCoarsePointer();
  const gestureRef = useRef<{
    mode: 'group' | 'dc';
    cells: Set<number>;
    /** Started by a long press, so no modifier is held to keep it alive. */
    touch?: boolean;
  } | null>(null);
  // Touch has no Ctrl, so a long press on a cell arms the same grouping sweep
  // the modifier does; dragging on from it circles the run of cells.
  const longPressRef = useRef(0);
  const pressOriginRef = useRef<{ x: number; y: number } | null>(null);
  const cancelLongPress = () => {
    window.clearTimeout(longPressRef.current);
    longPressRef.current = 0;
    pressOriginRef.current = null;
  };

  // Pointer path never moves the keyboard cursor -- a Ctrl gesture leaving a
  // cursor square behind read as a stuck selection.
  const toggleCell = (m: number) => {
    setIllegalFlash(false);
    setRefusal(null);
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
    if (usingTyped) {
      typed.toggleDontCare(m);
      return;
    }
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
      [myKey]: (prev[myKey] ?? []).filter((_, i) => i !== index),
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
    if (e.pointerType === 'touch') {
      // Armed, not started: a press that turns into a drag or lifts early is
      // still a pan or a plain tap, and must not circle anything.
      pressOriginRef.current = p;
      const target = e.target as Element;
      const pointerId = e.pointerId;
      longPressRef.current = window.setTimeout(() => {
        const origin = pressOriginRef.current;
        if (!origin) return;
        // Touch has no Shift and a tap only selects, so this is the one way off.
        const onCircle = userGroupAt(origin.x, origin.y);
        if (onCircle !== undefined) {
          deleteGroup(onCircle);
          return;
        }
        const m = kmapCellAt(layout, origin.x, origin.y);
        if (m === undefined) return;
        gestureRef.current = { mode: 'group', cells: new Set([m]), touch: true };
        toggleCell(m);
        target.setPointerCapture(pointerId);
      }, LONG_PRESS_MS);
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
    const origin = pressOriginRef.current;
    if (origin && Math.hypot(p.x - origin.x, p.y - origin.y) > TAP_SLOP) cancelLongPress();
    if (gestureRef.current?.mode === 'dc' && e.altKey) {
      const m = kmapCellAt(layout, p.x, p.y);
      if (m === undefined || gestureRef.current.cells.has(m)) return;
      gestureRef.current.cells.add(m);
      toggleDc(m);
      return;
    }
    if (gestureRef.current?.mode === 'group' && (e.ctrlKey || gestureRef.current.touch)) {
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
    cancelLongPress();
    gestureRef.current = null;
  };
  const onPointerLeave = () => {
    cancelLongPress();
    setHoverGroup(null);
  };

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

  const advanceReveal = () => {
    setCoverIdx(0);
    setRevealStage((prev) => ({ ...prev, [polarity]: (prev[polarity] + 1) % 4 }));
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
      else if (!['BUTTON', 'SELECT', 'INPUT', 'SUMMARY'].includes((e.target as Element).tagName))
        advanceReveal();
      anchorRef.current = null;
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      if (selectedGroup && selectedGroup.outPath === outPath) {
        deleteGroup(selectedGroup.index);
        return;
      }
      if (cursor === null) return;
      setCircles((prev) => {
        const groups = prev[myKey] ?? [];
        const idx = groups.findIndex((grp) => grp.minterms.includes(cursor));
        if (idx === -1) return prev;
        return { ...prev, [myKey]: groups.filter((_, i) => i !== idx) };
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
        setRefusal(null);
        anchorRef.current = null;
      } else if (selectedGroup) {
        setSelectedGroup(null);
      } else if (maximized) {
        setMaximized(false);
      } else onClose();
    }
  };

  const switchSource = (next: 'board' | 'typed') => {
    if (next === typed.source) return;
    typed.setSource(next);
    setOutputIndex(0);
    setCandidate(null);
    setCursor(null);
    setRevealStage({ ones: 0, zeros: 0 });
    setCoverIdx(0);
    setRefusal(null);
    setSelectedGroup(null);
    setHoverGroup(null);
  };
  const sourcePicker = (
    <>
      <select
        aria-label="Source"
        value={typed.source}
        onChange={(e) => switchSource(e.target.value as 'board' | 'typed')}
      >
        <option value="board">This board</option>
        <option value="typed">Typed function</option>
      </select>
      {boardAnalyses.error && (
        <div className="analyze-muted">{`This board: ${boardAnalyses.error}`}</div>
      )}
    </>
  );
  const typedEntry = usingTyped && <TypedEntry typed={typed} />;

  const selectOutput = (i: number) => {
    if (i < 0 || i >= outputs.length) return;
    setOutputIndex(i);
    setCandidate(null);
    setRevealStage({ ones: 0, zeros: 0 });
    setCoverIdx(0);
    setRefusal(null);
    setSelectedGroup(null);
    setHoverGroup(null);
  };
  const outputPicker = outputs.length > 1 && (
    <div className="analyze-outputs">
      <select
        aria-label="Output"
        value={outIdx}
        onChange={(e) => selectOutput(Number(e.target.value))}
      >
        {outputs.map((o, i) => (
          <option key={o.outputPath} value={i}>
            {tabLabel(o.outputPath)}
          </option>
        ))}
      </select>
    </div>
  );

  const asBuiltExpr = usingTyped ? undefined : asBuilt.get(outPath);
  const asBuiltLine = asBuiltExpr && (
    <div className="analyze-asbuilt">
      <span className="analyze-muted">As built:</span>
      <span>{nameOfPath(outPath)} =</span>
      <BoolExpr expr={asBuiltExpr} />
    </div>
  );

  const canCompare = !usingTyped && outputs.length >= 2;
  const comparePanel = canCompare && comparing && (
    <ComparePanel
      outputs={outputs}
      picked={comparing}
      onPick={setComparing}
      nameOf={nameOfPath}
      tabLabel={tabLabel}
    />
  );

  if (!current || !table) {
    return (
      <div className="analyze-drawer" tabIndex={0} onKeyDown={onKeyDown}>
        <h3>Analyze</h3>
        {sourcePicker}
        {outputPicker}
        <p className="analyze-error">analyze: {current?.error ?? analyses.error}</p>
        {comparePanel}
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
    return `${l.cols.map(nameOf).join('')} top, ${l.rows.map(nameOf).join('')} side`;
  };

  const fullTable = n <= 4;
  const posMode = polarity === 'zeros';
  const targetWord = posMode ? 'zero' : 'one';
  const selectPolarity = (next: KmapPolarity) => {
    if (next === polarity) return;
    setPolarity(next);
    setCandidate(null);
    setIllegalFlash(false);
    setSelectedGroup(null);
    setHoverGroup(null);
    setRefusal(null);
    setCoverIdx(0);
  };
  const termOf = (minterms: readonly number[]) => (
    <Term term={groupTerm(table, minterms, polarity)} nameOf={nameOfPath} sum={posMode} />
  );
  const dcList = [...myDcs].sort((a, b) => a - b);
  const compare = (() => {
    if (otherCover === null || stage !== 3) return null;
    const sop = posMode ? otherCover : cover;
    const pos = posMode ? cover : otherCover;
    return {
      sop: summarizeForm(sop.map((g) => groupTerm(table, g, 'ones').length)),
      pos: summarizeForm(pos.map((g) => groupTerm(table, g, 'zeros').length)),
      cells: dontCareDisagreements(dcList, sop, pos),
    };
  })();
  const kmapSection =
    kmapEligible && layout ? (
      <>
        <div className="analyze-kmap-bar">
          <select
            aria-label="Group"
            value={polarity}
            onChange={(e) => selectPolarity(e.target.value as KmapPolarity)}
          >
            <option value="ones">Group 1s (SOP)</option>
            <option value="zeros">Group 0s (POS)</option>
          </select>
          {layouts.length > 1 && (
            <select
              aria-label="Map layout"
              value={layoutIdx}
              onChange={(e) =>
                setLayoutSel((prev) => ({ ...prev, [outPath]: Number(e.target.value) }))
              }
            >
              {layouts.map((l, i) => (
                <option key={i} value={i}>
                  {layoutLabel(l)}
                </option>
              ))}
            </select>
          )}
          <Toggle
            checked={kmapCellNumbers}
            onChange={(on) => setPref('kmapCellNumbers', on)}
            label="Cell numbers"
            title="Number the cells"
          />
          <button
            type="button"
            className="tool-btn"
            aria-pressed={maximized}
            aria-label={maximized ? 'Restore' : 'Maximize'}
            title={
              maximized
                ? `Back to the drawer${coarse ? '' : ' (Esc)'}`
                : 'Focus the K-map screen-center'
            }
            onClick={() => setMaximized((v) => !v)}
          >
            <ToolIcon name={maximized ? 'restore' : 'maximize'} />
          </button>
        </div>
        <div className="analyze-sop">
          {functionLine(nameOfPath(outPath), sigmaOf(table, myDcs), polarity)}
        </div>
        <canvas
          ref={canvasRef}
          className="analyze-kmap"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerLeave}
        />
        {refusal && (
          <div className="analyze-refusal" role="status">
            {refusal}
          </div>
        )}
        <div className="analyze-sop">
          {myCircles.length === 0 ? (
            <span className="analyze-muted">{groupHint(coarse)}</span>
          ) : (
            <span>
              {nameOfPath(outPath)} ={' '}
              {myCircles.map((g, i) => (
                <span key={i} style={termStyle(i, g.color)}>
                  {i > 0 && !posMode && (
                    <span style={{ color: 'inherit', fontWeight: 400 }}> + </span>
                  )}
                  {termOf(g.minterms)}
                </span>
              ))}
            </span>
          )}
        </div>
        {myCircles.length > 0 && <div className="analyze-muted">{groupHint(coarse)}</div>}
        <div className="analyze-status">
          {uncovered > 0
            ? `${uncovered} ${targetWord}${uncovered === 1 ? '' : 's'} still uncovered`
            : ones.size > 0
              ? `all ${targetWord}s covered`
              : posMode
                ? 'constant 1'
                : 'constant 0'}
        </div>
        <details
          className="analyze-rules"
          open={kmapRulesOpen}
          onToggle={(e) => setPref('kmapRulesOpen', e.currentTarget.open)}
        >
          <summary>Grouping rules</summary>
          <ol>
            {groupingRules(polarity).map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ol>
        </details>
        <div className="analyze-reveal">
          <button
            type="button"
            className="tool-btn"
            aria-pressed={stage > 0}
            onClick={advanceReveal}
          >
            {REVEAL_LABELS[stage]}
          </button>
          {stage === 3 && covers.length > 1 && (
            <button type="button" className="tool-btn" onClick={() => setCoverIdx((i) => i + 1)}>
              {`Next minimum (${(coverIdx % covers.length) + 1} of ${covers.length})`}
            </button>
          )}
          <button
            type="button"
            className="tool-btn"
            onClick={() =>
              setCheckResult(
                checkGroups(
                  table,
                  0,
                  myCircles.map((c) => c.minterms),
                  myDcs,
                  polarity,
                ),
              )
            }
          >
            Check
          </button>
          {onBuild && (
            <button
              type="button"
              className="tool-btn"
              onClick={() => {
                const varNames = table.inputPaths.map(nameOfPath);
                onBuild(
                  printExpr(
                    posMode
                      ? exprOfPosCover(table, 0, myDcs, varNames)
                      : exprOfCover(table, 0, myDcs, varNames),
                  ),
                );
              }}
            >
              Build this
            </button>
          )}
          {stage === 3 && (
            <span className="analyze-sop">
              {cover.length === 0 ? (
                posMode ? (
                  '1'
                ) : (
                  '0'
                )
              ) : (
                <span>
                  {cover.map((g, i) => (
                    <span
                      key={i}
                      style={{ color: groupVar(drawGroups[myCircles.length + i]?.color ?? i) }}
                    >
                      {i > 0 && !posMode && ' + '}
                      {termOf(g)}
                    </span>
                  ))}
                </span>
              )}
            </span>
          )}
          {(stage === 1 || stage === 2) && (
            <span className="analyze-muted">
              {`${primeGroups.length} prime${primeGroups.length === 1 ? '' : 's'}`}
              {stage === 2 ? `, ${essentialKeys.size} essential (solid)` : ''}
            </span>
          )}
        </div>
        {checkResult && (
          <div className="analyze-check" role="status">
            {checkResult.circles.map(
              (c, i) =>
                (c.notPrime || c.redundant) && (
                  <div key={i} style={{ color: groupVar(myCircles[i]!.color) }}>
                    {termOf(myCircles[i]!.minterms)}
                    {c.notPrime && ': Rule 4, this group can grow.'}
                    {c.redundant && ': Rule 1, this group is not needed.'}
                  </div>
                ),
            )}
            <div>
              {checkResult.coversAll
                ? `Every ${targetWord} is covered.`
                : `Some ${targetWord}s are not covered.`}
            </div>
            <div>{checkResult.isMinimum ? 'A minimum cover.' : 'Not a minimum cover.'}</div>
          </div>
        )}
        {compare && (
          <div className="analyze-compare">
            <div>
              {`SOP: ${compare.sop.terms} terms, ${compare.sop.literals} literals, ${compare.sop.gates} gates. POS: ${compare.pos.terms} terms, ${compare.pos.literals} literals, ${compare.pos.gates} gates.`}
            </div>
            {compare.cells.length > 0 && (
              <div className="analyze-muted">
                {`The two forms disagree on don't-care cells ${compare.cells.join(', ')}.`}
              </div>
            )}
          </div>
        )}
      </>
    ) : (
      <p className="analyze-muted">K-map view supports up to 4 inputs.</p>
    );

  return (
    <div className="analyze-drawer" tabIndex={0} onKeyDown={onKeyDown}>
      <h3>Analyze</h3>
      {sourcePicker}
      {typedEntry}
      {outputPicker}
      {asBuiltLine}
      {(fullTable || canCompare) && (
        <div className="analyze-table-bar">
          {fullTable && (
            <Toggle checked={compressed} onChange={setCompressed} label="Compress rows" />
          )}
          {canCompare && (
            <Toggle
              checked={comparing !== null}
              onChange={(on) =>
                setComparing(on ? { a: outIdx, b: (outIdx + 1) % outputs.length } : null)
              }
              label="Compare outputs"
            />
          )}
        </div>
      )}
      {comparePanel}
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
                    <td className="analyze-table__out">
                      {usingTyped && typed.mode === 'table' ? (
                        <button
                          type="button"
                          className="analyze-cell"
                          ref={(el) => {
                            cellRefs.current[r] = el;
                          }}
                          onClick={() => typed.setCell(r, nextCell(typed.fn.cells[r]!))}
                          onKeyDown={(e) => {
                            const action = cellKeyAction(e.key);
                            if (!action) return;
                            // Digits and X select tools and marks in the drawer behind.
                            e.preventDefault();
                            e.stopPropagation();
                            if (action.write !== undefined) typed.setCell(r, action.write);
                            cellRefs.current[r + action.step]?.focus();
                          }}
                        >
                          {bitChar(table, r, 0, myDcs)}
                        </button>
                      ) : (
                        bitChar(table, r, 0, myDcs)
                      )}
                    </td>
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
            {outputPicker}
            {kmapSection}
          </div>
        </div>
      )}
    </div>
  );
}

/** Two outputs' tables side by side, inputs lined up by name, with a verdict
 *  per row in words as well as colour. */
function ComparePanel({
  outputs,
  picked,
  onPick,
  nameOf,
  tabLabel,
}: {
  outputs: readonly OutputAnalysis[];
  picked: { a: number; b: number };
  onPick: (next: { a: number; b: number }) => void;
  nameOf: (path: string) => string;
  tabLabel: (path: string) => string;
}) {
  const a = outputs[Math.min(picked.a, outputs.length - 1)]!;
  const b = outputs[Math.min(picked.b, outputs.length - 1)]!;
  const aName = nameOf(a.outputPath);
  const bName = nameOf(b.outputPath);
  const picker = (which: 'a' | 'b', label: string) => (
    <select
      aria-label={label}
      value={picked[which]}
      onChange={(e) => onPick({ ...picked, [which]: Number(e.target.value) })}
    >
      {outputs.map((o, i) => (
        <option key={o.outputPath} value={i}>
          {tabLabel(o.outputPath)}
        </option>
      ))}
    </select>
  );

  const verdict = (): React.ReactNode => {
    if (a === b) return <p className="analyze-muted">Pick two different outputs.</p>;
    if (!a.table || !b.table) {
      const broken = !a.table ? a : b;
      return <p className="analyze-error">{`${nameOf(broken.outputPath)}: ${broken.error}`}</p>;
    }
    const r = compareOutputs(
      a.table,
      a.table.inputPaths.map(nameOf),
      b.table,
      b.table.inputPaths.map(nameOf),
    );
    if (r.kind === 'duplicate')
      return (
        <p className="analyze-muted">
          {`Two inputs on one side are both called ${r.name}. Rename one to compare by name.`}
        </p>
      );
    if (r.kind === 'mismatch')
      return (
        <p className="analyze-muted">
          {`The inputs do not line up by name: only ${aName} reads ${r.onlyA.join(', ')}, ` +
            `only ${bName} reads ${r.onlyB.join(', ')}.`}
        </p>
      );
    const n = r.names.length;
    const unread = [
      ...(r.unreadByA.length ? [`${aName} does not read ${r.unreadByA.join(', ')}.`] : []),
      ...(r.unreadByB.length ? [`${bName} does not read ${r.unreadByB.join(', ')}.`] : []),
    ];
    return (
      <>
        <p className={r.differ.length ? 'analyze-compare__differs' : undefined}>
          {r.differ.length === 0
            ? `${aName} and ${bName} are equal on all ${r.a.rows.length} rows.`
            : `${aName} and ${bName} differ on rows ${r.differ.join(', ')}.`}
        </p>
        {unread.length > 0 && <p className="analyze-muted">{unread.join(' ')}</p>}
        <table className="analyze-table">
          <thead>
            <tr>
              {r.names.map((name) => (
                <th key={name}>{name}</th>
              ))}
              <th className="analyze-table__out">{aName}</th>
              <th className="analyze-table__out">{bName}</th>
              <th>Verdict</th>
            </tr>
          </thead>
          <tbody>
            {r.a.rows.map((_, row) => {
              const differs = r.differ.includes(row);
              return (
                <tr key={row} className={differs ? 'analyze-compare__differs' : undefined}>
                  {r.names.map((name, i) => (
                    <td key={name}>{(row >> (n - 1 - i)) & 1}</td>
                  ))}
                  <td className="analyze-table__out">{bitChar(r.a, row, 0)}</td>
                  <td className="analyze-table__out">{bitChar(r.b, row, 0)}</td>
                  <td>{differs ? 'differs' : 'same'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </>
    );
  };

  return (
    <section className="analyze-compare" aria-label="Compare outputs">
      <div className="analyze-compare__bar">
        {picker('a', 'First output')}
        <span className="analyze-muted">against</span>
        {picker('b', 'Second output')}
      </div>
      {verdict()}
    </section>
  );
}
