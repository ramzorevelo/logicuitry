// Batch connect: match source output pins onto target input pins by role,
// then width, then a visual-order pairing within each role/width group.
// Role is mandatory; an unmatchable source is reported, never silently
// mis-wired.

import type { PinRole } from '../../core/model/types';
import type { Vec2 } from '../../render/scene';
import type { PinTarget } from './pinTargets';

export interface SmartConnectResult {
  pairs: { source: PinTarget; target: PinTarget }[];
  unmatched: PinTarget[];
}

// --- shared ordered-mapping/permutation machinery (M4.5) -------------------

// Axis a pin group visually differs along most (x if wider in x than y, else
// y) -- the coordinate ordered-mapping sorts both sides by, so a multi-pin
// component's pins pair with sources by ON-SCREEN reading order at its
// current rotation, not declared pin `order`.
function pinsSpreadAxis(pins: readonly PinTarget[]): 'x' | 'y' {
  if (pins.length === 0) return 'x';
  const xs = pins.map((p) => p.worldPos.x);
  const ys = pins.map((p) => p.worldPos.y);
  const spreadX = Math.max(...xs) - Math.min(...xs);
  const spreadY = Math.max(...ys) - Math.min(...ys);
  return spreadX >= spreadY ? 'x' : 'y';
}

function sortByAxis(pins: readonly PinTarget[], axis: 'x' | 'y'): PinTarget[] {
  return [...pins].sort((a, b) =>
    axis === 'x'
      ? a.worldPos.x - b.worldPos.x || a.worldPos.y - b.worldPos.y
      : a.worldPos.y - b.worldPos.y || a.worldPos.x - b.worldPos.x,
  );
}

function factorial(n: number): number {
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

// A group larger than 6 falls back to a cyclic shift (guards factorial
// blowup); its "period" for rotation wrap-around is n rather than n!.
function groupPeriod(n: number): number {
  if (n <= 1) return 1;
  return n <= 6 ? factorial(n) : n;
}

// k-th permutation of [0..n-1] (lexicographic, identity first at k=0), or a
// cyclic shift when n > 6.
function permutationIndices(n: number, k: number): number[] {
  if (n <= 1) return n === 1 ? [0] : [];
  if (n > 6) {
    const shift = ((k % n) + n) % n;
    return Array.from({ length: n }, (_, i) => (i + shift) % n);
  }
  const total = factorial(n);
  let rem = ((k % total) + total) % total;
  const items = Array.from({ length: n }, (_, i) => i);
  const result: number[] = [];
  for (let i = n; i > 0; i--) {
    const f = factorial(i - 1);
    const pick = Math.floor(rem / f);
    rem -= pick * f;
    result.push(items.splice(pick, 1)[0]!);
  }
  return result;
}

// Pairs `srcs` onto `tgts` (same length after truncation) by sorting both
// along the target group's spread axis, iterating sources in that sorted
// order, and assigning each the target at the rotation's permuted index --
// rotation=0 is always the identity (visual-order) pairing; every other
// value is still a full 1-to-1 re-pairing of the same participants (never an
// orphan or a reused source), per the scroll-semantics spec.
function pairByPermutation(
  srcs: readonly PinTarget[],
  tgts: readonly PinTarget[],
  rotation: number,
): { source: PinTarget; target: PinTarget }[] {
  // Each side is read along ITS OWN spread axis: a column of switches reads
  // top-down while a mux's select pins read left-right, so the topmost source
  // takes the leftmost pin (with select pins MSB-first, sw0 -> s1, sw1 -> s0).
  // Sorting the sources along the targets' axis instead let their x order --
  // meaningless for a vertical stack -- decide the pairing.
  const sortedTgts = sortByAxis(tgts, pinsSpreadAxis(tgts));
  const sortedSrcs = sortByAxis(srcs, pinsSpreadAxis(srcs));
  const n = Math.min(sortedSrcs.length, sortedTgts.length);
  const perm = permutationIndices(n, rotation);
  const pairs: { source: PinTarget; target: PinTarget }[] = [];
  for (let i = 0; i < n; i++) pairs.push({ source: sortedSrcs[i]!, target: sortedTgts[perm[i]!]! });
  return pairs;
}

/** Whether a source pin's role may drive a target pin's role. Exact matches
 *  always win (callers try them first); beyond that a plain logic output --
 *  a switch, a gate, a chip -- is the ordinary way to feed a mux select, an
 *  enable, or an async set/clear, so refusing those left a mux's select pins
 *  unreachable by smart-connect once its data pins were wired. Only a plain
 *  data source crosses roles, and never onto a clock pin: a clock output
 *  landing on a data input, or a switch on a clock pin, is exactly the
 *  mis-wire the role check exists to prevent. */
export function canDrive(source: PinRole, target: PinRole): boolean {
  if (source === target) return true;
  return source === 'data' && target !== 'clock';
}

// --- hover path (4a) --------------------------------------------------------

// Groups `srcs`/`tgts` (already role/width-filtered by the caller) by the
// ordered-mapping rule, width-checking each resulting pair (a role can carry
// mixed widths); a width mismatch reports that source unmatched rather than
// silently pairing it.
function assignRole(
  srcs: readonly PinTarget[],
  tgts: readonly PinTarget[],
  rotation: number,
): { pairs: SmartConnectResult['pairs']; mismatched: PinTarget[]; used: PinTarget[] } {
  const mapped = pairByPermutation(srcs, tgts, rotation);
  const pairs: SmartConnectResult['pairs'] = [];
  const mismatched: PinTarget[] = [];
  for (const p of mapped) {
    if (p.source.width === p.target.width) pairs.push(p);
    else mismatched.push(p.source);
  }
  // A source this group didn't reach is not unmatched yet -- a later target
  // group may still be able to take it.
  return { pairs, mismatched, used: mapped.map((p) => p.source) };
}

// sources: one free pin per selected source, pre-sorted top-to-bottom by
// caller (only used as an ultimate tiebreak; ordering itself now comes from
// the ordered-mapping rule below). targetPins: pre-sorted by caller too (per-
// component pin `order`, components in spatial order) -- grouping by role
// below is a stable filter (push preserves relative order). `rotation`
// cycles through valid 1-to-1 re-pairings within each role/width group
// (permutation, not a plain counter shift -- M4.5).
export function smartConnect(
  sources: readonly PinTarget[],
  targetPins: readonly PinTarget[],
  rotation = 0,
): SmartConnectResult {
  const targetsByRole = new Map<PinRole, PinTarget[]>();
  for (const t of targetPins) {
    if (!t.free) continue;
    const list = targetsByRole.get(t.role) ?? [];
    list.push(t);
    targetsByRole.set(t.role, list);
  }
  const sourcesByRole = new Map<PinRole, PinTarget[]>();
  for (const s of sources) {
    if (!s.free) continue;
    const list = sourcesByRole.get(s.role) ?? [];
    list.push(s);
    sourcesByRole.set(s.role, list);
  }

  const pairs: SmartConnectResult['pairs'] = [];
  const unmatched: PinTarget[] = [];
  for (const s of sources) if (!s.free) unmatched.push(s);

  // Target groups are visited in the caller's pin order (a mux's data pins
  // before its select pins), and each takes its own role's sources first, so
  // the compatible-role fallback only ever picks up what no exact match
  // wanted.
  const claimed = new Set<PinTarget>();
  const free = sources.filter((s) => s.free);
  for (const [role, tgts] of targetsByRole) {
    const available = free.filter((s) => !claimed.has(s));
    const exact = available.filter((s) => s.role === role);
    const srcs =
      exact.length >= tgts.length
        ? exact
        : [...exact, ...available.filter((s) => s.role !== role && canDrive(s.role, role))];
    if (srcs.length === 0) continue;
    const result = assignRole(srcs, tgts, rotation);
    pairs.push(...result.pairs);
    unmatched.push(...result.mismatched);
    for (const s of result.used) claimed.add(s);
  }
  for (const s of free) if (!claimed.has(s)) unmatched.push(s);

  return { pairs, unmatched };
}

// A SINGLE source against a multi-pin target group is a "pick one of N"
// choice, not a permutation -- pairByPermutation's rotation is capped at
// min(srcs.length, tgts.length), so with exactly one source it always caps
// at n=1 and scrolling never moves off the first candidate. This is the
// dedicated 1-to-many path: default lands on the first candidate NOT already
// claimed by another In/Out label (each label logically wants its own pin),
// and scroll cycles through every valid candidate, wrapping.
export function smartConnectSingleSource(
  source: PinTarget,
  candidates: readonly PinTarget[],
  rotation: number,
  isLabelClaimed: (t: PinTarget) => boolean,
): { source: PinTarget; target: PinTarget } | null {
  const usable = candidates.filter((t) => t.free && t.width === source.width);
  const exact = usable.filter((t) => t.role === source.role);
  const compatible = usable.filter((t) => t.role !== source.role && canDrive(source.role, t.role));
  if (exact.length === 0 && compatible.length === 0) return null;
  // Exact-role pins lead the cycle, so the default lands on one whenever any
  // is free; scrolling continues on into the compatible ones (a mux select).
  const sorted = [
    ...sortByAxis(exact, pinsSpreadAxis(exact)),
    ...sortByAxis(compatible, pinsSpreadAxis(compatible)),
  ];
  const defaultIdx = sorted.findIndex((t) => !isLabelClaimed(t));
  const start = defaultIdx >= 0 ? defaultIdx : 0;
  const idx = (((start + rotation) % sorted.length) + sorted.length) % sorted.length;
  return { source, target: sorted[idx]! };
}

// --- no-hover multi-select connect (4b) -------------------------------------

export interface ChainComp {
  id: string;
  pos: Vec2;
  /** Body center (symbolBounds midpoint) -- pin facing is derived from the
   *  pin's offset off this, so rotation/mirror fall out of geometry. */
  center: Vec2;
  hasAnyInputPinSpec: boolean;
  freeIns: readonly PinTarget[];
  freeOuts: readonly PinTarget[];
  /** Top-level In label -- its leftover output may still name an
   *  already-driven input (a label merge, not a second real driver).
   *  Optional/defaults false so every pre-existing ChainComp literal (not an
   *  In label) doesn't need updating. */
  isInPort?: boolean;
  /** This component's own `in`-role pins that already carry a wire. */
  wiredIns?: readonly PinTarget[];
}

type ChainRole = 'middle' | 'pureSource' | 'pureSink' | 'skip';

function chainRole(c: ChainComp): ChainRole {
  const hasIn = c.freeIns.length > 0;
  const hasOut = c.freeOuts.length > 0;
  if (hasIn && hasOut) return 'middle';
  if (hasOut) return 'pureSource';
  if (hasIn) return 'pureSink';
  return 'skip';
}

function centroid(list: readonly ChainComp[], axis: 'x' | 'y'): number | undefined {
  if (list.length === 0) return undefined;
  const sum = list.reduce((s, c) => s + (axis === 'x' ? c.pos.x : c.pos.y), 0);
  return sum / list.length;
}

function pinGroupCentroid(pins: readonly PinTarget[]): Vec2 {
  const cx = pins.reduce((s, p) => s + p.worldPos.x, 0) / pins.length;
  const cy = pins.reduce((s, p) => s + p.worldPos.y, 0) / pins.length;
  return { x: cx, y: cy };
}

interface Candidate {
  pin: PinTarget;
  used: boolean;
  middleOut: boolean;
  trueSource: boolean;
  dist: number;
}

// Sink ranking tier: an unconsumed output of a middle (a component that still
// has free input pins) wins outright (stage-by-stage chain routing);
// otherwise a true source (switch/button/clock/const) outranks a gate whose
// declared input is simply saturated (wired elsewhere), preserving the
// direct-fallback case. Sinks resolve before middles now (M4.5 follow-up),
// so "will this middle participate" is unknowable here -- being a middle at
// all is the predicate.
function sinkTier(c: Candidate): number {
  if (c.middleOut && !c.used) return 0;
  return c.trueSource ? 1 : 2;
}

/** Cardinal direction a pin faces: dominant axis and sign of the pin's
 *  offset from its component's body center. Post-transform worldPos means a
 *  rotated/mirrored glyph's facing needs no special-casing. */
export function pinFacing(pin: Vec2, center: Vec2): Vec2 {
  const dx = pin.x - center.x;
  const dy = pin.y - center.y;
  if (Math.abs(dx) >= Math.abs(dy)) return { x: dx >= 0 ? 1 : -1, y: 0 };
  return { x: 0, y: dy >= 0 ? 1 : -1 };
}

/** Chain-alignment gate for a chip/gate output feeding another chip/gate's
 *  free input group: the two must mutually face each other -- the output pin
 *  must lie in the direction the input pins face (upstream chip on the input
 *  side), and the input group must lie in the direction the output pin faces.
 *  Facing uses the input group's first pin (our glyphs put a group's pins on
 *  one side) and position uses the group centroid. */
export function outputAlignedWithInputs(
  outPin: Vec2,
  outCenter: Vec2,
  inPins: readonly Vec2[],
  inCenter: Vec2,
): boolean {
  if (inPins.length === 0) return false;
  const dA = pinFacing(outPin, outCenter);
  const dB = pinFacing(inPins[0]!, inCenter);
  const qx = inPins.reduce((s, p) => s + p.x, 0) / inPins.length;
  const qy = inPins.reduce((s, p) => s + p.y, 0) / inPins.length;
  const towardOut = (outPin.x - qx) * dB.x + (outPin.y - qy) * dB.y;
  const towardIn = (qx - outPin.x) * dA.x + (qy - outPin.y) * dA.y;
  return towardOut > 0 && towardIn > 0;
}

// Extent of a comp along one axis, derived from pos (top-left) mirrored
// through center (body-center) -- ChainComp carries no width/height field.
function flowExtent(c: ChainComp, axis: 'x' | 'y'): [number, number] {
  const p = axis === 'x' ? c.pos.x : c.pos.y;
  const q = axis === 'x' ? c.center.x : c.center.y;
  const far = 2 * q - p;
  return [Math.min(p, far), Math.max(p, far)];
}

// Rule-5 exception: a pure source co-aligned with a misaligned feeder (both
// crossed by one sweep-line perpendicular to flow) vouches for that feeder,
// so its leftover output can still chain into a middle's input.
function flowExtentOverlap(a: ChainComp, b: ChainComp, axis: 'x' | 'y'): boolean {
  const [aMin, aMax] = flowExtent(a, axis);
  const [bMin, bMax] = flowExtent(b, axis);
  return aMin <= bMax && bMin <= aMax;
}

interface ChainGroup {
  srcs: PinTarget[];
  tgts: PinTarget[];
}

/** Prioritizes routing a switch/button through an intervening gate/chip's
 *  input rather than skipping straight to an LED/output. Pure sinks resolve
 *  FIRST (M4.5 follow-up) so LEDs claim chip/gate outputs before another
 *  chip's open inputs can steal them; a SINK's candidates rank by the tiered
 *  rule above. A MIDDLE consumer's free inputs then rank by proximity alone
 *  (no tier), so an adjacent switch wins over a distant gate's output -- but
 *  a chip/gate output (any component with an input pin spec, saturated or
 *  not) may feed a middle's input ONLY when it was left unconsumed by every
 *  sink AND the two chips are geometrically aligned for a chain
 *  (outputAlignedWithInputs); no chip-to-chip fan-out last resort -- an
 *  excluded input simply stays unconnected. Within a group (a consumer's
 *  free inputs sharing one role/width), the chosen sources pair onto the
 *  pins by the same ordered-mapping rule as the hover path (visual reading
 *  order, not which candidate happened to be nearest which specific pin).
 *  Distance is measured pin-to-pin against the group's centroid (documented
 *  choice, kept deterministic) -- a single-pin group reduces to plain
 *  pin-to-pin distance. */
/**
 * The no-hover gesture: resolve the chain within the selection, and only if
 * that yields nothing, widen to the whole board and keep the pairs that still
 * touch the selection.
 *
 * The selection alone cannot resolve a chain that has no consumer in it -- a
 * column of switches with the gate they should drive left unselected is the
 * common case, and it read as "no compatible pins" even though the board
 * plainly had somewhere for them to go. Widening is a FALLBACK rather than the
 * default so an already-resolving selection keeps its exact pairing: with the
 * whole board in the pool an unselected component can win a candidate slot or
 * spend an output the selection wanted.
 */
export function smartConnectChainWithin(
  comps: readonly ChainComp[],
  selected: ReadonlySet<string>,
  rotation = 0,
): SmartConnectResult {
  const within = smartConnectChain(
    comps.filter((c) => selected.has(c.id)),
    rotation,
  );
  if (within.pairs.length > 0) return within;
  const wide = smartConnectChain(comps, rotation);
  return {
    pairs: wide.pairs.filter(
      (p) => selected.has(p.source.componentId) || selected.has(p.target.componentId),
    ),
    unmatched: [],
  };
}

export function smartConnectChain(comps: readonly ChainComp[], rotation = 0): SmartConnectResult {
  const middles = comps.filter((c) => chainRole(c) === 'middle');
  const pureSources = comps.filter((c) => chainRole(c) === 'pureSource');
  const pureSinks = comps.filter((c) => chainRole(c) === 'pureSink');
  if (pureSources.length === 0 && pureSinks.length === 0) return { pairs: [], unmatched: [] };

  let axis: 'x' | 'y' = 'x';
  const srcGroup = pureSources.length ? pureSources : middles;
  const sinkGroup = pureSinks.length ? pureSinks : middles;
  const srcX = centroid(srcGroup, 'x');
  const srcY = centroid(srcGroup, 'y');
  const sinkX = centroid(sinkGroup, 'x');
  const sinkY = centroid(sinkGroup, 'y');
  if (srcX !== undefined && srcY !== undefined && sinkX !== undefined && sinkY !== undefined) {
    axis = Math.abs(sinkY - srcY) > Math.abs(sinkX - srcX) ? 'y' : 'x';
  }
  const flowCoord = (c: ChainComp): number => (axis === 'x' ? c.pos.x : c.pos.y);

  // Pure sinks resolve fully BEFORE middles (M4.5 follow-up), so every
  // LED-bound output is claimed before a chip's open inputs get to draw --
  // chip outputs never steal from sinks; they only chain to another chip
  // out of what the sinks left over, and only when aligned.
  const consumers = [
    ...[...pureSinks].sort((a, b) => flowCoord(a) - flowCoord(b)),
    ...[...middles].sort((a, b) => flowCoord(a) - flowCoord(b)),
  ];

  const usedOutputs = new Set<string>();
  const outKey = (p: PinTarget) => `${p.componentId} ${p.pinName}`;
  const groups: ChainGroup[] = [];

  for (const consumer of consumers) {
    const isMiddle = chainRole(consumer) === 'middle';
    // Group the consumer's free input pins by role+width, preserving
    // first-seen order (ordered-mapping runs within one such group, never
    // across roles -- a clock pin never contends with a data pin).
    const byGroup = new Map<string, PinTarget[]>();
    for (const pin of consumer.freeIns) {
      const key = `${pin.role} ${pin.width}`;
      const list = byGroup.get(key) ?? [];
      list.push(pin);
      byGroup.set(key, list);
    }
    for (const pins of byGroup.values()) {
      const centroidPt = pinGroupCentroid(pins);
      const groupPinPositions = pins.map((p) => p.worldPos);
      const candidates: Candidate[] = [];
      for (const other of comps) {
        if (other.id === consumer.id || flowCoord(other) >= flowCoord(consumer)) continue;
        for (const outPin of other.freeOuts) {
          if (!outPin.free || outPin.width !== pins[0]!.width) continue;
          if (!canDrive(outPin.role, pins[0]!.role)) continue;
          const used = usedOutputs.has(outKey(outPin));
          if (isMiddle && other.hasAnyInputPinSpec) {
            // Chip/gate output into another chip/gate's input: only from the
            // sinks' leftovers (no chip-to-chip fan-out), and only when the
            // two bodies mutually face each other for a chain.
            if (used) continue;
            const aligned = outputAlignedWithInputs(
              outPin.worldPos,
              other.center,
              groupPinPositions,
              consumer.center,
            );
            if (!aligned) {
              // Rule-5 exception: a misaligned feeder still qualifies if some
              // pure source upstream of this consumer is flow-axis-aligned
              // with it -- that source vouches for the feeder's chain.
              const vouched = pureSources.some(
                (s) => flowCoord(s) < flowCoord(consumer) && flowExtentOverlap(s, other, axis),
              );
              if (!vouched) continue;
            }
          }
          candidates.push({
            pin: outPin,
            used,
            middleOut: chainRole(other) === 'middle',
            trueSource: !other.hasAnyInputPinSpec,
            dist: Math.hypot(outPin.worldPos.x - centroidPt.x, outPin.worldPos.y - centroidPt.y),
          });
        }
      }
      if (candidates.length === 0) continue;
      if (isMiddle) {
        candidates.sort((a, b) => Number(a.used) - Number(b.used) || a.dist - b.dist);
      } else {
        candidates.sort(
          (a, b) => sinkTier(a) - sinkTier(b) || Number(a.used) - Number(b.used) || a.dist - b.dist,
        );
      }
      const chosen = candidates
        .slice(0, Math.min(pins.length, candidates.length))
        .map((c) => c.pin);
      if (chosen.length === 0) continue;
      groups.push({ srcs: chosen, tgts: pins.slice(0, chosen.length) });
      for (const p of chosen) usedOutputs.add(outKey(p));
    }
  }

  // In-label pass: a top-level In port is a pure label, not a real driver, so
  // its leftover free output may still additionally name an already-driven
  // input elsewhere (labelSync just merges the label onto that net) --
  // otherwise an In-label source can never pair with any input the owner
  // already wired to a switch/gate, which is the whole point of an In label.
  // Each label wants its own pin, so a target claimed here is spent for the
  // rest of the pass -- without this every label independently picked the
  // globally nearest wired input and two labels landed on the SAME pin.
  const claimedIns = new Set<string>();
  const labelSrcs: PinTarget[] = [];
  const labelTgts: PinTarget[] = [];
  for (const src of pureSources) {
    if (!src.isInPort) continue;
    for (const outPin of src.freeOuts) {
      if (usedOutputs.has(outKey(outPin))) continue;
      let best: PinTarget | undefined;
      let bestDist = Infinity;
      for (const consumer of comps) {
        if (consumer.id === src.id) continue;
        for (const pin of consumer.wiredIns ?? []) {
          if (pin.width !== outPin.width || !canDrive(outPin.role, pin.role)) continue;
          if (claimedIns.has(outKey(pin))) continue;
          const d = Math.hypot(
            pin.worldPos.x - outPin.worldPos.x,
            pin.worldPos.y - outPin.worldPos.y,
          );
          if (d < bestDist) {
            best = pin;
            bestDist = d;
          }
        }
      }
      if (best) {
        labelSrcs.push(outPin);
        labelTgts.push(best);
        claimedIns.add(outKey(best));
        usedOutputs.add(outKey(outPin));
      }
    }
  }
  // One group, not one per label: the ordered mapping then runs across the
  // whole set, so a column of labels reads onto a column of pins in visual
  // order instead of each label crossing to whichever pin it was nearest.
  if (labelSrcs.length > 0) groups.push({ srcs: labelSrcs, tgts: labelTgts });

  // Rotation composes across every group mixed-radix, in the order each
  // group was resolved above (sinks before middles, flow order within each)
  // -- one wheel step advances the whole assignment by one, wrapping at the
  // product of every group's period.
  const total = groups.reduce((p, g) => p * groupPeriod(Math.min(g.srcs.length, g.tgts.length)), 1);
  let rem = total > 0 ? ((rotation % total) + total) % total : 0;
  const pairs: SmartConnectResult['pairs'] = [];
  for (const g of groups) {
    const period = groupPeriod(Math.min(g.srcs.length, g.tgts.length));
    const idx = period > 0 ? rem % period : 0;
    rem = period > 0 ? Math.floor(rem / period) : rem;
    pairs.push(...pairByPermutation(g.srcs, g.tgts, idx));
  }
  return { pairs, unmatched: [] };
}
