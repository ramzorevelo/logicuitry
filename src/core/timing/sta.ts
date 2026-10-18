// Static timing analysis over a flattened CompiledCircuit. Pure: builds a DAG
// of combinational primitives, refuses combinational cycles, and accumulates
// longest (t_pd) and shortest (t_cd) arrival per net in one topological pass.
// Delay conventions mirror sim/delay.ts exactly so overlay numbers match sim.

import type { CompiledCircuit, CompiledPrimitive } from '../model/compile';
import { intParam } from '../sim/primitives/types';
import { FALLBACK_NS, isStructuralHop, pinNamesOf, type PinNames } from '../sim/delay';
import { arcFigure } from '../parts/arcs';
import {
  column,
  contaminationNs,
  estimatedContaminationNs,
  getPart,
  propagationNs,
  setupHoldNs,
  typPublished,
  type DatasheetColumn,
} from '../parts/partsDb';
import { endpointPin, timingShape, type PinTiming, type TimingShape } from './shape';

export class TimingError extends Error {
  constructor(
    message: string,
    readonly cyclePaths: string[],
  ) {
    super(message);
    this.name = 'TimingError';
  }
}

export interface TimingHop {
  prim: number;
  path: string;
  part?: string;
  tpdPs: number;
  tcdPs: number;
  /** t_cd is a documented estimate (0.35 x typ t_pd), never a datasheet minimum. */
  estimated: boolean;
  /** The part publishes no typ column, so its "typ" figures are really its max. */
  typUnpublished?: boolean;
}

export interface PathTiming {
  /** Endpoint path; an input of a stateful primitive is `<path>.<capturePin>`. */
  endpoint: string;
  capturePin?: string;
  /** Startpoint path of the critical (t_pd) chain. */
  startpoint: string;
  /** Startpoint path of the short (t_cd) chain; may differ from `startpoint`. */
  shortStartpoint: string;
  totalTpdPs: number;
  totalTcdPs: number;
  critical: TimingHop[];
  short: TimingHop[];
  estimated: boolean;
  typUnpublished: boolean;
}

export interface SeqPathTiming {
  launch: string;
  capture: string;
  /** The sampled pin this row times; lanes of one bus share a row. */
  capturePin: string;
  clockPeriodPs: number;
  skewPs: number;
  tpcqPs: number;
  tccqPs: number;
  tsetupPs: number;
  tholdPs: number;
  tpdCombPs: number;
  tcdCombPs: number;
  setupSlackPs: number;
  holdMarginPs: number;
  minPeriodPs: number;
  estimated: boolean;
}

export interface SequentialTiming {
  paths: SeqPathTiming[];
  minPeriodPs: number | null;
  /** True when clock components with different periods exist; cross-domain paths are skipped. */
  multiDomain: boolean;
}

export interface TimingReport {
  endpoints: PathTiming[];
  worst: PathTiming | null;
  sequential: SequentialTiming | null;
}

const SOURCE_KINDS = new Set(['toggle', 'button', 'inport', 'constant', 'clock']);

const NS_TO_PS = 1000;
const toPs = (ns: number) => Math.round(ns * NS_TO_PS);

export interface HopDelay {
  tpdPs: number;
  tcdPs: number;
  estimated: boolean;
  typUnpublished?: boolean;
}

/** Slowest-arc t_pd / fastest t_cd for a part, mirroring datasheetDelay's conventions. */
export function partDelayPs(part: string | undefined, col: DatasheetColumn): HopDelay {
  if (!part) return { tpdPs: toPs(FALLBACK_NS), tcdPs: toPs(0.35 * FALLBACK_NS), estimated: true };
  const lh = propagationNs(part, 'lh', col) ?? FALLBACK_NS;
  const hl = propagationNs(part, 'hl', col) ?? FALLBACK_NS;
  const clh = contaminationNs(part, 'lh') ?? Math.round(0.35 * FALLBACK_NS);
  const chl = contaminationNs(part, 'hl') ?? Math.round(0.35 * FALLBACK_NS);
  return {
    tpdPs: toPs(Math.max(lh, hl)),
    tcdPs: toPs(Math.min(clh, chl)),
    estimated: true,
    ...(typPublished(part) ? {} : { typUnpublished: true }),
  };
}

/**
 * The figures behind one output, read the way the sim reads them: the slowest
 * t_pd and fastest t_cd over the arcs ending there, or the part's single figure.
 */
export function outputDelayPs(
  part: string | undefined,
  ins: readonly string[],
  outPin: string,
  col: DatasheetColumn,
): HopDelay {
  const timed = part ? ins.filter((i) => arcFigure(part, i, outPin)) : [];
  if (!timed.length) return partDelayPs(part, col);
  const arcs = timed.map((i) => hopDelay(part, i, outPin, col));
  return {
    tpdPs: Math.max(...arcs.map((d) => d.tpdPs)),
    tcdPs: Math.min(...arcs.map((d) => d.tcdPs)),
    estimated: true,
    ...(arcs.some((d) => d.typUnpublished) ? { typUnpublished: true } : {}),
  };
}

function hopDelay(
  part: string | undefined,
  inPin: string,
  outPin: string,
  col: DatasheetColumn,
): HopDelay {
  if (part) {
    const fig = arcFigure(part, inPin, outPin);
    if (fig) {
      const edges = [fig.tplh, fig.tphl].filter((e) => e !== undefined);
      const tpd = Math.max(...edges.map((e) => column(e, col)));
      const tcd = Math.min(...edges.map((e) => estimatedContaminationNs(column(e, 'typ'))));
      return {
        tpdPs: toPs(tpd),
        tcdPs: toPs(tcd),
        estimated: true,
        ...(typPublished(part) ? {} : { typUnpublished: true }),
      };
    }
  }
  return partDelayPs(part, col);
}

// 'through' is a structural tristate (data passes at zero delay, no hop);
// 'ignored' is the rest of a chip's power gate, which times nothing; 'reg' is
// anything with a timing shape, a latch included: its outputs start paths.
type Role = 'source' | 'sink' | 'reg' | 'comb' | 'through' | 'ignored';

function roleOf(p: CompiledPrimitive): Role {
  if (isStructuralHop(p)) return p.kind === 'tristate' ? 'through' : 'ignored';
  if (timingShape(p.kind, p.params)) return 'reg';
  if (SOURCE_KINDS.has(p.kind)) return 'source';
  if (p.outputs.length === 0) return 'sink';
  return 'comb';
}

interface HopRef {
  hop: TimingHop;
  fromNet: number;
}

interface NetArrival {
  maxPs: number;
  minPs: number;
  /** The launch's own clk -> output figure inside maxPs and minPs; 0 off a sequential launch. */
  maxStartPs: number;
  minStartPs: number;
  maxHop: HopRef | null;
  minHop: HopRef | null;
  maxSource: string;
  minSource: string;
}

interface Analysis {
  roles: Role[];
  pinNames: PinNames[];
  shapes: (TimingShape | null)[];
  order: number[]; // comb prim indices, topological
}

function buildAnalysis(c: CompiledCircuit): Analysis {
  const roles = c.primitives.map(roleOf);
  const pinNames = c.primitives.map(pinNamesOf);
  const shapes = c.primitives.map((p, i) =>
    roles[i] === 'reg' ? timingShape(p.kind, p.params) : null,
  );

  // A stateful prim joins the graph only through its through arcs, so its
  // stored outputs and its other inputs break the path: Q feeding its own /CLR or EN is no cycle.
  const throughPins = (i: number, end: 'from' | 'to') =>
    new Set(shapes[i]?.through.map((t) => t[end]) ?? []);
  const fromPins = c.primitives.map((_, i) => (roles[i] === 'reg' ? throughPins(i, 'from') : null));
  const toPins = c.primitives.map((_, i) => (roles[i] === 'reg' ? throughPins(i, 'to') : null));
  const inGraph = (i: number) =>
    roles[i] === 'comb' || roles[i] === 'through' || (fromPins[i]?.size ?? 0) > 0;
  const comb = c.primitives.map((_, i) => i).filter(inGraph);
  const combSet = new Set(comb);
  const succ = new Map<number, number[]>(comb.map((i) => [i, []]));
  const indeg = new Map<number, number>(comb.map((i) => [i, 0]));
  for (const pi of comb) {
    for (const [slot, net] of c.primitives[pi]!.inputs.entries()) {
      if (roles[pi] === 'through' && pinNames[pi]!.ins[slot] !== 'a') continue;
      if (fromPins[pi] && !fromPins[pi].has(pinNames[pi]!.ins[slot]!)) continue;
      for (const d of c.drivers[net] ?? []) {
        if (!combSet.has(d.prim)) continue;
        if (toPins[d.prim] && !toPins[d.prim]!.has(pinNames[d.prim]!.outs[d.out]!)) continue;
        succ.get(d.prim)!.push(pi);
        indeg.set(pi, indeg.get(pi)! + 1);
      }
    }
  }

  const order: number[] = [];
  const queue = comb.filter((i) => indeg.get(i) === 0);
  while (queue.length) {
    const i = queue.shift()!;
    order.push(i);
    for (const s of succ.get(i)!) {
      const n = indeg.get(s)! - 1;
      indeg.set(s, n);
      if (n === 0) queue.push(s);
    }
  }

  if (order.length !== comb.length) {
    const done = new Set(order);
    const stuck = new Set(comb.filter((i) => !done.has(i)));
    const cyclePaths = findCycle(stuck, succ).map((i) => c.primitives[i]!.path);
    throw new TimingError(`combinational cycle: ${cyclePaths.join(' -> ')}`, cyclePaths);
  }
  return { roles, pinNames, shapes, order };
}

/** One cycle within the unresolved subgraph, in loop order. */
function findCycle(stuck: Set<number>, succ: Map<number, number[]>): number[] {
  const stack: number[] = [];
  const onStack = new Set<number>();
  const done = new Set<number>();
  let cycle: number[] = [];
  const dfs = (i: number): boolean => {
    stack.push(i);
    onStack.add(i);
    for (const s of succ.get(i) ?? []) {
      if (!stuck.has(s) || done.has(s)) continue;
      if (onStack.has(s)) {
        cycle = stack.slice(stack.indexOf(s));
        return true;
      }
      if (dfs(s)) return true;
    }
    stack.pop();
    onStack.delete(i);
    done.add(i);
    return false;
  };
  for (const i of stuck) if (dfs(i)) break;
  return cycle;
}
interface Seed {
  source: string;
  maxPs: number;
  minPs: number;
}

function propagate(
  c: CompiledCircuit,
  a: Analysis,
  col: DatasheetColumn,
  seeds: Map<number, Seed>,
): Map<number, NetArrival> {
  const arr = new Map<number, NetArrival>();
  for (const [net, seed] of seeds)
    arr.set(net, {
      maxPs: seed.maxPs,
      minPs: seed.minPs,
      maxStartPs: seed.maxPs,
      minStartPs: seed.minPs,
      maxHop: null,
      minHop: null,
      maxSource: seed.source,
      minSource: seed.source,
    });

  for (const pi of a.order) {
    const p = c.primitives[pi]!;
    const names = a.pinNames[pi]!;
    if (a.roles[pi] === 'through') {
      const from = arr.get(p.inputs[names.ins.indexOf('a')]!);
      if (from) mergeArrival(arr, p.outputs[0]!, from);
      continue;
    }
    const arcs: [number, number][] =
      a.roles[pi] === 'reg'
        ? a.shapes[pi]!.through.map((t) => [names.ins.indexOf(t.from), names.outs.indexOf(t.to)])
        : p.outputs.flatMap((_, o) => p.inputs.map((_, i): [number, number] => [i, o]));
    for (const [i, o] of arcs) {
      const from = arr.get(p.inputs[i]!);
      if (!from) continue;
      const d = hopDelay(p.part, names.ins[i]!, names.outs[o]!, col);
      const hop: TimingHop = {
        prim: pi,
        path: p.path,
        ...(p.part ? { part: p.part } : {}),
        tpdPs: d.tpdPs,
        tcdPs: d.tcdPs,
        estimated: d.estimated,
        ...(d.typUnpublished ? { typUnpublished: true } : {}),
      };
      const ref = { hop, fromNet: p.inputs[i]! };
      mergeArrival(arr, p.outputs[o]!, {
        ...from,
        maxPs: from.maxPs + d.tpdPs,
        minPs: from.minPs + d.tcdPs,
        maxHop: ref,
        minHop: ref,
      });
    }
  }
  return arr;
}

/** Keep the later of two max arrivals and the earlier of two min arrivals at one net. */
function mergeArrival(arr: Map<number, NetArrival>, outNet: number, from: NetArrival): void {
  const cur = arr.get(outNet);
  if (!cur) {
    arr.set(outNet, { ...from });
    return;
  }
  if (from.maxPs > cur.maxPs) {
    cur.maxPs = from.maxPs;
    cur.maxStartPs = from.maxStartPs;
    cur.maxHop = from.maxHop;
    cur.maxSource = from.maxSource;
  }
  if (from.minPs < cur.minPs) {
    cur.minPs = from.minPs;
    cur.minStartPs = from.minStartPs;
    cur.minHop = from.minHop;
    cur.minSource = from.minSource;
  }
}

function walkBack(arr: Map<number, NetArrival>, net: number, which: 'max' | 'min'): TimingHop[] {
  const hops: TimingHop[] = [];
  let cur = arr.get(net);
  while (cur) {
    const ref = which === 'max' ? cur.maxHop : cur.minHop;
    if (!ref) break;
    hops.unshift(ref.hop);
    cur = arr.get(ref.fromNet);
  }
  return hops;
}

/** The lane arriving last carries the critical chain, the lane arriving first the short one. */
interface Ends {
  maxNet: number;
  minNet: number;
}

function pathTiming(
  arr: Map<number, NetArrival>,
  ends: Ends,
  endpoint: string,
  capturePin?: string,
): PathTiming {
  const late = arr.get(ends.maxNet)!;
  const early = arr.get(ends.minNet)!;
  const critical = walkBack(arr, ends.maxNet, 'max');
  const short = walkBack(arr, ends.minNet, 'min');
  return {
    endpoint,
    ...(capturePin ? { capturePin } : {}),
    startpoint: late.maxSource,
    shortStartpoint: early.minSource,
    totalTpdPs: late.maxPs,
    totalTcdPs: early.minPs,
    critical,
    short,
    estimated: critical.some((h) => h.estimated) || short.some((h) => h.estimated),
    typUnpublished: critical.some((h) => h.typUnpublished) || short.some((h) => h.typUnpublished),
  };
}

function endsOf(arr: Map<number, NetArrival>, nets: readonly number[]): Ends | undefined {
  let ends: Ends | undefined;
  for (const net of nets) {
    const at = arr.get(net);
    if (!at) continue;
    if (!ends) ends = { maxNet: net, minNet: net };
    else {
      if (at.maxPs > arr.get(ends.maxNet)!.maxPs) ends.maxNet = net;
      if (at.minPs < arr.get(ends.minNet)!.minPs) ends.minNet = net;
    }
  }
  return ends;
}

interface InputGroup {
  pin: string;
  timing: PinTiming;
  nets: number[];
}

/** A stateful prim's non-clock inputs, lanes of one bus gathered under its name, in pin order. */
function inputGroups(c: CompiledCircuit, a: Analysis, pi: number): InputGroup[] {
  const groups = new Map<string, InputGroup>();
  const shape = a.shapes[pi]!;
  a.pinNames[pi]!.ins.forEach((name, slot) => {
    const timing = shape.pins.get(name)!;
    if (timing === 'clock') return;
    const pin = endpointPin(name);
    const g = groups.get(pin) ?? { pin, timing, nets: [] };
    g.nets.push(c.primitives[pi]!.inputs[slot]!);
    groups.set(pin, g);
  });
  return [...groups.values()];
}

function pinNet(
  c: CompiledCircuit,
  a: Analysis,
  pi: number,
  pin: string,
  dir: 'in' | 'out',
): number | undefined {
  const names = a.pinNames[pi]!;
  const slot = (dir === 'in' ? names.ins : names.outs).indexOf(pin);
  if (slot < 0) return undefined;
  return (dir === 'in' ? c.primitives[pi]!.inputs : c.primitives[pi]!.outputs)[slot];
}

interface ClockInfo {
  periodPs: number;
  phasePs: number;
}

// SPEC: only a clock primitive directly driving the clk net is recognized as
// the clock source; a gated or buffered clock reports no domain and its
// register drops out of sequential analysis.
function clockOf(c: CompiledCircuit, a: Analysis, reg: number): ClockInfo | null {
  const clockPin = a.shapes[reg]?.clock;
  const net = clockPin === undefined ? undefined : pinNet(c, a, reg, clockPin, 'in');
  if (net === undefined) return null;
  for (const d of c.drivers[net] ?? []) {
    const p = c.primitives[d.prim]!;
    if (p.kind === 'clock')
      return {
        periodPs: intParam(p.params, 'periodPs', 10_000),
        phasePs: intParam(p.params, 'phasePs', 0),
      };
  }
  return null;
}

/** Each output of a launching prim starts at its own clk -> output figure. */
function launchSeeds(
  c: CompiledCircuit,
  a: Analysis,
  col: DatasheetColumn,
  launch: number,
): Map<number, Seed> {
  const lp = c.primitives[launch]!;
  const clockPin = a.shapes[launch]!.clock!;
  const seeds = new Map<number, Seed>();
  a.pinNames[launch]!.outs.forEach((out, o) => {
    const d = clockToOutput(lp.part, clockPin, out, col);
    seeds.set(lp.outputs[o]!, { source: lp.path, maxPs: d.tpcqPs, minPs: d.tccqPs });
  });
  return seeds;
}

// Not hopDelay's part-level fallback: an unbound launch keeps the unrounded
// 0.35 x 10 ns t_ccq the sequential report has always shown.
function clockToOutput(
  part: string | undefined,
  clockPin: string,
  out: string,
  col: DatasheetColumn,
): { tpcqPs: number; tccqPs: number } {
  if (part && arcFigure(part, clockPin, out)) {
    const d = hopDelay(part, clockPin, out, col);
    return { tpcqPs: d.tpdPs, tccqPs: d.tcdPs };
  }
  const lh = part ? (propagationNs(part, 'lh', col) ?? FALLBACK_NS) : FALLBACK_NS;
  const hl = part ? (propagationNs(part, 'hl', col) ?? FALLBACK_NS) : FALLBACK_NS;
  const clh = part ? contaminationNs(part, 'lh') : undefined;
  const chl = part ? contaminationNs(part, 'hl') : undefined;
  return {
    tpcqPs: toPs(Math.max(lh, hl)),
    tccqPs: toPs(Math.min(clh ?? 0.35 * FALLBACK_NS, chl ?? 0.35 * FALLBACK_NS)),
  };
}

function sequentialTiming(
  c: CompiledCircuit,
  a: Analysis,
  col: DatasheetColumn,
  regs: number[],
): SequentialTiming | null {
  if (regs.length === 0) return null;
  const clocks = new Map(regs.map((r) => [r, clockOf(c, a, r)]));
  const periods = new Set(
    [...clocks.values()].filter((x): x is ClockInfo => x !== null).map((x) => x.periodPs),
  );
  const multiDomain = periods.size > 1;

  const paths: SeqPathTiming[] = [];
  for (const launch of regs) {
    const lClk = clocks.get(launch);
    if (!lClk) continue;
    const arr = propagate(c, a, col, launchSeeds(c, a, col, launch));
    for (const capture of regs) {
      const cClk = clocks.get(capture);
      if (!cClk || cClk.periodPs !== lClk.periodPs) continue;
      const cap = c.primitives[capture]!;
      // SPEC: unbound capture register contributes zero setup/hold.
      const capEntry = cap.part ? getPart(cap.part) : undefined;
      for (const g of inputGroups(c, a, capture)) {
        if (typeof g.timing === 'string') continue;
        const ends = endsOf(arr, g.nets);
        if (!ends) continue;
        const late = arr.get(ends.maxNet)!;
        const early = arr.get(ends.minNet)!;
        const { setupNs, holdNs } = setupHoldNs(capEntry, g.timing.sampled);
        const tpcqPs = late.maxStartPs;
        const tccqPs = early.minStartPs;
        const tsetupPs = toPs(setupNs);
        const tholdPs = toPs(holdNs);
        const skewPs = cClk.phasePs - lClk.phasePs;
        const tpdCombPs = late.maxPs - tpcqPs;
        const tcdCombPs = early.minPs - tccqPs;
        const minPeriodPs = tpcqPs + tpdCombPs + tsetupPs + skewPs;
        paths.push({
          launch: c.primitives[launch]!.path,
          capture: cap.path,
          capturePin: g.pin,
          clockPeriodPs: lClk.periodPs,
          skewPs,
          tpcqPs,
          tccqPs,
          tsetupPs,
          tholdPs,
          tpdCombPs,
          tcdCombPs,
          setupSlackPs: lClk.periodPs - minPeriodPs,
          holdMarginPs: tccqPs + tcdCombPs - (tholdPs + skewPs),
          minPeriodPs,
          estimated: true,
        });
      }
    }
  }
  return {
    paths,
    minPeriodPs: paths.length ? Math.max(...paths.map((p) => p.minPeriodPs)) : null,
    multiDomain,
  };
}

export function analyzeTiming(c: CompiledCircuit, opts: { column: DatasheetColumn }): TimingReport {
  const a = buildAnalysis(c);
  const col = opts.column;

  // Startpoints: source prims, stateful outputs, and undriven nets read by
  // logic (top-level In labels compile to no primitive, only an aliased net).
  const seeds = new Map<number, Seed>();
  const atZero = (source: string): Seed => ({ source, maxPs: 0, minPs: 0 });
  const regs: number[] = [];
  c.primitives.forEach((p, i) => {
    const role = a.roles[i]!;
    if (role === 'reg') regs.push(i);
    if (role === 'source' || role === 'reg')
      for (const net of p.outputs) seeds.set(net, atZero(p.path));
  });
  c.primitives.forEach((p, i) => {
    if (a.roles[i] === 'ignored') return;
    for (const net of p.inputs)
      if (!seeds.has(net) && (c.drivers[net] ?? []).length === 0)
        seeds.set(net, atZero(c.nets[net]!.paths[0]!));
  });

  const arr = propagate(c, a, col, seeds);

  const endpoints: PathTiming[] = [];
  c.primitives.forEach((p, i) => {
    if (a.roles[i] === 'sink') {
      // Multi-input observers take their latest-arriving input.
      let best: number | undefined;
      for (const net of p.inputs) {
        const at = arr.get(net);
        if (!at) continue;
        if (best === undefined || at.maxPs > arr.get(best)!.maxPs) best = net;
      }
      if (best !== undefined)
        endpoints.push(pathTiming(arr, { maxNet: best, minNet: best }, p.path));
    } else if (a.roles[i] === 'reg') {
      for (const g of inputGroups(c, a, i)) {
        const ends = endsOf(arr, g.nets);
        if (ends) endpoints.push(pathTiming(arr, ends, `${p.path}.${g.pin}`, g.pin));
      }
    }
  });

  const worst = endpoints.reduce<PathTiming | null>(
    (w, e) => (w === null || e.totalTpdPs > w.totalTpdPs ? e : w),
    null,
  );

  return { endpoints, worst, sequential: sequentialTiming(c, a, col, regs) };
}
