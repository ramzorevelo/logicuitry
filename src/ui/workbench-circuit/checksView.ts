// The Checks tab's model: static rows cached on the circuit's own arrays (a pan
// or a sim frame recomputes nothing), compile refusals, and live rows while powered.

import type { Board, ChipDef, ChipLibrary, Circuit } from '../../core/model/types';
import { compile, CompileError } from '../../core/model/compile';
import { lowerCircuit, lowerLibrary } from '../../core/gates/lower';
import {
  checkRows,
  compileErrorRow,
  fightRows,
  oscillationRow,
  sortRows,
  staticFindings,
  type CheckFinding,
  type CheckRow,
  type CheckSeverity,
} from '../../core/checks/checks';
import type { Rect, Viewport } from '../../render/scene';
import { useCircuitStore } from './circuitStore';

export interface CheckMarkers {
  pins: readonly { component: string; pin: string }[];
  badges: ReadonlySet<string>;
  dashedWires: ReadonlySet<string>;
}

export interface ChecksView {
  shown: CheckRow[];
  hidden: CheckRow[];
  counts: Record<CheckSeverity, number>;
  markers: CheckMarkers;
}

/** What the checks read: the active tab's circuit, and the board or def that compiles it. */
export interface ChecksInput {
  circuit: Circuit;
  /** The document compile takes for this tab. */
  top: Board | ChipDef;
  lib: ChipLibrary;
  /** Live findings, while powered. */
  live?: {
    fights: Parameters<typeof fightRows>[2];
    fighting: readonly number[];
    prefix: string;
    oscillation: readonly string[] | null;
  };
}

interface StaticEntry {
  key: readonly unknown[];
  body: Circuit;
  findings: CheckFinding[];
  compileError: CheckRow | null;
}

interface RowsEntry {
  key: readonly unknown[];
  rows: { shown: CheckRow[]; hidden: CheckRow[] };
}

let staticCache: StaticEntry | undefined;
let rowsCache: RowsEntry | undefined;

const sameKey = (a: readonly unknown[], b: readonly unknown[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

function compileRefusal(top: Board | ChipDef, circuit: Circuit, lib: ChipLibrary): CheckRow | null {
  try {
    compile(lowerCircuit(top), lowerLibrary(lib));
    return null;
  } catch (e) {
    if (!(e instanceof CompileError)) return null;
    return compileErrorRow(circuit, {
      message: e.message.slice(e.path.length + 2),
      path: e.path,
    });
  }
}

/** The tab's rows, counts and canvas markers. */
export function checksView(input: ChecksInput): ChecksView {
  const { circuit, top, lib } = input;
  const key = [circuit.components, circuit.wires, circuit.junctions, circuit.groups, lib];
  if (!staticCache || !sameKey(staticCache.key, key)) {
    // A circuit view built from the same arrays, so the net memo keys on content, not on the board object.
    const body: Circuit = {
      components: circuit.components,
      wires: circuit.wires,
      junctions: circuit.junctions,
      ...(circuit.groups ? { groups: circuit.groups } : {}),
    };
    staticCache = {
      key,
      body,
      findings: staticFindings(body, lib),
      compileError: compileRefusal(top, body, lib),
    };
  }
  const rowsKey = [staticCache, circuit.hiddenChecks];
  if (!rowsCache || !sameKey(rowsCache.key, rowsKey))
    rowsCache = {
      key: rowsKey,
      rows: checkRows(
        staticCache.findings,
        new Set(circuit.hiddenChecks ?? []),
        staticCache.body,
        lib,
      ),
    };

  const live: CheckRow[] = [];
  if (input.live) {
    const { fights, fighting, prefix, oscillation } = input.live;
    live.push(...fightRows(staticCache.body, lib, fights, fighting, prefix));
    if (oscillation) live.push(oscillationRow(oscillation));
  }
  const errors = staticCache.compileError ? [staticCache.compileError] : [];
  const shown =
    errors.length + live.length > 0
      ? sortRows([...errors, ...live, ...rowsCache.rows.shown])
      : rowsCache.rows.shown;
  return {
    shown,
    hidden: rowsCache.rows.hidden,
    counts: {
      error: shown.filter((r) => r.severity === 'error').length,
      warning: shown.filter((r) => r.severity === 'warning').length,
      info: shown.filter((r) => r.severity === 'info').length,
    },
    markers: markersOf(rowsCache.rows.shown),
  };
}

const markerCache = new WeakMap<CheckRow[], CheckMarkers>();

function markersOf(rows: CheckRow[]): CheckMarkers {
  let m = markerCache.get(rows);
  if (m) return m;
  m = {
    pins: rows.filter((r) => r.kind === 'unwired' || r.kind === 'undriven').flatMap((r) => r.pins),
    badges: new Set(rows.filter((r) => r.kind === 'power').flatMap((r) => r.components)),
    dashedWires: new Set(rows.filter((r) => r.kind === 'float').flatMap((r) => r.wires)),
  };
  markerCache.set(rows, m);
  return m;
}

/** The viewport moved just enough to bring `target` fully into view, zoom
 *  kept; centred on it when it is larger than the view. Unchanged when it is
 *  already in view. */
export function revealViewport(vp: Viewport, target: Rect, cssW: number, cssH: number): Viewport {
  const w = cssW / vp.zoom;
  const h = cssH / vp.zoom;
  const axis = (pan: number, span: number, lo: number, size: number) => {
    if (size > span) return lo + size / 2 - span / 2;
    if (lo < pan) return lo;
    if (lo + size > pan + span) return lo + size - span;
    return pan;
  };
  const panX = axis(vp.panX, w, target.x, target.w);
  const panY = axis(vp.panY, h, target.y, target.h);
  return panX === vp.panX && panY === vp.panY ? vp : { ...vp, panX, panY };
}

type StoreState = ReturnType<typeof useCircuitStore.getState>;

/** The active tab's checks, from store state. */
export function activeChecks(st: StoreState): ChecksView {
  const tab = st.tabs.find((t) => t.id === st.activeTabId);
  const def = tab?.kind === 'def' ? st.chipLib.get(tab.defId) : undefined;
  const top = def ?? st.board;
  const fights = st.simFights();
  return checksView({
    circuit: st.activeCircuit(),
    top,
    lib: st.chipLib,
    ...(fights
      ? {
          live: {
            fights: fights.compiled,
            fighting: fights.nets,
            prefix: tab?.kind === 'def' ? tab.prefix : 'main/',
            oscillation: st.oscillation,
          },
        }
      : {}),
  });
}

/** Markers draw only while the Checks tab is up: teacher-paced. */
export const checksTabShown = (st: StoreState) => st.waveformOpen && st.dockTab === 'checks';
