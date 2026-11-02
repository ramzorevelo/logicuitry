import type { Component } from './types';
import type { CompiledCircuit } from './compile';
import { getPrimitive, hasPrimitive } from '../sim/primitives/registry';
import { inputSlotPins, outputSlotPins } from './pinSlots';

/** Net index feeding a component pin, via the compiled path map; undefined for
 *  kinds compile strips. `path` is the component's `componentPaths` entry: a
 *  grouped or label-sharing chip is not at `<prefix><label>`. */
export function pinNet(
  compiled: CompiledCircuit,
  comp: Component,
  pinName: string,
  prefix = 'main/',
  path = `${prefix}${comp.label || comp.id}`,
): number | undefined {
  // Chip instances and ports have no primitive of their own; compile.ts
  // aliases their net as `<path>.<pinName>` instead.
  if (comp.kind === 'chip' || comp.kind === 'inport' || comp.kind === 'outport')
    return compiled.pathToNet.get(`${path}.${pinName}`);
  if (!hasPrimitive(comp.kind)) return undefined;
  // Keyed by component, not path: label sharing puts two components on one
  // path and pathToPrimitive is last-write-wins, which resolved an LED that
  // had inherited a switch's label to the switch's own pins.
  const pi = compiled.componentToPrimitive.get(`${prefix}${comp.id}`);
  if (pi === undefined) return undefined;
  const prim = compiled.primitives[pi]!;
  const specPins = getPrimitive(comp.kind).pins(comp.params ?? {});
  const ins = inputSlotPins(specPins);
  const outs = outputSlotPins(specPins);
  const oi = outs.findIndex((p) => p.name === pinName);
  if (oi >= 0) return prim.outputs[oi];
  const ii = ins.findIndex((p) => p.name === pinName);
  if (ii >= 0) return prim.inputs[ii];
  return undefined;
}
