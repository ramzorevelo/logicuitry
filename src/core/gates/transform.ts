// The atomic bubble-push transformation.
// Every exported move is pure and transactional: it returns a new Circuit on
// success or `null` on an illegal/failed drag, never a partially-applied one.
// Callers are expected to verify boolean equivalence (core/boolean) before
// committing a non-null result (see verify.ts), since that is the spec's
// explicit defense-in-depth requirement, even though each move here is
// constructed to already be equivalence-preserving.

import type { Circuit, Component, Point, WireEnd } from '../model/types';
import {
  dualizeGate,
  gateInputPins,
  getInputBubbles,
  getOutputBubble,
  isBubbleEligibleGate,
  isGateFamilyKind,
  normalizeGateComponent,
  toggleInputBubble,
  toggleOutputBubble,
  withInputBubble,
  withOutputBubble,
} from './bubbleModel';
import { connectedPins } from './netGraph';

function updateComponent<C extends Circuit>(
  circuit: C,
  id: string,
  fn: (c: Component) => Component,
): C {
  return { ...circuit, components: circuit.components.map((c) => (c.id === id ? fn(c) : c)) };
}

/** A synthesized id derived from `base` may already exist (e.g. a wire that
 *  already had a bubble pair spliced onto it once keeps its original id, so
 *  a second splice on the same wire id must not collide with the first). */
function freshId(circuit: Circuit, base: string): string {
  const taken = new Set([
    ...circuit.components.map((c) => c.id),
    ...circuit.wires.map((w) => w.id),
    ...circuit.junctions.map((j) => j.id),
  ]);
  if (!taken.has(base)) return base;
  let n = 1;
  while (taken.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

function getGate(circuit: Circuit, gateId: string): Component | undefined {
  const c = circuit.components.find((c) => c.id === gateId);
  if (!c || !isBubbleEligibleGate(c)) return undefined;
  return normalizeGateComponent(c);
}

/** Live pin geometry injected by the UI (A4). Core has no glyph metrics, so
 *  without a resolver a pin degrades to its component's own pos -- still a
 *  span midpoint, never the source gate's pos. */
export type ResolvePin = (componentId: string, pin: string) => Point | undefined;

export interface TransformGeom {
  resolvePin?: ResolvePin;
  /** Schematic grid pitch for snapping and marker spacing (theme.gridSchematic). */
  grid?: number;
  /** Placement anchor for a spliced full NOT: maps the wire-span midpoint
   *  (with the span's two endpoints) to the component's top-left `pos` so its
   *  pin centerline rides the wire -- core has no glyph metrics, so the raw
   *  midpoint would sit the glyph half a body low. */
  anchorNot?: (mid: Point, spanA: Point, spanB: Point) => Point;
  /** The wire's on-screen route polyline (a->b order). Without it a wire is
   *  treated as the straight a->b span, which misplaces a spliced NOT on any
   *  elbowed/detoured wire. */
  routeWire?: (wireId: string) => Point[] | undefined;
}

const DEFAULT_GRID = 8;

const snapPt = (p: Point, g: number): Point => ({
  x: Math.round(p.x / g) * g,
  y: Math.round(p.y / g) * g,
});

function pinPos(
  circuit: Circuit,
  ref: { component: string; pin: string },
  geom: TransformGeom | undefined,
): Point | undefined {
  const resolved = geom?.resolvePin?.(ref.component, ref.pin);
  if (resolved) return resolved;
  return circuit.components.find((c) => c.id === ref.component)?.pos;
}

function wireEndPos(
  circuit: Circuit,
  end: WireEnd,
  geom: TransformGeom | undefined,
): Point | undefined {
  if (end.kind === 'pin') return pinPos(circuit, { component: end.component, pin: end.pin }, geom);
  if (end.kind === 'free') return end.pos;
  if (end.kind === 'junction') return circuit.junctions.find((j) => j.id === end.junction)?.pos;
  return undefined;
}

/** The wire segment a spliced NOT should ride: the first horizontal segment
 *  of the wire's actual route scanning from the driver/upstream side, so the
 *  NOT's input centerline lands on the leg attached to the driver (falls back
 *  to the first segment, then the straight a->b span without a route). */
function spliceSpan(
  circuit: Circuit,
  wire: Circuit['wires'][number],
  upstreamIsA: boolean,
  geom: TransformGeom | undefined,
): { a: Point; b: Point } | undefined {
  let pts = geom?.routeWire?.(wire.id);
  if (!pts || pts.length < 2) {
    const a = wireEndPos(circuit, wire.a, geom);
    const b = wireEndPos(circuit, wire.b, geom);
    if (!a || !b) return undefined;
    pts = [a, b];
  }
  if (!upstreamIsA) pts = [...pts].reverse();
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    if (a.y === b.y && a.x !== b.x) return { a, b };
  }
  return { a: pts[0]!, b: pts[1]! };
}

function notPosOnSpan(
  span: { a: Point; b: Point } | undefined,
  fallback: Point,
  geom: TransformGeom | undefined,
): Point {
  if (!span) return fallback;
  const g = geom?.grid ?? DEFAULT_GRID;
  const mid = snapPt({ x: (span.a.x + span.b.x) / 2, y: (span.a.y + span.b.y) / 2 }, g);
  return geom?.anchorNot ? geom.anchorNot(mid, span.a, span.b) : mid;
}

/** Output-bubble pushed backward through its own gate: gate dualizes (kind
 *  flip via the outputBubble param), a bubble appears on every input.
 *  Legal iff the gate currently carries an output bubble. */
export function pushOutputBackward<C extends Circuit>(circuit: C, gateId: string): C | null {
  const gate = getGate(circuit, gateId);
  if (!gate || !getOutputBubble(gate)) return null;
  let next = updateComponent(circuit, gateId, dualizeGate);
  for (const pin of gateInputPins(gate)) {
    next = updateComponent(next, gateId, (c) => toggleInputBubble(c, pin));
  }
  // A double-bubbled buf collapses to a bare pass-through here (both
  // inversions cancelled through the body) -- heal it away, never leave it.
  return healBareBuf(next, gateId);
}

/** Input bubbles pushed forward, merging through the gate: legal only when
 *  every one of the gate's current inputs already carries a bubble (a
 *  single un-sibling-matched input bubble dragged forward is a failed drag). */
export function pushInputsForward<C extends Circuit>(circuit: C, gateId: string): C | null {
  const gate = getGate(circuit, gateId);
  if (!gate) return null;
  const pins = gateInputPins(gate);
  const bubbled = getInputBubbles(gate);
  if (!pins.every((p) => bubbled.has(p))) return null;
  let next = updateComponent(circuit, gateId, dualizeGate);
  for (const pin of pins) {
    next = updateComponent(next, gateId, (c) => toggleInputBubble(c, pin));
  }
  return healBareBuf(next, gateId);
}

/** Output bubble dragged forward onto the wire (away from its own gate),
 *  not into the gate: relocates as an inverter on every fan-out branch
 *  (fan-out rule -- never onto just one branch). A branch landing on
 *  another gate-family component's input becomes that pin's input bubble;
 *  a branch with no gate to carry the flag (a board output/probe/etc.)
 *  gets a real standalone 'not' component spliced onto that wire instead,
 *  per "a bubble dropped on a plain wire becomes an inverter placement".
 *  Legal iff the gate carries an output bubble -- or is a standalone
 *  inverter in its input-bubble stored form, whose single inversion
 *  relocates the same way. */
export function pushOutputAcrossFanout<C extends Circuit>(
  circuit: C,
  gateId: string,
  geom?: TransformGeom,
): C | null {
  const gate = getGate(circuit, gateId);
  if (!gate) return null;
  const inputForm = !getOutputBubble(gate) && isStandaloneInverter(gate);
  if (!getOutputBubble(gate) && !inputForm) return null;
  const consumers = connectedPins(circuit, { component: gateId, pin: 'y' });
  if (consumers.length === 0) return null;
  // A wide (width>1) gate-family consumer can't carry a 1-bit bubble flag or
  // take a spliced NOT -- refuse the whole fan-out push rather than silently
  // mistreat it as a plain (spliceNot) consumer (M6.6: width>1 refuses per-gate).
  if (
    consumers.some(({ component }) => {
      const c = circuit.components.find((x) => x.id === component);
      return !!c && isGateFamilyKind(c.kind) && !isBubbleEligibleGate(c);
    })
  )
    return null;
  // A standalone inverter (either form) with a single non-gate consumer
  // would just mint another NOT on the same wire every drag -- an identity
  // move, rejected (owner decision 2026-07-16). With 2+ consumers the push
  // duplicates the inverter per branch (a meaningful move), so only the
  // 1-consumer case rejects; a real gate always keeps the meaningful move.
  const anyGateConsumer = consumers.some(({ component }) => {
    const c = circuit.components.find((x) => x.id === component);
    return !!c && isGateFamilyKind(c.kind);
  });
  if (isStandaloneInverter(gate) && !anyGateConsumer && consumers.length === 1) return null;

  let next = updateComponent(circuit, gateId, (c) => {
    const n = normalizeGateComponent(c);
    return inputForm ? withInputBubble(n, 'a', false) : toggleOutputBubble(n);
  });
  let notCount = 0;
  for (const { component, pin } of consumers) {
    const consumer = next.components.find((c) => c.id === component);
    if (consumer && isGateFamilyKind(consumer.kind)) {
      const cn = normalizeGateComponent(consumer);
      const bareMarker = consumer.params?.['bubbleOnly'] === true;
      if (bareMarker && pin === 'a' && getOutputBubble(cn) && !getInputBubbles(cn).has('a')) {
        // Landing on a bare marker cancels it whole (owner rule 2026-07-17:
        // only a full NOT glyph stages the incoming inversion as a visible
        // input bubble; a lone bubble annihilating shows nothing staged).
        next = updateComponent(next, component, (c) =>
          withOutputBubble(normalizeGateComponent(c), false),
        );
      } else {
        next = updateComponent(next, component, (c) => toggleInputBubble(c, pin));
      }
    } else {
      const notId = freshId(next, `${gateId}__fanout_not_${notCount++}`);
      // A4: the marker lands on the consumer's own last-hop wire, never at
      // the source gate's pos -- works through junctions/multi-hop paths too.
      // anchorNot converts the wire-line midpoint into the glyph's top-left
      // `pos` so its pin centerline rides the wire.
      next = spliceNotAtConsumer(next, { component, pin }, notId, geom) ?? next;
    }
  }
  // A consumer whose input bubble just toggled OFF may be a standalone
  // inverter now emptied to a bare BUF (pushing an inversion onto a
  // BUF-with-input-bubble cancels it whole); heal it, don't strand it.
  for (const { component } of consumers) next = healBareBuf(next, component);
  return cleanupBareSource(next, gateId, geom);
}

function isBareBuf(c: Component): boolean {
  const n = normalizeGateComponent(c);
  return n.kind === 'buf' && !getOutputBubble(n) && getInputBubbles(n).size === 0;
}

/** Owner rule 2026-07-16: no bubble move may leave a bare BUF behind. Runs
 *  only on the move's own source component, never as a global sweep, so a
 *  user-placed BUF elsewhere is untouchable. One out-wire -> delete with
 *  heal; fan-out -> the component collapses to a junction at its old output
 *  pin so every branch keeps conducting. */
function cleanupBareSource<C extends Circuit>(circuit: C, id: string, geom?: TransformGeom): C {
  const c = circuit.components.find((x) => x.id === id);
  if (!c || !isGateFamilyKind(c.kind) || !isBareBuf(c)) return circuit;
  const at = (e: WireEnd, pin: string) => e.kind === 'pin' && e.component === id && e.pin === pin;
  const outWires = circuit.wires.filter((w) => at(w.a, 'y') || at(w.b, 'y'));
  if (outWires.length <= 1) return healBareBuf(circuit, id);
  const jid = freshId(circuit, `${id}__j`);
  const g = geom?.grid ?? DEFAULT_GRID;
  const jpos = snapPt(pinPos(circuit, { component: id, pin: 'y' }, geom) ?? c.pos, g);
  const jEnd: WireEnd = { kind: 'junction', junction: jid };
  const wires = circuit.wires.map((w) => {
    if (at(w.a, 'y') || at(w.a, 'a')) return { ...w, a: jEnd };
    if (at(w.b, 'y') || at(w.b, 'a')) return { ...w, b: jEnd };
    return w;
  });
  return {
    ...circuit,
    components: circuit.components.filter((x) => x.id !== id),
    wires,
    junctions: [...circuit.junctions, { id: jid, pos: jpos }],
  };
}

/** buf carrying exactly one inversion in either stored form: an output
 *  bubble (a NOT or bare marker), or a single input bubble on `a` (a NOT
 *  whose bubble was pushed to its own input). */
export function isStandaloneInverter(c: Component): boolean {
  const n = normalizeGateComponent(c);
  if (n.kind !== 'buf') return false;
  const out = getOutputBubble(n);
  const ins = getInputBubbles(n);
  return (out && ins.size === 0) || (!out && ins.size === 1 && ins.has('a'));
}

function clearInverterBubbles(c: Component): Component {
  const n = normalizeGateComponent(c);
  return withInputBubble(withOutputBubble(n, false), 'a', false);
}

/** Whole-unit inverter drag toward its feeder: merges a standalone inverter
 *  into the single gate-family driver whose sole consumer it is, by toggling
 *  the driver's output bubble (absent -> set, e.g. OR re-forms NOR; present
 *  -> the two inversions annihilate). The inverter is deleted with heal --
 *  nothing is ever left as a bare BUF. Null when the driver fans out (the
 *  junction-merge move covers that) or there is no single gate driver. */
export function absorbInverterIntoDriver<C extends Circuit>(
  circuit: C,
  inverterId: string,
): C | null {
  const inv = circuit.components.find((c) => c.id === inverterId);
  if (!inv || !isBubbleEligibleGate(inv) || !isStandaloneInverter(inv)) return null;
  const feeders = connectedPins(circuit, { component: inverterId, pin: 'a' });
  const drivers = feeders.filter((p) => {
    if (p.pin !== 'y') return false;
    const dc = circuit.components.find((c) => c.id === p.component);
    // A wide driver refuses this specific move (M6.6: per-gate refusal, not
    // a whole-board block) -- excluded here so drivers.length !== 1 -> null.
    return !!dc && isBubbleEligibleGate(dc);
  });
  if (drivers.length !== 1) return null;
  const driver = drivers[0]!;
  const consumers = connectedPins(circuit, { component: driver.component, pin: 'y' });
  const soleConsumer =
    consumers.length === 1 && consumers[0]!.component === inverterId && consumers[0]!.pin === 'a';
  if (!soleConsumer) return null;
  // A driver already carrying an inversion (either stored form) cancels with
  // the absorbed one; an uninverted driver gains the output bubble. Either
  // participant left as a bare buf heals away.
  let next = updateComponent(circuit, driver.component, (c) => {
    const n = normalizeGateComponent(c);
    if (getOutputBubble(n)) return toggleOutputBubble(n);
    if (n.kind === 'buf' && getInputBubbles(n).has('a')) return withInputBubble(n, 'a', false);
    return withOutputBubble(n, true);
  });
  next = healBareBuf(next, driver.component);
  next = updateComponent(next, inverterId, clearInverterBubbles);
  return healBareBuf(next, inverterId);
}

/** The inverse of a gate-branch bubble absorption: an input bubble dragged a
 *  short way back onto its own wire re-materializes as a standalone NOT
 *  spliced on the pin's last hop. Not for a BUF's own input bubble -- that is
 *  already a standalone inverter and would merely relocate (identity). */
export function materializeInputBubble<C extends Circuit>(
  circuit: C,
  at: { component: string; pin: string },
  geom?: TransformGeom,
): C | null {
  const c = circuit.components.find((x) => x.id === at.component);
  if (!c || !isBubbleEligibleGate(c)) return null;
  const n = normalizeGateComponent(c);
  if (n.kind === 'buf' || !getInputBubbles(n).has(at.pin)) return null;
  const cleared = updateComponent(circuit, at.component, (x) =>
    toggleInputBubble(normalizeGateComponent(x), at.pin),
  );
  const notId = freshId(cleared, `${at.component}_${at.pin}__not`);
  return spliceNotAtConsumer(cleared, at, notId, geom);
}

/** The dragged inversion a merge starts from: an input-bubble pin ref, or a
 *  standalone inverter component. */
export type MergeFrom = { component: string; pin: string } | { inverter: string };

/** Pulls the dragged inversion upstream past the fan-out point, resolving
 *  the whole net consistently (owner rule 2026-07-17): the inversion moves to
 *  the driver and every branch's inversion state flips -- a branch that
 *  carried one loses it (bubble cleared / inverter deleted with heal), a
 *  branch that didn't gains one (input bubble on a gate; a spliced NOT on a
 *  non-gate). Driver already inverted -> the two inversions cancel (bubble
 *  cleared; a driver left as a bare buf heals away); otherwise ONE new
 *  standalone NOT splices in just downstream of the driver. A junction on
 *  the net stays and now fans out the inverted signal. */
export function mergeInversionsUpstream<C extends Circuit>(
  circuit: C,
  from: MergeFrom,
  geom?: TransformGeom,
): C | null {
  return mergeUpstreamImpl(circuit, from, geom, false);
}

/** Naive, non-transactional variant for the failed-drag red-flash ghost:
 *  clears only the dragged inversion but splices the NOT upstream anyway,
 *  so the differing truth-table rows can render. Never committed. */
export function mergeInversionsUpstreamNaive<C extends Circuit>(
  circuit: C,
  from: MergeFrom,
  geom?: TransformGeom,
): C | null {
  return mergeUpstreamImpl(circuit, from, geom, true);
}

function mergeUpstreamImpl<C extends Circuit>(
  circuit: C,
  from: MergeFrom,
  geom: TransformGeom | undefined,
  naive: boolean,
): C | null {
  const startPin = 'inverter' in from ? { component: from.inverter, pin: 'a' } : { ...from };
  const startComp = circuit.components.find((c) => c.id === startPin.component);
  if (!startComp || !isBubbleEligibleGate(startComp)) return null;
  if ('inverter' in from) {
    if (!isStandaloneInverter(startComp)) return null;
  } else if (!getInputBubbles(normalizeGateComponent(startComp)).has(startPin.pin)) {
    return null;
  }
  const others = connectedPins(circuit, startPin);
  const outs = others.filter((p) => p.pin === 'y');
  if (outs.length !== 1) return null;
  const driver = outs[0]!;
  const consumers = [
    startPin,
    ...others.filter((p) => !(p.component === driver.component && p.pin === driver.pin)),
  ];
  // Any wide (width>1) gate-family participant on this net refuses the whole
  // merge (M6.6: per-gate refusal, never a whole-board block) -- it can't
  // carry a bubble flag or take a spliced NOT.
  if (
    consumers.some((p) => {
      const c = circuit.components.find((x) => x.id === p.component);
      return !!c && isGateFamilyKind(c.kind) && !isBubbleEligibleGate(c);
    })
  )
    return null;
  {
    const dc = circuit.components.find((c) => c.id === driver.component);
    if (dc && isGateFamilyKind(dc.kind) && !isBubbleEligibleGate(dc)) return null;
  }

  type Via = 'bubble' | 'inverter' | 'addBubble' | 'spliceNot';
  type Branch = { pin: { component: string; pin: string }; via: Via };
  const branches: Branch[] = consumers.map((p) => {
    const c = circuit.components.find((x) => x.id === p.component);
    if (c && isGateFamilyKind(c.kind)) {
      const n = normalizeGateComponent(c);
      if (getInputBubbles(n).has(p.pin)) return { pin: p, via: 'bubble' };
      if (p.pin === 'a' && isPlainInverter(n)) return { pin: p, via: 'inverter' };
      return { pin: p, via: 'addBubble' };
    }
    return { pin: p, via: 'spliceNot' };
  });

  // The driver carries an inversion in EITHER stored form: a gate-level
  // output bubble (NAND/NOR/NOT), or a standalone inverter whose bubble was
  // pushed to its own input (still one inversion, still cancels).
  const preDriverComp = circuit.components.find((c) => c.id === driver.component);
  const preDriverInverted =
    !!preDriverComp &&
    isGateFamilyKind(preDriverComp.kind) &&
    (getOutputBubble(normalizeGateComponent(preDriverComp)) || isStandaloneInverter(preDriverComp));
  // Pure relocation identity: a lone standalone inverter (either form)
  // sliding up its own wire toward an uninverted driver would just re-mint
  // itself there.
  const soloInverterBranch = (b: Branch): boolean => {
    if (b.via === 'inverter') return true;
    if (b.via !== 'bubble') return false;
    const c = circuit.components.find((x) => x.id === b.pin.component);
    return !!c && isStandaloneInverter(c);
  };
  if (!naive && !preDriverInverted && consumers.length === 1 && soloInverterBranch(branches[0]!))
    return null;

  // Naive ghost: consume only the dragged inversion, splice the driver NOT
  // anyway, flip nothing else -- renders the differing truth-table rows.
  const startKey = `${startPin.component}:${startPin.pin}`;
  const toProcess = naive
    ? branches.filter(
        (b) =>
          `${b.pin.component}:${b.pin.pin}` === startKey &&
          (b.via === 'bubble' || b.via === 'inverter'),
      )
    : branches;
  if (toProcess.length === 0) return null;

  let next: C = circuit;
  let flipNotCount = 0;
  for (const b of toProcess) {
    if (b.via === 'bubble' || b.via === 'addBubble') {
      next = updateComponent(next, b.pin.component, (c) =>
        toggleInputBubble(normalizeGateComponent(c), b.pin.pin),
      );
    } else if (b.via === 'inverter') {
      next = updateComponent(next, b.pin.component, (c) =>
        withOutputBubble(normalizeGateComponent(c), false),
      );
    } else {
      const flipId = freshId(next, `${b.pin.component}__flip_not_${flipNotCount++}`);
      next = spliceNotAtConsumer(next, b.pin, flipId, geom) ?? next;
    }
  }
  // Heal every consumed branch: an emptied standalone inverter, but also a
  // BUF whose single input bubble was just cleared -- the global invariant
  // (no bare BUF ever left) applies to both stored forms.
  for (const b of toProcess) {
    if (b.via === 'inverter' || b.via === 'bubble') next = healBareBuf(next, b.pin.component);
  }

  // Driver already inverted (either form): the pulled-back inversion cancels
  // into it instead of splicing a new NOT (a driver left as a bare buf heals
  // away).
  if (preDriverInverted && !naive) {
    next = updateComponent(next, driver.component, (c) => {
      const n = normalizeGateComponent(c);
      return getOutputBubble(n) ? toggleOutputBubble(n) : withInputBubble(n, 'a', false);
    });
    return healBareBuf(next, driver.component);
  }

  // One NOT just downstream of the driver: its `a` takes a fresh wire from
  // the driver pin, every existing branch wire re-ends at its `y` (a
  // driver->junction wire becomes not->junction, so the junction stays and
  // fans out the inverted signal).
  const atDriver = (e: WireEnd) =>
    e.kind === 'pin' && e.component === driver.component && e.pin === driver.pin;
  const dWires = next.wires.filter((w) => atDriver(w.a) || atDriver(w.b));
  if (dWires.length === 0) return null;
  const notId = freshId(next, `${driver.component}__merge_not`);
  const notY: WireEnd = { kind: 'pin', component: notId, pin: 'y' };
  const first = dWires[0]!;
  const fallback: Point = next.components.find((c) => c.id === driver.component)?.pos ?? {
    x: 0,
    y: 0,
  };
  const pos = notPosOnSpan(spliceSpan(next, first, atDriver(first.a), geom), fallback, geom);
  const wires = next.wires.map((w) =>
    atDriver(w.a) ? { ...w, a: notY } : atDriver(w.b) ? { ...w, b: notY } : w,
  );
  wires.push({
    id: freshId({ ...next, wires }, `${notId}__in`),
    a: { kind: 'pin', component: driver.component, pin: driver.pin },
    b: { kind: 'pin', component: notId, pin: 'a' },
    points: [],
  });
  return { ...next, components: [...next.components, standaloneNot(notId, pos)], wires };
}

/** Explicit ¬¬ cancellation (owner decision 2026-07-16: annihilation is an
 *  intentional gesture, never an automatic post-commit pass -- auto-cancel
 *  destroyed state the user meant to push back). Clears the driver's output
 *  bubble together with the matching inversion on the consumer side (an
 *  input bubble on `consumer.pin`, or a bare NOT/marker's own output
 *  bubble), then removes any participant left as a plain pass-through buf,
 *  healing its wires through. Transactional: null when the pair doesn't
 *  actually cancel. */
export function annihilatePair<C extends Circuit>(
  circuit: C,
  driverId: string,
  consumer: { component: string; pin: string },
): C | null {
  const driver = getGate(circuit, driverId);
  if (!driver || !getOutputBubble(driver)) return null;
  const connected = connectedPins(circuit, { component: driverId, pin: 'y' });
  // The output bubble is gate-level, not per-branch: cancelling it against
  // one consumer of a fanned-out driver would strand every other branch.
  if (connected.length !== 1) return null;
  if (!connected.some((p) => p.component === consumer.component && p.pin === consumer.pin))
    return null;
  const consumerGate = getGate(circuit, consumer.component);
  if (!consumerGate) return null;

  let next = updateComponent(circuit, driverId, (c) =>
    toggleOutputBubble(normalizeGateComponent(c)),
  );
  if (getInputBubbles(consumerGate).has(consumer.pin)) {
    next = updateComponent(next, consumer.component, (c) =>
      toggleInputBubble(normalizeGateComponent(c), consumer.pin),
    );
  } else if (isPlainInverter(consumerGate) && consumer.pin === 'a') {
    // Two NOTs/markers in series: both output bubbles cancel.
    next = updateComponent(next, consumer.component, (c) =>
      toggleOutputBubble(normalizeGateComponent(c)),
    );
  } else {
    return null;
  }
  next = healBareBuf(next, driverId);
  next = healBareBuf(next, consumer.component);
  return next;
}

/** buf carrying exactly an output bubble and nothing else -- a NOT or a bare
 *  ¬ marker, user-placed or synthetic alike (the explicit gesture may cancel
 *  a real user NOT; the automatic pass never could). */
export function isPlainInverter(c: Component): boolean {
  const n = normalizeGateComponent(c);
  return n.kind === 'buf' && getOutputBubble(n) && getInputBubbles(n).size === 0;
}

/** A cancel can leave a gate as a plain pass-through buf (e.g. a NOT whose
 *  inversion just annihilated); remove it and heal its input wire through to
 *  every output consumer, like the editor's Ctrl+X. Direct wires only; an
 *  unresolvable topology leaves the buf in place (safe, just not tidy). */
function healBareBuf<C extends Circuit>(circuit: C, id: string): C {
  const c = circuit.components.find((x) => x.id === id);
  if (!c || !isGateFamilyKind(c.kind)) return circuit;
  const n = normalizeGateComponent(c);
  if (n.kind !== 'buf' || getOutputBubble(n) || getInputBubbles(n).size > 0) return circuit;
  const at = (e: WireEnd, pin: string) => e.kind === 'pin' && e.component === id && e.pin === pin;
  const inWire = circuit.wires.find((w) => at(w.a, 'a') || at(w.b, 'a'));
  const outWires = circuit.wires.filter((w) => at(w.a, 'y') || at(w.b, 'y'));
  if (!inWire || outWires.length === 0) return circuit;
  const other = (w: (typeof circuit.wires)[number]) =>
    w.a.kind === 'pin' && w.a.component === id ? w.b : w.a;
  const upstream = other(inWire);
  const dropIds = new Set([inWire.id, ...outWires.map((w) => w.id)]);
  const wires = circuit.wires.filter((w) => !dropIds.has(w.id));
  for (const ow of outWires)
    wires.push({
      id: freshId({ ...circuit, wires }, `${inWire.id}__healed`),
      a: upstream,
      b: other(ow),
      points: [],
    });
  return { ...circuit, components: circuit.components.filter((x) => x.id !== id), wires };
}

/** Splices a real standalone 'not' component into the wire directly attached
 *  to `to`'s pin (the consumer's last hop), whatever sits upstream of that
 *  wire (a driver pin, a junction, a free end). Used when a bubble lands
 *  somewhere with no bubble param to carry it, e.g. a board output terminal.
 *  Returns null when the pin has no wire at all. */
function spliceNotAtConsumer<C extends Circuit>(
  circuit: C,
  to: { component: string; pin: string },
  notId: string,
  geom: TransformGeom | undefined,
): C | null {
  const atTo = (e: WireEnd) => e.kind === 'pin' && e.component === to.component && e.pin === to.pin;
  const idx = circuit.wires.findIndex((w) => atTo(w.a) || atTo(w.b));
  if (idx === -1) return null;
  const w = circuit.wires[idx]!;
  const onA = atTo(w.a);
  const fallback: Point = circuit.components.find((c) => c.id === to.component)?.pos ?? {
    x: 0,
    y: 0,
  };
  const pos = notPosOnSpan(spliceSpan(circuit, w, !onA, geom), fallback, geom);
  const wires = circuit.wires.slice();
  // The original wire now feeds the not's input; a new wire carries the
  // not's output onward to `to` (never join two output pins directly).
  wires[idx] = onA
    ? { ...w, a: { kind: 'pin', component: notId, pin: 'a' } }
    : { ...w, b: { kind: 'pin', component: notId, pin: 'a' } };
  wires.push({
    id: `${notId}__wire`,
    a: { kind: 'pin', component: notId, pin: 'y' },
    b: { kind: 'pin', component: to.component, pin: to.pin },
    points: [],
  });
  return { ...circuit, components: [...circuit.components, standaloneNot(notId, pos)], wires };
}

/** A standalone inverter, stored in the same base-kind + params convention
 *  as every other gate (never a literal 'not') -- so toggleOutputBubble and
 *  friends, which only ever look at params, stay correct for it too. Only
 *  lower.ts's *compiled* output uses the literal 'not' primitive kind.
 *  Flagged `synthetic` so annihilation only ever collapses a bubble-pair
 *  marker it placed itself, never a real user gate that merely dualized
 *  into the same buf+bubble shape. */
function standaloneNot(id: string, pos: Component['pos'], bubbleOnly = false): Component {
  const c = withOutputBubble({ id, kind: 'buf', pos }, true);
  return { ...c, params: { ...c.params, synthetic: true, ...(bubbleOnly ? { bubbleOnly } : {}) } };
}

/** N-convert on a buf carrying BOTH an input and an output bubble (the ¬¬
 *  state a push onto a NOT's input produces): a single bare marker would
 *  display one inversion where two exist, so it splits into two chained bare
 *  markers instead -- both visible, both still draggable to cancel. */
export function splitDoubleInverter<C extends Circuit>(
  circuit: C,
  id: string,
  geom?: TransformGeom,
): C | null {
  const c = circuit.components.find((x) => x.id === id);
  if (!c || !isBubbleEligibleGate(c)) return null;
  const n = normalizeGateComponent(c);
  if (n.kind !== 'buf' || !getOutputBubble(n) || !getInputBubbles(n).has('a')) return null;
  const at = (e: WireEnd, pin: string) => e.kind === 'pin' && e.component === id && e.pin === pin;
  const inWire = circuit.wires.find((w) => at(w.a, 'a') || at(w.b, 'a'));
  const outWires = circuit.wires.filter((w) => at(w.a, 'y') || at(w.b, 'y'));
  if (!inWire || outWires.length === 0) return null;
  const g = geom?.grid ?? DEFAULT_GRID;
  const aPos = pinPos(circuit, { component: id, pin: 'a' }, geom) ?? c.pos;
  // Bare markers are 2G squares with the pin midline one grid down; chain
  // them along the old glyph's wire line, input marker first.
  const m1Pos = snapPt({ x: aPos.x, y: aPos.y - g }, g);
  const m2Pos = snapPt({ x: aPos.x + 3 * g, y: aPos.y - g }, g);
  const id1 = freshId(circuit, `${id}__split0`);
  const id2 = freshId(circuit, `${id}__split1`);
  const wires = circuit.wires.map((w) => {
    if (at(w.a, 'a')) return { ...w, a: { kind: 'pin', component: id1, pin: 'a' } as WireEnd };
    if (at(w.b, 'a')) return { ...w, b: { kind: 'pin', component: id1, pin: 'a' } as WireEnd };
    if (at(w.a, 'y')) return { ...w, a: { kind: 'pin', component: id2, pin: 'y' } as WireEnd };
    if (at(w.b, 'y')) return { ...w, b: { kind: 'pin', component: id2, pin: 'y' } as WireEnd };
    return w;
  });
  wires.push({
    id: freshId({ ...circuit, wires }, `${id}__splitwire`),
    a: { kind: 'pin', component: id1, pin: 'y' },
    b: { kind: 'pin', component: id2, pin: 'a' },
    points: [],
  });
  return {
    ...circuit,
    components: [
      ...circuit.components.filter((x) => x.id !== id),
      standaloneNot(id1, m1Pos, true),
      standaloneNot(id2, m2Pos, true),
    ],
    wires,
  };
}

/** Inserts a pair of inverters in series on a wire -- always legal (¬¬x = x
 *  is self-cancelling by construction), the "add ¬¬ here" tool. Markers are
 *  bare-bubble form (A2) and sit one grid apart along the wire around the
 *  insertion point, each anchored so its 2G glyph is centered on the span
 *  line -- never stacked at one point (A4). `pos` is the caller's projected
 *  insertion point; with resolvable span geometry the midpoint refines it. */
export function insertBubblePair<C extends Circuit>(
  circuit: C,
  wireId: string,
  pos: Component['pos'],
  geom?: TransformGeom,
): C | null {
  const idx = circuit.wires.findIndex((w) => w.id === wireId);
  if (idx === -1) return null;
  const w = circuit.wires[idx]!;
  const g = geom?.grid ?? DEFAULT_GRID;
  const a = wireEndPos(circuit, w.a, geom);
  const b = wireEndPos(circuit, w.b, geom);
  const mid = snapPt(pos, g);
  let dir: Point = { x: 1, y: 0 };
  if (a && b && (a.x !== b.x || a.y !== b.y)) {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    dir = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
  }
  let c1 = snapPt({ x: mid.x - g * dir.x, y: mid.y - g * dir.y }, g);
  let c2 = snapPt({ x: mid.x + g * dir.x, y: mid.y + g * dir.y }, g);
  if (c1.x === c2.x && c1.y === c2.y) {
    // Snapping collapsed a near-diagonal offset; force one grid of separation
    // along the dominant axis so the markers never stack.
    const horiz = Math.abs(dir.x) >= Math.abs(dir.y);
    c1 = horiz ? { x: mid.x - g, y: mid.y } : { x: mid.x, y: mid.y - g };
    c2 = horiz ? { x: mid.x + g, y: mid.y } : { x: mid.x, y: mid.y + g };
  }
  // The bare-bubble glyph is a 2G square anchored at its top-left; shift by
  // one grid on each axis so the marker's pin midline rides the wire span.
  const anchor = (c: Point): Point => ({ x: c.x - g, y: c.y - g });
  const id1 = freshId(circuit, `${wireId}__pair0`);
  const id2 = freshId(circuit, `${wireId}__pair1`);
  const wires = circuit.wires.slice();
  wires[idx] = { ...w, b: { kind: 'pin', component: id1, pin: 'a' } };
  wires.push(
    {
      id: freshId(circuit, `${wireId}__pairwire`),
      a: { kind: 'pin', component: id1, pin: 'y' },
      b: { kind: 'pin', component: id2, pin: 'a' },
      points: [],
    },
    {
      id: freshId(circuit, `${wireId}__pairwireEnd`),
      a: { kind: 'pin', component: id2, pin: 'y' },
      b: w.b,
      points: [],
    },
  );
  return {
    ...circuit,
    components: [
      ...circuit.components,
      standaloneNot(id1, anchor(c1), true),
      standaloneNot(id2, anchor(c2), true),
    ],
    wires,
  };
}

/** Bulk ¬¬ cleanup (¬¬A = A): (a) a gate's output bubble feeding directly
 *  into another gate's already-bubbled input pin -- clears both flags on that
 *  one pin/branch only; (b) two synthetic 'not' markers wired directly in
 *  series -- removes both and rejoins the wire. Pure, idempotent. No longer
 *  run automatically after pushes (owner decision 2026-07-16 -- cancellation
 *  is the explicit `annihilatePair` gesture); kept for preset import
 *  normalization and tests. */
export function annihilate<C extends Circuit>(circuit: C): C {
  let next = annihilateGateBubblePairs(circuit);
  next = annihilateNotComponentPairs(next);
  return next;
}

function annihilateGateBubblePairs<C extends Circuit>(circuit: C): C {
  let next = circuit;
  for (const gate of circuit.components) {
    if (!isGateFamilyKind(gate.kind)) continue;
    const g = normalizeGateComponent(gate);
    if (!getOutputBubble(g)) continue;
    const consumers = connectedPins(circuit, { component: gate.id, pin: 'y' });
    // outputBubble is a gate-level (not per-branch) property: only safe to
    // clear it via a matched consumer bubble when there is exactly one
    // consumer -- with fan-out, every other branch still depends on that
    // same inversion and would silently lose it (the fan-out rule applies
    // to annihilation too, not just an explicit push).
    if (consumers.length !== 1) continue;
    const { component, pin } = consumers[0]!;
    const consumer = circuit.components.find((c) => c.id === component);
    if (!consumer || !isGateFamilyKind(consumer.kind)) continue;
    const cn = normalizeGateComponent(consumer);
    if (!getInputBubbles(cn).has(pin)) continue;
    next = updateComponent(next, gate.id, toggleOutputBubble);
    next = updateComponent(next, component, (c) => toggleInputBubble(c, pin));
  }
  return next;
}

/** True only for a synthetic standalone-inverter marker (from
 *  insertBubblePair/pushOutputAcrossFanout's splice, unmodified since) --
 *  never a real user gate that merely dualized into the same buf+bubble
 *  shape, which must not be silently deleted by annihilation. */
function isPlainNot(c: Component): boolean {
  const n = normalizeGateComponent(c);
  return (
    n.kind === 'buf' &&
    getOutputBubble(n) &&
    getInputBubbles(n).size === 0 &&
    c.params?.['synthetic'] === true
  );
}

function annihilateNotComponentPairs<C extends Circuit>(circuit: C): C {
  let changed = true;
  let components = circuit.components;
  let wires = circuit.wires;
  while (changed) {
    changed = false;
    for (const w of wires) {
      if (w.a.kind !== 'pin' || w.b.kind !== 'pin') continue;
      const aEnd = w.a as Extract<typeof w.a, { kind: 'pin' }>;
      const bEnd = w.b as Extract<typeof w.b, { kind: 'pin' }>;
      const compA = components.find((c) => c.id === aEnd.component);
      const compB = components.find((c) => c.id === bEnd.component);
      if (!compA || !compB || !isPlainNot(compA) || !isPlainNot(compB)) continue;
      if (aEnd.pin !== 'y' || bEnd.pin !== 'a') continue;
      // A directly drives B's sole input with nothing else on the wire:
      // find A's upstream driver wire and B's downstream consumer wire, splice through.
      const upWire = wires.find(
        (x) => x.id !== w.id && x.a.kind === 'pin' && x.a.component === compA.id && x.a.pin === 'a',
      );
      const upWireB = wires.find(
        (x) => x.id !== w.id && x.b.kind === 'pin' && x.b.component === compA.id && x.b.pin === 'a',
      );
      const downWire = wires.find(
        (x) => x.id !== w.id && x.a.kind === 'pin' && x.a.component === compB.id && x.a.pin === 'y',
      );
      const downWireB = wires.find(
        (x) => x.id !== w.id && x.b.kind === 'pin' && x.b.component === compB.id && x.b.pin === 'y',
      );
      const up = upWire ?? upWireB;
      const down = downWire ?? downWireB;
      if (!up || !down) continue;
      const upOther = up.a.kind === 'pin' && up.a.component === compA.id ? up.b : up.a;
      const downOther = down.a.kind === 'pin' && down.a.component === compB.id ? down.b : down.a;
      wires = wires
        .filter((x) => x.id !== w.id && x.id !== up.id && x.id !== down.id)
        .concat([{ id: `${w.id}__annihilated`, a: upOther, b: downOther, points: [] }]);
      components = components.filter((c) => c.id !== compA.id && c.id !== compB.id);
      changed = true;
      break;
    }
  }
  return { ...circuit, components, wires };
}
