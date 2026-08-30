// Duplicate/copy-paste shared extraction: the sub-circuit fully inside a
// selection -- picked components and junctions, plus only the wires whose
// both ends land on something picked. Wires leaving the selection are not
// carried over: wires whose both ends
// land on duplicated components are cloned with the group, wires leaving the
// selection are not. Ids are left untouched here; the caller (a store
// action) remaps them fresh at commit time so a clipboard can be pasted more
// than once without id collisions.

import type { Circuit, WireEnd } from '../../core/model/types';

export function extractInternalSelection(circuit: Circuit, ids: ReadonlySet<string>): Circuit {
  const components = circuit.components.filter((c) => ids.has(c.id));
  const junctions = circuit.junctions.filter((j) => ids.has(j.id));
  const endIn = (end: WireEnd): boolean =>
    (end.kind === 'pin' && ids.has(end.component)) ||
    (end.kind === 'junction' && ids.has(end.junction));
  const wires = circuit.wires.filter((w) => endIn(w.a) && endIn(w.b));
  return { components, wires, junctions };
}
