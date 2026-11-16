import { beforeEach, describe, expect, it } from 'vitest';
import { useCircuitStore } from './circuitStore';
import { freshness, useChallengeStore } from './challengeStore';
import { challengeMenuItems, type ChallengeMenuState } from './challengeMenu';
import { behaviorRowViews, partLabel, partsRowViews, tally } from './challengeView';
import { board, comp, wire } from '../../core/model/testFixtures';
import type { Challenge } from '../../core/model/types';
import { behaviorReport, type BehaviorReport } from '../../core/challenge/behavior';
import { partsReport } from '../../core/challenge/parts';
import { challengeChanged, challengeFingerprint } from '../../core/challenge/fingerprint';
import { builtinChipLibrary } from '../../core/parts/packages';
import type { BackgroundCheck } from './checkInBackground';
import type { MenuCommand } from '../menu/menuModel';

const st = () => useCircuitStore.getState();
const ch = () => useChallengeStore.getState();

const nandBoard = () =>
  board({
    components: [
      comp('a', 'toggle', undefined, 'A'),
      comp('b', 'toggle', undefined, 'B'),
      comp('g', 'nand', undefined, 'G1'),
      comp('x', 'xor', undefined, 'G2'),
      comp('y', 'led', undefined, 'Y'),
    ],
    wires: [
      wire('w1', ['a', 'y'], ['g', 'a']),
      wire('w2', ['b', 'y'], ['g', 'b']),
      wire('w3', ['g', 'y'], ['y', 'a']),
    ],
  });

const base: Challenge = {
  title: 'NAND',
  brief: 'Y = A NAND B',
  allowed: ['nand'],
  maxGates: 1,
  required: [],
  truthTable: {
    inputs: ['A', 'B'],
    outputs: ['Y'],
    rows: [
      [0, 0, 1],
      [0, 1, 1],
      [1, 0, 1],
      [1, 1, 0],
    ],
  },
};
const set = (c: Challenge): Challenge => ({ ...c, fingerprint: challengeFingerprint(c) });

/** A check that settles when the test says so. */
function deferredRun() {
  let resolve: (r: BehaviorReport | null) => void = () => {};
  let cancelled = false;
  const job: BackgroundCheck = {
    result: new Promise((r) => (resolve = r)),
    cancel: () => {
      cancelled = true;
      resolve(null);
    },
  };
  return { run: () => job, resolve: (r: BehaviorReport) => resolve(r), cancelled: () => cancelled };
}

beforeEach(() => {
  st().loadBoard(nandBoard());
  useChallengeStore.setState({ last: null, checking: null, editor: null });
});

describe('setChallenge', () => {
  it('sets, edits and removes as one undo step each, and redo restores', () => {
    const before = st().board;
    st().setChallenge('new challenge', set(base));
    expect(st().board).not.toBe(before);
    expect(st().board.challenge).toEqual(set(base));
    st().setChallenge('edit challenge', { ...st().board.challenge!, maxGates: 3 });
    expect(challengeChanged(st().board.challenge!)).toBe(true);
    st().setChallenge('remove challenge', undefined);
    expect(st().board.challenge).toBeUndefined();
    st().undo();
    expect(st().board.challenge?.maxGates).toBe(3);
    st().undo();
    expect(challengeChanged(st().board.challenge!)).toBe(false);
    st().undo();
    expect(st().board.challenge).toBeUndefined();
    st().redo();
    expect(st().board.challenge).toEqual(set(base));
  });

  it('leaves a powered board powered', () => {
    st().power();
    expect(st().powered).toBe(true);
    st().setChallenge('new challenge', set(base));
    expect(st().powered).toBe(true);
  });

  it('does nothing on a chip tab', () => {
    useCircuitStore.setState({
      tabs: [...st().tabs, { id: 't', kind: 'def', defId: 'half-adder' }],
      activeTabId: 't',
    } as never);
    st().setChallenge('new challenge', set(base));
    expect(st().board.challenge).toBeUndefined();
  });
});

describe('challenge check', () => {
  beforeEach(() => st().setChallenge('new challenge', set(base)));

  it('keeps the live sim as it was and reports fresh, then stale after an edit', async () => {
    st().power();
    const rev = st().rev;
    const report = behaviorReport(st().board, st().chipLib, st().board.challenge!, st().timing);
    const d = deferredRun();
    const pending = ch().check(d.run);
    expect(ch().checking).not.toBeNull();
    d.resolve(report);
    await pending;
    expect(ch().checking).toBeNull();
    expect(st().powered).toBe(true);
    expect(st().rev).toBe(rev);
    expect(freshness(ch().last, st())).toBe('fresh');
    st().setTiming({ mode: 'datasheet' });
    expect(freshness(ch().last, st())).toBe('stale');
    st().setChallenge('edit challenge', { ...st().board.challenge!, brief: 'x' });
    expect(freshness(ch().last, st())).toBe('none');
  });

  it('reads stale after a chip library change, which the board arrays do not show', async () => {
    const ok = deferredRun();
    const pending = ch().check(ok.run);
    ok.resolve(behaviorReport(st().board, st().chipLib, st().board.challenge!, st().timing));
    await pending;
    useCircuitStore.setState({ chipLib: new Map(st().chipLib) });
    expect(freshness(ch().last, st())).toBe('stale');
  });

  it('drops a cancelled check and reads none on another board', async () => {
    const d = deferredRun();
    const pending = ch().check(d.run);
    ch().cancel();
    await pending;
    expect(d.cancelled()).toBe(true);
    expect(ch().last).toBeNull();
    const ok = deferredRun();
    const again = ch().check(ok.run);
    ok.resolve(behaviorReport(st().board, st().chipLib, st().board.challenge!, st().timing));
    await again;
    expect(freshness(ch().last, st())).toBe('fresh');
    st().loadBoard(nandBoard());
    expect(freshness(ch().last, st())).toBe('none');
  });

  it('opens New prefilled from the board and Edit from the challenge', () => {
    ch().openEditor(true);
    expect(ch().editor?.isNew).toBe(true);
    expect(ch().editor?.initial.allowed).toEqual(['nand', 'xor']);
    ch().openEditor(false);
    expect(ch().editor?.initial).toBe(st().board.challenge);
  });
});

describe('challenge rows', () => {
  const lib = builtinChipLibrary();

  it('words the live rows and names the offender', () => {
    const rows = partsRowViews(base, partsReport(nandBoard(), lib, base));
    expect(rows.map((r) => [r.id, r.state, r.title, r.detail])).toEqual([
      ['allowed', 'unmet', 'Only parts from the list (NAND)', 'G2 XOR not on the list.'],
      ['gates', 'unmet', 'At most 1 gate', '2 gates, 1 too many. A gate counts its bit width.'],
    ]);
    expect(rows[0]!.components).toEqual(['x']);
  });

  it('keeps behavior pending until checked, then names the failing row', () => {
    expect(behaviorRowViews(base, null).map((r) => r.state)).toEqual(['pending']);
    const wrong: Challenge = {
      ...base,
      truthTable: {
        ...base.truthTable!,
        rows: base.truthTable!.rows.map((r) => [r[0]!, r[1]!, 1]),
      },
    };
    const report = behaviorReport(nandBoard(), lib, wrong, {
      mode: 'ideal',
      datasheet: 'typ',
      vendor: 'ti',
    });
    const [row] = behaviorRowViews(wrong, report);
    expect(row!.state).toBe('unmet');
    expect(row!.detail).toBe('3 of 4 rows match. A B = 1 1: Y is 0, expected 1.');
  });

  it('counts a never-checked behavior row against the total', () => {
    const parts = partsRowViews(
      { ...base, allowed: [], maxGates: 9 },
      partsReport(nandBoard(), lib, { ...base, allowed: [], maxGates: 9 }),
    );
    const t = tally([...parts, ...behaviorRowViews(base, null)]);
    expect(t).toEqual({ met: 1, unmet: 0, pending: 1, total: 2 });
  });

  it('names kinds by their palette label and part numbers as written', () => {
    expect(partLabel('toggle')).toBe('Switch');
    expect(partLabel('led')).toBe('LED');
    expect(partLabel('sevenseg')).toBe('7-seg display');
    expect(partLabel('74LS00')).toBe('74LS00');
  });
});

describe('challengeMenuItems', () => {
  const state = (over: Partial<ChallengeMenuState>): ChallengeMenuState => ({
    has: true,
    hasBehavior: true,
    checking: false,
    blocked: false,
    viewOnly: false,
    check: () => {},
    show: () => {},
    edit: () => {},
    remove: () => {},
    ...over,
  });
  const enabled = (s: ChallengeMenuState) =>
    challengeMenuItems(s)
      .filter((e): e is MenuCommand => 'run' in e && !e.disabled)
      .map((e) => e.id);

  it('offers only New without a challenge', () => {
    expect(enabled(state({ has: false }))).toEqual(['newChallenge']);
  });

  it('offers everything on a board with one, and only looking in view only', () => {
    expect(enabled(state({}))).toEqual([
      'checkChallenge',
      'showBrief',
      'editChallenge',
      'newChallenge',
      'removeChallenge',
    ]);
    expect(enabled(state({ viewOnly: true }))).toEqual(['checkChallenge', 'showBrief']);
  });

  it('greys Check on a challenge with nothing to check', () => {
    expect(enabled(state({ hasBehavior: false }))).not.toContain('checkChallenge');
  });

  it('greys every item in a chip tab or a lesson', () => {
    expect(enabled(state({ blocked: true }))).toEqual([]);
  });
});
