// Gates workbench bubble convention (M5): a gate is always
// stored in base form (and/or/buf) so its bubble state is inspectable and
// mutable per-terminal, independent of any single 'kind' string. NAND/NOR/NOT
// never appear as a stored Component.kind here: they are the *composed*
// result of a base gate plus an output bubble (and/nand, or/nor, buf/not are
// exactly the three families; NOT is BUF + output bubble, matching the
// spec's "a NAND is AND + output bubble" pattern uniformly).
//
// Board files authored in the Circuit workbench (or the 'library/boards/
// gates-*.board.json' presets) may still use the composed kinds directly --
// importCircuit() normalizes those into base kind + params on load, so
// callers never need to special-case where a circuit came from.

import type { Circuit, Component } from '../model/types';

export type GateBaseKind = 'and' | 'or' | 'buf';
export const GATE_BASE_KINDS: readonly GateBaseKind[] = ['and', 'or', 'buf'];

/** Every gate-family kind this workbench can render/compile, composed or not. */
export type GateFamilyKind = GateBaseKind | 'nand' | 'nor' | 'not';
const GATE_FAMILY_KINDS: ReadonlySet<string> = new Set(['and', 'or', 'buf', 'nand', 'nor', 'not']);

export function isGateFamilyKind(kind: string): kind is GateFamilyKind {
  return GATE_FAMILY_KINDS.has(kind);
}

/** width>1 gates keep their data-bit lanes but refuse the bubble-push
 *  interaction individually -- only that gate is off-limits, not the whole
 *  board; bubble mode itself never blocks on a wide gate elsewhere in the
 *  circuit. */
export function isBubbleEligibleGate(c: Component): boolean {
  return isGateFamilyKind(c.kind) && Number(c.params?.['width'] ?? 1) === 1;
}

function isBaseKind(kind: string): kind is GateBaseKind {
  return kind === 'and' || kind === 'or' || kind === 'buf';
}

/** and+bubble=nand, or+bubble=nor, buf+bubble=not (spec's decomposition, applied uniformly). */
export function composeKind(base: GateBaseKind, outputBubble: boolean): GateFamilyKind {
  if (!outputBubble) return base;
  return base === 'and' ? 'nand' : base === 'or' ? 'nor' : 'not';
}

export function decomposeKind(kind: GateFamilyKind): { base: GateBaseKind; outputBubble: boolean } {
  switch (kind) {
    case 'and':
    case 'or':
    case 'buf':
      return { base: kind, outputBubble: false };
    case 'nand':
      return { base: 'and', outputBubble: true };
    case 'nor':
      return { base: 'or', outputBubble: true };
    case 'not':
      return { base: 'buf', outputBubble: true };
  }
}

/** De Morgan's dual base kind: and<->or; buf is self-dual (a single-input gate
 *  has nothing to dualize, matching NOT = BUF + bubble having no AND/OR body). */
export function dualBase(base: GateBaseKind): GateBaseKind {
  return base === 'and' ? 'or' : base === 'or' ? 'and' : 'buf';
}

/** Reads params.outputBubble on an already-normalized (base-kind) component. */
export function getOutputBubble(c: Component): boolean {
  return c.params?.['outputBubble'] === true;
}

/** Pin names (e.g. 'a','b') on which this component's params flag an input bubble. */
export function getInputBubbles(c: Component): ReadonlySet<string> {
  const raw = c.params?.['inputBubbles'];
  if (typeof raw !== 'string' || raw === '') return new Set();
  return new Set(raw.split(','));
}

function setInputBubbles(c: Component, pins: ReadonlySet<string>): Component {
  return { ...c, params: { ...c.params, inputBubbles: [...pins].sort().join(',') } };
}

export function withOutputBubble(c: Component, value: boolean): Component {
  return { ...c, params: { ...c.params, outputBubble: value } };
}

export function withInputBubble(c: Component, pin: string, value: boolean): Component {
  const cur = new Set(getInputBubbles(c));
  if (value) cur.add(pin);
  else cur.delete(pin);
  return setInputBubbles(c, cur);
}

/** Dualizes a gate's base body (and<->or) and toggles its output bubble in one
 *  step -- the kind-flip half of pushOutputBackward/pushInputsForward. */
export function dualizeGate(c: Component): Component {
  const norm = normalizeGateComponent(c);
  const { base } = decomposeKind(norm.kind as GateFamilyKind);
  return { ...toggleOutputBubble(norm), kind: dualBase(base) };
}

export function toggleOutputBubble(c: Component): Component {
  return withOutputBubble(c, !getOutputBubble(c));
}

export function toggleInputBubble(c: Component, pin: string): Component {
  return withInputBubble(c, pin, !getInputBubbles(c).has(pin));
}

/** a..h in declaration order, per naryGate's INPUT_NAMES; arity from params.inputs (2..8), buf/not are always 1. */
export function gateInputPins(c: Component): readonly string[] {
  const norm = normalizeGateComponent(c);
  const { base } = decomposeKind(norm.kind as GateFamilyKind);
  if (base === 'buf') return ['a'];
  const n = typeof norm.params?.['inputs'] === 'number' ? norm.params['inputs'] : 2;
  return ['a', 'b', 'c', 'd'].slice(0, Math.min(4, Math.max(2, n)));
}

/** Decomposes a literal composed kind (nand/nor/not) into base+outputBubble params;
 *  already-base components (and/or/buf) pass through untouched (idempotent). */
export function normalizeGateComponent(c: Component): Component {
  if (!isGateFamilyKind(c.kind)) return c;
  if (isBaseKind(c.kind)) return c;
  const { base, outputBubble } = decomposeKind(c.kind);
  return withOutputBubble({ ...c, kind: base }, outputBubble);
}

/** Normalizes every gate-family component in a circuit to base-kind + bubble params.
 *  Non-gate components (input/output/constant/chip/...) pass through unchanged. */
export function importCircuit<C extends Circuit>(circuit: C): C {
  return { ...circuit, components: circuit.components.map(normalizeGateComponent) };
}
