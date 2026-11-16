// Event-driven simulation kernel. Discrete time in integer picoseconds,
// deterministic replay: events order by (time, seq), primitives evaluate in
// ascending index order, and nothing here is random.

import * as bv from '../value/busValue';
import type { CompiledCircuit } from '../model/compile';
import { isStructuralHop, type DelayModel } from './delay';
import { EventQueue } from './eventQueue';
import { getPrimitive } from './primitives/registry';
import type { Params, PrimitiveSpec } from './primitives/types';

export const OSC_EVENT_LIMIT = 10_000;

/** The net edge that triggered an evaluation/change; NO_CAUSE for power-on,
 * user actions, and clock self-wakes. */
export interface CauseEdge {
  net: number;
  time: number;
}

export const NO_CAUSE: CauseEdge = Object.freeze({ net: -1, time: -1 });

interface SimEvent {
  time: number;
  seq: number;
  prim: number;
  /** Output slot for drive events; -1 marks a wake (re-evaluate, no value). */
  out: number;
  value: bv.BusValue;
  cause: CauseEdge;
  /** Superseded by a later-issued drive of the same output; skipped on pop. */
  cancelled?: boolean;
  /** A wake a primitive asked for itself: `finite` for a bounce, else a clock's. */
  timed?: 'finite' | 'endless';
}

export interface NetChangeRecord {
  time: number;
  net: number;
  value: bv.BusValue;
  /** Input edge whose propagation produced this change (cause arrows). */
  cause: CauseEdge;
}

export interface DeltaReport {
  time: number;
  changedNets: number[];
  evaluated: number[];
}

export interface SettleReport {
  settled: boolean;
  time: number;
  eventsProcessed: number;
  /** Present when settled is false: the loop the instructor gets shown. */
  oscillation?: { nets: number[]; primitives: number[]; recent: NetChangeRecord[] };
}

export interface GateStepReport {
  time: number;
  changedNets: number[];
  evaluated: number[];
  /** Primitives still holding a live drive or wake after the step. */
  pendingPrimitives: number[];
  settled: boolean;
  /** Present when a zero-delay loop blew the event budget within the step. */
  oscillation?: NonNullable<SettleReport['oscillation']>;
}

export interface NextSlice {
  time: number;
  primitives: number[];
  wakes: boolean;
}

type Listener = (net: number, value: bv.BusValue, time: number) => void;

/** Weak pulls claim only the bits every driver left floating. */
function applyPull(value: bv.BusValue, pull: 0 | 1 | undefined): bv.BusValue {
  if (pull === undefined || !value.z) return value;
  return { v: (value.v | (pull ? value.z : 0)) >>> 0, x: value.x, z: 0 };
}

export class Simulator {
  time = 0;
  /** Self-timed wakes (clock sources) only fire while running; power-on
   * settling happens with clocks parked so it always drains. */
  private running = false;
  private seq = 0;
  private readonly queue = new EventQueue<SimEvent>();
  private readonly specs: PrimitiveSpec[];
  private readonly netValues: bv.BusValue[];
  /** Per net, one contribution slot per driving output. */
  private readonly contributions: bv.BusValue[][];
  /** (prim, out) -> [net, slot] so a drive event lands in its contribution. */
  private readonly outputSlots: [number, number][][];
  /** Last value scheduled per output; suppresses redundant identical events. */
  private readonly lastScheduled: bv.BusValue[][];
  /** Per output, its queued drives in ascending time: the transport rule
   *  cancels from the tail, and the head is the next one to land. */
  private readonly pendingDrives: SimEvent[][][];
  private cancelledInQueue = 0;
  private readonly states: unknown[];
  private readonly lastInputs: bv.BusValue[][];
  private readonly pendingWake: number[];
  /** The wake event behind pendingWake, valid while the two times agree. */
  private readonly pendingWakeEv: (SimEvent | undefined)[];
  /** Queued wakes a primitive asked for, so a pause or a new state can drop them. */
  private readonly timedWakes = new Set<SimEvent>();
  /** Primitives whose last evaluation asked to be re-woken (a clock, a running
   *  555). Recorded even while parked, so a paused Step can tell whether
   *  there is any source of future events at all. */
  private readonly selfTimed: boolean[];
  /** Set only for the arming sweep inside stepToNextEvent: it lets a parked
   *  self-timed primitive re-arm for that one delta without entering run. */
  private stepping = false;
  private readonly trace: NetChangeRecord[] = [];
  private traceHead = 0;
  private traceCount = 0;
  private readonly listeners = new Set<Listener>();

  constructor(
    readonly circuit: CompiledCircuit,
    private readonly delay: DelayModel,
    private readonly traceCapacity = 65536,
  ) {
    this.specs = circuit.primitives.map((p) => getPrimitive(p.kind));
    this.netValues = circuit.nets.map((n) => applyPull(bv.allZ(n.width), n.pull));
    this.contributions = circuit.nets.map(() => []);
    this.outputSlots = circuit.primitives.map(() => []);
    this.lastScheduled = circuit.primitives.map((p, pi) =>
      p.outputs.map((net) => {
        const slot = this.contributions[net]!.length;
        this.contributions[net]!.push(bv.allZ(circuit.nets[net]!.width));
        this.outputSlots[pi]!.push([net, slot]);
        return bv.allZ(circuit.nets[net]!.width);
      }),
    );
    this.pendingDrives = circuit.primitives.map((p) => p.outputs.map(() => []));
    this.states = circuit.primitives.map((p, pi) => this.specs[pi]!.init?.(p.params));
    this.lastInputs = circuit.primitives.map((p) =>
      p.inputs.map((net) => bv.allX(circuit.nets[net]!.width)),
    );
    this.pendingWake = circuit.primitives.map(() => -1);
    this.pendingWakeEv = circuit.primitives.map(() => undefined);
    this.selfTimed = circuit.primitives.map(() => false);
  }

  /** Power on: everything unknown, then settle. The all-X start is the lesson. */
  powerOn(limit = OSC_EVENT_LIMIT): SettleReport {
    this.time = 0;
    this.running = false;
    this.seq = 0;
    while (this.queue.size) this.queue.pop();
    this.cancelledInQueue = 0;
    this.timedWakes.clear();
    for (const outs of this.pendingDrives) for (const pending of outs) pending.length = 0;
    this.trace.length = 0;
    this.traceHead = 0;
    this.traceCount = 0;
    this.circuit.nets.forEach((n, i) => {
      const driven = this.contributions[i]!.length > 0;
      // A net nobody drives is never dirty, so the settle loop would never
      // reach it: its pull has to be applied here or a pull on a wholly
      // undriven net does nothing at all.
      this.netValues[i] = applyPull(driven ? bv.allX(n.width) : bv.allZ(n.width), n.pull);
      this.record(i, this.netValues[i]!, NO_CAUSE);
    });
    this.circuit.primitives.forEach((p, pi) => {
      this.states[pi] = this.specs[pi]!.init?.(p.params);
      this.lastInputs[pi] = p.inputs.map((net) => bv.allX(this.circuit.nets[net]!.width));
      this.outputSlots[pi]!.forEach(([net, slot], out) => {
        const x = bv.allX(this.circuit.nets[net]!.width);
        this.contributions[net]![slot] = x;
        this.lastScheduled[pi]![out] = x;
      });
      this.pendingWake[pi] = -1;
      this.scheduleWake(pi, 0, NO_CAUSE);
    });
    return this.settle(limit);
  }

  /** Runs delta steps until quiet or the event budget blows: oscillation. */
  settle(limit = OSC_EVENT_LIMIT): SettleReport {
    let processed = 0;
    while (this.liveEvents > 0) {
      const report = this.deltaStep();
      if (!report) break;
      processed += report.changedNets.length + report.evaluated.length;
      if (processed > limit) {
        return {
          settled: false,
          time: this.time,
          eventsProcessed: processed,
          oscillation: this.oscillationReport(),
        };
      }
    }
    return { settled: true, time: this.time, eventsProcessed: processed };
  }

  /**
   * Processes exactly one time slice (all events at the next pending time):
   * apply drives, re-resolve dirty nets, evaluate affected primitives once.
   */
  deltaStep(): DeltaReport | null {
    const first = this.peekLive();
    if (!first) return null;
    const t = first.time;
    this.time = t;

    const dirtyNets = new Set<number>();
    const toEvaluate = new Set<number>();
    const causeByPrim = new Map<number, CauseEdge>();

    while (this.peekLive()?.time === t) {
      const ev = this.queue.pop()!;
      if (ev.timed) this.timedWakes.delete(ev);
      if (ev.out === -1) {
        if (this.pendingWake[ev.prim] === ev.time) this.pendingWake[ev.prim] = -1;
        toEvaluate.add(ev.prim);
        if (!causeByPrim.has(ev.prim)) causeByPrim.set(ev.prim, ev.cause);
      } else {
        this.pendingDrives[ev.prim]![ev.out]!.shift();
        const [net, slot] = this.outputSlots[ev.prim]![ev.out]!;
        // Same-time same-slot events apply in seq order: last writer wins.
        this.contributions[net]![slot] = ev.value;
        dirtyNets.add(net);
        causeByPrim.set(net + this.circuit.primitives.length, ev.cause);
      }
    }

    const changedNets: number[] = [];
    for (const net of [...dirtyNets].sort((a, b) => a - b)) {
      const meta = this.circuit.nets[net]!;
      const value = applyPull(bv.resolve(this.contributions[net]!, meta.width), meta.pull);
      if (bv.equal(value, this.netValues[net]!)) continue;
      this.netValues[net] = value;
      const cause = causeByPrim.get(net + this.circuit.primitives.length) ?? NO_CAUSE;
      this.record(net, value, cause);
      changedNets.push(net);
      // Downstream primitives are caused by this edge itself, not its ancestor.
      const edge: CauseEdge = { net, time: t };
      for (const pi of this.circuit.fanout[net]!) {
        toEvaluate.add(pi);
        if (!causeByPrim.has(pi)) causeByPrim.set(pi, edge);
      }
      for (const l of this.listeners) l(net, value, t);
    }

    const evaluated = [...toEvaluate].sort((a, b) => a - b);
    for (const pi of evaluated) this.evaluate(pi, causeByPrim.get(pi) ?? NO_CAUSE);

    return { time: t, changedNets, evaluated };
  }

  /**
   * One manual step. A settled circuit has an empty queue by construction
   * (settle drains it, and parked clocks do not re-arm), so a bare deltaStep
   * would sit there doing nothing forever. Arm the self-timed sources for one
   * delta first, then advance to the earliest event now pending: the next
   * clock edge on a clocked board.
   */
  stepToNextEvent(): DeltaReport | null {
    if (this.liveEvents === 0) {
      this.stepping = true;
      try {
        this.circuit.primitives.forEach((_, pi) => this.scheduleWake(pi, this.time, NO_CAUSE));
        // The sweep lands at the current time and changes nothing; consuming
        // it here is bookkeeping, so the step the caller asked for is the one
        // below and time actually moves.
        this.deltaStep();
      } finally {
        this.stepping = false;
      }
    }
    const report = this.deltaStep();
    // The sweep armed every source and the step took the earliest; the rest
    // would drag the next paused settle out to their edges.
    if (!this.running) this.cancelTimedWakes((ev) => ev.timed === 'endless');
    return report;
  }

  /**
   * One gate delay: every slice at the next pending time, so wiring that
   * passes a value on in zero time lands in the same press. Arms the
   * self-timed sources on an empty queue as stepToNextEvent does. Null when
   * nothing can move.
   */
  gateStep(limit = OSC_EVENT_LIMIT): GateStepReport | null {
    const first = this.stepToNextEvent();
    if (!first) return null;
    const changed = new Set(first.changedNets);
    const evaluated = new Set(first.evaluated);
    let processed = changed.size + evaluated.size;
    while (this.peekLive()?.time === first.time) {
      if (processed > limit)
        return {
          ...this.gateReport(first.time, changed, evaluated),
          settled: false,
          oscillation: this.oscillationReport(),
        };
      const report = this.deltaStep()!;
      for (const net of report.changedNets) changed.add(net);
      for (const pi of report.evaluated) evaluated.add(pi);
      processed += report.changedNets.length + report.evaluated.length;
    }
    return this.gateReport(first.time, changed, evaluated);
  }

  private gateReport(
    time: number,
    changed: ReadonlySet<number>,
    evaluated: ReadonlySet<number>,
  ): GateStepReport {
    const ascending = (a: number, b: number) => a - b;
    return {
      time,
      changedNets: [...changed].sort(ascending),
      evaluated: [...evaluated].sort(ascending),
      pendingPrimitives: this.pendingPrimitives(),
      settled: this.settled,
    };
  }

  /** Primitives with a live drive or wake queued: the parts a gate step will still move. */
  pendingPrimitives(): number[] {
    const out: number[] = [];
    this.pendingDrives.forEach((outs, pi) => {
      const wake = this.pendingWakeEv[pi];
      const waking = !!wake && !wake.cancelled && this.pendingWake[pi] === wake.time;
      if (waking || outs.some((pending) => pending.length > 0)) out.push(pi);
    });
    return out;
  }

  /** What lands at the next pending time: the primitive behind each live
   *  event there, and whether any of them is a wake. Null on an empty queue. */
  nextSlice(): NextSlice | null {
    const first = this.peekLive();
    if (!first) return null;
    const primitives = new Set<number>();
    let wakes = false;
    this.queue.forEach((ev) => {
      if (ev.cancelled || ev.time !== first.time) return;
      primitives.add(ev.prim);
      if (ev.out === -1) wakes = true;
    });
    return { time: first.time, primitives: [...primitives].sort((a, b) => a - b), wakes };
  }

  /** Every drive has landed and only self-timed wakes (clocks, bounce) remain:
   *  a running board's logic has caught up with its last edge. */
  get logicSettled(): boolean {
    if (this.pendingDrives.some((outs) => outs.some((pending) => pending.length > 0))) return false;
    let plainWake = false;
    this.queue.forEach((ev) => {
      if (!ev.cancelled && ev.out === -1 && !ev.timed) plainWake = true;
    });
    return !plainWake;
  }

  /** Nothing queued. A paused clocked board is settled yet can still step. */
  get settled(): boolean {
    return this.liveEvents === 0;
  }

  /** Whether stepToNextEvent can still move: something queued, or some source
   *  that will queue one. False on a settled purely combinational board. */
  get canStep(): boolean {
    return this.liveEvents > 0 || this.selfTimed.some(Boolean);
  }

  /** Enters continuous run: wakes everything so clocks begin self-scheduling. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.circuit.primitives.forEach((_, pi) => this.scheduleWake(pi, this.time, NO_CAUSE));
  }

  /** Parks clocks. Their queued wakes go too: a paused settle would otherwise
   *  play on to the next clock or 555 edge. start() wakes them all again. */
  stop(): void {
    this.running = false;
    this.cancelTimedWakes((ev) => ev.timed === 'endless');
  }

  /**
   * Processes deltas while the next event is at or before targetPs. A spent
   * budget leaves time at the last event processed: jumping to the target
   * would strand the remaining events in the past.
   */
  runUntil(targetPs: number, budget = OSC_EVENT_LIMIT * 10): number {
    let processed = 0;
    while (processed < budget) {
      const next = this.peekLive();
      if (!next || next.time > targetPs) break;
      const report = this.deltaStep()!;
      processed += report.changedNets.length + report.evaluated.length;
    }
    const pending = this.peekLive();
    if (this.time < targetPs && !(pending && pending.time <= targetPs)) this.time = targetPs;
    return processed;
  }

  /** Whether the last runUntil stopped short of its target on a spent budget. */
  isBehind(targetPs: number): boolean {
    const pending = this.peekLive();
    return this.time < targetPs && !!pending && pending.time <= targetPs;
  }

  netValue(net: number): bv.BusValue {
    return this.netValues[net]!;
  }

  netValueByPath(path: string): bv.BusValue {
    const net = this.circuit.pathToNet.get(path);
    if (net === undefined) throw new Error(`no net at path '${path}'`);
    return this.netValues[net]!;
  }

  /** Replaces a primitive's state (switch flips, input assignment) and wakes it. */
  setPrimitiveState(path: string, state: unknown): void {
    const pi = this.circuit.pathToPrimitive.get(path);
    if (pi === undefined) throw new Error(`no primitive at path '${path}'`);
    this.setPrimitiveStateAt(pi, state);
  }

  /** Index-keyed form. A path is ambiguous whenever two components share a
   *  label (same-net label sharing), so a caller holding a specific component
   *  must resolve through `componentToPrimitive` and come in here instead. */
  setPrimitiveStateAt(pi: number, state: unknown): void {
    if (pi < 0 || pi >= this.states.length) throw new Error(`no primitive at index ${pi}`);
    this.states[pi] = state;
    // A bounce left over from the old state would wake it again later and drag
    // a paused settle or Step out to that time for nothing.
    this.cancelTimedWakes((ev) => ev.prim === pi && ev.timed === 'finite');
    this.scheduleWake(pi, this.time, NO_CAUSE);
  }

  /** Patches a primitive's compiled params in place and wakes it, so a param
   *  that evaluate() re-reads every call (a constant's value) can change under
   *  a live sim instead of forcing a power cycle. Only params that cannot
   *  alter pin count or width may come through here: the netlist, the nets'
   *  widths and the delay bindings are already built from the old ones, so a
   *  pin-shape change would leave the kernel describing a circuit that is no
   *  longer the one on the board. Callers gate on paramSpecs' liveness. */
  setPrimitiveParamsAt(pi: number, patch: Params): void {
    const prim = this.circuit.primitives[pi];
    if (!prim) throw new Error(`no primitive at index ${pi}`);
    prim.params = { ...prim.params, ...patch };
    this.scheduleWake(pi, this.time, NO_CAUSE);
  }

  /** Current state a primitive's own init()/evaluate() manages (switch value,
   *  button held, ...) -- the authoritative source for a stateful primitive's
   *  current value, independent of how pinView currently shapes its pins
   *  (a caller reading the value back off a net can't when e.g. a toggle's
   *  `y` is pinView-expanded into y0..y(w-1), no single `y` net exists). */
  getPrimitiveState(path: string): unknown {
    const pi = this.circuit.pathToPrimitive.get(path);
    if (pi === undefined) throw new Error(`no primitive at path '${path}'`);
    return this.primitiveStateAt(pi);
  }

  /** Index-keyed form; see setPrimitiveStateAt for why a caller wants it. */
  primitiveStateAt(pi: number): unknown {
    if (pi < 0 || pi >= this.states.length) throw new Error(`no primitive at index ${pi}`);
    return this.states[pi];
  }

  /** width-1 convenience; forever stays width 1 even as setToggleValue grows. */
  setToggle(path: string, on: boolean): void {
    this.setToggleValue(path, on ? 1 : 0);
  }

  setToggleValue(path: string, value: number): void {
    this.setPrimitiveState(path, { value });
  }

  /** Button's state shape ({on}) is distinct from toggle's ({value}); own setter. */
  setButtonPressed(path: string, on: boolean): void {
    this.setPrimitiveState(path, { on });
  }

  setInput(path: string, value: bv.BusValue): void {
    this.setPrimitiveState(path, { value });
  }

  onNetChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Chronological bounded history of net changes (waveform + golden traces). */
  traceRecords(): NetChangeRecord[] {
    if (this.trace.length < this.traceCapacity) return [...this.trace];
    return [...this.trace.slice(this.traceHead), ...this.trace.slice(0, this.traceHead)];
  }

  get pendingEvents(): number {
    return this.liveEvents;
  }

  private get liveEvents(): number {
    return this.queue.size - this.cancelledInQueue;
  }

  private peekLive(): SimEvent | undefined {
    while (this.queue.peek()?.cancelled) {
      this.queue.pop();
      this.cancelledInQueue--;
    }
    return this.queue.peek();
  }

  private evaluate(pi: number, cause: CauseEdge): void {
    const prim = this.circuit.primitives[pi]!;
    const spec = this.specs[pi]!;
    const inputs = prim.inputs.map((net) => this.netValues[net]!);
    const prevInputs = this.lastInputs[pi]!;
    const result = spec.evaluate({
      params: prim.params,
      state: this.states[pi],
      inputs,
      prevInputs,
      time: this.time,
    });
    this.lastInputs[pi] = inputs;
    let changedInputs: number[] | undefined;
    if ('state' in result) this.states[pi] = result.state;

    result.outputs.forEach((value, out) => {
      if (value === null || value === undefined) return;
      const prev = this.lastScheduled[pi]![out]!;
      if (bv.equal(value, prev)) return;
      this.lastScheduled[pi]![out] = value;
      changedInputs ??= inputs.flatMap((v, i) => (bv.equal(v, prevInputs[i]!) ? [] : [i]));
      const ps = Math.trunc(this.delay.delayPs(prim, out, prev, value, changedInputs));
      // Only wiring may pass a value on within the same time; silicon always takes time.
      const floor = isStructuralHop(prim) ? 0 : 1;
      this.scheduleDrive(pi, out, this.time + Math.max(floor, ps), value, cause);
    });

    if (result.nextWake !== undefined && result.finite) {
      this.scheduleWake(pi, result.nextWake, cause, 'finite');
    } else {
      // Per evaluation, not "ever": an idle monostable has nothing left to step to.
      this.selfTimed[pi] = result.nextWake !== undefined;
      if (result.nextWake !== undefined && (this.running || this.stepping))
        this.scheduleWake(pi, result.nextWake, cause, 'endless');
    }
  }

  /**
   * Transport delay, VHDL rule: a new drive cancels the output's drives queued
   * at or after it, so the last-issued value wins even when tPLH != tPHL puts
   * it ahead of an older one. Drives queued earlier still land: real glitches.
   */
  private scheduleDrive(
    pi: number,
    out: number,
    time: number,
    value: bv.BusValue,
    cause: CauseEdge,
  ): void {
    const pending = this.pendingDrives[pi]![out]!;
    while (pending.length && pending[pending.length - 1]!.time >= time) {
      pending.pop()!.cancelled = true;
      this.cancelledInQueue++;
    }
    const ev: SimEvent = { time, seq: this.seq++, prim: pi, out, value, cause };
    pending.push(ev);
    this.queue.push(ev);
  }

  private scheduleWake(
    pi: number,
    time: number,
    cause: CauseEdge,
    timed?: SimEvent['timed'],
  ): void {
    const at = Math.max(time, this.time);
    if (this.pendingWake[pi] === at) {
      // A plain wake merged into a timed one must survive that one being dropped.
      const merged = this.pendingWakeEv[pi];
      if (!timed && merged?.timed) {
        delete merged.timed;
        this.timedWakes.delete(merged);
      }
      return;
    }
    this.pendingWake[pi] = at;
    const ev: SimEvent = { time: at, seq: this.seq++, prim: pi, out: -1, value: bv.allZ(1), cause };
    if (timed) {
      ev.timed = timed;
      this.timedWakes.add(ev);
    }
    this.pendingWakeEv[pi] = ev;
    this.queue.push(ev);
  }

  private cancelTimedWakes(drop: (ev: SimEvent) => boolean): void {
    for (const ev of this.timedWakes) {
      if (!drop(ev)) continue;
      this.timedWakes.delete(ev);
      ev.cancelled = true;
      this.cancelledInQueue++;
      if (this.pendingWake[ev.prim] === ev.time) this.pendingWake[ev.prim] = -1;
    }
  }

  /** Total records ever written (monotonic): a cheap has-the-trace-grown probe. */
  get traceLength(): number {
    return this.traceCount;
  }

  private record(net: number, value: bv.BusValue, cause: CauseEdge): void {
    this.traceCount++;
    const rec = { time: this.time, net, value, cause };
    if (this.trace.length < this.traceCapacity) this.trace.push(rec);
    else {
      this.trace[this.traceHead] = rec;
      this.traceHead = (this.traceHead + 1) % this.traceCapacity;
    }
  }

  /** Nets where two drivers now drive opposite known levels on some bit. An X
   *  driver is not counted: an uninitialised flip-flop is not a fight. */
  fightingNets(): number[] {
    const out: number[] = [];
    this.contributions.forEach((drives, net) => {
      if (drives.length < 2) return;
      let ones = 0;
      let zeros = 0;
      for (const d of drives) {
        const known = ~(d.z | d.x);
        ones |= d.v & known;
        zeros |= ~d.v & known;
      }
      if ((ones & zeros & bv.widthMask(this.circuit.nets[net]!.width)) !== 0) out.push(net);
    });
    return out;
  }

  /** Recent activity tells the instructor where the loop is. */
  oscillationReport(): NonNullable<SettleReport['oscillation']> {
    const recent = this.traceRecords().slice(-64);
    const nets = [...new Set(recent.map((r) => r.net))];
    const primitives = [
      ...new Set(nets.flatMap((n) => this.circuit.drivers[n]!.map((d) => d.prim))),
    ];
    return { nets, primitives, recent };
  }
}
