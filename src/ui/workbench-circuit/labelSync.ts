// Label sharing between ports and IO devices on one net:
// a user-named terminal names its
// still-default net partners; two different user names raise a conflict for
// the dialog. Pure functions of a Circuit -- no store access.

import type { ChipLibrary, Circuit, Component, WireEnd } from '../../core/model/types';
import { connectedPins, netPins, type PinRef } from '../../core/gates/netGraph';
import { resolveComponentPins } from '../../render/glyphs/symbol';

/** Terminal kind -> its single data pin. */
const DATA_PIN: Record<string, string> = {
  inport: 'y',
  toggle: 'y',
  button: 'y',
  outport: 'a',
  led: 'a',
  probe: 'a',
  busdisplay: 'a',
  clock: 'y',
};

export const dataPinOf = (kind: string): string | undefined => DATA_PIN[kind];

/** A net with 2+ distinct user labels on it -- every distinct label is a
 *  candidate (Task 6: was capped at the first two), `netComponentIds` is
 *  every terminal on that net (the set a chosen label gets applied to). */
export interface NetConflict {
  candidates: string[];
  netComponentIds: string[];
}

export interface LabelSyncResult {
  /** Default-labeled terminals to name after the net's one user label. */
  inherit: { id: string; label: string }[];
  /** The net `start` sits on, if it carries 2+ distinct user labels. One
   *  call examines one net, so at most one conflict; the store batches
   *  conflicts found across several calls (Task 7). */
  conflict: NetConflict | null;
}

/** Distinct labels among `terminals`, in ascending component-id order (a
 *  deterministic tie-break independent of net-walk discovery order). */
function distinctLabelsById(terminals: readonly Component[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of [...terminals].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (c.label && !seen.has(c.label)) {
      seen.add(c.label);
      out.push(c.label);
    }
  }
  return out;
}

/** Terminal-kind components whose data pin sits on `start`'s net (including
 *  the start component itself when it's a terminal). */
export function netTerminals(circuit: Circuit, start: PinRef): Component[] {
  const pins = [start, ...connectedPins(circuit, start)];
  const byId = new Map<string, Component>();
  for (const p of pins) {
    const c = circuit.components.find((x) => x.id === p.component);
    if (c && DATA_PIN[c.kind] === p.pin && !byId.has(c.id)) byId.set(c.id, c);
  }
  return [...byId.values()];
}

/** Sync decision for the net at `start` (a pin touched by a wire commit or
 *  the renamed component's data pin). */
export function labelSync(circuit: Circuit, start: PinRef): LabelSyncResult {
  const terminals = netTerminals(circuit, start);
  const named = terminals.filter((c) => c.label);
  const labels = distinctLabelsById(named);
  if (labels.length === 0) return { inherit: [], conflict: null };
  if (labels.length === 1) {
    return {
      inherit: terminals.filter((c) => !c.label).map((c) => ({ id: c.id, label: labels[0]! })),
      conflict: null,
    };
  }
  return {
    inherit: [],
    conflict: {
      candidates: labels,
      netComponentIds: terminals.map((c) => c.id),
    },
  };
}

/** Next free label for a duplicate of `label`: a trailing number continues the
 *  sequence, a single letter advances the alphabet (falling to appended
 *  numbers past z), anything else appends a number. Skips labels in `used`
 *  so a duplicated terminal never lands on an existing label. */
export function nextLabel(label: string, used: ReadonlySet<string>): string {
  const numbered = /^(.*?)(\d+)$/.exec(label);
  if (numbered) {
    const prefix = numbered[1]!;
    for (let n = Number(numbered[2]!) + 1; ; n++) {
      const cand = `${prefix}${n}`;
      if (!used.has(cand)) return cand;
    }
  }
  if (label.length === 1 && /[a-yA-Y]/.test(label)) {
    for (let c = label.charCodeAt(0) + 1; c <= label.charCodeAt(0) + 25; c++) {
      const cand = String.fromCharCode(c);
      if (!/[a-zA-Z]/.test(cand)) break;
      if (!used.has(cand)) return cand;
    }
  }
  for (let n = 2; ; n++) {
    const cand = `${label}${n}`;
    if (!used.has(cand)) return cand;
  }
}

/** Task 1b: the output pin(s) whose net(s) `label` should be applied to when
 *  naming `componentId` -- one dot-free label for a single-output part
 *  (exactly one resolved `dir: 'out'` pin), `<label>.<pinName>` per pin for
 *  a multi-output part (decoder, demux, a chip instance, ...). Derived from
 *  the primitive/chip's own resolved pins, not a hand-maintained kind list.
 *  A part with no output pins at all (In port, LED, ...) returns []. */
export function deriveOutputLabels(
  circuit: Circuit,
  chipLib: ChipLibrary,
  componentId: string,
  label: string,
): { pin: string; label: string }[] {
  const comp = circuit.components.find((c) => c.id === componentId);
  if (!comp) return [];
  const def = comp.defId ? chipLib.get(comp.defId) : undefined;
  const outs = resolveComponentPins(comp, def).filter((p) => p.dir === 'out');
  if (outs.length === 0) return [];
  if (outs.length === 1) return [{ pin: outs[0]!.name, label }];
  return outs.map((p) => ({ pin: p.name, label: `${label}.${p.name}` }));
}

/** Like `labelSync`, but the start pin's label is an explicit proposal (the
 *  part being named) rather than read off an already-labeled terminal --
 *  naming a gate/mux/coder/chip (Task 1b) isn't itself a DATA_PIN terminal
 *  kind, so there's no existing label on its own pin to read. */
export function labelSyncForOutput(
  circuit: Circuit,
  start: PinRef,
  proposed: string,
): LabelSyncResult {
  const terminals = netTerminals(circuit, start);
  const named = terminals.filter((c) => c.label);
  const otherLabels = distinctLabelsById(named).filter((l) => l !== proposed);
  if (otherLabels.length === 0) {
    return {
      inherit: terminals.filter((c) => !c.label).map((c) => ({ id: c.id, label: proposed })),
      conflict: null,
    };
  }
  return {
    inherit: [],
    conflict: {
      candidates: [proposed, ...otherLabels],
      netComponentIds: terminals.map((c) => c.id),
    },
  };
}

/** Task 1b: every component id on the same net(s) as `componentId`'s own
 *  label-carrying pin(s) -- the DATA_PIN data pin for an IO-device kind, or
 *  every OUTPUT pin's net for a part that joins labelSync via
 *  deriveOutputLabels/labelSyncForOutput. Used to scope the board-wide
 *  uniqueness check's same-net exemption: renaming a mux to a name a
 *  connected, already-labeled LED shares (both on the mux's OWN output net)
 *  must be ALLOWED, same as the existing IO-device same-net feature -- the
 *  uniqueness check only rejects a label used OUTSIDE this set. Before this,
 *  a non-DATA_PIN kind's `netIds` was just its own id, so that legal rename
 *  was rejected as a false "used elsewhere" collision. */
export function ownNetTerminalIds(
  circuit: Circuit,
  chipLib: ChipLibrary,
  componentId: string,
): Set<string> {
  const ids = new Set<string>([componentId]);
  const comp = circuit.components.find((c) => c.id === componentId);
  if (!comp) return ids;
  const dataPin = dataPinOf(comp.kind);
  if (dataPin) {
    for (const t of netTerminals(circuit, { component: componentId, pin: dataPin })) ids.add(t.id);
  } else {
    const def = comp.defId ? chipLib.get(comp.defId) : undefined;
    for (const p of resolveComponentPins(comp, def).filter((p) => p.dir === 'out')) {
      for (const t of netTerminals(circuit, { component: componentId, pin: p.name })) ids.add(t.id);
    }
  }
  addSignalIdentical(circuit, ids);
  return ids;
}

/** Single-input parts whose output is a fixed function of their input, with
 *  the inversion each one contributes. A chain of them is transparent exactly
 *  when the inversions cancel: `sw -> buf -> led` and `sw -> not -> not -> led`
 *  both end up carrying the switch's own signal, and a reader naming them all
 *  `A` is right. One `not` in the chain is NOT transparent -- that LED shows
 *  the complement, and calling it `A` would be a lie. */
const INVERSION: Record<string, 0 | 1> = { buf: 0, not: 1 };

/** Grow `ids` to every component carrying the SAME signal, through chains of
 *  buffers and inverters whose inversions cancel.
 *
 *  Parity is tracked per NET, not per component: a chain is a sequence of nets
 *  joined by single-input parts, and hanging it off the components instead
 *  cannot carry parity across the middle of a longer chain. Walked to a fixed
 *  point and in both directions, so it does not matter which end is renamed. */
function addSignalIdentical(circuit: Circuit, ids: Set<string>): void {
  /** A net's identity, as the smallest `component pin` on it. Cheap, stable,
   *  and independent of which pin the walk happened to arrive from. */
  const netKey = (component: string, pin: string): string => {
    const pins = [{ component, pin }, ...connectedPins(circuit, { component, pin })];
    return pins.map((p) => `${p.component} ${p.pin}`).sort()[0]!;
  };

  const links: { a: string; y: string; inverts: boolean }[] = [];
  for (const comp of circuit.components) {
    const inversion = INVERSION[comp.kind];
    if (inversion === undefined) continue;
    links.push({
      a: netKey(comp.id, 'a'),
      y: netKey(comp.id, 'y'),
      inverts: inversion === 1,
    });
  }

  const parity = new Map<string, 0 | 1>();
  for (const id of ids) {
    const comp = circuit.components.find((c) => c.id === id);
    if (!comp) continue;
    const pin = dataPinOf(comp.kind);
    if (pin) parity.set(netKey(id, pin), 0);
  }
  if (parity.size === 0) return;

  const flip = (p: 0 | 1): 0 | 1 => (p === 0 ? 1 : 0);
  for (let grew = true; grew; ) {
    grew = false;
    for (const link of links) {
      const pa = parity.get(link.a);
      const py = parity.get(link.y);
      if (pa !== undefined && py === undefined) {
        parity.set(link.y, link.inverts ? flip(pa) : pa);
        grew = true;
      } else if (py !== undefined && pa === undefined) {
        parity.set(link.a, link.inverts ? flip(py) : py);
        grew = true;
      }
    }
  }

  for (const comp of circuit.components) {
    const pin = dataPinOf(comp.kind);
    if (!pin) continue;
    if (parity.get(netKey(comp.id, pin)) === 0) ids.add(comp.id);
  }
}

/** Uniqueness (decision 6): true when `label` is already used by a component
 *  OUTSIDE `netIds` (same-net duplication is the feature).
 *
 *  Scoped to a group, not the board. Two unconnected sub-circuits may each
 *  have an input named `A` -- that is what a group is for, and it is what lets
 *  a circuit be imported into a board that already uses those names. `group`
 *  is the scope being renamed into; components in other groups are invisible
 *  to the check, as are grouped components when renaming at board level. */
export function labelUsedElsewhere(
  circuit: Circuit,
  label: string,
  netIds: ReadonlySet<string>,
  group?: string,
): boolean {
  // Net labels are exempt in both directions: repeating a name is exactly how
  // they work, so neither a label being renamed nor a label already carrying
  // the name can make it a duplicate. Every other kind keeps the rule.
  return circuit.components.some(
    (c) =>
      c.kind !== 'netlabel' &&
      c.label === label &&
      !netIds.has(c.id) &&
      (c.group ?? undefined) === (group ?? undefined),
  );
}

/** Kinds that are never "chip/gate logic" for the direction check below:
 *  terminal/stimulus/observer components (In/Out labels themselves, switches,
 *  LEDs, probes, ...) and pure structural connectors. Everything else -- real
 *  gates, sequential elements, mux/demux/coder, chip instances -- counts. */
const NON_LOGIC_KINDS = new Set([
  ...Object.keys(DATA_PIN),
  'constant',
  'split',
  'merge',
  'tapread',
  'tapdrive',
  'tunnel',
  'netlabel',
  'pullup',
  'pulldown',
]);

/** Every pin reachable on the net(s) `ends` sit on -- unlike filtering to
 *  literal pin ends only, this also walks outward from a free/junction/tap
 *  end via `netPins`, so a wire with no pin endpoints of its own still
 *  surfaces every pin on the net it joins. */
export function netTouchedPins(circuit: Circuit, ends: readonly WireEnd[]): PinRef[] {
  const seen = new Set<string>();
  const out: PinRef[] = [];
  const push = (p: PinRef) => {
    const key = `${p.component}:${p.pin}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(p);
    }
  };
  for (const end of ends) {
    if (end.kind === 'pin') push({ component: end.component, pin: end.pin });
    for (const p of netPins(circuit, end)) push(p);
  }
  return out;
}

/** In ports are pure aliases for a value driven from *outside* the circuit;
 *  Out ports are pure aliases for a value read from *inside* it. Directly
 *  wiring an In port onto a chip/gate output net (a real, second driver) or an
 *  Out port onto a chip/gate input net (no driver at all) is never legal --
 *  checked here because compile.ts can't: ports compile to aliases, not
 *  primitives, so its own multi-driver check never sees them (checked here
 *  per the packaging rules). Returns a message naming the offending
 *  pin, or null when every touched net is clean. */
export function labelDirectionConflict(
  circuit: Circuit,
  chipLib: ChipLibrary,
  touched: readonly PinRef[],
): string | null {
  for (const start of touched) {
    const comp = circuit.components.find((c) => c.id === start.component);
    if (!comp || (comp.kind !== 'inport' && comp.kind !== 'outport')) continue;
    for (const p of connectedPins(circuit, start)) {
      const other = circuit.components.find((c) => c.id === p.component);
      if (!other || other.id === comp.id || NON_LOGIC_KINDS.has(other.kind)) continue;
      const def = other.defId ? chipLib.get(other.defId) : undefined;
      const dir = resolveComponentPins(other, def).find((spec) => spec.name === p.pin)?.dir;
      if (comp.kind === 'inport' && dir === 'out')
        return `an In port cannot connect to a chip/gate output (${other.label || other.id}.${p.pin})`;
      if (comp.kind === 'outport' && dir === 'in')
        return `an Out port cannot connect to a chip/gate input (${other.label || other.id}.${p.pin})`;
    }
  }
  return null;
}
