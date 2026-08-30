import { beforeEach, describe, expect, it } from 'vitest';
import { seedNextId, starterBoard, useCircuitStore, type ResolveWireEnd } from './circuitStore';
import type { Board, ChipDef, Point } from '../../core/model/types';
import { pushOutputBackward } from '../../core/gates/transform';
import { resolveComponentPins, symbolBounds } from '../../render/glyphs/symbol';
import type { Theme } from '../../render/theme';
import { makeTestTheme } from '../../render/theme.fixture';
import '../../render/glyphs/io'; // registers toggle/led/busdisplay geometry builders
import '../../render/glyphs/gates'; // registers gate geometry builders
import { collectPinTargets } from './pinTargets';
import type { RoutablePin } from './autoRoute';

// Real geometry-backed resolver, matching CircuitWorkbench.tsx's own
// resolveWireEnd exactly (component pin -> symbolBounds, junction -> pos,
// free/tap -> own point) -- Task 6's bug lives in pin-name resolution for an
// array's per-cell pins, which a component-id-only test stub can't catch.
const testTheme: Theme = makeTestTheme();
const geometryResolve: ResolveWireEnd = (end) => {
  const board = useCircuitStore.getState().board;
  if (end.kind === 'pin') {
    const comp = board.components.find((c) => c.id === end.component);
    if (!comp) return undefined;
    return symbolBounds(comp, testTheme).pins.get(end.pin);
  }
  if (end.kind === 'junction') return board.junctions.find((j) => j.id === end.junction)?.pos;
  return end.pos;
};

const reset = () => useCircuitStore.setState({ selection: new Set(), powered: false });

// Wires are electrically symmetric -- which literal field (a/b) a given
// component's pin lands on is an implementation detail (a fan-in-aware
// rewire has no single "ours" side to prefer), so tests resolve a wire's
// pin end for a given component orientation-agnostically instead of
// assuming it's always `w.a`.
const pinEndOf = (
  w: { a: { kind: string; component?: string; pin?: string }; b: typeof w.a },
  componentId: string,
): { kind: string; component?: string; pin?: string } | undefined =>
  w.a.kind === 'pin' && w.a.component === componentId
    ? w.a
    : w.b.kind === 'pin' && w.b.component === componentId
      ? w.b
      : undefined;
const otherEndOf = (
  w: { a: { kind: string; component?: string; pin?: string }; b: typeof w.a },
  componentId: string,
): { kind: string; component?: string; pin?: string } =>
  w.a.kind === 'pin' && w.a.component === componentId ? w.b : w.a;

describe('circuitStore power + pinSignal', () => {
  beforeEach(reset);

  it('powers on the starter board and resolves settled pin signals', () => {
    const s = useCircuitStore.getState();
    s.power();
    expect(useCircuitStore.getState().powered).toBe(true);
    expect(useCircuitStore.getState().error).toBeNull();
    // Fresh board powers on with every switch off: AND(0,0) = 0.
    expect(s.pinSignal('sw1', 'y')).toBe('0');
    expect(s.pinSignal('sw2', 'y')).toBe('0');
    expect(s.pinSignal('g1', 'y')).toBe('0');
    expect(s.pinSignal('led1', 'a')).toBe('0');
  });

  it('driving both switches propagates through the AND to the LED', () => {
    const s = useCircuitStore.getState();
    s.power();
    s.toggleInput('sw1');
    s.toggleInput('sw2'); // AND(1,1) = 1
    expect(s.pinSignal('g1', 'y')).toBe('1');
    expect(s.pinSignal('led1', 'a')).toBe('1');
  });

  it('toggling a switch while free-running does not fast-forward sim time', () => {
    // With a clock on the board, settle() never finds an empty queue while
    // running; toggleInput must not settle in that state (M6 live-QA fix).
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [...st.board.components, { id: 'ck9', kind: 'clock', pos: { x: 0, y: 0 } }],
      },
    }));
    const s = useCircuitStore.getState();
    s.power();
    s.toggleRun();
    const before = s.simTimePs();
    s.toggleInput('sw1');
    expect(s.simTimePs()).toBe(before);
    // The queued toggle wake takes effect through the normal pump loop.
    s.pump(20_000);
    expect(s.pinSignal('sw1', 'y')).toBe('1');
    s.toggleRun();
  });

  it('toggling individual bits of a pinView-expanded switch sets each independently', () => {
    // Regression: toggleInput read the switch's current value back off a
    // `y` net (pinNet + netValue) to XOR the clicked bit into it -- once
    // `y` is pinView-expanded into y0..y(w-1), no single `y` net exists,
    // pinNet silently returned undefined, and the read-back value defaulted
    // to 0 on every click. That made every click reset every other bit to 0
    // instead of flipping just the clicked one (owner: "can only turn on one
    // bit at a time"). Fixed by reading the switch's own kernel state
    // directly instead of round-tripping through a net that isn't there.
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [
          ...st.board.components,
          {
            id: 'sw9',
            kind: 'toggle',
            pos: { x: 0, y: 200 },
            params: { width: 2, pinView: 'y=expanded' },
          },
        ],
      },
    }));
    const s = useCircuitStore.getState();
    s.power();
    s.toggleInput('sw9', 0);
    expect(s.pinSignal('sw9', 'y0')).toBe('1');
    expect(s.pinSignal('sw9', 'y1')).toBe('0');
    s.toggleInput('sw9', 1);
    // Bit 0 must still be set -- this is exactly what broke before the fix.
    expect(s.pinSignal('sw9', 'y0')).toBe('1');
    expect(s.pinSignal('sw9', 'y1')).toBe('1');
  });

  it('junction tool no-ops on empty canvas, and splits the hit wire into a real connection', () => {
    const s = useCircuitStore.getState();
    // Straight horizontal wire from (0, 40) to (160, 40) via a stub resolver.
    const resolve: ResolveWireEnd = (end) =>
      end.kind === 'pin' && end.component === 'sw1' ? { x: 0, y: 40 } : { x: 160, y: 40 };
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        wires: [
          {
            id: 'wj',
            a: { kind: 'pin', component: 'sw1', pin: 'y' },
            b: { kind: 'pin', component: 'g1', pin: 'a' },
            points: [],
          },
        ],
        junctions: [],
      },
    }));
    s.addJunction({ x: 300, y: 300 }, 8, resolve as never);
    expect(useCircuitStore.getState().board.junctions).toHaveLength(0);
    expect(useCircuitStore.getState().board.wires).toHaveLength(1);

    s.addJunction({ x: 77, y: 44 }, 8, resolve as never);
    const board = useCircuitStore.getState().board;
    expect(board.junctions).toHaveLength(1);
    const jid = board.junctions[0]!.id;
    expect(board.junctions[0]!.pos).toEqual({ x: 80, y: 40 });
    // Original wire is gone; both halves now terminate at the junction.
    expect(board.wires).toHaveLength(2);
    expect(board.wires.find((w) => w.id === 'wj')).toBeUndefined();
    const half1 = board.wires.find(
      (w) => w.a.kind === 'pin' && w.a.component === 'sw1' && w.b.kind === 'junction',
    );
    const half2 = board.wires.find(
      (w) => w.b.kind === 'pin' && w.b.component === 'g1' && w.a.kind === 'junction',
    );
    expect(half1).toBeDefined();
    expect(half2).toBeDefined();
    expect((half1!.b as { junction: string }).junction).toBe(jid);
    expect((half2!.a as { junction: string }).junction).toBe(jid);

    // Clicking again right on the new junction is a no-op (already connected).
    s.addJunction({ x: 80, y: 40 }, 8, resolve as never);
    expect(useCircuitStore.getState().board.junctions).toHaveLength(1);
  });

  it('connectToJunction splits a hit wire and wires the new end into it, or falls back', () => {
    const s = useCircuitStore.getState();
    const resolve: ResolveWireEnd = (end) =>
      end.kind === 'pin' && end.component === 'sw1' ? { x: 0, y: 40 } : { x: 160, y: 40 };
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        wires: [
          {
            id: 'wj',
            a: { kind: 'pin', component: 'sw1', pin: 'y' },
            b: { kind: 'pin', component: 'g1', pin: 'a' },
            points: [],
          },
        ],
        junctions: [],
      },
    }));
    // led1's 'a' is an input pin -- a second consumer on sw1's net, not a
    // second driver (sw2's own output would be, and correctly rejects; see
    // the multi-driver describe block below).
    const connected = s.connectToJunction(
      { kind: 'pin', component: 'led1', pin: 'a' },
      { x: 77, y: 44 },
      8,
      resolve as never,
    );
    expect(connected).toBe('connected');
    const board = useCircuitStore.getState().board;
    expect(board.junctions).toHaveLength(1);
    expect(board.wires).toHaveLength(3); // two split halves + the new wire in
    const jid = board.junctions[0]!.id;
    const newWire = board.wires.find(
      (w) => w.a.kind === 'pin' && w.a.component === 'led1' && w.b.kind === 'junction',
    );
    expect(newWire).toBeDefined();
    expect((newWire!.b as { junction: string }).junction).toBe(jid);

    // Off the wire entirely: no connection made.
    const missed = s.connectToJunction(
      { kind: 'pin', component: 'led1', pin: 'a' },
      { x: 900, y: 900 },
      8,
      resolve as never,
    );
    expect(missed).toBe('miss');
  });

  it('connectToJunction onto an existing free wire end converts it, no zero-length stub', () => {
    const s = useCircuitStore.getState();
    const resolveFree: ResolveWireEnd = (end) => (end.kind === 'free' ? end.pos : undefined);
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        wires: [
          {
            id: 'wf',
            a: { kind: 'free', pos: { x: 0, y: 40 } },
            b: { kind: 'free', pos: { x: 160, y: 40 } },
            points: [],
          },
        ],
        junctions: [],
      },
    }));
    const connected = s.connectToJunction(
      { kind: 'pin', component: 'sw2', pin: 'y' },
      { x: 1, y: 40 }, // right at wf's free end 'a'
      8,
      resolveFree as never,
    );
    expect(connected).toBe('connected');
    const board = useCircuitStore.getState().board;
    expect(board.junctions).toHaveLength(1);
    const jid = board.junctions[0]!.id;
    // Original wire's 'a' end is converted in place -- still one original wire,
    // plus the new wire in, not three wires from a zero-length split.
    expect(board.wires).toHaveLength(2);
    const original = board.wires.find((w) => w.id === 'wf')!;
    expect(original.a).toEqual({ kind: 'junction', junction: jid });
    expect(original.b).toEqual({ kind: 'free', pos: { x: 160, y: 40 } });
    const newWire = board.wires.find((w) => w.id !== 'wf')!;
    expect(newWire.a).toEqual({ kind: 'pin', component: 'sw2', pin: 'y' });
    expect(newWire.b).toEqual({ kind: 'junction', junction: jid });
  });

  it('connectToTap pulls a sub-range tap off a wider bus, leaving the bus wire untouched', () => {
    const s = useCircuitStore.getState();
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [
          ...st.board.components,
          { id: 'c8', kind: 'constant', pos: { x: 0, y: 0 }, params: { width: 8, value: 0 } },
          { id: 'o8', kind: 'outport', pos: { x: 200, y: 0 }, params: { width: 8 } },
        ],
        wires: [
          ...st.board.wires,
          {
            id: 'wbus',
            a: { kind: 'pin', component: 'c8', pin: 'y' },
            b: { kind: 'pin', component: 'o8', pin: 'a' },
            points: [],
          },
        ],
        junctions: [],
      },
    }));
    const resolve: ResolveWireEnd = (end) => {
      if (end.kind === 'pin' && end.component === 'c8') return { x: 0, y: 0 };
      if (end.kind === 'pin' && end.component === 'o8') return { x: 200, y: 0 };
      return undefined;
    };
    // led1's 'a' pin is 1-bit; tapping onto the 8-bit bus should pull bit 0.
    const connected = s.connectToTap(
      { kind: 'pin', component: 'led1', pin: 'a' },
      { x: 100, y: 0 },
      8,
      resolve as never,
      1,
    );
    expect(connected).toBe('connected');
    const board = useCircuitStore.getState().board;
    expect(board.wires.filter((w) => w.id === 'wbus')).toHaveLength(1); // bus never split
    const tap = board.wires.find(
      (w) => w.a.kind === 'pin' && w.a.component === 'led1' && w.a.pin === 'a',
    );
    expect(tap).toBeDefined();
    expect(tap!.b).toMatchObject({ kind: 'tap', wire: 'wbus', range: { hi: 0, lo: 0 } });
  });

  it('connectToTap declines (returns miss) when the hit wire is not wider than the new pin', () => {
    const s = useCircuitStore.getState();
    const resolve: ResolveWireEnd = (end) =>
      end.kind === 'pin' && end.component === 'sw1' ? { x: 0, y: 40 } : { x: 160, y: 40 };
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        wires: [
          {
            id: 'w1b',
            a: { kind: 'pin', component: 'sw1', pin: 'y' },
            b: { kind: 'pin', component: 'g1', pin: 'a' },
            points: [],
          },
        ],
        junctions: [],
      },
    }));
    const connected = s.connectToTap(
      { kind: 'pin', component: 'sw2', pin: 'y' },
      { x: 77, y: 44 },
      8,
      resolve as never,
      1, // same width as the hit wire (1-bit switch) -- an ordinary junction, not a tap
    );
    expect(connected).toBe('miss');
    expect(useCircuitStore.getState().board.wires).toHaveLength(1); // untouched
  });

  it('deleteWithHeal wires the input source through to every fan-out consumer of a 1-in/1-out component', () => {
    const s = useCircuitStore.getState();
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [
          ...st.board.components.filter((c) => c.id !== 'g1'),
          { id: 'nt', kind: 'not', pos: { x: 200, y: 0 } },
          { id: 'led2', kind: 'led', pos: { x: 300, y: 40 } },
        ],
        wires: [
          {
            id: 'wIn',
            a: { kind: 'pin', component: 'sw1', pin: 'y' },
            b: { kind: 'pin', component: 'nt', pin: 'a' },
            points: [],
          },
          {
            id: 'wOut1',
            a: { kind: 'pin', component: 'nt', pin: 'y' },
            b: { kind: 'pin', component: 'led1', pin: 'a' },
            points: [],
          },
          {
            id: 'wOut2',
            a: { kind: 'pin', component: 'nt', pin: 'y' },
            b: { kind: 'pin', component: 'led2', pin: 'a' },
            points: [],
          },
        ],
      },
    }));
    s.deleteWithHeal(new Set(['nt']));
    const board = useCircuitStore.getState().board;
    expect(board.components.some((c) => c.id === 'nt')).toBe(false);
    const toLed1 = board.wires.find(
      (w) =>
        (w.a.kind === 'pin' &&
          w.a.component === 'sw1' &&
          w.b.kind === 'pin' &&
          w.b.component === 'led1') ||
        (w.b.kind === 'pin' &&
          w.b.component === 'sw1' &&
          w.a.kind === 'pin' &&
          w.a.component === 'led1'),
    );
    const toLed2 = board.wires.find(
      (w) =>
        (w.a.kind === 'pin' &&
          w.a.component === 'sw1' &&
          w.b.kind === 'pin' &&
          w.b.component === 'led2') ||
        (w.b.kind === 'pin' &&
          w.b.component === 'sw1' &&
          w.a.kind === 'pin' &&
          w.a.component === 'led2'),
    );
    expect(toLed1).toBeDefined();
    expect(toLed2).toBeDefined();
  });

  it('deleteWithHeal falls back to a normal delete for a non-1-in/1-out component', () => {
    const s = useCircuitStore.getState();
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [
          ...st.board.components.filter((c) => c.id !== 'g1'),
          { id: 'g1', kind: 'and', pos: { x: 176, y: 96 } },
        ],
      },
    }));
    const before = useCircuitStore.getState().board.components.length;
    s.deleteWithHeal(new Set(['g1'])); // 2-input AND gate: not healable
    expect(useCircuitStore.getState().board.components.length).toBe(before - 1);
    expect(useCircuitStore.getState().board.components.some((c) => c.id === 'g1')).toBe(false);
  });

  it('commitDuplicate remaps a slice fresh, offsets it in, and selects the copy (undoable)', () => {
    const s = useCircuitStore.getState();
    const before = useCircuitStore.getState().board;
    const slice = {
      components: [
        { id: 'sw1', kind: 'toggle' as const, pos: { x: 64, y: 72 }, params: { initial: false } },
        { id: 'g1', kind: 'and' as const, pos: { x: 176, y: 96 } },
      ],
      junctions: [],
      wires: [
        {
          id: 'w1',
          a: { kind: 'pin' as const, component: 'sw1', pin: 'y' },
          b: { kind: 'pin' as const, component: 'g1', pin: 'a' },
          points: [],
        },
      ],
    };
    s.commitDuplicate(slice, { x: 8, y: 8 });
    const board = useCircuitStore.getState().board;
    expect(board.components.length).toBe(before.components.length + 2);
    const newToggle = board.components.find(
      (c) => c.kind === 'toggle' && c.id !== 'sw1' && c.pos.x === 72 && c.pos.y === 80,
    );
    const newAnd = board.components.find(
      (c) => c.kind === 'and' && c.id !== 'g1' && c.pos.x === 184 && c.pos.y === 104,
    );
    expect(newToggle).toBeDefined();
    expect(newAnd).toBeDefined();
    const newWire = board.wires.find(
      (w) =>
        w.a.kind === 'pin' &&
        w.a.component === newToggle!.id &&
        w.b.kind === 'pin' &&
        w.b.component === newAnd!.id,
    );
    expect(newWire).toBeDefined();
    // Original untouched, new components selected.
    expect(board.components.some((c) => c.id === 'sw1')).toBe(true);
    expect(useCircuitStore.getState().selection).toEqual(new Set([newToggle!.id, newAnd!.id]));

    s.undo();
    expect(useCircuitStore.getState().board.components.length).toBe(before.components.length);

    // Empty slice is a no-op.
    s.commitDuplicate({ components: [], wires: [], junctions: [] }, { x: 8, y: 8 });
    expect(useCircuitStore.getState().board.components.length).toBe(before.components.length);
  });

  it('paste keeps a net label’s name verbatim while a port still auto-relabels', () => {
    const s = useCircuitStore.getState();
    const slice = {
      components: [
        { id: 'L9', kind: 'netlabel' as const, pos: { x: 0, y: 0 }, label: 'CLK' },
        { id: 'in9', kind: 'inport' as const, pos: { x: 0, y: 32 }, label: 'A' },
      ],
      junctions: [],
      wires: [],
    };
    s.commitDuplicate(slice, { x: 0, y: 0 });
    s.commitDuplicate(slice, { x: 0, y: 64 });
    const labels = useCircuitStore
      .getState()
      .board.components.filter((c) => c.kind === 'netlabel')
      .map((c) => c.label);
    // Repeating the name is how a label joins nets; auto-renaming it would
    // silently break the join the paste was for.
    expect(labels).toEqual(['CLK', 'CLK']);
    const ports = useCircuitStore
      .getState()
      .board.components.filter((c) => c.kind === 'inport')
      .map((c) => c.label);
    expect(new Set(ports).size).toBe(ports.length);
  });

  it('renameComponent lets two net labels share a name, but still blocks two devices', () => {
    const s = useCircuitStore.getState();
    s.commitDuplicate(
      {
        components: [
          { id: 'L1', kind: 'netlabel' as const, pos: { x: 0, y: 0 } },
          { id: 'L2', kind: 'netlabel' as const, pos: { x: 0, y: 32 } },
        ],
        junctions: [],
        wires: [],
      },
      { x: 0, y: 0 },
    );
    const ids = [...useCircuitStore.getState().selection];
    expect(s.renameComponent(ids[0]!, 'CLK')).toBe(true);
    expect(s.renameComponent(ids[1]!, 'CLK')).toBe(true);
    // Both renames stuck: the second was not silently rejected as a duplicate.
    const byId = new Map(useCircuitStore.getState().board.components.map((c) => [c.id, c]));
    expect(byId.get(ids[0]!)?.label).toBe('CLK');
    expect(byId.get(ids[1]!)?.label).toBe('CLK');
  });

  it('moveSelectionDetached moves the component but cuts touched wires to free ends', () => {
    const s = useCircuitStore.getState();
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        wires: [
          {
            id: 'w1',
            a: { kind: 'pin', component: 'sw1', pin: 'y' },
            b: { kind: 'pin', component: 'g1', pin: 'a' },
            points: [],
          },
        ],
      },
      selection: new Set(['sw1']),
    }));
    s.moveSelectionDetached(16, 0, [{ wireId: 'w1', end: 'a', pos: { x: 64, y: 72 } }]);
    const board = useCircuitStore.getState().board;
    const sw1 = board.components.find((c) => c.id === 'sw1')!;
    expect(sw1.pos).toEqual({ x: 80, y: 72 }); // moved
    const w1 = board.wires.find((w) => w.id === 'w1')!;
    expect(w1.a).toEqual({ kind: 'free', pos: { x: 64, y: 72 } }); // cut at old pin position
    expect(w1.b).toEqual({ kind: 'pin', component: 'g1', pin: 'a' }); // untouched end

    s.undo();
    const restored = useCircuitStore.getState().board;
    expect(restored.components.find((c) => c.id === 'sw1')!.pos).toEqual({ x: 64, y: 72 });
    expect(restored.wires.find((w) => w.id === 'w1')!.a).toEqual({
      kind: 'pin',
      component: 'sw1',
      pin: 'y',
    });
  });

  it('insertOnWire splices a 1-in/1-out primitive into the hit wire in one undo step', () => {
    const s = useCircuitStore.getState();
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        wires: [
          {
            id: 'w1',
            a: { kind: 'pin', component: 'sw1', pin: 'y' },
            b: { kind: 'pin', component: 'g1', pin: 'a' },
            points: [],
          },
        ],
        junctions: [],
      },
    }));
    const before = useCircuitStore.getState().board;
    const wireId = 'w1';
    s.insertOnWire({
      kind: 'not',
      wireId,
      pos: { x: 100, y: 72 },
      grid: 8,
      inName: 'a',
      outName: 'y',
      upstreamEnd: { kind: 'pin', component: 'sw1', pin: 'y' },
      downstreamEnd: { kind: 'pin', component: 'g1', pin: 'a' },
    });
    const board = useCircuitStore.getState().board;
    expect(board.wires.find((w) => w.id === wireId)).toBeUndefined();
    const notComp = board.components.find((c) => c.kind === 'not');
    expect(notComp).toBeDefined();
    const wIn = board.wires.find(
      (w) =>
        w.a.kind === 'pin' &&
        w.a.component === 'sw1' &&
        w.b.kind === 'pin' &&
        w.b.component === notComp!.id,
    );
    const wOut = board.wires.find(
      (w) =>
        w.a.kind === 'pin' &&
        w.a.component === notComp!.id &&
        w.b.kind === 'pin' &&
        w.b.component === 'g1',
    );
    expect(wIn).toBeDefined();
    expect(wOut).toBeDefined();

    s.undo();
    const restored = useCircuitStore.getState().board;
    expect(restored.wires.find((w) => w.id === wireId)).toBeDefined();
    expect(restored.components.some((c) => c.kind === 'not')).toBe(false);
    expect(restored.wires.length).toBe(before.wires.length);
  });

  it('deleteWires (wire-cut) removes whole wires in one undo step, no-ops on an empty set', () => {
    const s = useCircuitStore.getState();
    const before = useCircuitStore.getState().board.wires;
    s.deleteWires(new Set());
    expect(useCircuitStore.getState().board.wires).toBe(before); // no history entry pushed

    const wireIds = new Set(before.map((w) => w.id));
    s.deleteWires(wireIds);
    expect(useCircuitStore.getState().board.wires).toHaveLength(0);
    s.undo();
    expect(useCircuitStore.getState().board.wires).toHaveLength(before.length);
  });

  it('addWires (smart-connect commit) adds every pair in one undo step, no-ops on empty', () => {
    const s = useCircuitStore.getState();
    const before = useCircuitStore.getState().board.wires;
    s.addWires([]);
    expect(useCircuitStore.getState().board.wires).toBe(before); // no history entry pushed

    s.addWires([
      {
        a: { kind: 'pin', component: 'sw1', pin: 'y' },
        b: { kind: 'pin', component: 'g1', pin: 'a' },
      },
      {
        a: { kind: 'pin', component: 'sw2', pin: 'y' },
        b: { kind: 'pin', component: 'g1', pin: 'b' },
      },
    ]);
    expect(useCircuitStore.getState().board.wires.length).toBe(before.length + 2);
    s.undo();
    expect(useCircuitStore.getState().board.wires.length).toBe(before.length);
  });

  it('gate input count adjusts 2-8 and shrink drops wires to removed pins in one undo', () => {
    const s = useCircuitStore.getState();
    s.place('and', { x: 400, y: 200 }, 8);
    const gid = useCircuitStore
      .getState()
      .board.components.find((c) => c.pos.x === 400 && c.pos.y === 200)!.id;
    s.setGateInputs(gid, 1); // 2 -> 3
    const comp = () => useCircuitStore.getState().board.components.find((c) => c.id === gid)!;
    expect(comp().params?.['inputs']).toBe(3);
    // Wire something to the third input, then shrink.
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        wires: [
          ...st.board.wires,
          {
            id: 'wc',
            a: { kind: 'pin', component: 'sw1', pin: 'y' },
            b: { kind: 'pin', component: gid, pin: 'c' },
            points: [],
          },
        ],
      },
    }));
    const wiresBefore = useCircuitStore.getState().board.wires.length;
    s.setGateInputs(gid, -1); // 3 -> 2, drops the wire to 'c'
    expect(comp().params?.['inputs']).toBe(2);
    expect(useCircuitStore.getState().board.wires.length).toBe(wiresBefore - 1);
    s.undo(); // single step restores both the arity and the wire
    expect(comp().params?.['inputs']).toBe(3);
    expect(useCircuitStore.getState().board.wires.length).toBe(wiresBefore);
    s.setGateInputs(gid, 1);
    s.setGateInputs(gid, 1);
    s.setGateInputs(gid, 1);
    s.setGateInputs(gid, 1);
    s.setGateInputs(gid, 1); // 3 -> 8, then clamped (M6.5: cap raised 4 -> 8)
    expect(comp().params?.['inputs']).toBe(8);
  });

  it('setGateInputCount jumps to an absolute value, clamps, and drops removed-pin wires in one undo', () => {
    const s = useCircuitStore.getState();
    s.place('and', { x: 424, y: 224 }, 8);
    const gid = useCircuitStore
      .getState()
      .board.components.find((c) => c.pos.x === 424 && c.pos.y === 224)!.id;
    const comp = () => useCircuitStore.getState().board.components.find((c) => c.id === gid)!;

    s.setGateInputCount(gid, 6);
    expect(comp().params?.['inputs']).toBe(6);

    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        wires: [
          ...st.board.wires,
          {
            id: 'wf',
            a: { kind: 'pin', component: 'sw1', pin: 'y' },
            b: { kind: 'pin', component: gid, pin: 'f' },
            points: [],
          },
        ],
      },
    }));
    const wiresBefore = useCircuitStore.getState().board.wires.length;
    s.setGateInputCount(gid, 2); // drops the wire to 'f'
    expect(comp().params?.['inputs']).toBe(2);
    expect(useCircuitStore.getState().board.wires.length).toBe(wiresBefore - 1);
    s.undo();
    expect(comp().params?.['inputs']).toBe(6);
    expect(useCircuitStore.getState().board.wires.length).toBe(wiresBefore);

    s.setGateInputCount(gid, 99); // clamps to 8
    expect(comp().params?.['inputs']).toBe(8);
    s.setGateInputCount(gid, -5); // clamps to 2
    expect(comp().params?.['inputs']).toBe(2);
  });

  it('stepDiscreteInputs steps mux/encoder through {2,4,8,16} and drops wires on shrink', () => {
    const s = useCircuitStore.getState();
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [
          ...st.board.components,
          { id: 'mx', kind: 'mux', pos: { x: 500, y: 0 }, params: { selectBits: 2 } },
        ],
        wires: [
          ...st.board.wires,
          {
            id: 'wd3',
            a: { kind: 'pin', component: 'sw1', pin: 'y' },
            b: { kind: 'pin', component: 'mx', pin: 'd3' },
            points: [],
          },
        ],
      },
    }));
    const mx = () => useCircuitStore.getState().board.components.find((c) => c.id === 'mx')!;
    const wireCount = () => useCircuitStore.getState().board.wires.length;
    const before = wireCount();

    s.stepBitsParam('mx', 1); // selectBits 2 -> 3 (4 -> 8 data lines), pure growth, no wires touched
    expect(mx().params?.['selectBits']).toBe(3);
    expect(wireCount()).toBe(before);

    s.stepBitsParam('mx', -1); // 3 -> 2 (8 -> 4 lines), no-op for d3 (still exists at 4)
    expect(mx().params?.['selectBits']).toBe(2);
    expect(wireCount()).toBe(before);

    s.stepBitsParam('mx', -1); // 2 -> 1 (4 -> 2 lines): drops d3 and the wire to it
    expect(mx().params?.['selectBits']).toBe(1);
    expect(wireCount()).toBe(before - 1);
    s.undo();
    expect(mx().params?.['selectBits']).toBe(2);
    expect(wireCount()).toBe(before);
  });

  it('setBitsParam clamps to 1..4', () => {
    const s = useCircuitStore.getState();
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [
          ...st.board.components,
          { id: 'en1', kind: 'encoder', pos: { x: 520, y: 0 }, params: { addressBits: 2 } },
        ],
      },
    }));
    const en = () => useCircuitStore.getState().board.components.find((c) => c.id === 'en1')!;
    s.setBitsParam('en1', 5); // clamps at 4
    expect(en().params?.['addressBits']).toBe(4);
    s.setBitsParam('en1', 0); // clamps at 1
    expect(en().params?.['addressBits']).toBe(1);
  });

  it('stepBitsParam steps a decoder 1..4', () => {
    const s = useCircuitStore.getState();
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [
          ...st.board.components,
          { id: 'dc1', kind: 'decoder', pos: { x: 540, y: 0 }, params: { addressBits: 2 } },
        ],
      },
    }));
    const dc = () => useCircuitStore.getState().board.components.find((c) => c.id === 'dc1')!;
    s.stepBitsParam('dc1', 1);
    expect(dc().params?.['addressBits']).toBe(3);
    s.stepBitsParam('dc1', 1);
    s.stepBitsParam('dc1', 1); // clamps at 4
    expect(dc().params?.['addressBits']).toBe(4);
    for (let i = 0; i < 5; i++) s.stepBitsParam('dc1', -1); // clamps at 1
    expect(dc().params?.['addressBits']).toBe(1);
  });

  it('stepToggleWidth steps 1..MAX_WIDTH', () => {
    const s = useCircuitStore.getState();
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [
          ...st.board.components,
          { id: 'tg1', kind: 'toggle', pos: { x: 560, y: 0 }, params: { width: 1 } },
        ],
      },
    }));
    const tg = () => useCircuitStore.getState().board.components.find((c) => c.id === 'tg1')!;
    s.stepToggleWidth('tg1', 1);
    expect(tg().params?.['width']).toBe(2);
    for (let i = 0; i < 5; i++) s.stepToggleWidth('tg1', -1); // clamps at 1
    expect(tg().params?.['width']).toBe(1);
  });

  it('placing then undoing leaves the board unchanged', () => {
    const s = useCircuitStore.getState();
    const before = useCircuitStore.getState().board.components.length;
    s.place('not', { x: 400, y: 400 }, 8);
    expect(useCircuitStore.getState().board.components.length).toBe(before + 1);
    s.undo();
    expect(useCircuitStore.getState().board.components.length).toBe(before);
  });
});

function bufDef(id: string): ChipDef {
  return {
    format: 'lcir.chip',
    formatVersion: 3,
    id,
    name: id,
    version: 1,
    components: [
      { id: 'in1', kind: 'inport', pos: { x: 0, y: 0 }, label: 'a' },
      { id: 'g1', kind: 'buf', pos: { x: 40, y: 0 } },
      { id: 'out1', kind: 'outport', pos: { x: 80, y: 0 }, label: 'y' },
    ],
    wires: [
      {
        id: 'w1',
        a: { kind: 'pin', component: 'in1', pin: 'y' },
        b: { kind: 'pin', component: 'g1', pin: 'a' },
        points: [],
      },
      {
        id: 'w2',
        a: { kind: 'pin', component: 'g1', pin: 'y' },
        b: { kind: 'pin', component: 'out1', pin: 'a' },
        points: [],
      },
    ],
    junctions: [],
    pins: [
      {
        id: 'pin-a',
        name: 'a',
        dir: 'in',
        width: 1,
        role: 'data',
        order: 0,
        boundComponent: 'in1',
      },
      {
        id: 'pin-y',
        name: 'y',
        dir: 'out',
        width: 1,
        role: 'data',
        order: 0,
        boundComponent: 'out1',
      },
    ],
  };
}

function emptyBoard(): Board {
  return {
    format: 'lcir.board',
    formatVersion: 5,
    id: 'test',
    name: 'test',
    components: [],
    wires: [],
    junctions: [],
    probes: [],
    view: { x: 0, y: 0, zoom: 1 },
    timing: { mode: 'ideal', datasheet: 'typ' },
  };
}

describe('circuitStore packaging + tabs', () => {
  beforeEach(() =>
    useCircuitStore.setState({
      board: emptyBoard(),
      chipLib: new Map(),
      tabs: [{ id: 'board', kind: 'board' }],
      activeTabId: 'board',
      staleInstances: new Set(),
      selection: new Set(),
      powered: false,
    }),
  );

  it('commitNewChip makes a def instantiable and simulatable', () => {
    const s = useCircuitStore.getState();
    expect(s.commitNewChip(bufDef('buf1'))).toEqual({ ok: true });
    s.place('toggle', { x: 0, y: 0 }, 8);
    s.place('chip', { x: 100, y: 0 }, 8, undefined, undefined, 'buf1');
    const sw = useCircuitStore.getState().board.components.find((c) => c.kind === 'toggle')!;
    const inst = useCircuitStore.getState().board.components.find((c) => c.kind === 'chip')!;
    s.addWire(
      { kind: 'pin', component: sw.id, pin: 'y' },
      { kind: 'pin', component: inst.id, pin: 'a' },
    );
    s.power();
    expect(useCircuitStore.getState().error).toBeNull();
    s.toggleInput(sw.id);
    expect(s.pinSignal(inst.id, 'y')).toBe('1');
  });

  it('commitNewChip rejects a self-referencing def', () => {
    const selfRef: ChipDef = {
      ...bufDef('loopy'),
      components: [{ id: 'u1', kind: 'chip', defId: 'loopy', pos: { x: 0, y: 0 } }],
    };
    const result = useCircuitStore.getState().commitNewChip(selfRef);
    expect(result.ok).toBe(false);
  });

  it('open-internals edits the def and detaches instance wires when a pin is removed', () => {
    const s = useCircuitStore.getState();
    s.commitNewChip(bufDef('buf1'));
    s.place('toggle', { x: 0, y: 0 }, 8);
    s.place('chip', { x: 100, y: 0 }, 8, undefined, undefined, 'buf1');
    const sw = useCircuitStore.getState().board.components.find((c) => c.kind === 'toggle')!;
    const inst = useCircuitStore.getState().board.components.find((c) => c.kind === 'chip')!;
    s.addWire(
      { kind: 'pin', component: sw.id, pin: 'y' },
      { kind: 'pin', component: inst.id, pin: 'a' },
    );

    s.openDefTab('buf1', `main/${inst.id}:buf1/`, 'test-board ▸ buf1');
    expect(useCircuitStore.getState().activeCircuit().components).toHaveLength(3);

    s.deleteSelection(new Set(['in1'])); // drops the 'a' boundary pin
    const after = useCircuitStore.getState();
    expect(after.chipLib.get('buf1')!.pins.map((p) => p.name)).toEqual(['y']);
    const wireToInst = after.board.wires.find((w) => w.b.kind === 'free' || w.a.kind === 'free');
    expect(wireToInst).toBeDefined();
    expect(after.staleInstances.has(inst.id)).toBe(true);

    // Rewiring the instance clears its re-bind badge. Only 'y' (an output)
    // remains on the def after dropping 'a' -- a consumer (led), not another
    // driver like the switch, is the only legal thing to attach to it.
    s.setActiveTab('board');
    s.place('led', { x: 200, y: 100 }, 8);
    const led = useCircuitStore.getState().board.components.find((c) => c.kind === 'led')!;
    s.addWire(
      { kind: 'pin', component: inst.id, pin: 'y' },
      { kind: 'pin', component: led.id, pin: 'a' },
    );
    expect(useCircuitStore.getState().staleInstances.has(inst.id)).toBe(false);
  });

  it('renaming an In label inside a def tab propagates to the placed instance and its board wire', () => {
    const s = useCircuitStore.getState();
    s.commitNewChip(bufDef('buf1'));
    s.place('toggle', { x: 0, y: 0 }, 8);
    s.place('chip', { x: 100, y: 0 }, 8, undefined, undefined, 'buf1');
    const sw = useCircuitStore.getState().board.components.find((c) => c.kind === 'toggle')!;
    const inst = useCircuitStore.getState().board.components.find((c) => c.kind === 'chip')!;
    s.addWire(
      { kind: 'pin', component: sw.id, pin: 'y' },
      { kind: 'pin', component: inst.id, pin: 'a' },
    );

    s.openDefTab('buf1', `main/${inst.id}:buf1/`, 'test-board ▸ buf1');
    const ok = useCircuitStore.getState().renameComponent('in1', 'sel');
    expect(ok).toBe(true);

    const after = useCircuitStore.getState();
    expect(after.chipLib.get('buf1')!.pins.map((p) => p.name)).toEqual(['sel', 'y']);
    // The board wire that was bound to the old pin name 'a' now follows the
    // rename to 'sel' instead of dangling/breaking.
    const w = after.board.wires.find((x) => x.a.kind === 'pin' && x.a.component === sw.id);
    expect(w!.b).toEqual({ kind: 'pin', component: inst.id, pin: 'sel' });
    expect(after.staleInstances.has(inst.id)).toBe(false);
  });

  it('closing a def tab returns to the board and its own undo stack is separate', () => {
    const s = useCircuitStore.getState();
    s.commitNewChip(bufDef('buf1'));
    s.place('chip', { x: 100, y: 0 }, 8, undefined, undefined, 'buf1');
    const inst = useCircuitStore.getState().board.components.find((c) => c.kind === 'chip')!;

    s.openDefTab('buf1', `main/${inst.id}:buf1/`, 'test-board ▸ buf1');
    s.place('not', { x: 200, y: 0 }, 8);
    expect(useCircuitStore.getState().activeCircuit().components).toHaveLength(4);
    s.undo();
    expect(useCircuitStore.getState().activeCircuit().components).toHaveLength(3);

    // The board's own history is untouched by the def tab's undo.
    const boardComponentsBefore = useCircuitStore.getState().board.components.length;
    s.closeTab(useCircuitStore.getState().activeTabId);
    expect(useCircuitStore.getState().activeTabId).toBe('board');
    expect(useCircuitStore.getState().board.components.length).toBe(boardComponentsBefore);
  });

  it('closing an untouched def tab never prompts', () => {
    const s = useCircuitStore.getState();
    s.commitNewChip(bufDef('buf1'));
    s.place('chip', { x: 100, y: 0 }, 8, undefined, undefined, 'buf1');
    const inst = useCircuitStore.getState().board.components.find((c) => c.kind === 'chip')!;
    s.openDefTab('buf1', `main/${inst.id}:buf1/`, 'test-board ▸ buf1');
    const tabId = useCircuitStore.getState().activeTabId;
    s.closeTab(tabId);
    expect(useCircuitStore.getState().pendingTabClose).toBeNull();
    expect(useCircuitStore.getState().activeTabId).toBe('board');
    expect(useCircuitStore.getState().tabs.some((t) => t.id === tabId)).toBe(false);
  });

  it('closing a dirty def tab prompts instead of closing; Cancel keeps the tab and its undo stack', () => {
    const s = useCircuitStore.getState();
    s.commitNewChip(bufDef('buf1'));
    s.place('chip', { x: 100, y: 0 }, 8, undefined, undefined, 'buf1');
    const inst = useCircuitStore.getState().board.components.find((c) => c.kind === 'chip')!;
    s.openDefTab('buf1', `main/${inst.id}:buf1/`, 'test-board ▸ buf1');
    s.place('not', { x: 200, y: 0 }, 8);
    const tabId = useCircuitStore.getState().activeTabId;

    s.closeTab(tabId);
    expect(useCircuitStore.getState().pendingTabClose).toBe(tabId);
    expect(useCircuitStore.getState().tabs.some((t) => t.id === tabId)).toBe(true);
    expect(useCircuitStore.getState().activeCircuit().components).toHaveLength(4);

    s.cancelTabClose();
    expect(useCircuitStore.getState().pendingTabClose).toBeNull();
    expect(useCircuitStore.getState().tabs.some((t) => t.id === tabId)).toBe(true);
    // The undo stack survived -- undo still reverts the placed 'not'.
    s.undo();
    expect(useCircuitStore.getState().activeCircuit().components).toHaveLength(3);
  });

  it('Save closes a dirty def tab, keeping its edits live in chipLib', () => {
    const s = useCircuitStore.getState();
    s.commitNewChip(bufDef('buf1'));
    s.place('chip', { x: 100, y: 0 }, 8, undefined, undefined, 'buf1');
    const inst = useCircuitStore.getState().board.components.find((c) => c.kind === 'chip')!;
    s.openDefTab('buf1', `main/${inst.id}:buf1/`, 'test-board ▸ buf1');
    s.place('not', { x: 200, y: 0 }, 8);
    const tabId = useCircuitStore.getState().activeTabId;

    s.closeTab(tabId);
    s.resolveTabClose('save');
    expect(useCircuitStore.getState().pendingTabClose).toBeNull();
    expect(useCircuitStore.getState().tabs.some((t) => t.id === tabId)).toBe(false);
    expect(useCircuitStore.getState().activeTabId).toBe('board');
    expect(useCircuitStore.getState().chipLib.get('buf1')!.components).toHaveLength(4);
  });

  it('Discard restores the def to its baseline and reverts the placed instance', () => {
    const s = useCircuitStore.getState();
    s.commitNewChip(bufDef('buf1'));
    s.place('toggle', { x: 0, y: 0 }, 8);
    s.place('chip', { x: 100, y: 0 }, 8, undefined, undefined, 'buf1');
    const sw = useCircuitStore.getState().board.components.find((c) => c.kind === 'toggle')!;
    const inst = useCircuitStore.getState().board.components.find((c) => c.kind === 'chip')!;
    s.addWire(
      { kind: 'pin', component: sw.id, pin: 'y' },
      { kind: 'pin', component: inst.id, pin: 'a' },
    );

    s.openDefTab('buf1', `main/${inst.id}:buf1/`, 'test-board ▸ buf1');
    s.renameComponent('in1', 'sel'); // renames the def's boundary pin
    expect(
      useCircuitStore
        .getState()
        .chipLib.get('buf1')!
        .pins.map((p) => p.name),
    ).toEqual(['sel', 'y']);
    const tabId = useCircuitStore.getState().activeTabId;

    s.closeTab(tabId);
    s.resolveTabClose('discard');
    expect(useCircuitStore.getState().pendingTabClose).toBeNull();
    expect(useCircuitStore.getState().tabs.some((t) => t.id === tabId)).toBe(false);
    expect(useCircuitStore.getState().activeTabId).toBe('board');

    const after = useCircuitStore.getState();
    // The def's boundary pin is back to its pre-edit name, and the board
    // wire (which followed the rename while the tab was open) follows the
    // discard back too, staying attached rather than left dangling.
    expect(after.chipLib.get('buf1')!.pins.map((p) => p.name)).toEqual(['a', 'y']);
    const w = after.board.wires.find((x) => x.a.kind === 'pin' && x.a.component === sw.id);
    expect(w!.b).toEqual({ kind: 'pin', component: inst.id, pin: 'a' });
  });
});

describe('Task 2: In/Out label direction restrictions', () => {
  beforeEach(() =>
    useCircuitStore.setState({
      board: emptyBoard(),
      chipLib: new Map(),
      tabs: [{ id: 'board', kind: 'board' }],
      activeTabId: 'board',
      staleInstances: new Set(),
      selection: new Set(),
      powered: false,
      error: null,
    }),
  );

  it('addWire rejects an In port wired directly to a gate output', () => {
    const s = useCircuitStore.getState();
    s.place('inport', { x: 0, y: 0 }, 8);
    s.place('not', { x: 100, y: 0 }, 8);
    const in1 = useCircuitStore.getState().board.components.find((c) => c.kind === 'inport')!;
    const g1 = useCircuitStore.getState().board.components.find((c) => c.kind === 'not')!;
    const before = useCircuitStore.getState().board.wires.length;
    s.addWire(
      { kind: 'pin', component: in1.id, pin: 'y' },
      { kind: 'pin', component: g1.id, pin: 'y' },
    );
    expect(useCircuitStore.getState().board.wires.length).toBe(before);
    expect(useCircuitStore.getState().error).toMatch(/label:.*In port cannot connect/);
  });

  it('addWire returns false on rejection and does not commit a wire at all', () => {
    const s = useCircuitStore.getState();
    s.place('inport', { x: 0, y: 0 }, 8);
    s.place('not', { x: 100, y: 0 }, 8);
    const in1 = useCircuitStore.getState().board.components.find((c) => c.kind === 'inport')!;
    const g1 = useCircuitStore.getState().board.components.find((c) => c.kind === 'not')!;
    const ok = s.addWire(
      { kind: 'pin', component: in1.id, pin: 'y' },
      { kind: 'pin', component: g1.id, pin: 'y' },
    );
    expect(ok).toBe(false);
    expect(useCircuitStore.getState().board.wires).toHaveLength(0);
  });

  it('connectToJunction rejects an In label reaching a gate-output-driven wire body, no mutation and no stray bend', () => {
    // Confirmed live-use repro: connecting a label's pin onto an existing
    // WIRE's body (not a bare pin) never went through addWire's own
    // labelDirectionConflict check at all -- connectToJunction has its own,
    // separate rejection path, and its caller (CircuitWorkbench.tsx) used to
    // fall through to the P1.6 "empty click adds a bend" logic whenever
    // connectToJunction returned false, planting a bend on the rejected wire.
    const s = useCircuitStore.getState();
    const resolve: ResolveWireEnd = (end) =>
      end.kind === 'pin' && end.component === 'g1' ? { x: 0, y: 40 } : { x: 160, y: 40 };
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [
          ...st.board.components,
          { id: 'in1', kind: 'inport', pos: { x: 0, y: 0 } },
          { id: 'g1', kind: 'not', pos: { x: 40, y: 40 } },
          { id: 'led1', kind: 'led', pos: { x: 160, y: 40 } },
        ],
        wires: [
          {
            id: 'wg',
            a: { kind: 'pin', component: 'g1', pin: 'y' },
            b: { kind: 'pin', component: 'led1', pin: 'a' },
            points: [],
          },
        ],
        junctions: [],
      },
    }));
    const before = useCircuitStore.getState().board;
    const result = s.connectToJunction(
      { kind: 'pin', component: 'in1', pin: 'y' },
      { x: 77, y: 40 }, // a point along wg's body, not an endpoint
      8,
      resolve,
    );
    expect(result).toBe('rejected');
    expect(useCircuitStore.getState().board).toBe(before); // no mutation at all
    expect(useCircuitStore.getState().error).toMatch(/label:.*In port cannot connect/);
  });

  it('a rejection error clears on the next attempted edit', () => {
    const s = useCircuitStore.getState();
    s.place('inport', { x: 0, y: 0 }, 8);
    s.place('not', { x: 100, y: 0 }, 8);
    const in1 = useCircuitStore.getState().board.components.find((c) => c.kind === 'inport')!;
    const g1 = useCircuitStore.getState().board.components.find((c) => c.kind === 'not')!;
    s.addWire(
      { kind: 'pin', component: in1.id, pin: 'y' },
      { kind: 'pin', component: g1.id, pin: 'y' },
    );
    expect(useCircuitStore.getState().error).not.toBeNull();
    s.place('and', { x: 200, y: 0 }, 8);
    expect(useCircuitStore.getState().error).toBeNull();
  });

  it('addWire rejects an Out port wired directly to a gate input', () => {
    const s = useCircuitStore.getState();
    s.place('outport', { x: 0, y: 0 }, 8);
    s.place('and', { x: 100, y: 0 }, 8);
    const out1 = useCircuitStore.getState().board.components.find((c) => c.kind === 'outport')!;
    const g1 = useCircuitStore.getState().board.components.find((c) => c.kind === 'and')!;
    const before = useCircuitStore.getState().board.wires.length;
    s.addWire(
      { kind: 'pin', component: out1.id, pin: 'a' },
      { kind: 'pin', component: g1.id, pin: 'a' },
    );
    expect(useCircuitStore.getState().board.wires.length).toBe(before);
    expect(useCircuitStore.getState().error).toMatch(/Out port cannot connect/);
  });

  it('addWire still allows the normal In-drives-input / output-drives-Out wiring', () => {
    const s = useCircuitStore.getState();
    s.place('inport', { x: 0, y: 0 }, 8);
    s.place('and', { x: 100, y: 0 }, 8);
    const in1 = useCircuitStore.getState().board.components.find((c) => c.kind === 'inport')!;
    const g1 = useCircuitStore.getState().board.components.find((c) => c.kind === 'and')!;
    s.addWire(
      { kind: 'pin', component: in1.id, pin: 'y' },
      { kind: 'pin', component: g1.id, pin: 'a' },
    );
    expect(useCircuitStore.getState().error).toBeNull();
    expect(useCircuitStore.getState().board.wires).toHaveLength(1);
  });
});

describe('M4.2 P0.1/P0.2 junction crossing + auto-collapse', () => {
  beforeEach(reset);

  it('addJunction at a genuine crossing splits both wires, sharing one junction', () => {
    const s = useCircuitStore.getState();
    // Two independently-drawn wires crossing at (80, 40): one horizontal
    // (sw1 -> g1), one vertical (sw2 -> led1), neither sharing an endpoint.
    const resolve: ResolveWireEnd = (end) => {
      if (end.kind !== 'pin') return undefined;
      if (end.component === 'sw1') return { x: 0, y: 40 };
      if (end.component === 'g1') return { x: 160, y: 40 };
      if (end.component === 'sw2') return { x: 80, y: 0 };
      if (end.component === 'led1') return { x: 80, y: 80 };
      return undefined;
    };
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        wires: [
          {
            id: 'h',
            a: { kind: 'pin', component: 'sw1', pin: 'y' },
            b: { kind: 'pin', component: 'g1', pin: 'a' },
            points: [],
          },
          {
            id: 'v',
            a: { kind: 'pin', component: 'sw2', pin: 'y' },
            b: { kind: 'pin', component: 'led1', pin: 'a' },
            points: [],
          },
        ],
        junctions: [],
      },
    }));
    s.addJunction({ x: 80, y: 40 }, 8, resolve);
    const board = useCircuitStore.getState().board;
    expect(board.junctions).toHaveLength(1);
    const jid = board.junctions[0]!.id;
    // Both original wires are gone; four halves remain, all sharing the junction.
    expect(board.wires.find((w) => w.id === 'h')).toBeUndefined();
    expect(board.wires.find((w) => w.id === 'v')).toBeUndefined();
    expect(board.wires).toHaveLength(4);
    const atJunction = board.wires.filter(
      (w) =>
        (w.a.kind === 'junction' && w.a.junction === jid) ||
        (w.b.kind === 'junction' && w.b.junction === jid),
    );
    expect(atJunction).toHaveLength(4);
  });

  it('placing a junction on a single (uncrossed) wire keeps the dot -- an explicit placement sticks', () => {
    const s = useCircuitStore.getState();
    const resolve: ResolveWireEnd = (end) =>
      end.kind === 'pin' && end.component === 'sw1' ? { x: 0, y: 40 } : { x: 160, y: 40 };
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        wires: [
          {
            id: 'wj',
            a: { kind: 'pin', component: 'sw1', pin: 'y' },
            b: { kind: 'pin', component: 'g1', pin: 'a' },
            points: [],
          },
        ],
        junctions: [],
      },
    }));
    s.addJunction({ x: 77, y: 44 }, 8, resolve);
    const board = useCircuitStore.getState().board;
    expect(board.junctions).toHaveLength(1);
    expect(board.wires).toHaveLength(2);
  });

  it('degree-2 free-ended junction collapses back to one wire, but an L-bend does not', () => {
    const s = useCircuitStore.getState();
    // Straight pass-through: two free-ended wires meeting collinearly at a junction.
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        wires: [
          {
            id: 'w1',
            a: { kind: 'free', pos: { x: 0, y: 0 } },
            b: { kind: 'junction', junction: 'j1' },
            points: [],
          },
          {
            id: 'w2',
            a: { kind: 'junction', junction: 'j1' },
            b: { kind: 'free', pos: { x: 80, y: 0 } },
            points: [],
          },
        ],
        junctions: [{ id: 'j1', pos: { x: 40, y: 0 } }],
      },
    }));
    // Any edit runs the generic collapse pass; moveSelection with an empty
    // selection is a safe no-op trigger for wires but exercise via a real
    // mutating action instead: rotate a component, which no-ops on the wires
    // but still round-trips the draft through collapseJunctions.
    s.setSelection(new Set(['sw1']));
    s.rotateSelection([{ id: 'sw1', bounds: { x: 0, y: 0, w: 24, h: 40 }, rot: 0 }], 8);
    const board = useCircuitStore.getState().board;
    expect(board.junctions).toHaveLength(0);
    const merged = board.wires.find((w) => w.a.kind === 'free' && w.b.kind === 'free');
    expect(merged).toBeDefined();

    // Now an L-bend: same setup but the second wire heads off at a right angle.
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        wires: [
          {
            id: 'w1',
            a: { kind: 'free', pos: { x: 0, y: 0 } },
            b: { kind: 'junction', junction: 'j2' },
            points: [],
          },
          {
            id: 'w2',
            a: { kind: 'junction', junction: 'j2' },
            b: { kind: 'free', pos: { x: 40, y: 40 } },
            points: [],
          },
        ],
        junctions: [{ id: 'j2', pos: { x: 40, y: 0 } }],
      },
    }));
    s.rotateSelection([{ id: 'sw1', bounds: { x: 0, y: 0, w: 24, h: 40 }, rot: 0 }], 8);
    const board2 = useCircuitStore.getState().board;
    expect(board2.junctions).toHaveLength(1); // L-bend: left in place
    expect(board2.wires).toHaveLength(2);
  });
});

describe('M4.2 P0.3 In-pin toggle revert', () => {
  beforeEach(reset);

  it('toggleInput is a no-op on kind: input', () => {
    const s = useCircuitStore.getState();
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [
          ...st.board.components,
          { id: 'in1', kind: 'inport', pos: { x: 0, y: 200 }, params: { width: 1 } },
        ],
      },
    }));
    s.power();
    const before = useCircuitStore.getState().rev;
    s.toggleInput('in1');
    expect(useCircuitStore.getState().rev).toBe(before); // no-op: no rev bump
  });
});

describe('M4.2 P0.4 dragging preserves power', () => {
  beforeEach(reset);

  it('moving a selection while powered leaves powered/sim intact', () => {
    const s = useCircuitStore.getState();
    // Other test blocks in this file share the store singleton and mutate the
    // board, so pick whatever component is actually present rather than
    // assuming a fixed starter-board id.
    const comp = useCircuitStore.getState().board.components[0]!;
    const startX = comp.pos.x;
    s.power();
    expect(useCircuitStore.getState().powered).toBe(true);
    s.setSelection(new Set([comp.id]));
    s.moveSelection(16, 0);
    expect(useCircuitStore.getState().powered).toBe(true);
    expect(useCircuitStore.getState().board.components.find((c) => c.id === comp.id)!.pos.x).toBe(
      startX + 16,
    );
    // A real topology change still resets power as before.
    s.deleteSelection(new Set([comp.id]));
    expect(useCircuitStore.getState().powered).toBe(false);
  });
});

describe('id generation never collides with an already-loaded board', () => {
  beforeEach(reset);

  it('seedNextId advances past the highest id suffix already on the board', () => {
    const board: Board = {
      ...useCircuitStore.getState().board,
      wires: [
        {
          id: 'w99',
          a: { kind: 'free', pos: { x: 0, y: 0 } },
          b: { kind: 'free', pos: { x: 8, y: 0 } },
          points: [],
        },
      ],
    };
    seedNextId(board);
    const s = useCircuitStore.getState();
    s.place('toggle', { x: 0, y: 400 }, 8);
    const created = useCircuitStore.getState().board.components.at(-1)!;
    expect(Number(/(\d+)$/.exec(created.id)![1])).toBeGreaterThan(99);
  });

  it('a wire drawn right after loading the starter board never reuses one of its hardcoded ids', () => {
    // Regression: nextId used to start at 1 regardless of the board's own
    // hardcoded starter ids (sw1/sw2/g1/led1/w1/w2/w3), so the Nth id
    // generated in a session could collide with an existing one -- most
    // visibly a new wire silently landing on id "w3", duplicating the
    // starter's AND->LED wire and corrupting any id-keyed lookup of it
    // (insert-on-wire's `wires.findIndex` in particular).
    seedNextId(useCircuitStore.getState().board);
    const s = useCircuitStore.getState();
    s.place('toggle', { x: 0, y: 400 }, 8);
    s.place('led', { x: 100, y: 400 }, 8);
    const board = useCircuitStore.getState().board;
    const sw = board.components.at(-2)!;
    const led = board.components.at(-1)!;
    s.addWire(
      { kind: 'pin', component: sw.id, pin: 'y' },
      { kind: 'pin', component: led.id, pin: 'a' },
    );
    const after = useCircuitStore.getState().board;
    const allIds = [
      ...after.components.map((c) => c.id),
      ...after.wires.map((w) => w.id),
      ...after.junctions.map((j) => j.id),
    ];
    expect(new Set(allIds).size).toBe(allIds.length);
  });
});

describe('M4.3 moveSelection drag-stretch', () => {
  beforeEach(reset);

  const stubResolve =
    (positions: Record<string, Point>): ResolveWireEnd =>
    (end) =>
      end.kind === 'pin' ? positions[end.component] : undefined;

  const bentBoard = (st: { board: Board }): { board: Board } => ({
    board: {
      ...st.board,
      components: [
        { id: 'c1', kind: 'toggle', pos: { x: 0, y: 0 }, params: { initial: false } },
        { id: 'c2', kind: 'led', pos: { x: 100, y: 0 } },
      ],
      wires: [
        {
          id: 'wbend',
          a: { kind: 'pin', component: 'c1', pin: 'y' },
          b: { kind: 'pin', component: 'c2', pin: 'a' },
          points: [
            { x: 0, y: 80 },
            { x: 100, y: 80 },
          ],
        },
      ],
      junctions: [],
    },
  });

  it('stretches a bent wire terminal leg to follow the moved end, leaving no stale bend', () => {
    useCircuitStore.setState(bentBoard);
    const s = useCircuitStore.getState();
    const resolve = stubResolve({ c1: { x: 0, y: 0 }, c2: { x: 100, y: 0 } });
    s.setSelection(new Set(['c1']));
    s.moveSelection(30, 0, resolve);
    const wire = useCircuitStore.getState().board.wires.find((w) => w.id === 'wbend')!;
    // Old bend (0,80) followed c1's new pin x (30) instead of being left
    // behind -- a stale bend would have kept the wire visually detached from
    // c1's new position, requiring orthogonalPolyline's re-elbow fallback.
    expect(wire.points).toEqual([
      { x: 30, y: 80 },
      { x: 100, y: 80 },
    ]);
  });

  it('insertOnWire with componentId moves an EXISTING component and splices it, one undo step', () => {
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [...st.board.components, { id: 'nt', kind: 'not', pos: { x: 500, y: 500 } }],
        wires: [
          {
            id: 'w1',
            a: { kind: 'pin', component: 'sw1', pin: 'y' },
            b: { kind: 'pin', component: 'g1', pin: 'a' },
            points: [],
          },
        ],
        junctions: [],
      },
    }));
    const s = useCircuitStore.getState();
    const beforeCount = useCircuitStore.getState().board.components.length;
    s.insertOnWire({
      kind: 'not',
      wireId: 'w1',
      pos: { x: 100, y: 72 },
      grid: 8,
      inName: 'a',
      outName: 'y',
      upstreamEnd: { kind: 'pin', component: 'sw1', pin: 'y' },
      downstreamEnd: { kind: 'pin', component: 'g1', pin: 'a' },
      componentId: 'nt',
    });
    const board = useCircuitStore.getState().board;
    // No new component minted -- same count, 'nt' moved in place.
    expect(board.components.length).toBe(beforeCount);
    const nt = board.components.find((c) => c.id === 'nt')!;
    expect(nt.pos).toEqual({ x: 100, y: 72 });
    expect(board.wires.find((w) => w.id === 'w1')).toBeUndefined();
    const wIn = board.wires.find(
      (w) =>
        w.a.kind === 'pin' &&
        w.a.component === 'sw1' &&
        w.b.kind === 'pin' &&
        w.b.component === 'nt',
    );
    const wOut = board.wires.find(
      (w) =>
        w.a.kind === 'pin' &&
        w.a.component === 'nt' &&
        w.b.kind === 'pin' &&
        w.b.component === 'g1',
    );
    expect(wIn).toBeDefined();
    expect(wOut).toBeDefined();

    s.undo(); // one undo step restores both the position and the wire
    const restored = useCircuitStore.getState().board;
    expect(restored.components.find((c) => c.id === 'nt')!.pos).toEqual({ x: 500, y: 500 });
    expect(restored.wires.find((w) => w.id === 'w1')).toBeDefined();
  });

  it('a move that only changes component pos + wire points keeps a powered sim alive', () => {
    useCircuitStore.setState(bentBoard);
    const s = useCircuitStore.getState();
    s.power();
    expect(useCircuitStore.getState().powered).toBe(true);
    const resolve = stubResolve({ c1: { x: 0, y: 0 }, c2: { x: 100, y: 0 } });
    s.setSelection(new Set(['c1']));
    s.moveSelection(30, 0, resolve);
    expect(useCircuitStore.getState().powered).toBe(true);
    const wire = useCircuitStore.getState().board.wires.find((w) => w.id === 'wbend')!;
    expect(wire.points[0]).toEqual({ x: 30, y: 80 });
  });
});

describe('applyGroupRotate (Item 3, Shift+R)', () => {
  beforeEach(reset);

  it('commits component pos/rot, junction pos, and wire points in one undo step', () => {
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [
          ...st.board.components.filter((c) => c.id !== 'sw1'),
          { id: 'sw1', kind: 'toggle', pos: { x: 64, y: 72 }, params: { initial: false } },
        ],
        wires: [
          ...st.board.wires.filter((w) => w.id !== 'w1'),
          {
            id: 'w1',
            a: { kind: 'pin', component: 'sw1', pin: 'y' },
            b: { kind: 'pin', component: 'g1', pin: 'a' },
            points: [],
          },
        ],
      },
    }));
    const s = useCircuitStore.getState();
    s.applyGroupRotate({
      components: [{ id: 'sw1', pos: { x: 8, y: -8 }, rot: 90 }],
      junctions: [],
      wires: [{ id: 'w1', points: [{ x: 1, y: 2 }] }],
    });
    const board = useCircuitStore.getState().board;
    const sw1 = board.components.find((c) => c.id === 'sw1')!;
    expect(sw1.pos).toEqual({ x: 8, y: -8 });
    expect(sw1.rot).toBe(90);
    const w1 = board.wires.find((w) => w.id === 'w1')!;
    expect(w1.points).toEqual([{ x: 1, y: 2 }]);

    s.undo();
    const restored = useCircuitStore.getState().board;
    expect(restored.components.find((c) => c.id === 'sw1')!.pos).toEqual({ x: 64, y: 72 });
    expect(restored.wires.find((w) => w.id === 'w1')!.points).toEqual([]);
  });

  it('no-ops when every update list is empty', () => {
    const s = useCircuitStore.getState();
    const before = useCircuitStore.getState().board;
    s.applyGroupRotate({ components: [], junctions: [], wires: [] });
    expect(useCircuitStore.getState().board).toBe(before); // no history entry pushed
  });
});

describe('B3b moveFreeEnd', () => {
  beforeEach(reset);

  it('moves a wire free end, one undo step, powered sim survives', () => {
    // Fully self-contained board (not spreading in other test blocks' prior
    // mutations to this shared store's wires/components -- several earlier
    // blocks in this file leave stale cross-references behind on purpose,
    // e.g. a removed component's id still referenced by a wire built for a
    // narrower assertion). One end anchored to a real pin so the board still
    // compiles cleanly; the free end being dragged is the other one.
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [{ id: 'ledFreeTest', kind: 'led', pos: { x: 400, y: 400 } }],
        junctions: [],
        wires: [
          {
            id: 'wfree',
            a: { kind: 'pin', component: 'ledFreeTest', pin: 'a' },
            b: { kind: 'free', pos: { x: 40, y: 0 } },
            points: [],
          },
        ],
      },
    }));
    const s = useCircuitStore.getState();
    s.power();
    expect(useCircuitStore.getState().powered).toBe(true);
    s.moveFreeEnd('wfree', 'b', { x: 8, y: 8 });
    const board = useCircuitStore.getState().board;
    expect(board.wires.find((w) => w.id === 'wfree')!.b).toEqual({
      kind: 'free',
      pos: { x: 8, y: 8 },
    });
    // Position-only wire-end change: still counts as a pure move (P0.4).
    expect(useCircuitStore.getState().powered).toBe(true);

    s.undo();
    expect(useCircuitStore.getState().board.wires.find((w) => w.id === 'wfree')!.b).toEqual({
      kind: 'free',
      pos: { x: 40, y: 0 },
    });
  });

  it('no-ops when the end is not actually free (e.g. pin-ended)', () => {
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [{ id: 'ledPinTest', kind: 'led', pos: { x: 400, y: 400 } }],
        junctions: [],
        wires: [
          {
            id: 'wpin',
            a: { kind: 'pin', component: 'ledPinTest', pin: 'a' },
            b: { kind: 'free', pos: { x: 40, y: 0 } },
            points: [],
          },
        ],
      },
    }));
    const s = useCircuitStore.getState();
    const before = useCircuitStore.getState().board;
    s.moveFreeEnd('wpin', 'a', { x: 999, y: 999 });
    expect(useCircuitStore.getState().board).toBe(before);
  });

  it('dropping a free end onto an In port that would drive a gate output is rejected, end stays free', () => {
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [
          { id: 'in1', kind: 'inport', pos: { x: 0, y: 0 } },
          { id: 'g1', kind: 'not', pos: { x: 40, y: 40 } },
        ],
        junctions: [],
        wires: [
          {
            id: 'wm',
            a: { kind: 'pin', component: 'g1', pin: 'y' },
            b: { kind: 'free', pos: { x: 80, y: 40 } },
            points: [],
          },
        ],
      },
    }));
    const s = useCircuitStore.getState();
    const resolve: ResolveWireEnd = (end) =>
      end.kind === 'pin' && end.component === 'g1' ? { x: 40, y: 40 } : { x: 0, y: 0 };
    s.moveFreeEnd(
      'wm',
      'b',
      { x: 0, y: 0 },
      {
        grid: 8,
        resolveEnd: resolve,
        pinEnd: { kind: 'pin', component: 'in1', pin: 'y' },
      },
    );
    const board = useCircuitStore.getState().board;
    expect(board.wires.find((w) => w.id === 'wm')!.b).toEqual({
      kind: 'free',
      pos: { x: 80, y: 40 },
    }); // rejected: unchanged, not attached to in1
    expect(useCircuitStore.getState().error).toMatch(/label:.*In port cannot connect/);
  });
});

describe('B3a junction drag via moveSelection', () => {
  beforeEach(reset);

  it('moves the junction and keeps attached junction-ended wires consistent', () => {
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        junctions: [{ id: 'j1', pos: { x: 40, y: 0 } }],
        wires: [
          ...st.board.wires,
          {
            id: 'wa',
            a: { kind: 'free', pos: { x: 0, y: 0 } },
            b: { kind: 'junction', junction: 'j1' },
            points: [],
          },
          {
            id: 'wb',
            a: { kind: 'junction', junction: 'j1' },
            b: { kind: 'free', pos: { x: 80, y: 0 } },
            points: [],
          },
          {
            id: 'wc',
            a: { kind: 'junction', junction: 'j1' },
            b: { kind: 'free', pos: { x: 40, y: 40 } },
            points: [],
          },
        ],
      },
    }));
    const s = useCircuitStore.getState();
    s.setSelection(new Set(['j1']));
    s.moveSelection(8, 8);
    const board = useCircuitStore.getState().board;
    expect(board.junctions.find((j) => j.id === 'j1')!.pos).toEqual({ x: 48, y: 8 });
    // A genuine 3-way branch survives the drag -- collapseJunctions must not
    // remove it just because it moved.
    expect(board.junctions).toHaveLength(1);
    expect(
      board.wires.filter((w) => w.a.kind === 'junction' || w.b.kind === 'junction'),
    ).toHaveLength(3);
  });
});

describe('B4 wireFromStart (starting a wire on top of an existing one)', () => {
  beforeEach(reset);

  function isolatedWireBoard() {
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [
          { id: 'swStart', kind: 'toggle', pos: { x: 0, y: 400 } },
          { id: 'ledStart', kind: 'led', pos: { x: 400, y: 400 } },
        ],
        junctions: [],
        wires: [
          {
            id: 'wOrig',
            a: { kind: 'free', pos: { x: 0, y: 40 } },
            b: { kind: 'free', pos: { x: 160, y: 40 } },
            points: [],
          },
        ],
      },
    }));
  }

  it('start-on-wire splits the original wire into two and joins a new wire at the junction, one undo step', () => {
    isolatedWireBoard();
    const s = useCircuitStore.getState();
    const resolveFree: ResolveWireEnd = (end) => (end.kind === 'free' ? end.pos : undefined);
    const committed = s.wireFromStart(
      { x: 77, y: 44 }, // lands on wOrig's body
      { kind: 'pin', component: 'swStart', pin: 'y' },
      8,
      resolveFree,
    );
    expect(committed).toBe('connected');
    const board = useCircuitStore.getState().board;
    expect(board.junctions).toHaveLength(1);
    const jid = board.junctions[0]!.id;
    // Original wire split into two halves sharing the junction, plus the new
    // wire in -- three total, same as connectToJunction's end-side case.
    expect(board.wires).toHaveLength(3);
    expect(board.wires.find((w) => w.id === 'wOrig')).toBeUndefined();
    // wireFromStart's `a` is the start (hit-tested -> junction), `b` is the
    // already-resolved far end passed in (the swStart pin).
    const newWire = board.wires.find(
      (w) => w.b.kind === 'pin' && w.b.component === 'swStart' && w.a.kind === 'junction',
    );
    expect(newWire).toBeDefined();
    expect((newWire!.a as { junction: string }).junction).toBe(jid);

    s.undo();
    const restored = useCircuitStore.getState().board;
    expect(restored.junctions).toHaveLength(0);
    expect(restored.wires).toHaveLength(1);
    expect(restored.wires[0]!.id).toBe('wOrig');
  });

  it('start-on-free-end converts that end in place, no split', () => {
    isolatedWireBoard();
    const s = useCircuitStore.getState();
    const resolveFree: ResolveWireEnd = (end) => (end.kind === 'free' ? end.pos : undefined);
    const committed = s.wireFromStart(
      { x: 1, y: 40 }, // right on wOrig's free end 'a'
      { kind: 'pin', component: 'swStart', pin: 'y' },
      8,
      resolveFree,
    );
    expect(committed).toBe('connected');
    const board = useCircuitStore.getState().board;
    expect(board.junctions).toHaveLength(1);
    // No split: still exactly the original wire plus the new one in.
    expect(board.wires).toHaveLength(2);
    const original = board.wires.find((w) => w.id === 'wOrig')!;
    expect(original.a).toEqual({ kind: 'junction', junction: board.junctions[0]!.id });
  });

  it('degrades to a plain free start when nothing is at the recorded point anymore', () => {
    isolatedWireBoard();
    const s = useCircuitStore.getState();
    const resolveFree: ResolveWireEnd = (end) => (end.kind === 'free' ? end.pos : undefined);
    const committed = s.wireFromStart(
      { x: 900, y: 900 }, // nowhere near wOrig -- board "changed" since pointer-down
      { kind: 'pin', component: 'swStart', pin: 'y' },
      8,
      resolveFree,
    );
    expect(committed).toBe('connected');
    const board = useCircuitStore.getState().board;
    expect(board.junctions).toHaveLength(0);
    const newWire = board.wires.find((w) => w.id !== 'wOrig')!;
    // `a` (the start) degrades to a plain free end; `b` is the already-
    // resolved far end (the swStart pin), unaffected.
    expect(newWire.a).toEqual({ kind: 'free', pos: { x: 900, y: 900 } });
    expect(newWire.b).toEqual({ kind: 'pin', component: 'swStart', pin: 'y' });
  });

  it('far end also missing every pin: returns false and commits nothing (P1.6 bend-add fallback)', () => {
    isolatedWireBoard();
    const s = useCircuitStore.getState();
    const before = useCircuitStore.getState().board;
    const resolveFree: ResolveWireEnd = (end) => (end.kind === 'free' ? end.pos : undefined);
    const committed = s.wireFromStart(
      { x: 77, y: 44 }, // on wOrig's body
      { pos: { x: 900, y: 900 } }, // far end hits nothing either
      8,
      resolveFree,
    );
    expect(committed).toBe('miss');
    expect(useCircuitStore.getState().board).toBe(before); // no mutation at all
  });

  it('both ends land on existing wire bodies/junctions, still one undo step', () => {
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [],
        junctions: [],
        wires: [
          {
            id: 'wA',
            a: { kind: 'free', pos: { x: 0, y: 40 } },
            b: { kind: 'free', pos: { x: 160, y: 40 } },
            points: [],
          },
          {
            id: 'wB',
            a: { kind: 'free', pos: { x: 0, y: 200 } },
            b: { kind: 'free', pos: { x: 160, y: 200 } },
            points: [],
          },
        ],
      },
    }));
    const s = useCircuitStore.getState();
    const resolveFree: ResolveWireEnd = (end) => (end.kind === 'free' ? end.pos : undefined);
    const committed = s.wireFromStart(
      { x: 77, y: 44 }, // on wA's body
      { pos: { x: 77, y: 204 } }, // on wB's body
      8,
      resolveFree,
    );
    expect(committed).toBe('connected');
    const board = useCircuitStore.getState().board;
    expect(board.junctions).toHaveLength(2);
    // wA and wB each split into two, plus the connecting wire in.
    expect(board.wires).toHaveLength(5);

    s.undo();
    const restored = useCircuitStore.getState().board;
    expect(restored.junctions).toHaveLength(0);
    expect(restored.wires.map((w) => w.id).sort()).toEqual(['wA', 'wB']);
  });

  it('rejects an In-pin net reaching a gate output even when neither end is a literal pin', () => {
    // Both ends are bare points landing on wire bodies (wA reaches in1, wB
    // reaches g1's output) -- the old check only ran when one end was a
    // literal pin `WireEnd`, so this never got validated at all.
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [
          { id: 'in1', kind: 'inport', pos: { x: 0, y: 0 } },
          { id: 'g1', kind: 'not', pos: { x: 0, y: 200 } },
        ],
        junctions: [],
        wires: [
          {
            id: 'wA',
            a: { kind: 'pin', component: 'in1', pin: 'y' },
            b: { kind: 'free', pos: { x: 160, y: 40 } },
            points: [],
          },
          {
            id: 'wB',
            a: { kind: 'pin', component: 'g1', pin: 'y' },
            b: { kind: 'free', pos: { x: 160, y: 200 } },
            points: [],
          },
        ],
      },
    }));
    const s = useCircuitStore.getState();
    const resolve: ResolveWireEnd = (end) => {
      if (end.kind === 'pin' && end.component === 'in1') return { x: 0, y: 40 };
      if (end.kind === 'pin' && end.component === 'g1') return { x: 0, y: 200 };
      if (end.kind === 'free') return end.pos;
      return undefined;
    };
    const before = useCircuitStore.getState().board;
    const result = s.wireFromStart(
      { x: 77, y: 44 }, // on wA's body
      { pos: { x: 77, y: 204 } }, // on wB's body
      8,
      resolve,
    );
    expect(result).toBe('rejected');
    expect(useCircuitStore.getState().board).toBe(before); // no mutation at all
    expect(useCircuitStore.getState().error).toMatch(/label:.*In port cannot connect/);
  });
});

describe('junction Ctrl+X delete-with-heal (M5.1)', () => {
  beforeEach(reset);

  const twoLegBoard = (leg2End: Point) => ({
    junctions: [{ id: 'jh', pos: { x: 80, y: 40 } }],
    wires: [
      {
        id: 'wl',
        a: { kind: 'free' as const, pos: { x: 0, y: 40 } },
        b: { kind: 'junction' as const, junction: 'jh' },
        points: [],
      },
      {
        id: 'wr',
        a: { kind: 'junction' as const, junction: 'jh' },
        b: { kind: 'free' as const, pos: leg2End },
        points: [],
      },
    ],
  });

  it('heals a degree-2 pass-through junction into one merged wire, one undo step', () => {
    useCircuitStore.setState((st) => ({
      board: { ...st.board, ...twoLegBoard({ x: 160, y: 40 }) },
    }));
    const s = useCircuitStore.getState();
    s.deleteWithHeal(new Set(['jh']));
    const board = useCircuitStore.getState().board;
    expect(board.junctions).toHaveLength(0);
    const merged = board.wires.find((w) => w.a.kind === 'free' && w.b.kind === 'free');
    expect(merged).toBeDefined();
    expect(merged!.a).toEqual({ kind: 'free', pos: { x: 0, y: 40 } });
    expect(merged!.b).toEqual({ kind: 'free', pos: { x: 160, y: 40 } });

    s.undo();
    const restored = useCircuitStore.getState().board;
    expect(restored.junctions.map((j) => j.id)).toEqual(['jh']);
    expect(restored.wires.map((w) => w.id).sort()).toEqual(['wl', 'wr']);
  });

  it('heals non-collinear legs too, keeping the corner as a bend', () => {
    useCircuitStore.setState((st) => ({
      board: { ...st.board, ...twoLegBoard({ x: 80, y: 120 }) },
    }));
    useCircuitStore.getState().deleteWithHeal(new Set(['jh']));
    const board = useCircuitStore.getState().board;
    expect(board.junctions).toHaveLength(0);
    const merged = board.wires.find((w) => w.a.kind === 'free' && w.b.kind === 'free')!;
    expect(merged.points).toEqual([{ x: 80, y: 40 }]);
  });

  it('leaves a 3-way T junction to the plain-delete path', () => {
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        junctions: [{ id: 'jt', pos: { x: 80, y: 40 } }],
        wires: [
          {
            id: 'w1',
            a: { kind: 'free', pos: { x: 0, y: 40 } },
            b: { kind: 'junction', junction: 'jt' },
            points: [],
          },
          {
            id: 'w2',
            a: { kind: 'junction', junction: 'jt' },
            b: { kind: 'free', pos: { x: 160, y: 40 } },
            points: [],
          },
          {
            id: 'w3',
            a: { kind: 'junction', junction: 'jt' },
            b: { kind: 'free', pos: { x: 80, y: 120 } },
            points: [],
          },
        ],
      },
    }));
    useCircuitStore.getState().deleteWithHeal(new Set(['jt']));
    const board = useCircuitStore.getState().board;
    // No merge happened; the junction itself is deleted like any selection.
    expect(board.junctions).toHaveLength(0);
    expect(board.wires.find((w) => w.a.kind === 'free' && w.b.kind === 'free')).toBeUndefined();
    // Task 4: the 3 wires that pointed at the now-deleted junction must be
    // gone too, not left dangling with a {kind:'junction', junction: <dead
    // id>} end -- a dangling wire keeps its OTHER end's pin permanently
    // occupied even though nothing valid connects to it anymore.
    expect(board.wires).toHaveLength(0);
  });

  it('Task 4: a 3-way junction Ctrl+X frees every pin it touched, no undo needed', () => {
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [
          { id: 't4sw', kind: 'toggle', pos: { x: 0, y: 0 } },
          { id: 't4in', kind: 'inport', pos: { x: 0, y: 80 } },
          { id: 't4g', kind: 'and', pos: { x: 200, y: 0 }, params: { inputs: 2 } },
        ],
        junctions: [{ id: 't4j', pos: { x: 100, y: 40 } }],
        wires: [
          {
            id: 't4w1',
            a: { kind: 'pin', component: 't4sw', pin: 'y' },
            b: { kind: 'junction', junction: 't4j' },
            points: [],
          },
          {
            id: 't4w2',
            a: { kind: 'pin', component: 't4in', pin: 'y' },
            b: { kind: 'junction', junction: 't4j' },
            points: [],
          },
          {
            id: 't4w3',
            a: { kind: 'junction', junction: 't4j' },
            b: { kind: 'pin', component: 't4g', pin: 'a' },
            points: [],
          },
        ],
      },
    }));
    useCircuitStore.getState().deleteWithHeal(new Set(['t4j']));
    const board = useCircuitStore.getState().board;
    expect(board.junctions).toHaveLength(0);
    expect(board.wires).toHaveLength(0);
    // Every wire end resolves (there are none left); every pin the junction
    // touched is free again -- no need to inspect PinTarget.free directly
    // since occupancy is purely wire-existence-based (pinTargets.ts).
    const stillReferencesDeadJunction = board.wires.some(
      (w) =>
        (w.a.kind === 'junction' && w.a.junction === 't4j') ||
        (w.b.kind === 'junction' && w.b.junction === 't4j'),
    );
    expect(stillReferencesDeadJunction).toBe(false);

    const targets = collectPinTargets(board.components, board.wires, testTheme, new Map());
    const gateInput = targets.find((t) => t.componentId === 't4g' && t.pinName === 'a')!;
    expect(gateInput.free).toBe(true);
  });
});

describe('moveFreeEnd drop materialization (M5.1)', () => {
  beforeEach(reset);

  const resolveFree: ResolveWireEnd = (end) => (end.kind === 'free' ? end.pos : undefined);

  // j1 carries two real legs (an L, so it never auto-collapses) -- a bare
  // junction with no wires would be dropped by collapseJunctions on any edit.
  const dragBoard = () => ({
    components: [],
    junctions: [{ id: 'j1', pos: { x: 200, y: 200 } }],
    wires: [
      {
        id: 'wd',
        a: { kind: 'free' as const, pos: { x: 0, y: 0 } },
        b: { kind: 'free' as const, pos: { x: 40, y: 0 } },
        points: [],
      },
      {
        id: 'wo',
        a: { kind: 'free' as const, pos: { x: 0, y: 100 } },
        b: { kind: 'free' as const, pos: { x: 160, y: 100 } },
        points: [],
      },
      {
        id: 'wj1',
        a: { kind: 'free' as const, pos: { x: 200, y: 280 } },
        b: { kind: 'junction' as const, junction: 'j1' },
        points: [],
      },
      {
        id: 'wj2',
        a: { kind: 'junction' as const, junction: 'j1' },
        b: { kind: 'free' as const, pos: { x: 280, y: 200 } },
        points: [],
      },
    ],
  });

  it('drop onto an existing junction converts the free end to a junction end', () => {
    useCircuitStore.setState((st) => ({ board: { ...st.board, ...dragBoard() } }));
    useCircuitStore
      .getState()
      .moveFreeEnd('wd', 'b', { x: 200, y: 200 }, { grid: 8, resolveEnd: resolveFree });
    const wd = useCircuitStore.getState().board.wires.find((w) => w.id === 'wd')!;
    expect(wd.b).toEqual({ kind: 'junction', junction: 'j1' });
  });

  it('drop onto another wire body splits it and joins at a new junction', () => {
    useCircuitStore.setState((st) => ({ board: { ...st.board, ...dragBoard() } }));
    useCircuitStore
      .getState()
      .moveFreeEnd('wd', 'b', { x: 80, y: 100 }, { grid: 8, resolveEnd: resolveFree });
    const board = useCircuitStore.getState().board;
    // j1 untouched, plus the new split junction.
    expect(board.junctions).toHaveLength(2);
    const jid = board.junctions.find((j) => j.id !== 'j1')!.id;
    const wd = board.wires.find((w) => w.id === 'wd')!;
    expect(wd.b).toEqual({ kind: 'junction', junction: jid });
    // wo split into two halves sharing the junction.
    expect(board.wires.find((w) => w.id === 'wo')).toBeUndefined();
    expect(
      board.wires.filter(
        (w) =>
          (w.a.kind === 'junction' && w.a.junction === jid) ||
          (w.b.kind === 'junction' && w.b.junction === jid),
      ),
    ).toHaveLength(3);
  });

  it('drop with a caller-resolved pin lands on the pin', () => {
    useCircuitStore.setState((st) => ({ board: { ...st.board, ...dragBoard() } }));
    useCircuitStore.getState().moveFreeEnd(
      'wd',
      'b',
      { x: 320, y: 112 },
      {
        grid: 8,
        resolveEnd: resolveFree,
        pinEnd: { kind: 'pin', component: 'led1', pin: 'a' },
      },
    );
    const wd = useCircuitStore.getState().board.wires.find((w) => w.id === 'wd')!;
    expect(wd.b).toEqual({ kind: 'pin', component: 'led1', pin: 'a' });
  });

  it("drop with a caller-resolved pin clears that component's re-bind badge (Task 3)", () => {
    useCircuitStore.setState((st) => ({
      board: { ...st.board, ...dragBoard() },
      staleInstances: new Set(['led1']),
    }));
    useCircuitStore.getState().moveFreeEnd(
      'wd',
      'b',
      { x: 320, y: 112 },
      {
        grid: 8,
        resolveEnd: resolveFree,
        pinEnd: { kind: 'pin', component: 'led1', pin: 'a' },
      },
    );
    expect(useCircuitStore.getState().staleInstances.has('led1')).toBe(false);
  });

  it('drop on empty canvas stays a plain free end', () => {
    useCircuitStore.setState((st) => ({ board: { ...st.board, ...dragBoard() } }));
    useCircuitStore
      .getState()
      .moveFreeEnd('wd', 'b', { x: 500, y: 500 }, { grid: 8, resolveEnd: resolveFree });
    const wd = useCircuitStore.getState().board.wires.find((w) => w.id === 'wd')!;
    expect(wd.b).toEqual({ kind: 'free', pos: { x: 500, y: 500 } });
  });
});

describe('bubble absorb via store actions (keyboard parity)', () => {
  it('previews and commits absorbInverter with no pointer events', () => {
    useCircuitStore.setState((st) => ({
      mode: 'edit' as const,
      powered: false,
      board: {
        ...st.board,
        components: [
          { id: 'in1', kind: 'inport', pos: { x: 0, y: 0 }, label: 'in1' },
          { id: 'in2', kind: 'inport', pos: { x: 0, y: 8 }, label: 'in2' },
          { id: 'g1', kind: 'or', pos: { x: 8, y: 0 } },
          { id: 'n1', kind: 'not', pos: { x: 16, y: 0 } },
          { id: 'out1', kind: 'outport', pos: { x: 24, y: 0 }, label: 'out1' },
        ],
        wires: [
          {
            id: 'w1',
            a: { kind: 'pin' as const, component: 'in1', pin: 'y' },
            b: { kind: 'pin' as const, component: 'g1', pin: 'a' },
            points: [],
          },
          {
            id: 'w2',
            a: { kind: 'pin' as const, component: 'in2', pin: 'y' },
            b: { kind: 'pin' as const, component: 'g1', pin: 'b' },
            points: [],
          },
          {
            id: 'w3',
            a: { kind: 'pin' as const, component: 'g1', pin: 'y' },
            b: { kind: 'pin' as const, component: 'n1', pin: 'a' },
            points: [],
          },
          {
            id: 'w4',
            a: { kind: 'pin' as const, component: 'n1', pin: 'y' },
            b: { kind: 'pin' as const, component: 'out1', pin: 'a' },
            points: [],
          },
        ],
        junctions: [],
      },
    }));
    const s = useCircuitStore.getState();
    s.enterBubbleMode();
    expect(useCircuitStore.getState().mode).toBe('bubble');
    s.previewBubbleMove({ kind: 'absorbInverter', inverterId: 'n1' });
    expect(useCircuitStore.getState().bubblePreview?.result.legal).toBe(true);
    s.commitBubbleMove({ kind: 'absorbInverter', inverterId: 'n1' });
    const b = useCircuitStore.getState().board;
    const g1 = b.components.find((c) => c.id === 'g1')!;
    expect(g1.kind).toBe('or');
    expect(g1.params?.['outputBubble']).toBe(true);
    expect(b.components.some((c) => c.id === 'n1')).toBe(false);
    useCircuitStore.getState().exitBubbleMode();
  });
});

describe('label sharing (labelSync store hooks)', () => {
  const setBoard = () =>
    useCircuitStore.setState((st) => ({
      selection: new Set(),
      powered: false,
      labelConflict: null,
      board: {
        ...st.board,
        components: [
          { id: 'sw1', kind: 'toggle', pos: { x: 0, y: 0 } },
          { id: 'in1', kind: 'inport', pos: { x: 0, y: 8 }, label: 'A' },
          { id: 'led1', kind: 'led', pos: { x: 16, y: 0 } },
          { id: 'sw2', kind: 'toggle', pos: { x: 0, y: 16 }, label: 'S' },
        ],
        wires: [],
        junctions: [],
      },
    }));

  it('wiring a named pin to an unnamed switch names the switch, one undo step', () => {
    setBoard();
    const s = useCircuitStore.getState();
    s.addWire(
      { kind: 'pin', component: 'in1', pin: 'y' },
      { kind: 'pin', component: 'sw1', pin: 'y' },
    );
    let b = useCircuitStore.getState().board;
    expect(b.components.find((c) => c.id === 'sw1')!.label).toBe('A');
    s.undo();
    b = useCircuitStore.getState().board;
    expect(b.wires).toHaveLength(0);
    expect(b.components.find((c) => c.id === 'sw1')!.label).toBeUndefined();
  });

  it('wiring two user-named sides raises a conflict, wire stays', () => {
    setBoard();
    const s = useCircuitStore.getState();
    s.addWire(
      { kind: 'pin', component: 'in1', pin: 'y' },
      { kind: 'pin', component: 'sw2', pin: 'y' },
    );
    const st = useCircuitStore.getState();
    expect(st.board.wires).toHaveLength(1);
    expect(st.labelConflict).not.toBeNull();
    expect(st.labelConflict).toHaveLength(1);
    expect([...st.labelConflict![0]!.candidates].sort()).toEqual(['A', 'S']);
    // Applying a chosen label unifies the net; conflict clears.
    st.applyLabelConflicts(['A']);
    const after = useCircuitStore.getState();
    expect(after.labelConflict).toBeNull();
    expect(after.board.components.find((c) => c.id === 'sw2')!.label).toBe('A');
  });

  it('Apply with "keep both" (the default choice) commits the wire, leaves both labels', () => {
    setBoard();
    const s = useCircuitStore.getState();
    s.addWire(
      { kind: 'pin', component: 'in1', pin: 'y' },
      { kind: 'pin', component: 'sw2', pin: 'y' },
    );
    useCircuitStore.getState().applyLabelConflicts([null]);
    const after = useCircuitStore.getState();
    expect(after.labelConflict).toBeNull();
    expect(after.board.wires).toHaveLength(1);
    expect(after.board.components.find((c) => c.id === 'sw2')!.label).toBe('S');
    expect(after.board.components.find((c) => c.id === 'in1')!.label).toBe('A');
  });

  it('Esc/cancel undoes the edit that raised the conflict (the wire itself)', () => {
    setBoard();
    const s = useCircuitStore.getState();
    s.addWire(
      { kind: 'pin', component: 'in1', pin: 'y' },
      { kind: 'pin', component: 'sw2', pin: 'y' },
    );
    expect(useCircuitStore.getState().board.wires).toHaveLength(1);
    useCircuitStore.getState().cancelLabelConflict();
    const after = useCircuitStore.getState();
    expect(after.labelConflict).toBeNull();
    expect(after.board.wires).toHaveLength(0);
    expect(after.board.components.find((c) => c.id === 'sw2')!.label).toBe('S');
    expect(after.board.components.find((c) => c.id === 'in1')!.label).toBe('A');
  });

  it('renaming a component propagates to a default-named connected LED', () => {
    setBoard();
    const s = useCircuitStore.getState();
    // Both unlabeled: the wire commit inherits nothing, led1 stays default.
    s.addWire(
      { kind: 'pin', component: 'sw1', pin: 'y' },
      { kind: 'pin', component: 'led1', pin: 'a' },
    );
    expect(
      useCircuitStore.getState().board.components.find((c) => c.id === 'led1')!.label,
    ).toBeUndefined();
    expect(useCircuitStore.getState().renameComponent('sw1', 'Q')).toBe(true);
    const b = useCircuitStore.getState().board;
    expect(b.components.find((c) => c.id === 'sw1')!.label).toBe('Q');
    expect(b.components.find((c) => c.id === 'led1')!.label).toBe('Q');
  });

  it('renaming into a net whose partner is already user-named raises a conflict', () => {
    setBoard();
    const s = useCircuitStore.getState();
    s.addWire(
      { kind: 'pin', component: 'in1', pin: 'y' },
      { kind: 'pin', component: 'led1', pin: 'a' },
    );
    // led1 inherited 'A' (now user-named); renaming in1 to 'Q' conflicts.
    expect(useCircuitStore.getState().renameComponent('in1', 'Q')).toBe(true);
    const st = useCircuitStore.getState();
    expect(st.labelConflict).not.toBeNull();
    expect(st.labelConflict).toHaveLength(1);
    expect([...st.labelConflict![0]!.candidates].sort()).toEqual(['A', 'Q']);
  });

  it('rejects a rename duplicating a label on a different net; allows same net', () => {
    setBoard();
    const s = useCircuitStore.getState();
    expect(s.renameComponent('sw1', 'S')).toBe(false); // sw2 owns 'S' on another net
    expect(
      useCircuitStore.getState().board.components.find((c) => c.id === 'sw1')!.label,
    ).toBeUndefined();
    // Same net: allowed (the feature).
    s.addWire(
      { kind: 'pin', component: 'sw2', pin: 'y' },
      { kind: 'pin', component: 'led1', pin: 'a' },
    );
    expect(useCircuitStore.getState().renameComponent('led1', 'S')).toBe(true);
  });
});

describe('Task 1b: naming a gate/mux/decoder/chip participates in labelSync', () => {
  beforeEach(reset);

  it('naming a gate (single output) propagates to a default-named connected LED', () => {
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [
          { id: 'ng1', kind: 'and', pos: { x: 0, y: 0 }, params: { inputs: 2 } },
          { id: 'nled1', kind: 'led', pos: { x: 100, y: 0 } },
        ],
        wires: [
          {
            id: 'nw1',
            a: { kind: 'pin', component: 'ng1', pin: 'y' },
            b: { kind: 'pin', component: 'nled1', pin: 'a' },
            points: [],
          },
        ],
      },
    }));
    const s = useCircuitStore.getState();
    const ok = s.setComponentParamsBatch([{ id: 'ng1', params: { inputs: 2 }, label: 'foo' }]);
    expect(ok).toBe(true);
    const board = useCircuitStore.getState().board;
    expect(board.components.find((c) => c.id === 'ng1')!.label).toBe('foo');
    expect(board.components.find((c) => c.id === 'nled1')!.label).toBe('foo');
  });

  it('naming a decoder (multi-output) derives <label>.<pinName> per output net', () => {
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [
          { id: 'nd1', kind: 'decoder', pos: { x: 0, y: 0 }, params: { addressBits: 1 } },
          { id: 'nled2', kind: 'led', pos: { x: 100, y: 0 } },
        ],
        wires: [
          {
            id: 'nw2',
            a: { kind: 'pin', component: 'nd1', pin: 'y0' },
            b: { kind: 'pin', component: 'nled2', pin: 'a' },
            points: [],
          },
        ],
      },
    }));
    const s = useCircuitStore.getState();
    const ok = s.setComponentParamsBatch([
      { id: 'nd1', params: { addressBits: 1 }, label: 'dec1' },
    ]);
    expect(ok).toBe(true);
    const board = useCircuitStore.getState().board;
    expect(board.components.find((c) => c.id === 'nd1')!.label).toBe('dec1');
    // led2 sits on dec1's y0 net -> inherits 'dec1.y0', not the bare part name.
    expect(board.components.find((c) => c.id === 'nled2')!.label).toBe('dec1.y0');
  });

  it('Task 7: naming a decoder whose 2 output nets each carry a differently-labeled LED raises 2 conflicts in one publish, resolved as one undo step', () => {
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [
          { id: 'nd2', kind: 'decoder', pos: { x: 0, y: 0 }, params: { addressBits: 1 } },
          { id: 'ledA', kind: 'led', pos: { x: 100, y: 0 }, label: 'A' },
          { id: 'ledB', kind: 'led', pos: { x: 100, y: 20 }, label: 'B' },
        ],
        wires: [
          {
            id: 'nw3',
            a: { kind: 'pin', component: 'nd2', pin: 'y0' },
            b: { kind: 'pin', component: 'ledA', pin: 'a' },
            points: [],
          },
          {
            id: 'nw4',
            a: { kind: 'pin', component: 'nd2', pin: 'y1' },
            b: { kind: 'pin', component: 'ledB', pin: 'a' },
            points: [],
          },
        ],
      },
    }));
    const s = useCircuitStore.getState();
    const ok = s.setComponentParamsBatch([
      { id: 'nd2', params: { addressBits: 1 }, label: 'dec1' },
    ]);
    expect(ok).toBe(true);
    const st1 = useCircuitStore.getState();
    expect(st1.labelConflict).toHaveLength(2);
    expect(st1.labelConflict!.map((r) => r.heading).sort()).toEqual(['dec1.y0', 'dec1.y1']);
    // dec1 itself already committed (naming a multi-output part always
    // applies; only the OUTPUT nets' inherited labels are in question).
    expect(st1.board.components.find((c) => c.id === 'nd2')!.label).toBe('dec1');

    // Apply both rows differently in one call: y0 net keeps 'A', y1 net
    // picks 'dec1.y1' -- Apply always commits every row together.
    const y0 = st1.labelConflict!.findIndex((r) => r.heading === 'dec1.y0');
    const y1 = st1.labelConflict!.findIndex((r) => r.heading === 'dec1.y1');
    const choices: (string | null)[] = [];
    choices[y0] = 'A';
    choices[y1] = 'dec1.y1';
    s.applyLabelConflicts(choices);
    const after = useCircuitStore.getState();
    expect(after.labelConflict).toBeNull();
    expect(after.board.components.find((c) => c.id === 'ledA')!.label).toBe('A');
    expect(after.board.components.find((c) => c.id === 'ledB')!.label).toBe('dec1.y1');

    // One undo step reverts BOTH resolutions together (Apply is one edit
    // spanning every row) without touching the earlier dec1 rename.
    s.undo();
    const undone = useCircuitStore.getState();
    expect(undone.board.components.find((c) => c.id === 'ledB')!.label).toBe('B');
    expect(undone.board.components.find((c) => c.id === 'ledA')!.label).toBe('A');
    expect(undone.board.components.find((c) => c.id === 'nd2')!.label).toBe('dec1');
  });

  it('naming a chip instance derives one label per boundary output pin, via renameComponent', () => {
    const def: ChipDef = {
      format: 'lcir.chip',
      formatVersion: 3,
      id: 'chipdef1',
      name: 'MyChip',
      version: 1,
      pins: [
        {
          id: 'p1',
          name: 'o1',
          dir: 'out',
          width: 1,
          role: 'data',
          order: 0,
          boundComponent: 'b1',
        },
        {
          id: 'p2',
          name: 'o2',
          dir: 'out',
          width: 1,
          role: 'data',
          order: 1,
          boundComponent: 'b2',
        },
      ],
      components: [],
      wires: [],
      junctions: [],
    };
    useCircuitStore.setState((st) => ({
      chipLib: new Map([...st.chipLib, ['chipdef1', def]]),
      board: {
        ...st.board,
        components: [
          { id: 'nc1', kind: 'chip', defId: 'chipdef1', pos: { x: 0, y: 0 } },
          { id: 'nled3', kind: 'led', pos: { x: 100, y: 0 } },
        ],
        wires: [
          {
            id: 'nw3',
            a: { kind: 'pin', component: 'nc1', pin: 'o2' },
            b: { kind: 'pin', component: 'nled3', pin: 'a' },
            points: [],
          },
        ],
      },
    }));
    const ok = useCircuitStore.getState().renameComponent('nc1', 'chip1');
    expect(ok).toBe(true);
    const board = useCircuitStore.getState().board;
    expect(board.components.find((c) => c.id === 'nc1')!.label).toBe('chip1');
    expect(board.components.find((c) => c.id === 'nled3')!.label).toBe('chip1.o2');
  });

  // Live-QA report: naming a mux whose output net already carries an
  // inherited label (e.g. from an earlier rename) silently failed -- root
  // cause was the uniqueness check's `netIds` for a non-DATA_PIN kind being
  // just the component's own id, so a same-net label the mux's OWN output
  // already shares with a connected LED read as "used elsewhere" and
  // rejected the otherwise-legal same-net rename.
  it('renaming a mux to a label its own output net already shares (an inherited LED label) is allowed, not rejected', () => {
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [
          { id: 'nmux1', kind: 'mux', pos: { x: 0, y: 0 }, params: { selectBits: 1 } },
          { id: 'nled4', kind: 'led', pos: { x: 100, y: 0 }, label: 'shared' },
        ],
        wires: [
          {
            id: 'nw4',
            a: { kind: 'pin', component: 'nmux1', pin: 'y' },
            b: { kind: 'pin', component: 'nled4', pin: 'a' },
            points: [],
          },
        ],
      },
    }));
    const ok = useCircuitStore.getState().renameComponent('nmux1', 'shared');
    expect(ok).toBe(true);
    expect(useCircuitStore.getState().board.components.find((c) => c.id === 'nmux1')!.label).toBe(
      'shared',
    );
  });

  it('renaming a mux to a label used on a genuinely DIFFERENT, unconnected net is still rejected', () => {
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [
          { id: 'nmux2', kind: 'mux', pos: { x: 0, y: 0 }, params: { selectBits: 1 } },
          { id: 'nled5', kind: 'led', pos: { x: 100, y: 0 }, label: 'elsewhere' },
        ],
        wires: [],
      },
    }));
    const ok = useCircuitStore.getState().renameComponent('nmux2', 'elsewhere');
    expect(ok).toBe(false);
  });
});

describe('duplicate relabeling', () => {
  it('a duplicated labeled component advances to the next free label', () => {
    useCircuitStore.setState((st) => ({
      selection: new Set(),
      powered: false,
      board: {
        ...st.board,
        components: [{ id: 'in1', kind: 'inport', pos: { x: 0, y: 0 }, label: 'A' }],
        wires: [],
        junctions: [],
      },
    }));
    const s = useCircuitStore.getState();
    s.commitDuplicate(
      {
        components: [{ id: 'in1', kind: 'inport', pos: { x: 0, y: 0 }, label: 'A' }],
        wires: [],
        junctions: [],
      },
      { x: 8, y: 8 },
    );
    const labels = useCircuitStore
      .getState()
      .board.components.map((c) => c.label)
      .sort();
    expect(labels).toEqual(['A', 'B']);
  });
});

describe('clock name + params commit', () => {
  it('commits label and params as ONE undo step', () => {
    useCircuitStore.setState((st) => ({
      selection: new Set(),
      powered: false,
      board: {
        ...st.board,
        components: [{ id: 'ck1', kind: 'clock', pos: { x: 0, y: 0 } }],
        wires: [],
        junctions: [],
      },
    }));
    const s = useCircuitStore.getState();
    const before = useCircuitStore.getState().board;
    expect(s.setComponentParams('ck1', { periodPs: 20_000 }, 'CLK')).toBe(true);
    const after = useCircuitStore.getState().board.components.find((c) => c.id === 'ck1')!;
    expect(after.label).toBe('CLK');
    expect(after.params?.['periodPs']).toBe(20_000);
    s.undo();
    const undone = useCircuitStore.getState().board.components.find((c) => c.id === 'ck1')!;
    expect(undone.label).toBeUndefined();
    expect(undone.params?.['periodPs']).toBeUndefined();
    expect(useCircuitStore.getState().board).toEqual(before);
  });

  it('rejects a duplicate label on another net without touching params', () => {
    useCircuitStore.setState((st) => ({
      selection: new Set(),
      powered: false,
      board: {
        ...st.board,
        components: [
          { id: 'in1', kind: 'inport', pos: { x: 0, y: 0 }, label: 'CLK' },
          { id: 'ck1', kind: 'clock', pos: { x: 80, y: 0 } },
        ],
        wires: [],
        junctions: [],
      },
    }));
    const s = useCircuitStore.getState();
    expect(s.setComponentParams('ck1', { periodPs: 20_000 }, 'CLK')).toBe(false);
    const ck = useCircuitStore.getState().board.components.find((c) => c.id === 'ck1')!;
    expect(ck.label).toBeUndefined();
    expect(ck.params?.['periodPs']).toBeUndefined();
  });
});

describe('M6.5 width edit mismatch surfacing (decision 7)', () => {
  beforeEach(() => {
    reset();
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [
          { id: 'wsw', kind: 'toggle', pos: { x: 0, y: 0 }, params: { width: 1 } },
          { id: 'wg', kind: 'outport', pos: { x: 100, y: 0 }, params: { width: 1 } },
        ],
        wires: [
          {
            id: 'ww1',
            a: { kind: 'pin', component: 'wsw', pin: 'y' },
            b: { kind: 'pin', component: 'wg', pin: 'a' },
            points: [],
          },
        ],
        junctions: [],
      },
    }));
  });

  it('a width edit commits unconditionally, then surfaces the mismatch as an error + warn wire', () => {
    const s = useCircuitStore.getState();
    const ok = s.setComponentParams('wsw', { width: 4 });
    expect(ok).toBe(true); // commits even though it desyncs wg's pin (decision 7)
    const st2 = useCircuitStore.getState();
    expect(st2.board.components.find((c) => c.id === 'wsw')!.params?.['width']).toBe(4);
    expect(st2.error).toMatch(/^width: /);
    expect(st2.mismatchWires.has('ww1')).toBe(true);
  });

  it('widening the consumer to match clears the error and warn wire', () => {
    const s = useCircuitStore.getState();
    s.setComponentParams('wsw', { width: 4 });
    expect(useCircuitStore.getState().mismatchWires.size).toBe(1);
    s.setComponentParams('wg', { width: 4 });
    const st2 = useCircuitStore.getState();
    expect(st2.error).toBeNull();
    expect(st2.mismatchWires.size).toBe(0);
  });

  it('an unrelated topology-changing edit does NOT clear a still-genuine mismatch', () => {
    // Every topology change re-validates (checkWidthMismatch) rather than
    // blindly clearing -- an edit that doesn't actually fix the underlying
    // problem must not make the warning silently disappear.
    const s = useCircuitStore.getState();
    s.setComponentParams('wsw', { width: 4 });
    expect(useCircuitStore.getState().mismatchWires.size).toBe(1);
    s.place('led', { x: 200, y: 0 }, 8);
    const st2 = useCircuitStore.getState();
    expect(st2.mismatchWires.has('ww1')).toBe(true);
    expect(st2.error).toMatch(/^width: /);
  });

  it('undoing the edit that caused the mismatch clears the error and warn wire', () => {
    // Regression: undo previously never re-validated at all, so a stale
    // "width: ..." error/warn-wire from an edit the user had just undone
    // stayed on screen until the next power-on.
    const s = useCircuitStore.getState();
    s.setComponentParams('wsw', { width: 4 });
    expect(useCircuitStore.getState().mismatchWires.size).toBe(1);
    s.undo();
    const st2 = useCircuitStore.getState();
    expect(st2.error).toBeNull();
    expect(st2.mismatchWires.size).toBe(0);
  });

  it('deleting the mismatched wire clears the error even though the underlying width stays desynced', () => {
    // Regression: deleting the offending wire fixes compile (no wire, no
    // width check to fail) even though the two components' widths are still
    // different -- the error must clear because the board now genuinely
    // compiles, not because of a blind "topology changed" guess.
    const s = useCircuitStore.getState();
    s.setComponentParams('wsw', { width: 4 });
    expect(useCircuitStore.getState().mismatchWires.size).toBe(1);
    s.deleteWires(new Set(['ww1']));
    const st2 = useCircuitStore.getState();
    expect(st2.error).toBeNull();
    expect(st2.mismatchWires.size).toBe(0);
  });
});

describe('M6.6 Phase 6: pinView reshapes drop stale wires in one undo step', () => {
  beforeEach(() => {
    reset();
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [
          { id: 'gsw', kind: 'toggle', pos: { x: 0, y: 0 }, params: { width: 3 } },
          { id: 'g1', kind: 'and', pos: { x: 100, y: 0 }, params: { width: 3, inputs: 2 } },
        ],
        wires: [
          {
            id: 'gw1',
            a: { kind: 'pin', component: 'gsw', pin: 'y' },
            b: { kind: 'pin', component: 'g1', pin: 'a' },
            points: [],
          },
        ],
        junctions: [],
      },
    }));
  });

  it('expanding a wired-to pin rewires bit-for-bit onto the far side (also expanded), in one undo step', () => {
    const s = useCircuitStore.getState();
    const ok = s.setComponentParams('g1', { pinView: 'a=expanded' });
    expect(ok).toBe(true);
    const st2 = useCircuitStore.getState();
    // The original bus wire is gone, replaced by one wire per bit; bit i on
    // one side is always named `<base>i` on both sides, so gsw's own `y`
    // group had to expand too (its wire never carried a real bus, just a
    // wide pin the width happened to match) for the rewire to make sense.
    expect(st2.board.wires.find((w) => w.id === 'gw1')).toBeUndefined();
    const byBit = st2.board.wires.filter((w) => {
      const e = pinEndOf(w, 'g1');
      return !!e && /^a\d$/.test(e.pin!);
    });
    expect(byBit).toHaveLength(3);
    for (const w of byBit) {
      const mine = pinEndOf(w, 'g1')!;
      const other = otherEndOf(w, 'g1');
      expect(other.kind === 'pin' && other.pin).toBe(mine.pin!.replace('a', 'y'));
    }
    expect(st2.board.components.find((c) => c.id === 'g1')!.params?.['pinView']).toBe('a=expanded');
    expect(st2.board.components.find((c) => c.id === 'gsw')!.params?.['pinView']).toBe(
      'y=expanded',
    );
    // Single undo reverts the param changes on BOTH components and restores
    // the original single bus wire together.
    useCircuitStore.getState().undo();
    const st3 = useCircuitStore.getState();
    expect(st3.board.wires.find((w) => w.id === 'gw1')).toBeDefined();
    expect(st3.board.wires).toHaveLength(1);
    expect(st3.board.components.find((c) => c.id === 'g1')!.params?.['pinView']).toBeUndefined();
    expect(st3.board.components.find((c) => c.id === 'gsw')!.params?.['pinView']).toBeUndefined();
  });

  it('expanding a wired-to pin drops its wire when the far side cannot also expand', () => {
    // oo1's 'bus' pin (split primitive) has no pinView group of its own to
    // expand into -- no safe bit-for-bit target exists, so this still drops,
    // same as before this fix.
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [
          ...st.board.components,
          { id: 'oo1', kind: 'split', pos: { x: 200, y: 0 }, params: { width: 3 } },
        ],
        wires: [
          ...st.board.wires,
          {
            id: 'gw3',
            a: { kind: 'pin', component: 'g1', pin: 'y' },
            b: { kind: 'pin', component: 'oo1', pin: 'bus' },
            points: [],
          },
        ],
      },
    }));
    const ok = useCircuitStore.getState().setComponentParams('g1', { pinView: 'y=expanded' });
    expect(ok).toBe(true);
    expect(useCircuitStore.getState().board.wires.find((w) => w.id === 'gw3')).toBeUndefined();
  });

  it('expanding a gate output wired directly (no junction) to an Out port produces one wire per bit', () => {
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [
          ...st.board.components,
          { id: 'oo2', kind: 'outport', pos: { x: 200, y: 0 }, params: { width: 3 } },
        ],
        wires: [
          ...st.board.wires,
          {
            id: 'gw4',
            a: { kind: 'pin', component: 'g1', pin: 'y' },
            b: { kind: 'pin', component: 'oo2', pin: 'a' },
            points: [],
          },
        ],
      },
    }));
    const ok = useCircuitStore.getState().setComponentParams('g1', { pinView: 'y=expanded' });
    expect(ok).toBe(true);
    const st2 = useCircuitStore.getState();
    expect(st2.board.wires.find((w) => w.id === 'gw4')).toBeUndefined();
    const byBit = st2.board.wires.filter((w) => {
      const e = pinEndOf(w, 'g1');
      return !!e && /^y\d$/.test(e.pin!);
    });
    expect(byBit).toHaveLength(3);
    for (const w of byBit) {
      const mine = pinEndOf(w, 'g1')!;
      const other = otherEndOf(w, 'g1');
      expect(other.kind === 'pin' && other.component).toBe('oo2');
      expect(other.kind === 'pin' && other.pin).toBe(mine.pin!.replace('y', 'a'));
    }
    expect(st2.board.components.find((c) => c.id === 'oo2')!.params?.['pinView']).toBe(
      'a=expanded',
    );
  });

  it('collapsing an expanded lane retargets its wire onto the merged pin instead of dropping it', () => {
    const s = useCircuitStore.getState();
    s.setComponentParams('g1', { pinView: 'a=expanded' });
    // Wire the individual a2 lane while expanded (simulating the owner's real
    // workflow: expand to wire bits individually).
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        wires: [
          ...st.board.wires,
          {
            id: 'gw2',
            a: { kind: 'pin', component: 'gsw', pin: 'y' },
            b: { kind: 'pin', component: 'g1', pin: 'a2' },
            points: [],
          },
        ],
      },
    }));
    const ok = useCircuitStore.getState().setComponentParams('g1', { pinView: 'a=collapsed' });
    expect(ok).toBe(true);
    const st2 = useCircuitStore.getState();
    const migrated = st2.board.wires.find((w) => w.id === 'gw2')!;
    expect(migrated).toBeDefined();
    expect(migrated.b).toEqual({ kind: 'pin', component: 'g1', pin: 'a' });
  });

  it('expand then collapse a fanned-out output round-trips to exactly one wire (no duplicates)', () => {
    // g1.y (width 3) fans out to a single led -- expanding auto-expands the
    // led's own `a` group and rewires bit-for-bit (3 wires); collapsing
    // back should merge those 3 wires into one again, not leave 3 wires
    // stacked onto the same now-mismatched pin.
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [
          ...st.board.components,
          { id: 'led1', kind: 'led', pos: { x: 200, y: 0 }, params: { width: 3 } },
        ],
        wires: [
          ...st.board.wires,
          {
            id: 'yw1',
            a: { kind: 'pin', component: 'g1', pin: 'y' },
            b: { kind: 'pin', component: 'led1', pin: 'a' },
            points: [],
          },
        ],
      },
    }));
    useCircuitStore.getState().setComponentParams('g1', { pinView: 'y=expanded' });
    expect(useCircuitStore.getState().board.wires).toHaveLength(4); // gw1 + 3 bit wires
    const ok = useCircuitStore.getState().setComponentParams('g1', { pinView: 'y=collapsed' });
    expect(ok).toBe(true);
    const st2 = useCircuitStore.getState();
    expect(st2.board.wires).toHaveLength(2); // gw1 unchanged + one merged y<->a wire
    const merged = st2.board.wires.find(
      (w) => w.a.kind === 'pin' && w.a.component === 'g1' && w.a.pin === 'y',
    )!;
    expect(merged).toBeDefined();
    expect(merged.b).toEqual({ kind: 'pin', component: 'led1', pin: 'a' });
    expect(st2.board.components.find((c) => c.id === 'led1')!.params?.['pinView']).toBe(
      'a=collapsed',
    );
  });

  it('mux select-group collapse retargets an s0 wire onto the merged "s" pin', () => {
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [
          ...st.board.components,
          { id: 'msw', kind: 'toggle', pos: { x: 200, y: 0 }, params: { width: 1 } },
          { id: 'mx1', kind: 'mux', pos: { x: 300, y: 0 }, params: { inputs: 4 } },
        ],
        wires: [
          ...st.board.wires,
          {
            id: 'mw1',
            a: { kind: 'pin', component: 'msw', pin: 'y' },
            b: { kind: 'pin', component: 'mx1', pin: 's0' },
            points: [],
          },
        ],
      },
    }));
    const ok = useCircuitStore
      .getState()
      .setComponentParams('mx1', { inputs: 4, pinView: 's=collapsed' });
    expect(ok).toBe(true);
    const st2 = useCircuitStore.getState();
    const migrated = st2.board.wires.find((w) => w.id === 'mw1')!;
    expect(migrated.b).toEqual({ kind: 'pin', component: 'mx1', pin: 's' });
  });

  it('mux select-group collapse merges one switch per select line into a single bank', () => {
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [
          ...st.board.components,
          { id: 'bsw0', kind: 'toggle', pos: { x: 200, y: 0 }, params: { width: 1 } },
          { id: 'bsw1', kind: 'toggle', pos: { x: 200, y: 60 }, params: { width: 1 } },
          { id: 'mx3', kind: 'mux', pos: { x: 300, y: 0 }, params: { selectBits: 2 } },
        ],
        wires: [
          ...st.board.wires,
          {
            id: 'bw0',
            a: { kind: 'pin', component: 'bsw0', pin: 'y' },
            b: { kind: 'pin', component: 'mx3', pin: 's0' },
            points: [],
          },
          {
            id: 'bw1',
            a: { kind: 'pin', component: 'bsw1', pin: 'y' },
            b: { kind: 'pin', component: 'mx3', pin: 's1' },
            points: [],
          },
        ],
      },
    }));
    const ok = useCircuitStore.getState().setComponentParams('mx3', { pinView: 's=collapsed' });
    expect(ok).toBe(true);
    const st2 = useCircuitStore.getState();
    // Bit 0's switch survives, widened; bit 1's is gone with its wire.
    expect(st2.board.components.find((c) => c.id === 'bsw0')!.params?.['width']).toBe(2);
    expect(st2.board.components.find((c) => c.id === 'bsw1')).toBeUndefined();
    const left = st2.board.wires.filter(
      (w) => pinEndOf(w, 'mx3')?.pin === 's' || pinEndOf(w, 'bsw0'),
    );
    expect(left).toHaveLength(1);
    expect(otherEndOf(left[0]!, 'mx3')).toEqual({ kind: 'pin', component: 'bsw0', pin: 'y' });
    // One undo step restores both switches and both bit wires.
    useCircuitStore.getState().undo();
    const st3 = useCircuitStore.getState();
    expect(st3.board.components.find((c) => c.id === 'bsw1')).toBeDefined();
    expect(st3.board.wires.map((w) => w.id)).toEqual(expect.arrayContaining(['bw0', 'bw1']));
  });

  it('mux data-group expand rewires bit-for-bit onto a collapsed toggle bus (indexed pin convention)', () => {
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [
          ...st.board.components,
          { id: 'dsw', kind: 'toggle', pos: { x: 200, y: 0 }, params: { width: 4 } },
          {
            id: 'mx2',
            kind: 'mux',
            pos: { x: 300, y: 0 },
            params: { inputs: 4, pinView: 'd=collapsed' },
          },
        ],
        wires: [
          ...st.board.wires,
          {
            id: 'mw2',
            a: { kind: 'pin', component: 'dsw', pin: 'y' },
            b: { kind: 'pin', component: 'mx2', pin: 'd' },
            points: [],
          },
        ],
      },
    }));
    const ok = useCircuitStore.getState().setComponentParams('mx2', { pinView: 'd=expanded' });
    expect(ok).toBe(true);
    const st2 = useCircuitStore.getState();
    expect(st2.board.wires.find((w) => w.id === 'mw2')).toBeUndefined();
    const byBit = st2.board.wires.filter((w) => {
      const e = pinEndOf(w, 'mx2');
      return !!e && /^d\d$/.test(e.pin!);
    });
    expect(byBit).toHaveLength(4);
    for (const w of byBit) {
      const mine = pinEndOf(w, 'mx2')!;
      const other = otherEndOf(w, 'mx2');
      expect(other.kind === 'pin' && other.pin).toBe(mine.pin!.replace('d', 'y'));
    }
    expect(st2.board.components.find((c) => c.id === 'dsw')!.params?.['pinView']).toBe(
      'y=expanded',
    );
  });

  it('collapsing one lane-expanded-indexed group (demux y0) merges its bit wires without touching a sibling line (y1)', () => {
    // Regression: a far pin like 'd00' (mux data line 0, bit 0) is ambiguous
    // by blind digit-stripping -- 'd0' and 'd' are both syntactically valid
    // prefixes. Collapsing demux's y0 line (itself lane-expanded to y00/y01)
    // while y1 stays expanded (y10/y11) must resolve the far group as mux's
    // 'd0', not 'd', or it silently fails to merge (or worse, merges into
    // the wrong group).
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [
          ...st.board.components,
          {
            id: 'dmx1',
            kind: 'demux',
            pos: { x: 200, y: 0 },
            params: { outputs: 2, width: 2, pinView: 'y0=expanded;y1=expanded' },
          },
          {
            id: 'mx3',
            kind: 'mux',
            pos: { x: 300, y: 0 },
            params: { inputs: 2, width: 2, pinView: 'd0=expanded;d1=expanded' },
          },
        ],
        wires: [
          ...st.board.wires,
          {
            id: 'nw1',
            a: { kind: 'pin', component: 'dmx1', pin: 'y00' },
            b: { kind: 'pin', component: 'mx3', pin: 'd00' },
            points: [],
          },
          {
            id: 'nw2',
            a: { kind: 'pin', component: 'dmx1', pin: 'y01' },
            b: { kind: 'pin', component: 'mx3', pin: 'd01' },
            points: [],
          },
          {
            id: 'nw3',
            a: { kind: 'pin', component: 'dmx1', pin: 'y10' },
            b: { kind: 'pin', component: 'mx3', pin: 'd10' },
            points: [],
          },
          {
            id: 'nw4',
            a: { kind: 'pin', component: 'dmx1', pin: 'y11' },
            b: { kind: 'pin', component: 'mx3', pin: 'd11' },
            points: [],
          },
        ],
      },
    }));
    const ok = useCircuitStore
      .getState()
      .setComponentParams('dmx1', { pinView: 'y0=collapsed;y1=expanded' });
    expect(ok).toBe(true);
    const st2 = useCircuitStore.getState();
    // y1's own two bit wires are untouched.
    expect(st2.board.wires.find((w) => w.id === 'nw3')).toBeDefined();
    expect(st2.board.wires.find((w) => w.id === 'nw4')).toBeDefined();
    // y0's two bit wires merged into exactly one y0<->d0 wire.
    expect(st2.board.wires.find((w) => w.id === 'nw1')).toBeUndefined();
    expect(st2.board.wires.find((w) => w.id === 'nw2')).toBeUndefined();
    const merged = st2.board.wires.filter(
      (w) => w.a.kind === 'pin' && w.a.component === 'dmx1' && w.a.pin === 'y0',
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.b).toEqual({ kind: 'pin', component: 'mx3', pin: 'd0' });
    expect(st2.board.wires).toHaveLength(4); // gw1 (untouched), nw3, nw4, merged
    expect(st2.board.components.find((c) => c.id === 'mx3')!.params?.['pinView']).toBe(
      'd0=collapsed;d1=expanded',
    );
  });

  it('expanding a toggle (the switch, not the gate) auto-expands the connected gate input bit-for-bit', () => {
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [
          ...st.board.components,
          { id: 'swx', kind: 'toggle', pos: { x: 200, y: 0 }, params: { width: 2 } },
          { id: 'g9', kind: 'and', pos: { x: 300, y: 0 }, params: { width: 2, inputs: 2 } },
        ],
        wires: [
          ...st.board.wires,
          {
            id: 'sw1',
            a: { kind: 'pin', component: 'swx', pin: 'y' },
            b: { kind: 'pin', component: 'g9', pin: 'a' },
            points: [],
          },
        ],
      },
    }));
    const ok = useCircuitStore.getState().setComponentParams('swx', { pinView: 'y=expanded' });
    expect(ok).toBe(true);
    const st2 = useCircuitStore.getState();
    expect(st2.board.wires.find((w) => w.id === 'sw1')).toBeUndefined();
    const byBit = st2.board.wires.filter((w) => {
      const e = pinEndOf(w, 'swx');
      return !!e && /^y\d$/.test(e.pin!);
    });
    expect(byBit).toHaveLength(2);
    for (const w of byBit) {
      const mine = pinEndOf(w, 'swx')!;
      const other = otherEndOf(w, 'swx');
      expect(other.kind === 'pin' && other.pin).toBe(mine.pin!.replace('y', 'a'));
    }
    expect(st2.board.components.find((c) => c.id === 'g9')!.params?.['pinView']).toBe('a=expanded');
  });

  it('expanding a toggle through the real overlay call shape (label always sent alongside params) still propagates', () => {
    // Regression: the double-click param overlay's commitParamEdit ALWAYS
    // sends a `label` for toggle/led/probe (labelable=true, seeded from the
    // component's own current label/id at open time -- '' when unset), even
    // when the user never touched the name field. setComponentParams used to
    // route "label !== undefined" through renameWith's plain param merge
    // instead of applyParamsDroppingRemovedPins, silently skipping all the
    // pin-drop/rewire logic above for every toggle/led/probe edit made via
    // the overlay -- the store-only calls elsewhere in this file (no label
    // argument) never exercised that branch, which is why they kept passing
    // while the real app didn't.
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [
          ...st.board.components,
          { id: 'swy', kind: 'toggle', pos: { x: 400, y: 0 }, params: { width: 2 } },
          { id: 'g10', kind: 'and', pos: { x: 500, y: 0 }, params: { width: 2, inputs: 2 } },
        ],
        wires: [
          ...st.board.wires,
          {
            id: 'sw2',
            a: { kind: 'pin', component: 'swy', pin: 'y' },
            b: { kind: 'pin', component: 'g10', pin: 'a' },
            points: [],
          },
        ],
      },
    }));
    const ok = useCircuitStore
      .getState()
      .setComponentParams('swy', { width: 2, pinView: 'y=expanded' }, '');
    expect(ok).toBe(true);
    const st2 = useCircuitStore.getState();
    expect(st2.board.wires.find((w) => w.id === 'sw2')).toBeUndefined();
    expect(st2.error).toBeNull();
    const byBit = st2.board.wires.filter((w) => {
      const e = pinEndOf(w, 'swy');
      return !!e && /^y\d$/.test(e.pin!);
    });
    expect(byBit).toHaveLength(2);
  });
});

describe('pinView expand/collapse: direct multi-wire fan-in (no junction)', () => {
  // A switch AND an In label both wired straight to the same gate input, no
  // junction between them (legal -- a label is never a real second driver).
  beforeEach(() => {
    reset();
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [
          { id: 'fsw', kind: 'toggle', pos: { x: 0, y: 0 }, params: { width: 2 } },
          { id: 'fin', kind: 'inport', pos: { x: 0, y: 40 }, params: { width: 2 } },
          { id: 'fg1', kind: 'and', pos: { x: 100, y: 0 }, params: { width: 2, inputs: 2 } },
        ],
        wires: [
          {
            id: 'fw1',
            a: { kind: 'pin', component: 'fsw', pin: 'y' },
            b: { kind: 'pin', component: 'fg1', pin: 'a' },
            points: [],
          },
          {
            id: 'fw2',
            a: { kind: 'pin', component: 'fin', pin: 'y' },
            b: { kind: 'pin', component: 'fg1', pin: 'a' },
            points: [],
          },
        ],
        junctions: [],
      },
    }));
  });

  it('expanding via one of the two fan-in sources (not the gate) still propagates to the OTHER source too', () => {
    // Bug: expanding via fin's own param only rewired fin's own wire,
    // leaving fsw's wire dangling on the now-gone collapsed 'a' pin.
    const ok = useCircuitStore.getState().setComponentParams('fin', { pinView: 'y=expanded' });
    expect(ok).toBe(true);
    const st2 = useCircuitStore.getState();
    expect(st2.board.wires.find((w) => w.id === 'fw1')).toBeUndefined();
    expect(st2.board.wires.find((w) => w.id === 'fw2')).toBeUndefined();
    const fromSw = st2.board.wires.filter((w) => pinEndOf(w, 'fsw'));
    const fromIn = st2.board.wires.filter((w) => pinEndOf(w, 'fin'));
    expect(fromSw).toHaveLength(2);
    expect(fromIn).toHaveLength(2);
    for (const w of [...fromSw, ...fromIn]) {
      const other = otherEndOf(w, pinEndOf(w, 'fsw') ? 'fsw' : 'fin');
      expect(other.kind === 'pin' && other.component).toBe('fg1');
      expect(other.kind === 'pin' && /^a\d$/.test(other.pin!)).toBe(true);
    }
    expect(st2.board.components.find((c) => c.id === 'fg1')!.params?.['pinView']).toBe(
      'a=expanded',
    );
    expect(st2.board.components.find((c) => c.id === 'fsw')!.params?.['pinView']).toBe(
      'y=expanded',
    );
  });

  it('collapsing via the gate after both fan-in sources are expanded merges cleanly, no width mismatch', () => {
    // Bug: collapsing via fg1's own param left fsw/fin still expanded,
    // producing width-mismatched wires (net width 1 vs pin width 2).
    useCircuitStore.getState().setComponentParams('fg1', { pinView: 'a=expanded' });
    const ok = useCircuitStore.getState().setComponentParams('fg1', { pinView: 'a=collapsed' });
    expect(ok).toBe(true);
    const st2 = useCircuitStore.getState();
    const touchingGate = st2.board.wires.filter((w) => pinEndOf(w, 'fg1'));
    expect(touchingGate).toHaveLength(2); // one merged wire each from fsw and fin
    for (const w of touchingGate) {
      const mine = pinEndOf(w, 'fg1')!;
      expect(mine.pin).toBe('a');
    }
    expect(
      touchingGate.some(
        (w) =>
          otherEndOf(w, 'fg1').kind === 'pin' &&
          (otherEndOf(w, 'fg1') as { component?: string }).component === 'fsw',
      ),
    ).toBe(true);
    expect(
      touchingGate.some(
        (w) =>
          otherEndOf(w, 'fg1').kind === 'pin' &&
          (otherEndOf(w, 'fg1') as { component?: string }).component === 'fin',
      ),
    ).toBe(true);
    expect(st2.board.components.find((c) => c.id === 'fsw')!.params?.['pinView']).toBe(
      'y=collapsed',
    );
    expect(st2.board.components.find((c) => c.id === 'fin')!.params?.['pinView']).toBe(
      'y=collapsed',
    );
  });
});

describe('pinView expand/collapse through a junction', () => {
  beforeEach(() => {
    reset();
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [{ id: 'jsw', kind: 'toggle', pos: { x: 0, y: 0 }, params: { width: 3 } }],
        wires: [
          {
            id: 'jw1',
            a: { kind: 'pin', component: 'jsw', pin: 'y' },
            b: { kind: 'junction', junction: 'jj1' },
            points: [],
          },
        ],
        junctions: [{ id: 'jj1', pos: { x: 40, y: 0 } }],
      },
    }));
  });

  it('expanding a pin wired to a junction keeps the connection, one wire per bit to the same junction', () => {
    const ok = useCircuitStore.getState().setComponentParams('jsw', { pinView: 'y=expanded' });
    expect(ok).toBe(true);
    const st2 = useCircuitStore.getState();
    expect(st2.board.wires.find((w) => w.id === 'jw1')).toBeUndefined();
    const byBit = st2.board.wires.filter(
      (w) => w.a.kind === 'pin' && w.a.component === 'jsw' && /^y\d$/.test(w.a.pin),
    );
    expect(byBit).toHaveLength(3);
    for (const w of byBit) expect(w.b).toEqual({ kind: 'junction', junction: 'jj1' });
    // Round-trips back to a single wire on undo.
    useCircuitStore.getState().undo();
    const st3 = useCircuitStore.getState();
    expect(st3.board.wires).toHaveLength(1);
    expect(st3.board.wires[0]!.b).toEqual({ kind: 'junction', junction: 'jj1' });
  });

  it('collapsing bit-wires that all share one junction merges them into a single wire', () => {
    useCircuitStore.getState().setComponentParams('jsw', { pinView: 'y=expanded' });
    const ok = useCircuitStore.getState().setComponentParams('jsw', { pinView: 'y=collapsed' });
    expect(ok).toBe(true);
    const st2 = useCircuitStore.getState();
    const fromSw = st2.board.wires.filter((w) => w.a.kind === 'pin' && w.a.component === 'jsw');
    expect(fromSw).toHaveLength(1);
    expect(fromSw[0]!.a).toEqual({ kind: 'pin', component: 'jsw', pin: 'y' });
    // The merged wire is jj1's only remaining leg, so the generic post-edit
    // collapseJunctions pass (degree-1 = pointless) folds the junction away,
    // converting the wire's far end to a plain free end at its position --
    // same outcome a manual two-wire merge through a junction would produce.
    expect(fromSw[0]!.b).toEqual({ kind: 'free', pos: { x: 40, y: 0 } });
    expect(st2.board.junctions.find((j) => j.id === 'jj1')).toBeUndefined();
  });

  it('collapsing bit-wires that point at DIFFERENT junctions retargets each individually instead of merging', () => {
    useCircuitStore.getState().setComponentParams('jsw', { pinView: 'y=expanded' });
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        wires: st.board.wires.map((w) =>
          w.a.kind === 'pin' && w.a.pin === 'y2'
            ? { ...w, b: { kind: 'junction' as const, junction: 'jj2' } }
            : w,
        ),
        junctions: [...st.board.junctions, { id: 'jj2', pos: { x: 40, y: 40 } }],
      },
    }));
    const ok = useCircuitStore.getState().setComponentParams('jsw', { pinView: 'y=collapsed' });
    expect(ok).toBe(true);
    const st2 = useCircuitStore.getState();
    // No single far junction to point the merged pin at, so nothing merges
    // -- each wire keeps its own far end and just retargets its near pin
    // onto the collapsed 'y' pin (the pin-to-pin case's existing behavior,
    // not a junction-specific drop).
    const fromSw = st2.board.wires.filter((w) => w.a.kind === 'pin' && w.a.component === 'jsw');
    expect(fromSw).toHaveLength(3);
    expect(fromSw.every((w) => w.a.kind === 'pin' && w.a.pin === 'y')).toBe(true);
  });

  it('expanding through a junction with real fan-out propagates to every branch, not just ours', () => {
    // g1.y (width 3) fans out at a junction to BOTH an LED and an Out port --
    // expanding g1's y must expand both far sides too, replacing the one
    // junction with 3 per-bit junctions each carrying all 3 branches; a
    // mismatched width>1 wire at any branch is the exact bug being fixed.
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [
          { id: 'g1', kind: 'and', pos: { x: 0, y: 0 }, params: { width: 3, inputs: 2 } },
          { id: 'led1', kind: 'led', pos: { x: 100, y: 0 }, params: { width: 3 } },
          { id: 'out1', kind: 'outport', pos: { x: 100, y: 40 }, params: { width: 3 } },
        ],
        wires: [
          {
            id: 'fw0',
            a: { kind: 'pin', component: 'g1', pin: 'y' },
            b: { kind: 'junction', junction: 'fj1' },
            points: [],
          },
          {
            id: 'fw1',
            a: { kind: 'junction', junction: 'fj1' },
            b: { kind: 'pin', component: 'led1', pin: 'a' },
            points: [],
          },
          {
            id: 'fw2',
            a: { kind: 'junction', junction: 'fj1' },
            b: { kind: 'pin', component: 'out1', pin: 'a' },
            points: [],
          },
        ],
        junctions: [{ id: 'fj1', pos: { x: 50, y: 20 } }],
      },
    }));
    const ok = useCircuitStore.getState().setComponentParams('g1', { pinView: 'y=expanded' });
    expect(ok).toBe(true);
    const st2 = useCircuitStore.getState();
    // Original junction is gone, replaced by 3 per-bit junctions.
    expect(st2.board.junctions.find((j) => j.id === 'fj1')).toBeUndefined();
    expect(st2.board.junctions).toHaveLength(3);
    // Both far components auto-expanded to match.
    expect(st2.board.components.find((c) => c.id === 'led1')!.params?.['pinView']).toBe(
      'a=expanded',
    );
    expect(st2.board.components.find((c) => c.id === 'out1')!.params?.['pinView']).toBe(
      'a=expanded',
    );
    // Every per-bit junction carries exactly 3 wires: g1.yI, led1.aI, out1.aI.
    for (const j of st2.board.junctions) {
      const touching = st2.board.wires.filter(
        (w) =>
          (w.a.kind === 'junction' && w.a.junction === j.id) ||
          (w.b.kind === 'junction' && w.b.junction === j.id),
      );
      expect(touching).toHaveLength(3);
      const pins = touching.map((w) => (w.a.kind === 'pin' ? w.a : w.b) as { pin: string });
      const bit = pins.find((p) => p.pin.startsWith('y'))!.pin.slice(1);
      expect(pins.map((p) => p.pin).sort()).toEqual([`a${bit}`, `a${bit}`, `y${bit}`].sort());
    }
    // Round-trips cleanly on undo.
    useCircuitStore.getState().undo();
    const st3 = useCircuitStore.getState();
    expect(st3.board.junctions).toHaveLength(1);
    expect(st3.board.junctions[0]!.id).toBe('fj1');
    expect(st3.board.wires).toHaveLength(3);
  });

  it('per-bit junctions from a fan-out expand never land at the exact same position', () => {
    // Same repro as the fan-out test above but with a probe added as a 3rd
    // branch and width bumped from 1 -> 2 first (the owner's real workflow:
    // wire at width 1, THEN widen, THEN pinView-expand) -- data-level result
    // was always correct here; the actual bug was every new per-bit junction
    // sharing the OLD junction's exact pos, so bit 1's dot renders exactly
    // on top of bit 0's and reads as "only bit 0 got connected."
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [
          { id: 'rg1', kind: 'and', pos: { x: 0, y: 0 }, params: { width: 1, inputs: 2 } },
          { id: 'rled', kind: 'led', pos: { x: 100, y: -40 }, params: { width: 1 } },
          { id: 'rout', kind: 'outport', pos: { x: 100, y: 0 }, params: { width: 1 } },
          { id: 'rprobe', kind: 'probe', pos: { x: 100, y: 40 }, params: { width: 1 } },
        ],
        wires: [
          {
            id: 'rw0',
            a: { kind: 'pin', component: 'rg1', pin: 'y' },
            b: { kind: 'junction', junction: 'rj1' },
            points: [],
          },
          {
            id: 'rw1',
            a: { kind: 'junction', junction: 'rj1' },
            b: { kind: 'pin', component: 'rled', pin: 'a' },
            points: [],
          },
          {
            id: 'rw2',
            a: { kind: 'junction', junction: 'rj1' },
            b: { kind: 'pin', component: 'rout', pin: 'a' },
            points: [],
          },
          {
            id: 'rw3',
            a: { kind: 'junction', junction: 'rj1' },
            b: { kind: 'pin', component: 'rprobe', pin: 'a' },
            points: [],
          },
        ],
        junctions: [{ id: 'rj1', pos: { x: 50, y: 0 } }],
      },
    }));
    const s = useCircuitStore.getState();
    for (const id of ['rg1', 'rled', 'rout', 'rprobe']) s.setComponentParams(id, { width: 2 });
    const ok = useCircuitStore.getState().setComponentParams('rg1', { pinView: 'y=expanded' });
    expect(ok).toBe(true);
    const final = useCircuitStore.getState().board;
    expect(final.junctions).toHaveLength(2);
    const [j0, j1] = final.junctions;
    expect(j0!.pos).not.toEqual(j1!.pos);
    for (const j of final.junctions) {
      const touching = final.wires.filter(
        (w) =>
          (w.a.kind === 'junction' && w.a.junction === j.id) ||
          (w.b.kind === 'junction' && w.b.junction === j.id),
      );
      expect(touching).toHaveLength(4); // rg1, rled, rout, rprobe
    }
  });
});

describe('M6.6 follow-up: bubble mode never blocks entry on a wide gate/terminal (per-gate refusal only)', () => {
  beforeEach(reset);

  it('entry succeeds with a width>1 terminal present on the board', () => {
    useCircuitStore.setState((st) => ({
      mode: 'edit' as const,
      board: {
        ...st.board,
        components: [
          { id: 'sw3', kind: 'toggle', pos: { x: 0, y: 0 }, params: { width: 4 }, label: 'sw3' },
          { id: 'out1', kind: 'outport', pos: { x: 40, y: 0 }, params: { width: 4 } },
        ],
        wires: [
          {
            id: 'w1',
            a: { kind: 'pin', component: 'sw3', pin: 'y' },
            b: { kind: 'pin', component: 'out1', pin: 'a' },
            points: [],
          },
        ],
      },
    }));
    const s = useCircuitStore.getState();
    s.enterBubbleMode();
    const st2 = useCircuitStore.getState();
    expect(st2.mode).toBe('bubble');
    expect(st2.error).toBeNull();
  });

  it('entry succeeds with a width>1 input pin present (a different terminal kind than toggle)', () => {
    useCircuitStore.setState((st) => ({
      mode: 'edit' as const,
      board: {
        ...st.board,
        components: [
          { id: 'in1', kind: 'inport', pos: { x: 0, y: 0 }, params: { width: 2 } },
          { id: 'out1', kind: 'outport', pos: { x: 80, y: 0 }, params: { width: 2 } },
        ],
        wires: [
          {
            id: 'w1',
            a: { kind: 'pin', component: 'in1', pin: 'y' },
            b: { kind: 'pin', component: 'out1', pin: 'a' },
            points: [],
          },
        ],
      },
    }));
    const s = useCircuitStore.getState();
    s.enterBubbleMode();
    const st2 = useCircuitStore.getState();
    expect(st2.mode).toBe('bubble');
    expect(st2.error).toBeNull();
  });

  it('a 1-bit gate-family component is fine -- entry succeeds on an otherwise-valid 1-bit circuit', () => {
    useCircuitStore.setState((st) => ({
      mode: 'edit' as const,
      board: {
        ...st.board,
        components: [
          { id: 'in1', kind: 'inport', pos: { x: 0, y: 0 } },
          { id: 'g1', kind: 'and', pos: { x: 40, y: 0 } },
          { id: 'out1', kind: 'outport', pos: { x: 80, y: 0 } },
        ],
        wires: [
          {
            id: 'w1',
            a: { kind: 'pin', component: 'in1', pin: 'y' },
            b: { kind: 'pin', component: 'g1', pin: 'a' },
            points: [],
          },
          {
            id: 'w2',
            a: { kind: 'pin', component: 'g1', pin: 'y' },
            b: { kind: 'pin', component: 'out1', pin: 'a' },
            points: [],
          },
        ],
      },
    }));
    const s = useCircuitStore.getState();
    s.enterBubbleMode();
    expect(useCircuitStore.getState().mode).toBe('bubble');
  });

  it('entry succeeds with a width>1 gate present; pushing that specific gate still refuses', () => {
    useCircuitStore.setState((st) => ({
      mode: 'edit' as const,
      board: {
        ...st.board,
        components: [
          { id: 'in1', kind: 'inport', pos: { x: 0, y: 0 }, params: { width: 4 } },
          {
            id: 'g1',
            kind: 'and',
            pos: { x: 40, y: 0 },
            label: 'g1',
            params: { width: 4, outputBubble: true },
          },
          { id: 'out1', kind: 'outport', pos: { x: 80, y: 0 }, params: { width: 4 } },
        ],
        wires: [
          {
            id: 'w1',
            a: { kind: 'pin', component: 'in1', pin: 'y' },
            b: { kind: 'pin', component: 'g1', pin: 'a' },
            points: [],
          },
          {
            id: 'w2',
            a: { kind: 'pin', component: 'g1', pin: 'y' },
            b: { kind: 'pin', component: 'out1', pin: 'a' },
            points: [],
          },
        ],
      },
    }));
    const s = useCircuitStore.getState();
    s.enterBubbleMode();
    const st2 = useCircuitStore.getState();
    expect(st2.mode).toBe('bubble'); // never blocked entirely (M6.6 follow-up)
    expect(st2.error).toBeNull();
    // The wide gate itself refuses the push (would otherwise succeed: it
    // carries an output bubble already) -- per-gate refusal, core layer.
    expect(pushOutputBackward(st2.board, 'g1')).toBeNull();
  });
});

describe('multi-driver pre-commit rejection (general case, not just In/Out labels)', () => {
  beforeEach(() =>
    useCircuitStore.setState({
      board: emptyBoard(),
      chipLib: new Map(),
      tabs: [{ id: 'board', kind: 'board' }],
      activeTabId: 'board',
      staleInstances: new Set(),
      selection: new Set(),
      powered: false,
      error: null,
    }),
  );

  it('addWire rejects two non-tristate gate outputs wired directly together', () => {
    const s = useCircuitStore.getState();
    s.place('not', { x: 0, y: 0 }, 8);
    s.place('not', { x: 100, y: 0 }, 8);
    const [g1, g2] = useCircuitStore.getState().board.components;
    const ok = s.addWire(
      { kind: 'pin', component: g1!.id, pin: 'y' },
      { kind: 'pin', component: g2!.id, pin: 'y' },
    );
    expect(ok).toBe(false);
    expect(useCircuitStore.getState().board.wires).toHaveLength(0);
    expect(useCircuitStore.getState().error).toMatch(/drive the same wire/);
  });

  it('addWire still allows two tristate outputs to share a net', () => {
    const s = useCircuitStore.getState();
    s.place('tristate', { x: 0, y: 0 }, 8);
    s.place('tristate', { x: 100, y: 0 }, 8);
    const [t1, t2] = useCircuitStore.getState().board.components;
    const ok = s.addWire(
      { kind: 'pin', component: t1!.id, pin: 'y' },
      { kind: 'pin', component: t2!.id, pin: 'y' },
    );
    expect(ok).toBe(true);
    expect(useCircuitStore.getState().error).toBeNull();
  });
});

describe('clearTransientError', () => {
  beforeEach(reset);

  it('clears a one-shot notice like timing:/bubble mode:', () => {
    useCircuitStore.setState({ error: 'timing: something' });
    useCircuitStore.getState().clearTransientError();
    expect(useCircuitStore.getState().error).toBeNull();

    useCircuitStore.setState({ error: 'bubble mode: truth table inputs 16 exceeds max 8' });
    useCircuitStore.getState().clearTransientError();
    expect(useCircuitStore.getState().error).toBeNull();
  });

  it('never clears a width: error -- only a real recompile may', () => {
    useCircuitStore.setState({ error: 'width: mismatch' });
    useCircuitStore.getState().clearTransientError();
    expect(useCircuitStore.getState().error).toBe('width: mismatch');
  });

  it('edit() clears a stale label: error at its own entry point', () => {
    useCircuitStore.setState({ error: 'label: stale notice' });
    const s = useCircuitStore.getState();
    s.place('not', { x: 0, y: 0 }, 8);
    expect(useCircuitStore.getState().error).toBeNull();
  });
});

describe('setComponentParamsBatch', () => {
  beforeEach(() =>
    useCircuitStore.setState({
      board: emptyBoard(),
      chipLib: new Map(),
      tabs: [{ id: 'board', kind: 'board' }],
      activeTabId: 'board',
      staleInstances: new Set(),
      selection: new Set(),
      powered: false,
      error: null,
    }),
  );

  it('swaps a wired gate to another kind of the same family, keeping every wire', () => {
    const s = useCircuitStore.getState();
    s.place('toggle', { x: 0, y: 0 }, 8);
    s.place('and', { x: 100, y: 0 }, 8);
    s.place('led', { x: 200, y: 0 }, 8);
    const [sw, g, led] = useCircuitStore.getState().board.components;
    s.addWire(
      { kind: 'pin', component: sw!.id, pin: 'y' },
      { kind: 'pin', component: g!.id, pin: 'a0' },
    );
    s.addWire(
      { kind: 'pin', component: g!.id, pin: 'y' },
      { kind: 'pin', component: led!.id, pin: 'a' },
    );
    const before = useCircuitStore
      .getState()
      .board.wires.map((w) => w.id)
      .sort();

    const ok = s.setComponentParamsBatch([{ id: g!.id, params: { inputs: 2 }, kind: 'nand' }]);

    expect(ok).toBe(true);
    const after = useCircuitStore.getState().board;
    expect(after.components.find((c) => c.id === g!.id)!.kind).toBe('nand');
    // Same pin vocabulary, so nothing is dropped and nothing is re-created.
    expect(after.wires.map((w) => w.id).sort()).toEqual(before);
    // ...and one undo puts the original kind back.
    useCircuitStore.getState().undo();
    expect(useCircuitStore.getState().board.components.find((c) => c.id === g!.id)!.kind).toBe(
      'and',
    );
  });

  it('applies a width change to every listed component, decoder (no width key) untouched', () => {
    const s = useCircuitStore.getState();
    s.place('toggle', { x: 0, y: 0 }, 8);
    s.place('and', { x: 100, y: 0 }, 8);
    s.place('led', { x: 200, y: 0 }, 8);
    s.place('decoder', { x: 300, y: 0 }, 8);
    const [sw, g, led, dec] = useCircuitStore.getState().board.components;

    s.setComponentParamsBatch([
      { id: sw!.id, params: { width: 2 } },
      { id: g!.id, params: { width: 2 } },
      { id: led!.id, params: { width: 2 } },
    ]);

    const after = useCircuitStore.getState();
    expect(after.board.components.find((c) => c.id === sw!.id)!.params?.['width']).toBe(2);
    expect(after.board.components.find((c) => c.id === g!.id)!.params?.['width']).toBe(2);
    expect(after.board.components.find((c) => c.id === led!.id)!.params?.['width']).toBe(2);
    // decoder was never in the batch (UI excludes it -- no `width` key) --
    // its params stay untouched.
    expect(after.board.components.find((c) => c.id === dec!.id)!.params?.['width']).toBeUndefined();
  });

  it('commits the whole batch as one undo step', () => {
    const s = useCircuitStore.getState();
    s.place('toggle', { x: 0, y: 0 }, 8);
    s.place('led', { x: 100, y: 0 }, 8);
    const [sw, led] = useCircuitStore.getState().board.components;

    s.setComponentParamsBatch([
      { id: sw!.id, params: { width: 4 } },
      { id: led!.id, params: { width: 4 } },
    ]);
    s.undo();

    const after = useCircuitStore.getState();
    expect(after.board.components.find((c) => c.id === sw!.id)!.params?.['width']).toBeUndefined();
    expect(after.board.components.find((c) => c.id === led!.id)!.params?.['width']).toBeUndefined();
  });

  it('shrinking two wired gates in one batch drops both stranded wires without clobbering', () => {
    const s = useCircuitStore.getState();
    s.place('and', { x: 0, y: 0 }, 8, { inputs: 3 });
    s.place('and', { x: 200, y: 0 }, 8, { inputs: 3 });
    const [g1, g2] = useCircuitStore.getState().board.components;
    s.addWire({ kind: 'pin', component: g1!.id, pin: 'c' }, { kind: 'free', pos: { x: 0, y: 40 } });
    s.addWire(
      { kind: 'pin', component: g2!.id, pin: 'c' },
      { kind: 'free', pos: { x: 200, y: 40 } },
    );
    expect(useCircuitStore.getState().board.wires).toHaveLength(2);

    s.setComponentParamsBatch([
      { id: g1!.id, params: { inputs: 2 } },
      { id: g2!.id, params: { inputs: 2 } },
    ]);

    const after = useCircuitStore.getState();
    expect(after.board.components.find((c) => c.id === g1!.id)!.params?.['inputs']).toBe(2);
    expect(after.board.components.find((c) => c.id === g2!.id)!.params?.['inputs']).toBe(2);
    // Both stranded 'c'-pin wires are gone, in the one batch commit.
    expect(after.board.wires).toHaveLength(0);

    s.undo();
    expect(useCircuitStore.getState().board.wires).toHaveLength(2);
  });

  it('an empty batch is a no-op', () => {
    const s = useCircuitStore.getState();
    const before = useCircuitStore.getState().board;
    s.setComponentParamsBatch([]);
    expect(useCircuitStore.getState().board).toBe(before);
  });
});

describe('Task 8: individual R rotate pivots on the body centre', () => {
  beforeEach(reset);

  it('four R presses on a non-square component return it to its exact original pos/rot', () => {
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [
          ...st.board.components,
          { id: 'x1', kind: 'and', pos: { x: 96, y: 200 }, rot: 0, params: { inputs: 2 } },
        ],
      },
    }));
    const s = useCircuitStore.getState();
    const origPos = { x: 96, y: 200 };
    const baseW = 24;
    const baseH = 40;
    for (let i = 0; i < 4; i++) {
      const c = useCircuitStore.getState().board.components.find((c) => c.id === 'x1')!;
      const rot = c.rot ?? 0;
      const swapped = rot % 180 === 90;
      const bounds = {
        x: c.pos.x,
        y: c.pos.y,
        w: swapped ? baseH : baseW,
        h: swapped ? baseW : baseH,
      };
      s.rotateSelection([{ id: 'x1', bounds, rot }], 8);
    }
    const final = useCircuitStore.getState().board.components.find((c) => c.id === 'x1')!;
    expect(final.pos).toEqual(origPos);
    expect(final.rot).toBe(0);
  });

  it('rotating stays centred on the body midpoint, not the top-left corner', () => {
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [
          ...st.board.components,
          { id: 'x2', kind: 'and', pos: { x: 0, y: 0 }, rot: 0, params: { inputs: 2 } },
        ],
      },
    }));
    const s = useCircuitStore.getState();
    // 24x40 bounds centred at (12, 20); after one R (90deg) the new 40x24
    // bounds must still be centred at (12, 20), not swing around (0,0).
    s.rotateSelection([{ id: 'x2', bounds: { x: 0, y: 0, w: 24, h: 40 }, rot: 0 }], 8);
    const after = useCircuitStore.getState().board.components.find((c) => c.id === 'x2')!;
    expect(after.rot).toBe(90);
    expect(after.pos).toEqual({ x: 12 - 20, y: 20 - 12 });
  });

  // Live-QA follow-up: a 2-input gate's real bounds (9Gx4G -- w-h isn't a
  // multiple of 2G) drifted bottom-right over four R presses; a 1-bit
  // switch/LED (odd-multiple-parity-matched) didn't. Root cause was
  // `Math.round`'s asymmetric tie-breaking on the resulting exact-half-grid
  // discrepancy; fixed via `halfSnap` (see wireGeom.ts).
  it('a 2-input-gate-shaped component (9Gx4G, w-h not a multiple of 2G) does not drift', () => {
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [
          ...st.board.components,
          { id: 'x3', kind: 'and', pos: { x: 40, y: 40 }, rot: 0, params: { inputs: 2 } },
        ],
      },
    }));
    const s = useCircuitStore.getState();
    const origPos = { x: 40, y: 40 };
    const baseW = 72;
    const baseH = 32;
    for (let i = 0; i < 4; i++) {
      const c = useCircuitStore.getState().board.components.find((c) => c.id === 'x3')!;
      const rot = c.rot ?? 0;
      const swapped = rot % 180 === 90;
      const bounds = {
        x: c.pos.x,
        y: c.pos.y,
        w: swapped ? baseH : baseW,
        h: swapped ? baseW : baseH,
      };
      s.rotateSelection([{ id: 'x3', bounds, rot }], 8);
    }
    const final = useCircuitStore.getState().board.components.find((c) => c.id === 'x3')!;
    expect(final.pos).toEqual(origPos);
    expect(final.rot).toBe(0);
  });

  // Task 8 follow-up (owner decision): a single-pin part (In/Out, 1-bit
  // switch, button, 1-bit LED, probe) hinges on its own pin's world
  // position, not its body centre.
  it('an explicit item pivot (single-pin part hinging on its own pin) wins over the body centre', () => {
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [
          ...st.board.components,
          { id: 'x4', kind: 'toggle', pos: { x: 0, y: 0 }, rot: 0 },
        ],
      },
    }));
    const s = useCircuitStore.getState();
    // A pin at (40, 20), well off the 24x40 body's own centre (12, 20).
    const pivot = { x: 40, y: 20 };
    s.rotateSelection([{ id: 'x4', bounds: { x: 0, y: 0, w: 24, h: 40 }, rot: 0, pivot }], 8);
    const after = useCircuitStore.getState().board.components.find((c) => c.id === 'x4')!;
    expect(after.rot).toBe(90);
    // Confirms the passed `pivot` (not the body's own centre, (12,20)) drove
    // a TRUE corner-rotation (rotateAboutPivot) -- a body-centre rotation
    // about (12,20) would land somewhere else entirely.
    expect(after.pos).toEqual({ x: 20, y: -20 });
    expect(after.pos).not.toEqual({ x: -8, y: 8 }); // the body-centre-pivot result
  });

  it('two 90deg rotations about a fixed external pivot return to that pivot exactly (hinge behaviour)', () => {
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [
          ...st.board.components,
          { id: 'x5', kind: 'toggle', pos: { x: 0, y: 0 }, rot: 0 },
        ],
      },
    }));
    const s = useCircuitStore.getState();
    const pivot = { x: 40, y: 20 };
    let bounds = { x: 0, y: 0, w: 24, h: 40 };
    let rot: 0 | 90 | 180 | 270 = 0;
    for (let i = 0; i < 4; i++) {
      s.rotateSelection([{ id: 'x5', bounds, rot, pivot }], 8);
      const c = useCircuitStore.getState().board.components.find((c) => c.id === 'x5')!;
      bounds = { x: c.pos.x, y: c.pos.y, w: bounds.h, h: bounds.w };
      rot = c.rot ?? 0;
    }
    expect(bounds).toEqual({ x: 0, y: 0, w: 24, h: 40 });
    expect(rot).toBe(0);
  });
});

describe('Task 6: dragging an array (DIP-bank/LED) reroutes its wires', () => {
  beforeEach(reset);

  it('an expanded 4-bit DIP-bank switch wired (with a bend) to a gate stretches on moveSelection', () => {
    const arrsw1 = {
      id: 'arrsw1',
      kind: 'toggle' as const,
      pos: { x: 0, y: 0 },
      params: { width: 4, pinView: 'y=expanded' },
    };
    const pinY = symbolBounds(arrsw1 as never, testTheme).pins.get('y2')!.y;
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [
          arrsw1,
          { id: 'arrg1', kind: 'and', pos: { x: 200, y: 0 }, params: { inputs: 2 } },
        ],
        wires: [
          {
            id: 'arrw1',
            a: { kind: 'pin', component: 'arrsw1', pin: 'y2' },
            b: { kind: 'pin', component: 'arrg1', pin: 'a' },
            points: [{ x: 100, y: pinY }],
          },
        ],
      },
    }));
    const before = useCircuitStore.getState().board.wires.find((w) => w.id === 'arrw1')!;
    const s = useCircuitStore.getState();
    s.setSelection(new Set(['arrsw1']));
    s.moveSelection(40, 40, geometryResolve);
    const after = useCircuitStore.getState().board.wires.find((w) => w.id === 'arrw1')!;
    // The pin-2 end moved with the switch; the bend must have followed, not
    // stayed at its stale pre-drag position (Task 6's bug: resolveEnd
    // silently failing to look up an array's per-cell pin leaves the bend
    // exactly where it started).
    expect(after.points).not.toEqual(before.points);
  });

  it('a collapsed (width>1, not expanded) switch bank wired to a gate also stretches', () => {
    const arrsw2 = {
      id: 'arrsw2',
      kind: 'toggle' as const,
      pos: { x: 0, y: 0 },
      params: { width: 4 },
    };
    // bend's y must land on the switch pin's own y for stretchWirePoints to
    // treat it as the wire's first orthogonal leg off that pin.
    const pinY = symbolBounds(arrsw2 as never, testTheme).pins.get('y')!.y;
    useCircuitStore.setState((st) => ({
      board: {
        ...st.board,
        components: [arrsw2, { id: 'arrbd1', kind: 'busdisplay', pos: { x: 200, y: 0 } }],
        wires: [
          {
            id: 'arrw2',
            a: { kind: 'pin', component: 'arrsw2', pin: 'y' },
            b: { kind: 'pin', component: 'arrbd1', pin: 'value' },
            points: [{ x: 100, y: pinY }],
          },
        ],
      },
    }));
    const before = useCircuitStore.getState().board.wires.find((w) => w.id === 'arrw2')!;
    const s = useCircuitStore.getState();
    s.setSelection(new Set(['arrsw2']));
    s.moveSelection(40, 40, geometryResolve);
    const after = useCircuitStore.getState().board.wires.find((w) => w.id === 'arrw2')!;
    expect(after.points).not.toEqual(before.points);
  });
});

describe('loadChipDefs (library folder -> chipLib)', () => {
  beforeEach(reset);

  const def = (id: string): ChipDef => ({
    format: 'lcir.chip',
    formatVersion: 3,
    id,
    name: id,
    version: 1,
    pins: [],
    components: [],
    wires: [],
    junctions: [],
  });

  it('merges loaded defs over what is already in memory and bumps rev', () => {
    const s = useCircuitStore.getState();
    s.commitNewChip(def('packaged-not-yet-saved'));
    const revBefore = useCircuitStore.getState().rev;

    const result = useCircuitStore.getState().loadChipDefs([def('fromDisk1'), def('fromDisk2')]);

    expect(result).toEqual({ ok: true, count: 2 });
    const lib = useCircuitStore.getState().chipLib;
    // The in-memory chip survives connecting a folder; the disk ones join it.
    expect([...lib.keys()].sort()).toEqual(['fromDisk1', 'fromDisk2', 'packaged-not-yet-saved']);
    // rev must move or a load landing after first paint would never be drawn.
    expect(useCircuitStore.getState().rev).toBeGreaterThan(revBefore);
  });

  it('rejects a library that would form a def cycle, leaving chipLib alone', () => {
    const a = {
      ...def('a'),
      components: [{ id: 'i1', kind: 'chip' as const, defId: 'b', pos: { x: 0, y: 0 } }],
    };
    const b = {
      ...def('b'),
      components: [{ id: 'i2', kind: 'chip' as const, defId: 'a', pos: { x: 0, y: 0 } }],
    };
    const before = useCircuitStore.getState().chipLib;
    const result = useCircuitStore.getState().loadChipDefs([a, b]);
    expect(result.ok).toBe(false);
    expect(useCircuitStore.getState().chipLib).toBe(before);
  });

  it('an empty load is a no-op', () => {
    const revBefore = useCircuitStore.getState().rev;
    expect(useCircuitStore.getState().loadChipDefs([])).toEqual({ ok: true, count: 0 });
    expect(useCircuitStore.getState().rev).toBe(revBefore);
  });
});

describe('loadBoard (session restore / File > Open)', () => {
  beforeEach(reset);

  const loaded = (): Board => ({
    format: 'lcir.board',
    formatVersion: 5,
    id: 'opened',
    name: 'opened',
    components: [
      { id: 'sw7', kind: 'toggle', pos: { x: 0, y: 0 } },
      { id: 'g9', kind: 'and', pos: { x: 80, y: 0 } },
    ],
    wires: [
      {
        id: 'w5',
        a: { kind: 'pin', component: 'sw7', pin: 'y' },
        b: { kind: 'pin', component: 'g9', pin: 'a' },
        points: [],
      },
    ],
    junctions: [],
    probes: [],
    view: { x: 0, y: 0, zoom: 1 },
    timing: { mode: 'ideal', datasheet: 'typ' },
  });

  it('replaces the board and seeds ids past the loaded ones', () => {
    useCircuitStore.getState().loadBoard(loaded());
    const s = useCircuitStore.getState();
    expect(s.board.id).toBe('opened');
    expect(s.board.components.map((c) => c.id)).toEqual(['sw7', 'g9']);

    // The trap this action exists for: a generated id colliding with one the
    // loaded board already uses makes every id-keyed lookup ambiguous.
    s.place('toggle', { x: 200, y: 200 }, 8);
    s.place('and', { x: 300, y: 200 }, 8);
    const ids = useCircuitStore.getState().board.components.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    // The two new ids are genuinely new, not a second 'sw7'/'g9'.
    expect(ids.slice(2).some((id) => id === 'sw7' || id === 'g9')).toBe(false);
  });

  it('drops undo history, selection and power from the previous board', () => {
    const s = useCircuitStore.getState();
    s.place('toggle', { x: 8, y: 8 }, 8);
    s.setSelection(new Set(['sw1']));
    const placed = useCircuitStore.getState().board.components.length;

    useCircuitStore.getState().loadBoard(loaded());
    // Undo must not reach back into the previous board's stack.
    useCircuitStore.getState().undo();

    const after = useCircuitStore.getState();
    expect(after.board.components.length).toBe(2);
    expect(after.board.components.length).not.toBe(placed);
    expect(after.selection.size).toBe(0);
    expect(after.powered).toBe(false);
    expect(after.activeTabId).toBe('board');
  });
});

describe('setBusLabelT', () => {
  it('stores a clamped position and keeps it in one undo step', () => {
    const st = useCircuitStore.getState();
    const wireId = st.board.wires[0]!.id;
    st.setBusLabelT(wireId, 0.25);
    const after = useCircuitStore.getState().board.wires.find((w) => w.id === wireId);
    expect(after?.busLabelT).toBe(0.25);
    useCircuitStore.getState().undo();
    expect(
      useCircuitStore.getState().board.wires.find((w) => w.id === wireId)?.busLabelT,
    ).toBeUndefined();
  });

  it('clamps a position off either end of the wire', () => {
    const st = useCircuitStore.getState();
    const wireId = st.board.wires[0]!.id;
    st.setBusLabelT(wireId, -3);
    expect(useCircuitStore.getState().board.wires.find((w) => w.id === wireId)?.busLabelT).toBe(0);
    useCircuitStore.getState().setBusLabelT(wireId, 9);
    expect(useCircuitStore.getState().board.wires.find((w) => w.id === wireId)?.busLabelT).toBe(1);
  });

  it('does not power-cycle a running sim: the diff touches neither end', () => {
    const st = useCircuitStore.getState();
    st.power();
    expect(useCircuitStore.getState().powered).toBe(true);
    useCircuitStore.getState().setBusLabelT(useCircuitStore.getState().board.wires[0]!.id, 0.7);
    expect(useCircuitStore.getState().powered).toBe(true);
    useCircuitStore.getState().power();
  });
});

describe('starterBoard', () => {
  it('puts the LED input pin on the same row as the gate output pin', () => {
    const board = starterBoard();
    const find = (id: string) => board.components.find((c) => c.id === id)!;
    const gateY = symbolBounds(find('g1'), testTheme).pins.get('y')!.y;
    const ledA = symbolBounds(find('led1'), testTheme).pins.get('a')!.y;
    expect(ledA).toBe(gateY);
  });
});

describe('net label joins do not steal the switch', () => {
  beforeEach(reset);

  // Two same-name net labels join the switch's net to the LED's, which makes
  // the unlabeled LED inherit the switch's label. Both then compile to the
  // same path, so addressing the kernel by path drove the LED's state and the
  // switch never moved.
  const labelJoinBoard = (): Board => ({
    ...starterBoard(),
    components: [
      { id: 'sw', kind: 'toggle', pos: { x: 0, y: 0 }, label: 'A' },
      { id: 'nl1', kind: 'netlabel', pos: { x: 40, y: 0 }, label: 'N' },
      { id: 'nl2', kind: 'netlabel', pos: { x: 40, y: 60 }, label: 'N' },
      { id: 'led', kind: 'led', pos: { x: 80, y: 60 } },
    ],
    wires: [
      {
        id: 'w1',
        a: { kind: 'pin', component: 'sw', pin: 'y' },
        b: { kind: 'pin', component: 'nl1', pin: 'a' },
        points: [],
      },
      {
        id: 'w2',
        a: { kind: 'pin', component: 'nl2', pin: 'a' },
        b: { kind: 'pin', component: 'led', pin: 'a' },
        points: [],
      },
    ],
    junctions: [],
  });

  it('keeps the switch toggling and lights the LED through the join', () => {
    useCircuitStore.setState({ board: labelJoinBoard() });
    const s = useCircuitStore.getState();
    s.power();
    expect(useCircuitStore.getState().error).toBeNull();
    expect(s.pinSignal('sw', 'y')).toBe('0');
    expect(s.pinSignal('led', 'a')).toBe('0');

    s.toggleInput('sw');
    expect(s.pinSignal('sw', 'y')).toBe('1');
    expect(s.pinSignal('led', 'a')).toBe('1');

    s.toggleInput('sw');
    expect(s.pinSignal('sw', 'y')).toBe('0');
    expect(s.pinSignal('led', 'a')).toBe('0');
  });

  it('still toggles once the LED has inherited the switch label', () => {
    const b = labelJoinBoard();
    // What labelSync does live the moment the duplicate is wired up.
    b.components = b.components.map((c) => (c.id === 'led' ? { ...c, label: 'A' } : c));
    useCircuitStore.setState({ board: b });
    const s = useCircuitStore.getState();
    s.power();
    expect(useCircuitStore.getState().error).toBeNull();
    s.toggleInput('sw');
    expect(s.pinSignal('sw', 'y')).toBe('1');
    expect(s.pinSignal('led', 'a')).toBe('1');
  });
});

describe('tidyWiring', () => {
  beforeEach(reset);

  const routableOf = (c: { id: string; kind: string; defId?: string }) => {
    const board = useCircuitStore.getState().board;
    const comp = board.components.find((x) => x.id === c.id)!;
    const { bounds, pins } = symbolBounds(comp, testTheme);
    const dirs = new Map(resolveComponentPins(comp).map((p) => [p.name, p.dir]));
    const routable = new Map<string, RoutablePin>();
    for (const [name, pos] of pins) {
      const dir = dirs.get(name);
      if (dir) routable.set(name, { pos, dir });
    }
    return { id: comp.id, bounds, pins: routable };
  };

  const pin = (component: string, name: string) => ({ kind: 'pin', component, pin: name }) as const;

  /** One switch driving two gates by two separate wires from the same pin --
   *  the shape that renders as stacked parallel runs. */
  const fanoutBoard = (): Board => ({
    ...starterBoard(),
    components: [
      { id: 'sw', kind: 'toggle', pos: { x: 48, y: 48 } },
      { id: 'g1', kind: 'and', pos: { x: 288, y: 48 } },
      { id: 'g2', kind: 'and', pos: { x: 288, y: 288 } },
    ],
    wires: [
      { id: 'w1', a: pin('sw', 'y'), b: pin('g1', 'a'), points: [] },
      { id: 'w2', a: pin('sw', 'y'), b: pin('g2', 'a'), points: [] },
    ],
    junctions: [],
  });

  const runTidy = (only?: Set<string>) => {
    const st = useCircuitStore.getState();
    const components = st.board.components.map(routableOf);
    st.tidyWiring({
      components,
      grid: testTheme.gridSchematic,
      ...(only ? { only } : {}),
    });
  };

  it('survives the post-edit junction collapse', () => {
    useCircuitStore.setState({ board: fanoutBoard() });
    runTidy();
    // A T-branch has three legs, so collapseJunctions must leave it alone.
    expect(useCircuitStore.getState().board.junctions).toHaveLength(1);
  });

  it('is one undo step', () => {
    useCircuitStore.setState({ board: fanoutBoard() });
    const before = useCircuitStore.getState().board;
    runTidy();
    expect(useCircuitStore.getState().board.junctions).toHaveLength(1);
    useCircuitStore.getState().undo();
    const after = useCircuitStore.getState().board;
    expect(after.junctions).toEqual(before.junctions);
    expect(after.wires).toEqual(before.wires);
  });

  it('leaves wiring outside the selection untouched', () => {
    useCircuitStore.setState({ board: fanoutBoard() });
    const before = useCircuitStore.getState().board;
    runTidy(new Set(['sw', 'g1'])); // g2 is on the same net, so nothing qualifies
    const after = useCircuitStore.getState().board;
    expect(after.wires).toEqual(before.wires);
    expect(after.junctions).toEqual(before.junctions);
  });
});

describe('circuitStore groups', () => {
  // The shared store keeps its board between tests, and these tests rename the
  // same two switches, so each starts from a fresh one.
  beforeEach(() => {
    reset();
    useCircuitStore.getState().loadBoard(starterBoard());
  });

  it('groups the selection, and undo puts it back', () => {
    const s = useCircuitStore.getState();
    useCircuitStore.setState({ selection: new Set(['sw1', 'sw2']) });
    const id = s.groupSelection('Left');
    expect(id).not.toBeNull();

    const after = useCircuitStore.getState().board;
    expect(after.groups).toEqual([{ id, name: 'Left' }]);
    expect(
      after.components
        .filter((c) => c.group === id)
        .map((c) => c.id)
        .sort(),
    ).toEqual(['sw1', 'sw2']);

    // Group membership and the group record are one undo step, not two.
    useCircuitStore.getState().undo();
    const back = useCircuitStore.getState().board;
    expect(back.groups ?? []).toEqual([]);
    expect(back.components.every((c) => c.group === undefined)).toBe(true);
  });

  it('ungroups everything the selection touches', () => {
    const s = useCircuitStore.getState();
    useCircuitStore.setState({ selection: new Set(['sw1', 'sw2']) });
    s.groupSelection('Left');
    // One member is enough to dissolve the group it belongs to.
    useCircuitStore.setState({ selection: new Set(['sw1']) });
    useCircuitStore.getState().ungroupSelection();
    const board = useCircuitStore.getState().board;
    expect(board.groups ?? []).toEqual([]);
    expect(board.components.every((c) => c.group === undefined)).toBe(true);
  });

  it('lets two groups reuse a label that is unique within each', () => {
    const s = useCircuitStore.getState();
    useCircuitStore.setState({ selection: new Set(['sw1']) });
    const g1 = s.groupSelection('Left');
    useCircuitStore.setState({ selection: new Set(['sw2']) });
    const g2 = useCircuitStore.getState().groupSelection('Right');
    expect(g1).not.toBe(g2);

    // Board-wide uniqueness would refuse the second of these.
    expect(useCircuitStore.getState().renameComponent('sw1', 'A')).toBe(true);
    expect(useCircuitStore.getState().renameComponent('sw2', 'A')).toBe(true);
    const board = useCircuitStore.getState().board;
    expect(board.components.filter((c) => c.label === 'A').length).toBe(2);
  });

  it('still refuses a duplicate label inside one group', () => {
    const s = useCircuitStore.getState();
    useCircuitStore.setState({ selection: new Set(['sw1', 'sw2']) });
    s.groupSelection('Left');
    expect(useCircuitStore.getState().renameComponent('sw1', 'A')).toBe(true);
    expect(useCircuitStore.getState().renameComponent('sw2', 'A')).toBe(false);
  });

  it('refuses a group name already in use', () => {
    const s = useCircuitStore.getState();
    useCircuitStore.setState({ selection: new Set(['sw1']) });
    const g1 = s.groupSelection('Left')!;
    useCircuitStore.setState({ selection: new Set(['sw2']) });
    const g2 = useCircuitStore.getState().groupSelection('Right')!;
    expect(useCircuitStore.getState().renameGroup(g2, 'Left')).toBe(false);
    expect(useCircuitStore.getState().renameGroup(g2, 'Middle')).toBe(true);
    expect(useCircuitStore.getState().board.groups).toEqual([
      { id: g1, name: 'Left' },
      { id: g2, name: 'Middle' },
    ]);
  });
});

describe('circuitStore label sharing across a buffer', () => {
  beforeEach(() => {
    reset();
    useCircuitStore.getState().loadBoard(starterBoard());
  });

  const chainBoard = (withBuffer: boolean): Board => ({
    format: 'lcir.board',
    formatVersion: 5,
    id: 'chain',
    name: 'chain',
    components: [
      { id: 'sw', kind: 'toggle', pos: { x: 48, y: 48 } },
      ...(withBuffer ? [{ id: 'bf', kind: 'buf' as const, pos: { x: 200, y: 48 } }] : []),
      { id: 'lamp', kind: 'led', pos: { x: 360, y: 48 } },
    ],
    wires: withBuffer
      ? [
          {
            id: 'w1',
            a: { kind: 'pin' as const, component: 'sw', pin: 'y' },
            b: { kind: 'pin' as const, component: 'bf', pin: 'a' },
            points: [],
          },
          {
            id: 'w2',
            a: { kind: 'pin' as const, component: 'bf', pin: 'y' },
            b: { kind: 'pin' as const, component: 'lamp', pin: 'a' },
            points: [],
          },
        ]
      : [
          {
            id: 'w1',
            a: { kind: 'pin' as const, component: 'sw', pin: 'y' },
            b: { kind: 'pin' as const, component: 'lamp', pin: 'a' },
            points: [],
          },
        ],
    junctions: [],
    probes: [],
    view: { x: 0, y: 0, zoom: 1 },
    timing: { mode: 'ideal', datasheet: 'typ' },
  });

  it('lets a switch and the LED it drives share a name', () => {
    useCircuitStore.getState().loadBoard(chainBoard(false));
    expect(useCircuitStore.getState().renameComponent('sw', 'A')).toBe(true);
    expect(useCircuitStore.getState().renameComponent('lamp', 'A')).toBe(true);
  });

  /** sw -> chain of single-input parts -> led. */
  const throughBoard = (kinds: readonly string[]): Board => ({
    format: 'lcir.board',
    formatVersion: 5,
    id: 'chain',
    name: 'chain',
    components: [
      { id: 'sw', kind: 'toggle', pos: { x: 48, y: 48 } },
      ...kinds.map((k, i) => ({
        id: `m${i}`,
        kind: k as 'buf',
        pos: { x: 160 + 120 * i, y: 48 },
      })),
      { id: 'lamp', kind: 'led', pos: { x: 160 + 120 * kinds.length, y: 48 } },
    ],
    wires: [...Array(kinds.length + 1)].map((_, i) => ({
      id: `w${i}`,
      a: {
        kind: 'pin' as const,
        component: i === 0 ? 'sw' : `m${i - 1}`,
        pin: 'y',
      },
      b: {
        kind: 'pin' as const,
        component: i === kinds.length ? 'lamp' : `m${i}`,
        pin: 'a',
      },
      points: [],
    })),
    junctions: [],
    probes: [],
    view: { x: 0, y: 0, zoom: 1 },
    timing: { mode: 'ideal', datasheet: 'typ' },
  });

  const canShare = (kinds: readonly string[]) => {
    useCircuitStore.getState().loadBoard(throughBoard(kinds));
    expect(useCircuitStore.getState().renameComponent('sw', 'A')).toBe(true);
    return useCircuitStore.getState().renameComponent('lamp', 'A');
  };

  it('shares a name through any chain whose inversions cancel', () => {
    expect(canShare(['buf'])).toBe(true);
    expect(canShare(['not', 'not'])).toBe(true);
    expect(canShare(['buf', 'not', 'not', 'buf'])).toBe(true);
    expect(canShare(['not', 'buf', 'not'])).toBe(true);
  });

  it('refuses it when the chain inverts', () => {
    // That LED shows the complement. Calling it `A` would be a lie.
    expect(canShare(['not'])).toBe(false);
    expect(canShare(['not', 'not', 'not'])).toBe(false);
    expect(canShare(['buf', 'not'])).toBe(false);
  });

  it('still lets them share it with a buffer between', () => {
    // A buffer splits the net in two, so without the transparency rule the
    // second rename reads as a board-wide duplicate. `A` through a buffer is
    // still `A`.
    useCircuitStore.getState().loadBoard(chainBoard(true));
    expect(useCircuitStore.getState().renameComponent('sw', 'A')).toBe(true);
    expect(useCircuitStore.getState().renameComponent('lamp', 'A')).toBe(true);
  });

  it('still refuses a duplicate with a gate between', () => {
    // An AND is not transparent: its output is a different signal, so sharing
    // the name would be a lie.
    const b = chainBoard(true);
    b.components = b.components.map((c) => (c.id === 'bf' ? { ...c, kind: 'and' as const } : c));
    useCircuitStore.getState().loadBoard(b);
    expect(useCircuitStore.getState().renameComponent('sw', 'A')).toBe(true);
    expect(useCircuitStore.getState().renameComponent('lamp', 'A')).toBe(false);
  });
});
