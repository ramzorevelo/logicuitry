import type { CompiledCircuit } from '../model/compile';
import { getPart, setupHoldNs } from '../parts/partsDb';
import { pinNamesOf } from '../sim/delay';
import type { NetChangeRecord } from '../sim/kernel';
import { timingShape } from './shape';

export interface ApertureWindow {
  net: number;
  kind: 'setup' | 'hold';
  t0: number;
  t1: number;
}

/** Rising edges inside [t0, t1]; X or Z reads as low, so X -> 1 is shaded like 0 -> 1. */
function risingEdges(records: readonly NetChangeRecord[], net: number, t0: number, t1: number) {
  const edges: number[] = [];
  let prev = 0;
  for (const r of records) {
    if (r.net !== net) continue;
    const v = r.value.x | r.value.z ? 0 : r.value.v & 1;
    if (prev === 0 && v === 1 && r.time >= t0 && r.time <= t1) edges.push(r.time);
    prev = v;
  }
  return edges;
}

/**
 * Setup and hold windows on every sampled input of the given clocked
 * primitives, around each rising edge of their clock in the window. A part
 * that publishes no setup or hold figure for a pin's class shades nothing.
 */
export function setupHoldWindows(
  circuit: CompiledCircuit,
  records: readonly NetChangeRecord[],
  prims: Iterable<number>,
  t0: number,
  t1: number,
): ApertureWindow[] {
  const out: ApertureWindow[] = [];
  // One net on two sampled pins (enp tied to ent) would otherwise stack two identical windows.
  const seen = new Set<string>();
  const push = (w: ApertureWindow) => {
    const key = `${w.net}:${w.kind}:${w.t0}:${w.t1}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(w);
  };
  for (const pi of prims) {
    const prim = circuit.primitives[pi]!;
    const shape = timingShape(prim.kind, prim.params);
    if (!shape?.clock) continue;
    const ins = pinNamesOf(prim).ins;
    const clkNet = prim.inputs[ins.indexOf(shape.clock)];
    if (clkNet === undefined) continue;
    const edges = risingEdges(records, clkNet, t0, t1);
    const entry = prim.part ? getPart(prim.part) : undefined;
    ins.forEach((pin, slot) => {
      const timing = shape.pins.get(pin);
      if (typeof timing !== 'object') return;
      const { setupNs, holdNs } = setupHoldNs(entry, timing.sampled);
      const net = prim.inputs[slot]!;
      for (const t of edges) {
        if (setupNs) push({ net, kind: 'setup', t0: t - Math.round(setupNs * 1000), t1: t });
        if (holdNs) push({ net, kind: 'hold', t0: t, t1: t + Math.round(holdNs * 1000) });
      }
    });
  }
  return out;
}
