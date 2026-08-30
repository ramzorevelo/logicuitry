// Maps a TimingReport path onto board wires/components for the schematic
// overlay (Fig 2.68): critical path wires in accent, short path muted, a
// per-hop delay label above each component on the critical path. Pure.

import type { Circuit, Component } from '../../core/model/types';
import type { CompiledCircuit } from '../../core/model/compile';
import type { PathTiming, TimingHop, TimingReport } from '../../core/timing/sta';
import { formatTimePs } from '../../render/waveform';
import { pinNet } from './circuitStore';

export interface StaOverlayData {
  criticalWires: Set<string>;
  shortWires: Set<string>;
  labels: Map<string, string>;
  /** Per-hop t_cd labels for the short path (drawn muted, below the glyph). */
  shortLabels: Map<string, string>;
  /** The endpoint actually shown (selected component's, else worst overall). */
  path: PathTiming;
}

function compName(path: string): string {
  const base = path.startsWith('main/') ? path.slice(5) : path;
  return base.endsWith('.d') ? base.slice(0, -2) : base;
}

function findComp(board: Circuit, path: string): Component | undefined {
  const name = compName(path);
  return board.components.find((c) => (c.label || c.id) === name);
}

/** Nets connecting startpoint -> hops -> endpoint along one reported path. */
function pathNets(
  compiled: CompiledCircuit,
  startpoint: string,
  endpoint: string,
  hops: readonly TimingHop[],
): Set<number> {
  const nets = new Set<number>();
  const outsOf = (path: string): number[] => {
    const pi = compiled.pathToPrimitive.get(path);
    if (pi !== undefined) return compiled.primitives[pi]!.outputs;
    // Alias-only startpoint (top-level In label / undriven net).
    const net = compiled.pathToNet.get(path);
    return net === undefined ? [] : [net];
  };
  const insOf = (path: string): number[] => {
    const base = path.endsWith('.d') ? path.slice(0, -2) : path;
    const pi = compiled.pathToPrimitive.get(base);
    return pi === undefined ? [] : compiled.primitives[pi]!.inputs;
  };
  const link = (froms: number[], tos: number[]) => {
    for (const n of froms) if (tos.includes(n)) nets.add(n);
  };
  const chain: { outs: number[]; ins: number[] }[] = [
    { outs: outsOf(startpoint), ins: [] },
    ...hops.map((h) => ({
      outs: compiled.primitives[h.prim]!.outputs,
      ins: compiled.primitives[h.prim]!.inputs,
    })),
    { outs: [], ins: insOf(endpoint) },
  ];
  for (let i = 0; i + 1 < chain.length; i++) link(chain[i]!.outs, chain[i + 1]!.ins);
  return nets;
}

function wiresOnNets(board: Circuit, compiled: CompiledCircuit, nets: Set<number>): Set<string> {
  const byId = new Map(board.components.map((c) => [c.id, c]));
  const ids = new Set<string>();
  for (const w of board.wires)
    for (const end of [w.a, w.b]) {
      if (end.kind !== 'pin') continue;
      const comp = byId.get(end.component);
      if (!comp) continue;
      const net = pinNet(compiled, comp, end.pin);
      if (net !== undefined && nets.has(net)) {
        ids.add(w.id);
        break;
      }
    }
  return ids;
}

export function buildStaOverlay(
  board: Circuit,
  compiled: CompiledCircuit,
  report: TimingReport,
  selection: ReadonlySet<string>,
): StaOverlayData | null {
  let path = report.worst;
  if (selection.size === 1) {
    const id = [...selection][0]!;
    const comp = board.components.find((c) => c.id === id);
    if (comp) {
      const name = comp.label || comp.id;
      const hit = report.endpoints.find((e) => compName(e.endpoint) === name);
      if (hit) path = hit;
    }
  }
  if (!path) return null;

  const criticalWires = wiresOnNets(
    board,
    compiled,
    pathNets(compiled, path.startpoint, path.endpoint, path.critical),
  );
  const shortWires = wiresOnNets(
    board,
    compiled,
    pathNets(compiled, path.shortStartpoint, path.endpoint, path.short),
  );

  const labels = new Map<string, string>();
  for (const hop of path.critical) {
    const comp = findComp(board, hop.path);
    if (comp) labels.set(comp.id, `+${formatTimePs(hop.tpdPs)}`);
  }
  const shortLabels = new Map<string, string>();
  for (const hop of path.short) {
    const comp = findComp(board, hop.path);
    if (comp) shortLabels.set(comp.id, `cd +${formatTimePs(hop.tcdPs)}`);
  }
  return { criticalWires, shortWires, labels, shortLabels, path };
}
