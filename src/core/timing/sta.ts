// Static timing analysis over a flattened CompiledCircuit. Pure: builds a DAG
// of combinational primitives, refuses combinational cycles, and accumulates
// longest (t_pd) and shortest (t_cd) arrival per net in one topological pass.
// Delay conventions mirror sim/delay.ts exactly so overlay numbers match sim.

import type { CompiledCircuit, CompiledPrimitive } from '../model/compile';
import { getPrimitive } from '../sim/primitives/registry';
import { intParam } from '../sim/primitives/types';
import { FALLBACK_NS } from '../sim/delay';
import {
  column,
  contaminationNs,
  getPart,
  propagationNs,
  typPublished,
  type DatasheetColumn,
} from '../parts/partsDb';

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
  /** Endpoint path; a register capture endpoint is `<dffPath>.d`. */
  endpoint: string;
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
// SPEC: sequential launch/capture prims; dlatch stays combinationally
// transparent until latch timing lands, so it is deliberately absent.
const SEQUENTIAL_KINDS = new Set(['dff', 'register']);

/** Per-part input-pin -> output-pin arc to datasheet `paths` key. */
const PART_PATHS: Record<string, Record<string, string>> = {
  '74LS283': {
    'cin->cout': 'cin_to_cout',
    'cin->sum': 'cin_to_sum',
    'a->sum': 'ab_to_sum',
    'b->sum': 'ab_to_sum',
    'a->cout': 'ab_to_cout',
    'b->cout': 'ab_to_cout',
  },
};

// SPEC: decoder/encoder have too many pins (y0..y15, i0..i15) to enumerate per
// PART_PATHS; every a/en/i<n> pin shares one arc regardless of index, so a
// prefix match stands in for an explicit table.
export function codecPathKey(inPin: string, outPin: string): string | undefined {
  if ((inPin === 'a' || /^a\d+$/.test(inPin)) && outPin.startsWith('y')) return 'sel_to_y';
  if (inPin === 'en' && outPin.startsWith('y')) return 'en_to_y';
  if (/^i\d+$/.test(inPin) && (outPin === 'a' || /^a\d+$/.test(outPin))) return 'i_to_y';
  if (/^i\d+$/.test(inPin) && outPin === 'valid') return 'i_to_valid';
  // mux (M6.5): individual d<n>/s<n> lines share one arc per class, same
  // reasoning as decoder/encoder's index-agnostic prefix match above.
  if (/^d\d+$/.test(inPin) && outPin === 'y') return 'data_to_y';
  if (/^s\d+$/.test(inPin) && outPin === 'y') return 'sel_to_y';
  // demux (M6.6): mirror image of mux, but the datasheet-real parts (74LS139/
  // 74LS138/74LS154) demux through their active-low strobe pin -- our 'd'
  // pin maps to that same en_to_y arc, not a separate data arc.
  if (inPin === 'd' && /^y\d+$/.test(outPin)) return 'en_to_y';
  if (/^s\d+$/.test(inPin) && /^y\d+$/.test(outPin)) return 'sel_to_y';
  return undefined;
}

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

function hopDelay(
  part: string | undefined,
  inPin: string,
  outPin: string,
  col: DatasheetColumn,
): HopDelay {
  if (part) {
    const key = PART_PATHS[part]?.[`${inPin}->${outPin}`] ?? codecPathKey(inPin, outPin);
    const fig = key ? getPart(part)?.paths?.[key] : undefined;
    if (fig) {
      const tpd = Math.max(column(fig.tplh, col), column(fig.tphl, col));
      const tcd = Math.min(
        Math.round(0.35 * column(fig.tplh, 'typ')),
        Math.round(0.35 * column(fig.tphl, 'typ')),
      );
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

type Role = 'source' | 'sink' | 'reg' | 'comb';

function roleOf(p: CompiledPrimitive): Role {
  if (SEQUENTIAL_KINDS.has(p.kind)) return 'reg';
  if (SOURCE_KINDS.has(p.kind)) return 'source';
  if (p.outputs.length === 0) return 'sink';
  return 'comb';
}

interface PinNames {
  ins: string[];
  outs: string[];
}

function pinNamesOf(p: CompiledPrimitive): PinNames {
  const pins = getPrimitive(p.kind).pins(p.params);
  return {
    ins: pins.filter((x) => x.dir === 'in').map((x) => x.name),
    outs: pins.filter((x) => x.dir === 'out').map((x) => x.name),
  };
}

interface HopRef {
  hop: TimingHop;
  fromNet: number;
}

interface NetArrival {
  maxPs: number;
  minPs: number;
  maxHop: HopRef | null;
  minHop: HopRef | null;
  maxSource: string;
  minSource: string;
}

interface Analysis {
  roles: Role[];
  pinNames: PinNames[];
  order: number[]; // comb prim indices, topological
}

function buildAnalysis(c: CompiledCircuit): Analysis {
  const roles = c.primitives.map(roleOf);
  const pinNames = c.primitives.map(pinNamesOf);

  const comb = c.primitives.map((_, i) => i).filter((i) => roles[i] === 'comb');
  const combSet = new Set(comb);
  const succ = new Map<number, number[]>(comb.map((i) => [i, []]));
  const indeg = new Map<number, number>(comb.map((i) => [i, 0]));
  for (const pi of comb) {
    for (const net of c.primitives[pi]!.inputs) {
      for (const d of c.drivers[net] ?? []) {
        if (!combSet.has(d.prim)) continue;
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
  return { roles, pinNames, order };
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

function propagate(
  c: CompiledCircuit,
  a: Analysis,
  col: DatasheetColumn,
  seeds: Map<number, string>,
): Map<number, NetArrival> {
  const arr = new Map<number, NetArrival>();
  for (const [net, source] of seeds)
    arr.set(net, {
      maxPs: 0,
      minPs: 0,
      maxHop: null,
      minHop: null,
      maxSource: source,
      minSource: source,
    });

  for (const pi of a.order) {
    const p = c.primitives[pi]!;
    const names = a.pinNames[pi]!;
    for (let o = 0; o < p.outputs.length; o++) {
      const outNet = p.outputs[o]!;
      for (let i = 0; i < p.inputs.length; i++) {
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
        const maxPs = from.maxPs + d.tpdPs;
        const minPs = from.minPs + d.tcdPs;
        const cur = arr.get(outNet);
        if (!cur) {
          arr.set(outNet, {
            maxPs,
            minPs,
            maxHop: { hop, fromNet: p.inputs[i]! },
            minHop: { hop, fromNet: p.inputs[i]! },
            maxSource: from.maxSource,
            minSource: from.minSource,
          });
        } else {
          if (maxPs > cur.maxPs) {
            cur.maxPs = maxPs;
            cur.maxHop = { hop, fromNet: p.inputs[i]! };
            cur.maxSource = from.maxSource;
          }
          if (minPs < cur.minPs) {
            cur.minPs = minPs;
            cur.minHop = { hop, fromNet: p.inputs[i]! };
            cur.minSource = from.minSource;
          }
        }
      }
    }
  }
  return arr;
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

function pathTiming(arr: Map<number, NetArrival>, net: number, endpoint: string): PathTiming {
  const a = arr.get(net)!;
  const critical = walkBack(arr, net, 'max');
  const short = walkBack(arr, net, 'min');
  return {
    endpoint,
    startpoint: a.maxSource,
    shortStartpoint: a.minSource,
    totalTpdPs: a.maxPs,
    totalTcdPs: a.minPs,
    critical,
    short,
    estimated: critical.some((h) => h.estimated) || short.some((h) => h.estimated),
    typUnpublished: critical.some((h) => h.typUnpublished) || short.some((h) => h.typUnpublished),
  };
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
  const net = pinNet(c, a, reg, 'clk', 'in');
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
    const lp = c.primitives[launch]!;
    const lClk = clocks.get(launch);
    if (!lClk) continue;
    const seeds = new Map(lp.outputs.map((net) => [net, lp.path]));
    const arr = propagate(c, a, col, seeds);
    for (const capture of regs) {
      const cClk = clocks.get(capture);
      if (!cClk || cClk.periodPs !== lClk.periodPs) continue;
      const dNet = pinNet(c, a, capture, 'd', 'in');
      if (dNet === undefined) continue;
      const at = arr.get(dNet);
      if (!at) continue;

      const lhq = lp.part ? (propagationNs(lp.part, 'lh', col) ?? FALLBACK_NS) : FALLBACK_NS;
      const hlq = lp.part ? (propagationNs(lp.part, 'hl', col) ?? FALLBACK_NS) : FALLBACK_NS;
      const clh = lp.part ? contaminationNs(lp.part, 'lh') : undefined;
      const chl = lp.part ? contaminationNs(lp.part, 'hl') : undefined;
      const tpcqPs = toPs(Math.max(lhq, hlq));
      const tccqPs = toPs(Math.min(clh ?? 0.35 * FALLBACK_NS, chl ?? 0.35 * FALLBACK_NS));
      const cap = c.primitives[capture]!;
      const capEntry = cap.part ? getPart(cap.part) : undefined;
      // SPEC: unbound capture register contributes zero setup/hold.
      const tsetupPs = toPs(capEntry?.setup_min ?? 0);
      const tholdPs = toPs(capEntry?.hold_min ?? 0);
      const skewPs = cClk.phasePs - lClk.phasePs;
      const tpdCombPs = at.maxPs;
      const tcdCombPs = at.minPs;
      const minPeriodPs = tpcqPs + tpdCombPs + tsetupPs + skewPs;
      paths.push({
        launch: lp.path,
        capture: cap.path,
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
  return {
    paths,
    minPeriodPs: paths.length ? Math.max(...paths.map((p) => p.minPeriodPs)) : null,
    multiDomain,
  };
}

export function analyzeTiming(c: CompiledCircuit, opts: { column: DatasheetColumn }): TimingReport {
  const a = buildAnalysis(c);
  const col = opts.column;

  // Startpoints: source prims, register outputs, and undriven nets read by
  // logic (top-level In labels compile to no primitive, only an aliased net).
  const seeds = new Map<number, string>();
  const regs: number[] = [];
  c.primitives.forEach((p, i) => {
    const role = a.roles[i]!;
    if (role === 'reg') regs.push(i);
    if (role === 'source' || role === 'reg') for (const net of p.outputs) seeds.set(net, p.path);
  });
  c.primitives.forEach((p) => {
    for (const net of p.inputs)
      if (!seeds.has(net) && (c.drivers[net] ?? []).length === 0)
        seeds.set(net, c.nets[net]!.paths[0]!);
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
      if (best !== undefined) endpoints.push(pathTiming(arr, best, p.path));
    } else if (a.roles[i] === 'reg') {
      const dNet = pinNet(c, a, i, 'd', 'in');
      if (dNet !== undefined && arr.has(dNet)) endpoints.push(pathTiming(arr, dNet, `${p.path}.d`));
    }
  });

  const worst = endpoints.reduce<PathTiming | null>(
    (w, e) => (w === null || e.totalTpdPs > w.totalTpdPs ? e : w),
    null,
  );

  return { endpoints, worst, sequential: sequentialTiming(c, a, col, regs) };
}
