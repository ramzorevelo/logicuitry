// Acceptance criterion: 1,000 seeded random circuits x
// random sequences of *legal* moves hold truth-table equivalence at every
// step; injected illegal moves are rejected with the model unchanged
// (structural hash identical).

import { describe, expect, it } from 'vitest';
import { mulberry32, type Prng } from '../sim/prng';
import type { Board, Component, Wire } from '../model/types';
import { getInputBubbles, getOutputBubble, withOutputBubble } from './bubbleModel';
import {
  absorbInverterIntoDriver,
  annihilate,
  materializeInputBubble,
  mergeInversionsUpstream,
  insertBubblePair,
  pushInputsForward,
  pushOutputAcrossFanout,
  pushOutputBackward,
} from './transform';
import { isEquivalent } from './verify';

const lib = new Map();

function structuralHash(b: Board): string {
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v as object)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, canon(x)]),
          )
        : v;
  return JSON.stringify(
    canon({ components: b.components, wires: b.wires, junctions: b.junctions }),
  );
}

const GATE_BASES: readonly ('and' | 'or' | 'buf')[] = ['and', 'or', 'buf'];

/** A small random combinational board: nIn primary inputs, a DAG of
 *  nGates gates (each wired to earlier stages, so fan-out and no cycles
 *  arise naturally), nOut outputs tapping random gate/input pins. */
function randomBoard(rng: Prng, nIn: number, nGates: number, nOut: number): Board {
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)]!;
  const components: Component[] = [];
  const wires: Wire[] = [];
  // stage: every producer pin available so far (component id, pin name)
  const producers: { component: string; pin: string }[] = [];

  for (let i = 0; i < nIn; i++) {
    const id = `in${i}`;
    components.push({ id, kind: 'inport', pos: { x: 0, y: i }, label: id });
    producers.push({ component: id, pin: 'y' });
  }

  let wireCount = 0;
  const wireUp = (to: { component: string; pin: string }) => {
    const from = pick(producers);
    wires.push({
      id: `w${wireCount++}`,
      a: { kind: 'pin', component: from.component, pin: from.pin },
      b: { kind: 'pin', component: to.component, pin: to.pin },
      points: [],
    });
  };

  for (let i = 0; i < nGates; i++) {
    const id = `g${i}`;
    const base = pick(GATE_BASES);
    let comp: Component = { id, kind: base, pos: { x: 1, y: i } };
    if (rng() < 0.4) comp = withOutputBubble(comp, true); // seed some already-bubbled gates to push
    components.push(comp);
    if (base === 'buf') {
      wireUp({ component: id, pin: 'a' });
    } else {
      wireUp({ component: id, pin: 'a' });
      wireUp({ component: id, pin: 'b' });
    }
    producers.push({ component: id, pin: 'y' });
  }

  for (let i = 0; i < nOut; i++) {
    const id = `out${i}`;
    components.push({ id, kind: 'outport', pos: { x: 2, y: i }, label: id });
    wireUp({ component: id, pin: 'a' });
  }

  return {
    format: 'lcir.board',
    formatVersion: 5,
    id: 'rand',
    name: 'rand',
    components,
    wires,
    junctions: [],
    probes: [],
    view: { x: 0, y: 0, zoom: 1 },
    timing: { mode: 'ideal', datasheet: 'typ' },
  };
}

type LegalMove = { label: string; apply: (b: Board) => Board | null };

function legalMoves(b: Board): LegalMove[] {
  const moves: LegalMove[] = [];
  for (const c of b.components) {
    if (
      c.kind !== 'and' &&
      c.kind !== 'or' &&
      c.kind !== 'buf' &&
      c.kind !== 'nand' &&
      c.kind !== 'nor' &&
      c.kind !== 'not'
    )
      continue;
    if (getOutputBubble(c)) {
      moves.push({
        label: `pushOutputBackward(${c.id})`,
        apply: (bb) => pushOutputBackward(bb, c.id),
      });
      // Pre-test: the last-hop identity guard makes some of these null now.
      if (pushOutputAcrossFanout(b, c.id)) {
        moves.push({
          label: `pushOutputAcrossFanout(${c.id})`,
          apply: (bb) => pushOutputAcrossFanout(bb, c.id),
        });
      }
    }
    const pins = c.kind === 'buf' || c.kind === 'not' ? ['a'] : ['a', 'b'];
    if (pins.every((p) => getInputBubbles(c).has(p))) {
      moves.push({
        label: `pushInputsForward(${c.id})`,
        apply: (bb) => pushInputsForward(bb, c.id),
      });
    }
    if (absorbInverterIntoDriver(b, c.id)) {
      moves.push({
        label: `absorbInverter(${c.id})`,
        apply: (bb) => absorbInverterIntoDriver(bb, c.id),
      });
    }
    for (const p of pins) {
      if (!getInputBubbles(c).has(p)) continue;
      const from = { component: c.id, pin: p };
      if (mergeInversionsUpstream(b, from)) {
        moves.push({
          label: `mergeUpstream(${c.id}.${p})`,
          apply: (bb) => mergeInversionsUpstream(bb, from),
        });
      }
      if (materializeInputBubble(b, from)) {
        moves.push({
          label: `materializeNot(${c.id}.${p})`,
          apply: (bb) => materializeInputBubble(bb, from),
        });
      }
    }
  }
  for (const w of b.wires) {
    moves.push({
      label: `insertBubblePair(${w.id})`,
      apply: (bb) => insertBubblePair(bb, w.id, { x: 0, y: 0 }),
    });
  }
  return moves;
}

describe('bubble-push property test (1000 seeded circuits)', () => {
  it('random legal-move sequences preserve truth-table equivalence at every step', () => {
    const rng = mulberry32(0xc0ffee);
    for (let iter = 0; iter < 1000; iter++) {
      const nIn = 2 + Math.floor(rng() * 3); // 2..4
      const nGates = 2 + Math.floor(rng() * 4); // 2..5
      const nOut = 1 + Math.floor(rng() * 2); // 1..2
      const original = randomBoard(rng, nIn, nGates, nOut);
      let current = annihilate(original);

      const steps = Math.floor(rng() * 4); // 0..3 moves
      const history: string[] = [];
      for (let s = 0; s < steps; s++) {
        const moves = legalMoves(current);
        if (moves.length === 0) break;
        const move = moves[Math.floor(rng() * moves.length)]!;
        history.push(move.label);
        const next = move.apply(current);
        expect(next).not.toBeNull();
        try {
          expect(isEquivalent(original, next!, lib)).toBe(true);
        } catch (e) {
          console.error(
            'FAIL iter',
            iter,
            'step',
            s,
            'history',
            history,
            JSON.stringify({ original, next }, null, 1),
          );
          throw e;
        }
        current = next!;
      }
    }
  });

  it('injected illegal moves are rejected, model unchanged (structural hash identical)', () => {
    const rng = mulberry32(0xbadc0de);
    let rejections = 0;
    for (let iter = 0; iter < 1000; iter++) {
      const nIn = 2 + Math.floor(rng() * 3);
      const nGates = 2 + Math.floor(rng() * 4);
      const b = annihilate(randomBoard(rng, nIn, nGates, 1));
      const before = structuralHash(b);

      // Deliberately attempt pushInputsForward on every gate that does NOT
      // have every input bubbled (the documented failed-drag case), and
      // pushOutputBackward/pushOutputAcrossFanout on every gate with no
      // output bubble (nothing to push).
      for (const c of b.components) {
        if (
          c.kind !== 'and' &&
          c.kind !== 'or' &&
          c.kind !== 'buf' &&
          c.kind !== 'nand' &&
          c.kind !== 'nor' &&
          c.kind !== 'not'
        )
          continue;
        const pins = c.kind === 'buf' || c.kind === 'not' ? ['a'] : ['a', 'b'];
        const allBubbled = pins.every((p) => getInputBubbles(c).has(p));
        if (!allBubbled) {
          expect(pushInputsForward(b, c.id)).toBeNull();
          rejections++;
        }
        if (!getOutputBubble(c)) {
          expect(pushOutputBackward(b, c.id)).toBeNull();
          expect(pushOutputAcrossFanout(b, c.id)).toBeNull();
          rejections += 2;
        }
      }
      expect(pushOutputBackward(b, '__nonexistent__')).toBeNull();
      rejections++;

      expect(structuralHash(b)).toBe(before);
    }
    expect(rejections).toBeGreaterThan(0);
  });
});
