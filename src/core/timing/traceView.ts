// Pure transform from the sim trace to renderable waveform tracks. Tracks are
// path-addressed; `valuesAt(t)` is the public scrub-replay API (also the hook
// future sequential lessons step against). Nothing here touches the kernel.

import * as bv from '../value/busValue';
import type { Board } from '../model/types';
import type { CompiledCircuit } from '../model/compile';
import { componentPaths } from '../model/compile';
import type { NetChangeRecord } from '../sim/kernel';
import type { DatasheetColumn } from '../parts/partsDb';
import { partDelayPs } from './sta';
import { hasPrimitive, getPrimitive } from '../sim/primitives/registry';

/** Kinds that get a waveform track (owner decision: probes + clocks + top-level I/O). */
const TRACK_KINDS = new Set(['clock', 'toggle', 'button', 'inport', 'outport', 'led', 'probe']);

export const DEFAULT_GLITCH_THRESHOLD_PS = 25_000;

export interface TrackSpec {
  /** Component path (`main/<comp.id>`, or `main/<comp.id>.<pin>` for a
   *  multi-output part) -- always keyed by id, never by the display label,
   *  so two label-sharing components never collide onto one path (Task 3). */
  path: string;
  label: string;
  kind: string;
  net: number;
  width: number;
}

export interface Segment {
  t0: number;
  t1: number;
  value: bv.BusValue;
  /** Any X/Z lane in a bus segment; renders hatched. */
  mixed: boolean;
  /** '0'/'1'/'X'/'Z' for 1-bit; hex for buses; 'X?'/'Z?' when mixed. */
  label: string;
}

/** Fig 2.67 eye: output may change from `earliest` (t - (t_pd - t_cd)) to `t`. */
export interface EdgeBand {
  t: number;
  earliest: number;
  estimated: boolean;
}

export interface GlitchMarker {
  trackPath: string;
  t0: number;
  t1: number;
}

/** One causal hop between two visible tracks (Fig 2.69 arrows). */
export interface CauseArrow {
  fromPath: string;
  fromT: number;
  toPath: string;
  toT: number;
}

export interface Track extends TrackSpec {
  segments: Segment[];
  bands: EdgeBand[];
  /** This net's records inside the window, ascending (feeds valuesAt / cursor snap). */
  times: number[];
  values: bv.BusValue[];
}

export interface TraceView {
  tracks: Track[];
  glitches: GlitchMarker[];
  arrows: CauseArrow[];
  t0: number;
  t1: number;
}

export interface TraceViewOpts {
  t0?: number;
  t1?: number;
  /** Simulator clock. Records only exist where a net CHANGED, so without this
   *  the default window stops at the last transition and every trailing flat
   *  segment -- the newest state of the board -- is clipped off the right. */
  spanEnd?: number;
  /** Datasheet column enables band + glitch computation; omit in ideal mode. */
  column?: DatasheetColumn;
  glitchThresholdPs?: number;
  /** Pass-through suppression lookback (board critical-path t_pd); default 2x threshold. */
  glitchWindowPs?: number;
}

/** Board-order component scan; the owner-decided track source (Board.probes stays unused). */
export function trackList(board: Board, circuit: CompiledCircuit): TrackSpec[] {
  const specs: TrackSpec[] = [];
  // The names compile actually emitted, so a port whose label was already
  // taken (label sharing lets several terminals show one name) still resolves.
  const compiledPaths = componentPaths(board, 'main/');
  for (const comp of board.components) {
    if (TRACK_KINDS.has(comp.kind)) {
      // Path is keyed by comp.id, never comp.label -- label sharing lets
      // several components display the same name, but two different
      // components must never produce the same literal track path (see the
      // named-part branch below, which had this fix already).
      const path = `main/${comp.id}`;
      let net: number | undefined;
      if (comp.kind === 'inport' || comp.kind === 'outport') {
        // Ports compile to no primitive, only a label-aliased net --
        // board-wide label uniqueness (labelSync.ts) guarantees two In/Out
        // pins sharing a label share a net, so this lookup can't resolve to
        // the wrong net even though it's keyed by label, not id.
        const labelPath = compiledPaths.get(comp.id)!;
        net = circuit.pathToNet.get(`${labelPath}.${comp.kind === 'inport' ? 'y' : 'a'}`);
      } else {
        const pi = circuit.componentToPrimitive.get(path);
        if (pi !== undefined) {
          const p = circuit.primitives[pi]!;
          net = (p.outputs.length ? p.outputs : p.inputs)[0];
        }
      }
      if (net === undefined) continue;
      specs.push({
        path,
        label: comp.label || comp.id,
        kind: comp.kind,
        net,
        width: circuit.nets[net]!.width,
      });
      continue;
    }
    // Task 1d: gates/mux/demux/decoder/encoder and other primitive kinds are
    // listed ONLY when named -- the owner already has probes for scoping an
    // arbitrary wire/bus, so an unnamed part stays off this list by design.
    // One track per OUTPUT pin (a named decoder yields dec1.y0, dec1.y1, ...);
    // a single-output part's path/label is just the plain name. Chip
    // instances are not resolvable through the primitive registry (no
    // PrimitiveSpec for 'chip') and are not covered this session.
    if (!comp.label || !hasPrimitive(comp.kind)) continue;
    // componentToPrimitive, not pathToPrimitive: same-net label sharing
    // (labelSync.ts) lets a device inherit this component's own label, so
    // path-keyed lookup can resolve to the WRONG primitive (last-write-wins
    // on a colliding key) -- found live: naming a gate whose output already
    // drives a plain LED silently produced the LED's track under the gate's
    // path instead of the gate's own.
    const pi = circuit.componentToPrimitive.get(`main/${comp.id}`);
    if (pi === undefined) continue;
    const prim = circuit.primitives[pi]!;
    const outs = getPrimitive(comp.kind)
      .pins(comp.params ?? {})
      .filter((p) => p.dir === 'out');
    // Path is keyed by comp.id (always unique), NOT comp.label -- a track's
    // display label CAN legally collide with another component's (same-net
    // sharing), but two DIFFERENT components must never produce the same
    // literal track path (the exact "2 g1 waveforms" bug: an LED that
    // inherited a named gate's label would otherwise get the identical path
    // string as the gate's own track).
    const compPath = `main/${comp.id}`;
    outs.forEach((outPin, i) => {
      const net = prim.outputs[i];
      if (net === undefined) return;
      const multi = outs.length > 1;
      specs.push({
        path: multi ? `${compPath}.${outPin.name}` : compPath,
        label: multi ? `${comp.label}.${outPin.name}` : comp.label!,
        kind: comp.kind,
        net,
        width: circuit.nets[net]!.width,
      });
    });
  }
  return specs;
}

export function segmentLabel(value: bv.BusValue, width: number): { label: string; mixed: boolean } {
  if (width === 1) return { label: bv.toString(value, 1), mixed: false };
  if (value.x) return { label: 'X?', mixed: true };
  if (value.z) return { label: 'Z?', mixed: true };
  const digits = Math.ceil(width / 4);
  return { label: value.v.toString(16).toUpperCase().padStart(digits, '0'), mixed: false };
}

/** Latest record index with time <= t, or -1. */
function latestAt(times: number[], t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= t) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

function buildSegments(
  times: number[],
  values: bv.BusValue[],
  width: number,
  t0: number,
  t1: number,
): Segment[] {
  const segs: Segment[] = [];
  const startIdx = latestAt(times, t0);
  // Before the first surviving record (power-on, or ring-buffer eviction) the value is X.
  let cur = startIdx >= 0 ? values[startIdx]! : bv.allX(width);
  let curT = t0;
  for (let i = startIdx + 1; i < times.length; i++) {
    const t = times[i]!;
    if (t > t1) break;
    if (bv.equal(values[i]!, cur)) continue;
    if (t > curT) segs.push({ t0: curT, t1: t, value: cur, ...segmentLabel(cur, width) });
    cur = values[i]!;
    curT = t;
  }
  // Always emit the final run; a change exactly at t1 yields a zero-width
  // segment so its edge still gets a band and a cursor value.
  segs.push({ t0: curT, t1: Math.max(t1, curT), value: cur, ...segmentLabel(cur, width) });
  return segs;
}

/** Task 5: one width-1 Track per lane of a width>1 track, bit 0 first (the
 *  project's bit-0-topmost convention since the M6.6 pin-order flip). Path
 *  and label use the same `name[bit]` bracket form busPins.ts's lane
 *  expansion already uses for pin labels, kept stable across redraws so
 *  hiding/annotations/cursor readout (all path-keyed) still work on a
 *  derived row. `net` is unchanged, so glitch markers/cause arrows/driver
 *  lookups (all net-keyed) still resolve for an expanded row. Session-only
 *  view state -- the caller decides which rows are expanded, this just
 *  derives the rows. */
export function expandTrackByBit(track: Track): Track[] {
  if (track.width <= 1) return [track];
  const t0 = track.segments[0]?.t0 ?? 0;
  const t1 = track.segments[track.segments.length - 1]?.t1 ?? t0;
  const lanes: Track[] = [];
  for (let bit = 0; bit < track.width; bit++) {
    const values = track.values.map((v) => bv.slice(v, bit, 1));
    lanes.push({
      ...track,
      path: `${track.path}#${bit}`,
      label: `${track.label}[${bit}]`,
      width: 1,
      values,
      segments: buildSegments(track.times, values, 1, t0, t1),
    });
  }
  return lanes;
}

/**
 * Uncertainty band per value-change edge. The trace's `cause` is a net edge,
 * not a primitive, so the delay figure comes from the net's drivers.
 * SPEC: a multi-driver net takes the widest (max t_pd - t_cd) of its drivers.
 */
function buildBands(
  segments: Segment[],
  circuit: CompiledCircuit,
  net: number,
  column: DatasheetColumn,
): EdgeBand[] {
  const drivers = circuit.drivers[net] ?? [];
  if (!drivers.length) return [];
  let spread = 0;
  let estimated = false;
  for (const d of drivers) {
    const del = partDelayPs(circuit.primitives[d.prim]!.part, column);
    spread = Math.max(spread, del.tpdPs - del.tcdPs);
    estimated ||= del.estimated;
  }
  if (spread <= 0) return [];
  // Skip the window-start pseudo-edge (segments[0].t0 is the clip, not a change).
  return segments.slice(1).map((s) => ({ t: s.t0, earliest: s.t0 - spread, estimated }));
}

/** Kinds whose track is a signal source, not a circuit response. */
const INPUT_TRACK_KINDS = new Set(['clock', 'toggle', 'button', 'inport']);

/** True when this track's own primitive is one of the net's drivers (as
 *  opposed to merely observing it, like an LED or a same-net probe). */
function tracksOwnNetDriver(tr: Track, circuit: CompiledCircuit): boolean {
  const drivers = circuit.drivers[tr.net] ?? [];
  return drivers.some((d) => {
    const cid = circuit.primitives[d.prim]!.componentId;
    return tr.path === cid || tr.path.startsWith(`${cid}.`);
  });
}

/** Owner's rank, lowest (best) first: probe > In/Out boundary pin > the
 *  net's own driver > board order (ties within a tier keep the first one
 *  seen, i.e. board order, via the strict '<' in canonicalTrackForNet). */
function trackRank(tr: Track, circuit?: CompiledCircuit): number {
  if (tr.kind === 'probe') return 0;
  if (tr.kind === 'inport' || tr.kind === 'outport') return 1;
  if (circuit && tracksOwnNetDriver(tr, circuit)) return 2;
  return 3;
}

/** One track per net for markers and arrow endpoints: probe > port >
 *  the net's driver > board order. `circuit` is optional only so callers
 *  that never had it at hand (none left in this codebase) still compile;
 *  omitting it collapses tier 2 into tier 3 (driver rank indistinguishable
 *  from plain board order). */
export function canonicalTrackForNet(
  tracks: readonly Track[],
  circuit?: CompiledCircuit,
): Map<number, Track> {
  const byNet = new Map<number, Track>();
  for (const tr of tracks) {
    const cur = byNet.get(tr.net);
    if (!cur || trackRank(tr, circuit) < trackRank(cur, circuit)) byNet.set(tr.net, tr);
  }
  return byNet;
}

/** Sub-threshold runs strictly between two runs of one same other value. */
function scanPulses(segs: Segment[], thresholdPs: number): { t0: number; t1: number }[] {
  const out: { t0: number; t1: number }[] = [];
  for (let i = 1; i + 1 < segs.length; i++) {
    const s = segs[i]!;
    if (
      s.t1 - s.t0 < thresholdPs &&
      bv.equal(segs[i - 1]!.value, segs[i + 1]!.value) &&
      !bv.equal(s.value, segs[i - 1]!.value)
    )
      out.push({ t0: s.t0, t1: s.t1 });
  }
  return out;
}

export function buildTraceView(
  board: Board,
  circuit: CompiledCircuit,
  records: NetChangeRecord[],
  opts: TraceViewOpts = {},
): TraceView {
  const specs = trackList(board, circuit);
  const perNet = new Map<number, { times: number[]; values: bv.BusValue[] }>();
  for (const spec of specs)
    if (!perNet.has(spec.net)) perNet.set(spec.net, { times: [], values: [] });
  for (const r of records) {
    const bucket = perNet.get(r.net);
    if (bucket) {
      bucket.times.push(r.time);
      bucket.values.push(r.value);
    }
  }
  const lastRecord = records.length ? records[records.length - 1]!.time : 0;
  // The kernel's trace is a bounded ring buffer, so on a long free-run the
  // oldest records are gone. Starting at 0 would claim history the view
  // cannot draw; the first surviving record is where the data actually is.
  const firstRecord = records.length ? records[0]!.time : 0;
  const t0 = opts.t0 ?? firstRecord;
  const t1 = opts.t1 ?? Math.max(opts.spanEnd ?? 0, lastRecord, t0 + 1);

  const tracks: Track[] = specs.map((spec) => {
    const bucket = perNet.get(spec.net)!;
    const segments = buildSegments(bucket.times, bucket.values, spec.width, t0, t1);
    const bands = opts.column ? buildBands(segments, circuit, spec.net, opts.column) : [];
    return { ...spec, segments, bands, times: bucket.times, values: bucket.values };
  });

  // Glitch scan is datasheet-mode only; ideal-mode unit delays would flag everything.
  // SPEC: a glitch is a hazard -- a spurious pulse from reconvergent paths of unequal
  // delay, i.e. BOTH edges of the pulse stem from one single input transition. So
  // input-source tracks never flag, and a short pulse on a driven net is suppressed
  // when two or more input transitions fall in its lookback window: the pulse's rise
  // and fall are then separately input-driven (a fast toggle's pass-through, or an
  // AND briefly high between one switch rising and another falling), not a race.
  const canonical = canonicalTrackForNet(tracks, circuit);

  let glitches: GlitchMarker[] = [];
  if (opts.column) {
    const threshold = opts.glitchThresholdPs ?? DEFAULT_GLITCH_THRESHOLD_PS;
    const windowPs = opts.glitchWindowPs ?? 2 * threshold;
    // All input-track value-change times (segment boundaries; index 0 is the
    // window clip, not a change).
    const inputEdges = tracks
      .filter((tr) => INPUT_TRACK_KINDS.has(tr.kind))
      .flatMap((tr) => tr.segments.slice(1).map((s) => s.t0));
    // One marker per net: tracks sharing a net (led + probe) have identical
    // segments, so the scan runs once, hosted on the net's canonical track.
    glitches = [...canonical.values()]
      .filter((tr) => tr.width === 1 && !INPUT_TRACK_KINDS.has(tr.kind))
      .flatMap((tr) =>
        scanPulses(tr.segments, threshold)
          .filter((p) => inputEdges.filter((t) => t >= p.t0 - windowPs && t <= p.t1).length < 2)
          .map((p) => ({ trackPath: tr.path, t0: p.t0, t1: p.t1 })),
      );
  }

  // SPEC: per-hop arrows only (Fig 2.69) -- a hop through an untracked internal
  // net draws nothing rather than walking the chain transitively.
  const arrows: CauseArrow[] = [];
  for (const r of records) {
    if (r.time < t0 || r.time > t1 || r.cause.net < 0 || r.cause.time < t0) continue;
    const to = canonical.get(r.net);
    const from = canonical.get(r.cause.net);
    if (!to || !from || to.path === from.path) continue;
    arrows.push({ fromPath: from.path, fromT: r.cause.time, toPath: to.path, toT: r.time });
  }

  return { tracks, glitches, arrows, t0, t1 };
}

/** Path -> value at time t; the scrub-replay API. Pre-first-record reads X. */
export function valuesAt(view: TraceView, t: number): Map<string, bv.BusValue> {
  const out = new Map<string, bv.BusValue>();
  for (const tr of view.tracks) {
    const i = latestAt(tr.times, t);
    out.set(tr.path, i >= 0 ? tr.values[i]! : bv.allX(tr.width));
  }
  return out;
}

/** Per-net record index over the whole trace; feeds full-board replay coloring. */
export interface ReplayIndex {
  times: number[][];
  values: bv.BusValue[][];
  widths: number[];
}

export function buildReplayIndex(
  circuit: CompiledCircuit,
  records: NetChangeRecord[],
): ReplayIndex {
  const times: number[][] = circuit.nets.map(() => []);
  const values: bv.BusValue[][] = circuit.nets.map(() => []);
  for (const r of records) {
    times[r.net]!.push(r.time);
    values[r.net]!.push(r.value);
  }
  return { times, values, widths: circuit.nets.map((n) => n.width) };
}

/** One net's value at time t (per-pin replay coloring; O(log records)). */
export function replayNetValue(index: ReplayIndex, net: number, t: number): bv.BusValue {
  const times = index.times[net];
  if (!times) return bv.allX(1);
  const i = latestAt(times, t);
  return i >= 0 ? index.values[net]![i]! : bv.allX(index.widths[net]!);
}

/** Every net's value at time t; nets with no surviving record by t read X. */
export function netValuesAt(index: ReplayIndex, t: number): bv.BusValue[] {
  return index.times.map((times, net) => {
    const i = latestAt(times, t);
    return i >= 0 ? index.values[net]![i]! : bv.allX(index.widths[net]!);
  });
}

/** Distinct event times across tracks within the window, ascending (cursor stepping). */
export function eventTimes(view: TraceView): number[] {
  const set = new Set<number>();
  for (const tr of view.tracks)
    for (const t of tr.times) if (t >= view.t0 && t <= view.t1) set.add(t);
  return [...set].sort((a, b) => a - b);
}
