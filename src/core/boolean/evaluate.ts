// Pure combinational evaluation over a flattened CompiledCircuit -- no event
// queue, no delay, no clock. Used by the Gates workbench's truth-table
// enforcement; the circuit must be purely combinational
// (no dff/dlatch/register, no feedback loop) or evaluation throws.

import type { CompiledCircuit } from '../model/compile';
import { getPrimitive } from '../sim/primitives/registry';
import * as bv from '../value/busValue';
import type { BusValue } from '../value/busValue';

export class BooleanEvalError extends Error {}

/**
 * Resolves every net in `circuit` given a driven value for some subset of
 * nets (typically the seeded primitives' output nets). A seeded primitive is
 * never evaluated: its output net must already be in `driven`, else it
 * defaults to X. `seeded` defaults to every 'inport' primitive; callers
 * treating other kinds (e.g. toggles) as table inputs pass indices
 * explicitly. Pure sinks (output/led/probe) are skipped, and an undriven net
 * defaults to Z, matching the kernel.
 */
export function evaluateNets(
  circuit: CompiledCircuit,
  driven: ReadonlyMap<number, BusValue>,
  seeded?: ReadonlySet<number>,
): Map<number, BusValue> {
  const seededSet =
    seeded ??
    new Set(
      circuit.primitives.map((_, i) => i).filter((i) => circuit.primitives[i]!.kind === 'inport'),
    );
  const values = new Map(driven);
  const pending = new Set(
    circuit.primitives
      .map((_, i) => i)
      .filter((i) => !seededSet.has(i) && circuit.primitives[i]!.outputs.length > 0),
  );

  const netValue = (n: number): BusValue | undefined => {
    const known = values.get(n);
    if (known) return known;
    const drivers = circuit.drivers[n]!;
    if (drivers.length === 0) {
      const z = bv.allZ(circuit.nets[n]!.width);
      values.set(n, z);
      return z;
    }
    if (drivers.every((d) => seededSet.has(d.prim))) {
      const x = bv.allX(circuit.nets[n]!.width);
      values.set(n, x);
      return x;
    }
    return undefined;
  };

  let progressed = true;
  while (pending.size > 0 && progressed) {
    progressed = false;
    for (const i of pending) {
      const prim = circuit.primitives[i]!;
      const inputs: BusValue[] = [];
      let ready = true;
      for (const n of prim.inputs) {
        const v = netValue(n);
        if (v === undefined) {
          ready = false;
          break;
        }
        inputs.push(v);
      }
      if (!ready) continue;
      const spec = getPrimitive(prim.kind);
      const state = spec.init ? spec.init(prim.params) : undefined;
      const result = spec.evaluate({
        params: prim.params,
        state,
        inputs,
        prevInputs: inputs,
        time: 0,
      });
      prim.outputs.forEach((n, slot) => {
        const out = result.outputs[slot];
        if (out) values.set(n, out);
      });
      pending.delete(i);
      progressed = true;
    }
  }

  if (pending.size > 0) {
    const stuck = [...pending].map((i) => circuit.primitives[i]!.path).join(', ');
    throw new BooleanEvalError(`not purely combinational: cycle or unresolved driver at ${stuck}`);
  }

  // Nets read only by a skipped 'outport' primitive (or read by nothing at
  // all) never went through netValue() above; force their default now.
  for (let n = 0; n < circuit.nets.length; n++) netValue(n);

  return values;
}
