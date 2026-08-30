// Event-driven simulation kernel. Discrete time in integer picoseconds,
// deterministic replay: events order by (time, seq), primitives evaluate in
// ascending index order, and nothing here is random.

import * as bv from '../value/busValue';
import type { CompiledCircuit } from '../model/compile';
import type { DelayModel } from './delay';
import { EventQueue } from './eventQueue';
import { getPrimitive } from './primitives/registry';
import type { PrimitiveSpec } from './primitives/types';

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

type Listener = (net: number, value: bv.BusValue, time: number) => void;

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
  private readonly states: unknown[];
  private readonly lastInputs: bv.BusValue[][];
  private readonly pendingWake: number[];
  /** Primitives that have ever asked to be re-woken (a clock is the only one
   *  today). Recorded even while parked, so a paused Step can tell whether
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
    this.netValues = circuit.nets.map((n) => bv.allZ(n.width));
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
    this.states = circuit.primitives.map((p, pi) => this.specs[pi]!.init?.(p.params));
    this.lastInputs = circuit.primitives.map((p) =>
      p.inputs.map((net) => bv.allX(circuit.nets[net]!.width)),
    );
    this.pendingWake = circuit.primitives.map(() => -1);
    this.selfTimed = circuit.primitives.map(() => false);
  }

  /** Power on: everything unknown, then settle. The all-X start is the lesson. */
  powerOn(limit = OSC_EVENT_LIMIT): SettleReport {
    this.time = 0;
    this.running = false;
    this.seq = 0;
    while (this.queue.size) this.queue.pop();
    this.trace.length = 0;
    this.traceHead = 0;
    this.traceCount = 0;
    this.circuit.nets.forEach((n, i) => {
      const driven = this.contributions[i]!.length > 0;
      this.netValues[i] = driven ? bv.allX(n.width) : bv.allZ(n.width);
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
    while (this.queue.size > 0) {
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
    const first = this.queue.peek();
    if (!first) return null;
    const t = first.time;
    this.time = t;

    const dirtyNets = new Set<number>();
    const toEvaluate = new Set<number>();
    const causeByPrim = new Map<number, CauseEdge>();

    while (this.queue.peek()?.time === t) {
      const ev = this.queue.pop()!;
      if (ev.out === -1) {
        if (this.pendingWake[ev.prim] === ev.time) this.pendingWake[ev.prim] = -1;
        toEvaluate.add(ev.prim);
        if (!causeByPrim.has(ev.prim)) causeByPrim.set(ev.prim, ev.cause);
      } else {
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
      let value = bv.resolve(this.contributions[net]!, meta.width);
      // Weak pulls claim only the bits every driver left floating.
      if (meta.pull !== undefined && value.z) {
        value = { v: (value.v | (meta.pull ? value.z : 0)) >>> 0, x: value.x, z: 0 };
      }
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
    if (this.queue.size === 0) {
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
    return this.deltaStep();
  }

  /** Whether stepToNextEvent can still move: something queued, or some source
   *  that will queue one. False on a settled purely combinational board. */
  get canStep(): boolean {
    return this.queue.size > 0 || this.selfTimed.some(Boolean);
  }

  /** Enters continuous run: wakes everything so clocks begin self-scheduling. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.circuit.primitives.forEach((_, pi) => this.scheduleWake(pi, this.time, NO_CAUSE));
  }

  /** Parks clocks; already-queued events still fire, then the queue drains. */
  stop(): void {
    this.running = false;
  }

  /** Processes deltas while the next event is at or before targetPs. */
  runUntil(targetPs: number, budget = OSC_EVENT_LIMIT * 10): number {
    let processed = 0;
    while (processed < budget) {
      const next = this.queue.peek();
      if (!next || next.time > targetPs) break;
      const report = this.deltaStep()!;
      processed += report.changedNets.length + report.evaluated.length;
    }
    if (this.time < targetPs) this.time = targetPs;
    return processed;
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
    return this.queue.size;
  }

  private evaluate(pi: number, cause: CauseEdge): void {
    const prim = this.circuit.primitives[pi]!;
    const spec = this.specs[pi]!;
    const inputs = prim.inputs.map((net) => this.netValues[net]!);
    const result = spec.evaluate({
      params: prim.params,
      state: this.states[pi],
      inputs,
      prevInputs: this.lastInputs[pi]!,
      time: this.time,
    });
    this.lastInputs[pi] = inputs;
    if ('state' in result) this.states[pi] = result.state;

    result.outputs.forEach((value, out) => {
      if (value === null || value === undefined) return;
      const prev = this.lastScheduled[pi]![out]!;
      if (bv.equal(value, prev)) return;
      this.lastScheduled[pi]![out] = value;
      const delay = Math.max(1, Math.trunc(this.delay.delayPs(prim, out, prev, value)));
      this.queue.push({ time: this.time + delay, seq: this.seq++, prim: pi, out, value, cause });
    });

    if (result.nextWake !== undefined) {
      this.selfTimed[pi] = true;
      if (this.running || this.stepping) this.scheduleWake(pi, result.nextWake, cause);
    }
  }

  private scheduleWake(pi: number, time: number, cause: CauseEdge): void {
    const at = Math.max(time, this.time);
    if (this.pendingWake[pi] === at) return;
    this.pendingWake[pi] = at;
    this.queue.push({ time: at, seq: this.seq++, prim: pi, out: -1, value: bv.allZ(1), cause });
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

  /** Recent activity tells the instructor where the loop is. */
  private oscillationReport(): NonNullable<SettleReport['oscillation']> {
    const recent = this.traceRecords().slice(-64);
    const nets = [...new Set(recent.map((r) => r.net))];
    const primitives = [
      ...new Set(nets.flatMap((n) => this.circuit.drivers[n]!.map((d) => d.prim))),
    ];
    return { nets, primitives, recent };
  }
}
