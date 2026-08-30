// Lowers a Gates-workbench circuit (base-kind gates + bubble params) into an
// ordinary Board/Circuit that compile() and core/boolean can evaluate
// completely unmodified. Never touches core/model/compile.ts.
//
// Output-bubble composition: and+outputBubble -> 'nand', etc (bubbleModel's
// composeKind): a literal kind flip, no new components.
// Input-bubble composition: an input bubble has no field to live on in a
// compiled primitive, so it is spliced in as a real 'not' primitive on that
// one wire, between the driving end and the bubbled input pin. This is
// exactly the model's own "a bubble is a NOT" framing,
// applied per-terminal instead of only at gate output.

import type { Circuit, Component, Wire, WireEnd } from '../model/types';
import {
  composeKind,
  decomposeKind,
  getInputBubbles,
  getOutputBubble,
  isGateFamilyKind,
} from './bubbleModel';

function endMatches(e: WireEnd, component: string, pin: string): boolean {
  return e.kind === 'pin' && e.component === component && e.pin === pin;
}

function omit<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Omit<T, K> {
  const copy = { ...obj };
  for (const k of keys) delete copy[k];
  return copy;
}

/** Pure; returns a new Circuit with every gate composed to its literal kind
 *  and every flagged input bubble spliced in as a real 'not' component. */
export function lowerCircuit<C extends Circuit>(circuit: C): C {
  const components: Component[] = [];
  const wires: Wire[] = circuit.wires.map((w) => ({ ...w }));

  for (const c of circuit.components) {
    if (!isGateFamilyKind(c.kind)) {
      components.push(c);
      continue;
    }
    const { base, outputBubble } = decomposeKind(c.kind as Parameters<typeof decomposeKind>[0]);
    const cleanParams = omit(c.params ?? {}, [
      'outputBubble',
      'inputBubbles',
      'synthetic',
      'bubbleOnly',
    ]);
    const composed = composeKind(base, getOutputBubble(c) || outputBubble);
    components.push({
      ...omit(c, ['params']),
      kind: composed,
      ...(Object.keys(cleanParams).length ? { params: cleanParams } : {}),
    });

    for (const pin of getInputBubbles(c)) {
      const wireIdx = wires.findIndex(
        (w) => endMatches(w.a, c.id, pin) || endMatches(w.b, c.id, pin),
      );
      if (wireIdx === -1) continue; // unconnected input pin: nothing to invert
      const notId = `__bubble_not__${c.id}__${pin}`;
      const w = wires[wireIdx]!;
      const onA = endMatches(w.a, c.id, pin);
      wires[wireIdx] = onA
        ? { ...w, a: { kind: 'pin', component: notId, pin: 'a' } }
        : { ...w, b: { kind: 'pin', component: notId, pin: 'a' } };
      wires.push({
        id: `${notId}__wire`,
        a: { kind: 'pin', component: notId, pin: 'y' },
        b: { kind: 'pin', component: c.id, pin },
        points: [],
      });
      components.push({ id: notId, kind: 'not', pos: c.pos });
    }
  }

  return { ...circuit, components, wires };
}
