import { describe, expect, it } from 'vitest';
import { compile } from '../model/compile';
import type { ChipLibrary } from '../model/types';
import { board, comp, wire } from '../model/testFixtures';
import { NO_CAUSE, type NetChangeRecord } from '../sim/kernel';
import * as bv from '../value/busValue';
import {
  buildReplayIndex,
  buildTraceView,
  canonicalTrackForNet,
  eventTimes,
  expandTrackByBit,
  netValuesAt,
  segmentLabel,
  trackList,
  valuesAt,
} from './traceView';

const noLib: ChipLibrary = new Map();

// toggle -> nand -> led, plus a labeled probe on the nand output and a clock.
function fixture() {
  const b = board({
    components: [
      comp('sw', 'toggle'),
      comp('ck', 'clock'),
      comp('g1', 'nand'),
      comp('l1', 'led'),
      comp('p1', 'probe', undefined, 'Y'),
    ],
    wires: [
      wire('w1', ['sw', 'y'], ['g1', 'a']),
      wire('w2', ['sw', 'y'], ['g1', 'b']),
      wire('w3', ['g1', 'y'], ['l1', 'a']),
      wire('w4', ['g1', 'y'], ['p1', 'a']),
    ],
  });
  return { b, c: compile(b, noLib) };
}

function rec(
  time: number,
  net: number,
  value: bv.BusValue,
  cause: NetChangeRecord['cause'] = NO_CAUSE,
): NetChangeRecord {
  return { time, net, value, cause };
}

describe('trackList', () => {
  it('scans I/O devices, clocks, and probes in board order; gates excluded', () => {
    const { b, c } = fixture();
    const tracks = trackList(b, c);
    // Task 3: path is keyed by comp.id, never comp.label -- the probe's
    // label ('Y') shows in .label only.
    expect(tracks.map((t) => t.path)).toEqual(['main/sw', 'main/ck', 'main/l1', 'main/p1']);
    expect(tracks.map((t) => t.label)).toEqual(['sw', 'ck', 'l1', 'Y']);
    expect(tracks.map((t) => t.kind)).toEqual(['toggle', 'clock', 'led', 'probe']);
    // led and probe observe the same nand-output net.
    expect(tracks[2]!.net).toBe(tracks[3]!.net);
  });

  it('Task 1d: a named single-output part (a gate) gets one track under its own name', () => {
    const b = board({
      components: [comp('sw', 'toggle'), comp('g1', 'not', undefined, 'inv1')],
      wires: [wire('w1', ['sw', 'y'], ['g1', 'a'])],
    });
    const c = compile(b, noLib);
    const tracks = trackList(b, c);
    // Path is keyed by comp.id (main/g1), not the label -- label sharing
    // with another component must never collide two tracks onto one path
    // (see the live-QA repro test below).
    const gateTrack = tracks.find((t) => t.path === 'main/g1');
    expect(gateTrack).toBeDefined();
    expect(gateTrack!.label).toBe('inv1');
  });

  it('Task 1d: a named multi-output part (a decoder) gets one track per output pin', () => {
    const b = board({
      components: [comp('sw', 'toggle'), comp('d1', 'decoder', { addressBits: 1 }, 'dec1')],
      wires: [wire('w1', ['sw', 'y'], ['d1', 'a'])],
    });
    const c = compile(b, noLib);
    const tracks = trackList(b, c).filter((t) => t.path.startsWith('main/d1'));
    expect(tracks.map((t) => t.path).sort()).toEqual(['main/d1.y0', 'main/d1.y1']);
    expect(tracks.map((t) => t.label).sort()).toEqual(['dec1.y0', 'dec1.y1']);
  });

  // Live-QA repro: naming a gate whose output drives an LED that inherits
  // the SAME label (labelSync.ts's same-net sharing) used to silently
  // collide -- both components compile to the literal path `main/<label>`,
  // so `pathToPrimitive.get(path)` (last-write-wins) resolved to whichever
  // was compiled last, and the gate's own track either vanished (wrong
  // primitive had no outputs) or the two tracks landed on the identical
  // path string ("2 g1 waveforms", indistinguishable in the Signals list).
  // trackList now resolves via componentToPrimitive (unambiguous, keyed by
  // component id) and paths its own track by id, not label, so two
  // same-labeled components always get two DISTINCT, correctly-resolved
  // tracks.
  it('a gate and an LED sharing an inherited label get two tracks with distinct paths on the same net', () => {
    const b = board({
      components: [
        comp('sw', 'toggle'),
        comp('g1', 'not', undefined, 'shared'),
        comp('l1', 'led', undefined, 'shared'),
      ],
      wires: [wire('w1', ['sw', 'y'], ['g1', 'a']), wire('w2', ['g1', 'y'], ['l1', 'a'])],
    });
    const c = compile(b, noLib);
    const tracks = trackList(b, c).filter((t) => t.label === 'shared');
    expect(tracks).toHaveLength(2);
    expect(new Set(tracks.map((t) => t.path)).size).toBe(2);
    expect(tracks.map((t) => t.kind).sort()).toEqual(['led', 'not']);
    expect(tracks[0]!.net).toBe(tracks[1]!.net);
  });

  // Task 3 (owner's exact repro): a named gate driving an LED and an Out port,
  // all three sharing one inherited label -- the fix must not stop at two
  // terminals (bug class is "N terminals", not "3").
  it('a gate, an LED, and an Out port sharing one inherited label get 3 distinct paths on 1 net', () => {
    const b = board({
      components: [
        comp('sw', 'toggle'),
        comp('g1', 'not', undefined, 'shared'),
        comp('l1', 'led', undefined, 'shared'),
        comp('o1', 'outport', undefined, 'shared'),
      ],
      wires: [
        wire('w1', ['sw', 'y'], ['g1', 'a']),
        wire('w2', ['g1', 'y'], ['l1', 'a']),
        wire('w3', ['g1', 'y'], ['o1', 'a']),
      ],
    });
    const c = compile(b, noLib);
    const tracks = trackList(b, c).filter((t) => t.label === 'shared');
    expect(tracks).toHaveLength(3);
    expect(new Set(tracks.map((t) => t.path)).size).toBe(3);
    expect(new Set(tracks.map((t) => t.net)).size).toBe(1);
  });

  it('chaining a 4th same-labeled terminal still yields exactly 4 distinct paths on 1 net', () => {
    const b = board({
      components: [
        comp('sw', 'toggle'),
        comp('g1', 'not', undefined, 'shared'),
        comp('l1', 'led', undefined, 'shared'),
        comp('o1', 'outport', undefined, 'shared'),
        comp('p1', 'probe', undefined, 'shared'),
      ],
      wires: [
        wire('w1', ['sw', 'y'], ['g1', 'a']),
        wire('w2', ['g1', 'y'], ['l1', 'a']),
        wire('w3', ['g1', 'y'], ['o1', 'a']),
        wire('w4', ['g1', 'y'], ['p1', 'a']),
      ],
    });
    const c = compile(b, noLib);
    const tracks = trackList(b, c).filter((t) => t.label === 'shared');
    expect(tracks).toHaveLength(4);
    expect(new Set(tracks.map((t) => t.path)).size).toBe(4);
    expect(new Set(tracks.map((t) => t.net)).size).toBe(1);
  });

  // Task 1d follow-up: a named gate whose output drives a plain LED (or any
  // other TRACK_KINDS device) now produces two tracks on the SAME net --
  // canonicalTrackForNet is what WaveformPanel's default-visibility hook
  // uses to keep the Signals list from defaulting to two checked rows for
  // one signal.
  it('a named gate and the LED it drives share one net -- canonicalTrackForNet picks exactly one', () => {
    const b = board({
      components: [comp('sw', 'toggle'), comp('g1', 'not', undefined, 'inv1'), comp('l1', 'led')],
      wires: [wire('w1', ['sw', 'y'], ['g1', 'a']), wire('w2', ['g1', 'y'], ['l1', 'a'])],
    });
    const c = compile(b, noLib);
    const tracks = buildTraceView(b, c, []).tracks;
    const gateTrack = tracks.find((t) => t.path === 'main/g1')!;
    const ledTrack = tracks.find((t) => t.kind === 'led')!;
    expect(gateTrack.net).toBe(ledTrack.net);
    const canonical = canonicalTrackForNet(tracks);
    // Exactly one of the two is canonical for that shared net.
    expect([gateTrack, ledTrack]).toContainEqual(canonical.get(gateTrack.net));
    expect(canonical.get(gateTrack.net)).not.toBe(undefined);
  });
});

describe('canonicalTrackForNet (Task 4: probe > port > driver > board order)', () => {
  it('tier 1: a probe wins over any other kind sharing its net', () => {
    const b = board({
      components: [comp('sw', 'toggle'), comp('l1', 'led'), comp('p1', 'probe', undefined, 'Y')],
      wires: [wire('w1', ['sw', 'y'], ['l1', 'a']), wire('w2', ['sw', 'y'], ['p1', 'a'])],
    });
    const c = compile(b, noLib);
    const tracks = buildTraceView(b, c, []).tracks;
    const canonical = canonicalTrackForNet(tracks, c);
    const net = tracks.find((t) => t.path === 'main/l1')!.net;
    expect(canonical.get(net)!.kind).toBe('probe');
  });

  it('tier 2: with no probe, an Out port wins over the driving gate and an LED', () => {
    const b = board({
      components: [
        comp('sw', 'toggle'),
        comp('g1', 'not', undefined, 'inv1'),
        comp('l1', 'led'),
        comp('o1', 'outport', undefined, 'inv1'),
      ],
      wires: [
        wire('w1', ['sw', 'y'], ['g1', 'a']),
        wire('w2', ['g1', 'y'], ['l1', 'a']),
        wire('w3', ['g1', 'y'], ['o1', 'a']),
      ],
    });
    const c = compile(b, noLib);
    const tracks = buildTraceView(b, c, []).tracks;
    const canonical = canonicalTrackForNet(tracks, c);
    const net = tracks.find((t) => t.path === 'main/l1')!.net;
    expect(canonical.get(net)!.kind).toBe('outport');
  });

  it("tier 3: with no probe or Out port, the net's own driver wins over a plain LED", () => {
    const b = board({
      components: [comp('sw', 'toggle'), comp('g1', 'not', undefined, 'inv1'), comp('l1', 'led')],
      wires: [wire('w1', ['sw', 'y'], ['g1', 'a']), wire('w2', ['g1', 'y'], ['l1', 'a'])],
    });
    const c = compile(b, noLib);
    const tracks = buildTraceView(b, c, []).tracks;
    const canonical = canonicalTrackForNet(tracks, c);
    const net = tracks.find((t) => t.path === 'main/l1')!.net;
    expect(canonical.get(net)!.path).toBe('main/g1');
  });

  it('tier 4: with none of the above, board order decides (first-encountered wins)', () => {
    const b = board({
      components: [comp('sw', 'toggle'), comp('l1', 'led'), comp('l2', 'led')],
      wires: [wire('w1', ['sw', 'y'], ['l1', 'a']), wire('w2', ['sw', 'y'], ['l2', 'a'])],
    });
    const c = compile(b, noLib);
    const tracks = buildTraceView(b, c, []).tracks;
    const canonical = canonicalTrackForNet(tracks, c);
    const net = tracks.find((t) => t.path === 'main/l1')!.net;
    // sw itself drives this net (tier 3), so it's the actual canonical pick;
    // among the two LEDs (tier 4, neither drives the net) l1 is first in board order.
    expect(canonical.get(net)!.path).toBe('main/sw');
    const ledOnly = canonicalTrackForNet(
      tracks.filter((t) => t.kind === 'led'),
      c,
    );
    expect(ledOnly.get(net)!.path).toBe('main/l1');
  });

  it('remove the probe and the Out port wins; remove that too and the driver wins', () => {
    const b = board({
      components: [
        comp('sw', 'toggle'),
        comp('g1', 'not', undefined, 'inv1'),
        comp('o1', 'outport', undefined, 'inv1'),
        comp('p1', 'probe', undefined, 'inv1'),
      ],
      wires: [
        wire('w1', ['sw', 'y'], ['g1', 'a']),
        wire('w2', ['g1', 'y'], ['o1', 'a']),
        wire('w3', ['g1', 'y'], ['p1', 'a']),
      ],
    });
    const c = compile(b, noLib);
    const tracks = buildTraceView(b, c, []).tracks;
    const net = tracks.find((t) => t.path === 'main/g1')!.net;
    expect(canonicalTrackForNet(tracks, c).get(net)!.kind).toBe('probe');
    const noProbe = tracks.filter((t) => t.kind !== 'probe');
    expect(canonicalTrackForNet(noProbe, c).get(net)!.kind).toBe('outport');
    const noProbeNoOut = noProbe.filter((t) => t.kind !== 'outport');
    expect(canonicalTrackForNet(noProbeNoOut, c).get(net)!.path).toBe('main/g1');
  });
});

describe('expandTrackByBit (Task 5: per-bit chevron expansion)', () => {
  it('a width-1 track is returned unchanged (no chevron)', () => {
    const { b, c } = fixture();
    const net = trackList(b, c).find((t) => t.path === 'main/sw')!.net;
    const view = buildTraceView(b, c, [rec(0, net, bv.known(1, 1))]);
    const tr = view.tracks.find((t) => t.path === 'main/sw')!;
    expect(expandTrackByBit(tr)).toEqual([tr]);
  });

  it('splits a width>1 track into N width-1 lanes, bit 0 first, with bracket paths/labels', () => {
    const b = board({
      components: [comp('sw', 'toggle', { width: 4 })],
      wires: [],
    });
    const c = compile(b, noLib);
    const net = trackList(b, c).find((t) => t.path === 'main/sw')!.net;
    // 0b0101 -> bit0=1,bit1=0,bit2=1,bit3=0; 0b0010 -> bit0=0,bit1=1,bit2=0,bit3=0.
    const view = buildTraceView(
      b,
      c,
      [rec(0, net, bv.known(0b0101, 4)), rec(100, net, bv.known(0b0010, 4))],
      { t0: 0, t1: 200 },
    );
    const tr = view.tracks.find((t) => t.path === 'main/sw')!;
    const lanes = expandTrackByBit(tr);
    expect(lanes).toHaveLength(4);
    expect(lanes.map((l) => l.path)).toEqual(['main/sw#0', 'main/sw#1', 'main/sw#2', 'main/sw#3']);
    expect(lanes.map((l) => l.label)).toEqual(['sw[0]', 'sw[1]', 'sw[2]', 'sw[3]']);
    expect(lanes.every((l) => l.width === 1)).toBe(true);
    expect(lanes.every((l) => l.net === tr.net)).toBe(true);
    expect(lanes[0]!.segments.map((s) => s.label)).toEqual(['1', '0']);
    expect(lanes[1]!.segments.map((s) => s.label)).toEqual(['0', '1']);
    expect(lanes[2]!.segments.map((s) => s.label)).toEqual(['1', '0']);
    expect(lanes[3]!.segments.map((s) => s.label)).toEqual(['0']); // never changes -> one segment
  });
});

describe('segments', () => {
  it('builds runs with pre-first-record X and clips to the window', () => {
    const { b, c } = fixture();
    const net = trackList(b, c).find((t) => t.path === 'main/sw')!.net;
    const records = [rec(100, net, bv.known(0, 1)), rec(300, net, bv.known(1, 1))];
    const view = buildTraceView(b, c, records, { t0: 0, t1: 500 });
    const tr = view.tracks.find((t) => t.path === 'main/sw')!;
    expect(tr.segments.map((s) => [s.t0, s.t1, s.label])).toEqual([
      [0, 100, 'X'],
      [100, 300, '0'],
      [300, 500, '1'],
    ]);
  });

  it('treats a wrapped-away history as X before the first surviving record', () => {
    const { b, c } = fixture();
    const net = trackList(b, c)[0]!.net;
    // Ring buffer evicted everything before t=900.
    const view = buildTraceView(b, c, [rec(900, net, bv.known(1, 1))], { t0: 0, t1: 1000 });
    expect(view.tracks[0]!.segments[0]!.label).toBe('X');
  });

  // The trace records CHANGES, so a settled board's newest state lies between
  // the last record and the simulator clock. Ending the default window at the
  // last record clipped that trailing state off the right of the plot, which
  // is what made "Fit" look like it was missing the latest signals.
  it('default window runs out to the sim clock, not the last record', () => {
    const { b, c } = fixture();
    const net = trackList(b, c).find((t) => t.path === 'main/sw')!.net;
    const records = [rec(100, net, bv.known(0, 1)), rec(300, net, bv.known(1, 1))];
    expect(buildTraceView(b, c, records).t1).toBe(300);
    const view = buildTraceView(b, c, records, { spanEnd: 5000 });
    expect(view.t1).toBe(5000);
    const tr = view.tracks.find((t) => t.path === 'main/sw')!;
    // The final run reaches the right edge instead of stopping at t=300.
    expect(tr.segments[tr.segments.length - 1]).toMatchObject({ t0: 300, t1: 5000, label: '1' });
  });

  it('a sim clock behind the last record never shortens the window', () => {
    const { b, c } = fixture();
    const net = trackList(b, c).find((t) => t.path === 'main/sw')!.net;
    const records = [rec(100, net, bv.known(0, 1)), rec(400, net, bv.known(1, 1))];
    expect(buildTraceView(b, c, records, { spanEnd: 10 }).t1).toBe(400);
  });

  // Once the ring buffer has wrapped there is no data before the first
  // surviving record, so a window starting at 0 would claim history it cannot
  // draw and squash the real trace into the right-hand sliver of the plot.
  it('default window starts at the first surviving record, not zero', () => {
    const { b, c } = fixture();
    const net = trackList(b, c).find((t) => t.path === 'main/sw')!.net;
    const view = buildTraceView(b, c, [rec(9000, net, bv.known(1, 1))], { spanEnd: 9500 });
    expect(view.t0).toBe(9000);
    expect(view.t1).toBe(9500);
    // An explicit t0 still wins, so the zoom window is unaffected.
    expect(buildTraceView(b, c, [rec(9000, net, bv.known(1, 1))], { t0: 0 }).t0).toBe(0);
  });

  it('labels bus values as hex and X?/Z? when mixed', () => {
    expect(segmentLabel(bv.known(0xa3, 8), 8)).toEqual({ label: 'A3', mixed: false });
    expect(segmentLabel(bv.known(5, 8), 8).label).toBe('05');
    expect(segmentLabel({ v: 1, x: 2, z: 0 }, 8)).toEqual({ label: 'X?', mixed: true });
    expect(segmentLabel({ v: 1, x: 0, z: 4 }, 8)).toEqual({ label: 'Z?', mixed: true });
    expect(segmentLabel(bv.known(1, 1), 1).label).toBe('1');
  });
});

describe('valuesAt', () => {
  it('answers at exact record times and before the first record', () => {
    const { b, c } = fixture();
    const net = trackList(b, c)[0]!.net;
    const view = buildTraceView(b, c, [
      rec(100, net, bv.known(0, 1)),
      rec(300, net, bv.known(1, 1)),
    ]);
    expect(valuesAt(view, 50).get('main/sw')).toEqual(bv.allX(1));
    expect(valuesAt(view, 100).get('main/sw')).toEqual(bv.known(0, 1));
    expect(valuesAt(view, 299).get('main/sw')).toEqual(bv.known(0, 1));
    expect(valuesAt(view, 300).get('main/sw')).toEqual(bv.known(1, 1));
  });

  it('netValuesAt replays every net, not just tracks', () => {
    const { c } = fixture();
    const idx = buildReplayIndex(c, [rec(10, 0, bv.known(1, 1))]);
    const at5 = netValuesAt(idx, 5);
    const at10 = netValuesAt(idx, 10);
    expect(at5[0]).toEqual(bv.allX(1));
    expect(at10[0]).toEqual(bv.known(1, 1));
    expect(at10.length).toBe(c.nets.length);
  });
});

describe('glitch scan', () => {
  it('flags a short pulse between equal runs, datasheet mode only', () => {
    const { b, c } = fixture();
    const net = trackList(b, c).find((t) => t.path === 'main/p1')!.net;
    const records = [
      rec(0, net, bv.known(1, 1)),
      rec(100_000, net, bv.known(0, 1)), // 10 ns pulse
      rec(110_000, net, bv.known(1, 1)),
      rec(300_000, net, bv.known(0, 1)), // long, legitimate
      rec(400_000, net, bv.known(1, 1)),
    ];
    const ds = buildTraceView(b, c, records, { column: 'typ' });
    // led and probe share the glitchy net: ONE marker, hosted on the probe.
    expect(ds.glitches).toEqual([{ trackPath: 'main/p1', t0: 100_000, t1: 110_000 }]);
    expect(ds.tracks.filter((t) => t.net === net).length).toBe(2);
    const ideal = buildTraceView(b, c, records);
    expect(ideal.glitches).toEqual([]);
  });

  it('never flags input-source tracks', () => {
    const { b, c } = fixture();
    const swNet = trackList(b, c).find((t) => t.path === 'main/sw')!.net;
    const records = [
      rec(0, swNet, bv.known(0, 1)),
      rec(100_000, swNet, bv.known(1, 1)), // 5 ns pulse on the toggle itself
      rec(105_000, swNet, bv.known(0, 1)),
    ];
    expect(buildTraceView(b, c, records, { column: 'typ' }).glitches).toEqual([]);
  });

  it('suppresses a pass-through pulse (fast toggle) but keeps a true hazard', () => {
    const { b, c } = fixture();
    const tracks = trackList(b, c);
    const swNet = tracks.find((t) => t.path === 'main/sw')!.net;
    const yNet = tracks.find((t) => t.path === 'main/p1')!.net;
    // The toggle itself pulses 5 ns; the output echoes it 10 ns later: not a hazard.
    const passThrough = [
      rec(0, swNet, bv.known(0, 1)),
      rec(0, yNet, bv.known(1, 1)),
      rec(100_000, swNet, bv.known(1, 1)),
      rec(105_000, swNet, bv.known(0, 1)),
      rec(110_000, yNet, bv.known(0, 1)),
      rec(115_000, yNet, bv.known(1, 1)),
    ];
    expect(buildTraceView(b, c, passThrough, { column: 'typ' }).glitches).toEqual([]);
    // A single input edge with a short output pulse IS a hazard.
    const hazard = [
      rec(0, swNet, bv.known(0, 1)),
      rec(0, yNet, bv.known(1, 1)),
      rec(100_000, swNet, bv.known(1, 1)),
      rec(110_000, yNet, bv.known(0, 1)),
      rec(115_000, yNet, bv.known(1, 1)),
    ];
    const flagged = buildTraceView(b, c, hazard, { column: 'typ' }).glitches;
    expect(flagged.map((g) => g.trackPath)).toEqual(['main/p1']);
  });

  it('suppresses a pulse bracketed by edges on two different inputs (AND briefly high)', () => {
    const { b, c } = fixture();
    const tracks = trackList(b, c);
    const swNet = tracks.find((t) => t.path === 'main/sw')!.net;
    const ckNet = tracks.find((t) => t.path === 'main/ck')!.net;
    const yNet = tracks.find((t) => t.path === 'main/p1')!.net;
    // One input rises, the output follows high, the other input falls and the
    // output drops: each output edge is separately input-driven -- not a hazard.
    const records = [
      rec(0, swNet, bv.known(0, 1)),
      rec(0, ckNet, bv.known(1, 1)),
      rec(0, yNet, bv.known(0, 1)),
      rec(100_000, swNet, bv.known(1, 1)),
      rec(110_000, yNet, bv.known(1, 1)),
      rec(114_000, ckNet, bv.known(0, 1)),
      rec(124_000, yNet, bv.known(0, 1)),
      rec(500_000, yNet, bv.known(1, 1)), // later unrelated change ends the pulse's runs
    ];
    expect(buildTraceView(b, c, records, { column: 'typ' }).glitches).toEqual([]);
  });
});

describe('cause arrows', () => {
  it('emits per-hop arrows between visible tracks, probe canonical over led', () => {
    const { b, c } = fixture();
    const tracks = trackList(b, c);
    const swNet = tracks.find((t) => t.path === 'main/sw')!.net;
    const yNet = tracks.find((t) => t.path === 'main/p1')!.net;
    const records = [
      rec(0, swNet, bv.known(0, 1)),
      rec(0, yNet, bv.known(1, 1)),
      rec(100, swNet, bv.known(1, 1)), // user action: NO_CAUSE, no arrow in
      rec(110, yNet, bv.known(0, 1), { net: swNet, time: 100 }),
    ];
    const view = buildTraceView(b, c, records);
    // Target resolves to the net's canonical track (probe), never the led.
    expect(view.arrows).toEqual([{ fromPath: 'main/sw', fromT: 100, toPath: 'main/p1', toT: 110 }]);
  });

  it('skips hops from untracked nets and self-arrows', () => {
    const { b, c } = fixture();
    const tracks = trackList(b, c);
    const yNet = tracks.find((t) => t.path === 'main/p1')!.net;
    // Every fixture net happens to be tracked; a synthetic index stands in for
    // an internal net between two gates.
    const untracked = c.nets.length;
    const records = [
      rec(0, yNet, bv.known(0, 1)),
      rec(100, yNet, bv.known(1, 1), { net: untracked, time: 90 }),
      rec(200, yNet, bv.known(0, 1), { net: yNet, time: 200 }),
    ];
    expect(buildTraceView(b, c, records).arrows).toEqual([]);
  });
});

describe('bands', () => {
  it('computes earliest-change from the driver part figures', () => {
    const { b, c } = fixture();
    const net = trackList(b, c).find((t) => t.path === 'main/p1')!.net; // driven by 74LS00
    const records = [rec(0, net, bv.known(0, 1)), rec(50_000, net, bv.known(1, 1))];
    const view = buildTraceView(b, c, records, { column: 'typ' });
    const tr = view.tracks.find((t) => t.path === 'main/p1')!;
    // 74LS00 typ: t_pd max(9,10)=10 ns, t_cd min(3,4)=3 ns -> 7 ns eye.
    expect(tr.bands).toEqual([{ t: 50_000, earliest: 43_000, estimated: true }]);
    // Source-driven toggle track: toggle has no part -> fallback 10/3.5 ns eye.
    const sw = view.tracks.find((t) => t.path === 'main/sw')!;
    expect(sw.bands).toEqual([]);
  });

  it('eventTimes merges distinct times across tracks', () => {
    const { b, c } = fixture();
    const tracks = trackList(b, c);
    const swNet = tracks[0]!.net;
    const yNet = tracks.find((t) => t.path === 'main/p1')!.net;
    const view = buildTraceView(b, c, [
      rec(10, swNet, bv.known(1, 1)),
      rec(20, yNet, bv.known(0, 1)),
      rec(20, swNet, bv.known(0, 1)),
    ]);
    expect(eventTimes(view)).toEqual([10, 20]);
  });
});
