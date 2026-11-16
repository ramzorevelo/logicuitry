// Gate step: one press of the toolbar's Gate step, the run of presses it
// belongs to, the status text it reads out and the overlay it draws.

import { componentPaths, type CompiledCircuit } from '../../core/model/compile';
import { netWiresOf } from '../../core/gates/netGraph';
import { pinNet } from '../../core/model/pinNet';
import { isChipInstance, type Circuit } from '../../core/model/types';
import { isStructuralHop } from '../../core/sim/delay';
import type { GateStepReport, NextSlice } from '../../core/sim/kernel';
import { formatTimePs } from '../../render/waveform';

export const GATE_STEP_TIP =
  'Advances the simulation by one gate delay, so you can watch a change ripple through. Settle runs until nothing changes.';
export const SETTLE_TIP = 'Runs the simulation until nothing changes.';
export const SETTLED_TEXT = 'Settled: nothing left to step';

/** Bounds one press: an empty slice or a wiring hop is folded in, never a run of them forever. */
const MAX_FOLDED_SLICES = 64;

export interface GateSim {
  gateStep(): GateStepReport | null;
  nextSlice(): NextSlice | null;
}

/** The ripple a run of presses is following. */
export interface GateRun {
  /** Gate delays since the source edge that started it; that edge is 0. */
  count: number;
  /** Sim time of that edge, or of the run's first press when no edge was seen. */
  originPs: number;
  timePs: number;
  changedNets: readonly number[];
  pendingPrimitives: readonly number[];
}

function union(a: readonly number[], b: readonly number[]): number[] {
  return [...new Set([...a, ...b])].sort((x, y) => x - y);
}

function fold(a: GateStepReport, b: GateStepReport): GateStepReport {
  return {
    ...b,
    changedNets: union(a.changedNets, b.changedNets),
    evaluated: union(a.evaluated, b.evaluated),
  };
}

function hopLandsNext(slice: NextSlice | null, compiled: CompiledCircuit): boolean {
  return (
    !!slice &&
    !slice.wakes &&
    slice.primitives.length > 0 &&
    slice.primitives.every((pi) => isStructuralHop(compiled.primitives[pi]!))
  );
}

/**
 * One press: a gate step, folding in slices that would show nothing on their
 * own. A slice that only evaluates (an input's or a clock's wake) changes no
 * net. In ideal timing a package's power gate and output buffers still take
 * the unit delay, so the hop that carries a gate's output to its pin follows
 * as its own slice; datasheet timing already lands it in the same press.
 */
export function pressGateStep(
  sim: GateSim,
  compiled: CompiledCircuit,
  ideal: boolean,
): GateStepReport | null {
  let report = sim.gateStep();
  if (!report) return null;
  for (let i = 0; i < MAX_FOLDED_SLICES && !report.oscillation && !report.settled; i++) {
    const quiet = report.changedNets.length === 0;
    if (!quiet && !(ideal && hopLandsNext(sim.nextSlice(), compiled))) break;
    const next = sim.gateStep();
    if (!next) break;
    report = fold(report, next);
  }
  return report;
}

/** A change only sources made (switches, clocks, constants) starts a ripple: t = 0. */
function isSourceEdge(compiled: CompiledCircuit, nets: readonly number[]): boolean {
  return nets.every((net) => {
    const drivers = compiled.drivers[net] ?? [];
    return (
      drivers.length > 0 &&
      drivers.every(({ prim }) => {
        const p = compiled.primitives[prim]!;
        return p.inputs.length === 0 || isStructuralHop(p);
      })
    );
  });
}

/**
 * The run after a press that started at `fromPs`, continuing `prev` when it is still current.
 * A press from a settled sim lands on a self-timed edge (a clock, a 555), which starts a ripple
 * whatever drives it.
 */
export function nextGateRun(
  prev: GateRun | null,
  report: GateStepReport,
  compiled: CompiledCircuit,
  fromPs: number,
  fromSettled: boolean,
): GateRun {
  const edge =
    report.changedNets.length > 0 && (fromSettled || isSourceEdge(compiled, report.changedNets));
  return {
    count: edge ? 0 : prev ? prev.count + 1 : 1,
    originPs: edge ? report.time : (prev?.originPs ?? fromPs),
    timePs: report.time,
    changedNets: report.changedNets,
    pendingPrimitives: report.pendingPrimitives,
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Elapsed time of a run: gate delays in ideal timing, the sim's own time in datasheet timing. */
function elapsedText(run: GateRun, ideal: boolean): string {
  if (ideal) return plural(run.count, 'gate delay');
  if (run.count === 0) return '0';
  return `+${formatTimePs(run.timePs - run.originPs)}, ${plural(run.count, 'gate step')}`;
}

export interface GateStatusInput {
  run: GateRun | null;
  ideal: boolean;
  /** Changed nets with a wire on the circuit on show. */
  boardNets: number;
  settled: boolean;
  canStep: boolean;
}

/** The paused simulation's status line. */
export function gateStatusText(s: GateStatusInput): string {
  const at = s.run ? ` (t = ${elapsedText(s.run, s.ideal)})` : '';
  if (s.settled && !s.canStep) return SETTLED_TEXT + at;
  if (s.settled) return s.run ? `Settled${at}, next: clock edge` : 'settled, paused';
  if (!s.run) return 'Paused: gate steps pending';
  const total = s.run.changedNets.length;
  const nets =
    s.boardNets > 0
      ? `${plural(s.boardNets, 'net')} changed`
      : total > 0
        ? 'changes inside parts only'
        : 'no nets changed';
  return `t = ${elapsedText(s.run, s.ideal)}, ${nets}`;
}

export interface GateOverlay {
  /** Wires on a net the last press changed. */
  wires: ReadonlySet<string>;
  /** Parts still holding a drive or wake: a chip instance stands for its insides. */
  parts: ReadonlySet<string>;
  /** Changed nets that have a wire on this circuit. */
  boardNets: number;
}

/** What a run draws on `circuit`, the board or a chip's insides compiled under `prefix`. */
export function gateOverlay(
  circuit: Circuit,
  compiled: CompiledCircuit,
  prefix: string,
  run: GateRun,
): GateOverlay {
  const paths = componentPaths(circuit, prefix);
  const byId = new Map(circuit.components.map((c) => [c.id, c]));
  const changed = new Set(run.changedNets);
  const hitNets = new Set<number>();
  const direct = new Set<string>();
  for (const w of circuit.wires)
    for (const end of [w.a, w.b]) {
      if (end.kind !== 'pin') continue;
      const comp = byId.get(end.component);
      if (!comp) continue;
      const net = pinNet(compiled, comp, end.pin, prefix, paths.get(comp.id));
      if (net === undefined || !changed.has(net)) continue;
      hitNets.add(net);
      direct.add(w.id);
    }

  const ownPrimitive = new Map(circuit.components.map((c) => [prefix + c.id, c.id]));
  const chipAt = new Map(
    circuit.components.filter(isChipInstance).map((c) => [paths.get(c.id)!, c.id]),
  );
  const parts = new Set<string>();
  for (const pi of run.pendingPrimitives) {
    const prim = compiled.primitives[pi];
    if (!prim?.path.startsWith(prefix)) continue;
    const own = ownPrimitive.get(prim.componentId);
    if (own) {
      parts.add(own);
      continue;
    }
    const colon = prim.path.indexOf(':', prefix.length);
    const chip = colon < 0 ? undefined : chipAt.get(prim.path.slice(0, colon));
    if (chip) parts.add(chip);
  }
  return { wires: netWiresOf(circuit, direct), parts, boardNets: hitNets.size };
}
