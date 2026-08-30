// Preview/commit core shared by mouse drag and the keyboard path (Tab focus
// + arrow preview + Enter commit).
// Both input methods build a PushMove and call previewPush/commitPush --
// neither duplicates the transformation logic itself (core/gates/transform.ts).

import type { Board, ChipLibrary } from '../../../core/model/types';
import {
  absorbInverterIntoDriver,
  annihilatePair,
  insertBubblePair,
  materializeInputBubble,
  mergeInversionsUpstream,
  mergeInversionsUpstreamNaive,
  pushInputsForward,
  pushOutputAcrossFanout,
  pushOutputBackward,
  type MergeFrom,
  type TransformGeom,
} from '../../../core/gates/transform';
import {
  gateInputPins,
  getInputBubbles,
  toggleInputBubble,
  toggleOutputBubble,
} from '../../../core/gates/bubbleModel';
import { diffRows, tablesEqual } from '../../../core/boolean/truthTable';
import { truthTableOf } from '../../../core/gates/verify';

export type PushMove =
  | { kind: 'outputBackward'; gateId: string }
  | { kind: 'inputsForward'; gateId: string }
  | { kind: 'outputAcrossFanout'; gateId: string }
  | { kind: 'pairInsert'; wireId: string; pos: { x: number; y: number } }
  | { kind: 'annihilate'; driverId: string; consumer: { component: string; pin: string } }
  | { kind: 'absorbInverter'; inverterId: string }
  | { kind: 'mergeUpstream'; from: MergeFrom }
  | { kind: 'materializeNot'; at: { component: string; pin: string } };

export type PushPreview =
  | { legal: true; result: Board }
  | { legal: false; attempted: Board | null; diffRows: number[] };

function applyMove(board: Board, move: PushMove, geom?: TransformGeom): Board | null {
  switch (move.kind) {
    case 'outputBackward':
      return pushOutputBackward(board, move.gateId);
    case 'inputsForward':
      return pushInputsForward(board, move.gateId);
    case 'outputAcrossFanout':
      return pushOutputAcrossFanout(board, move.gateId, geom);
    case 'pairInsert':
      return insertBubblePair(board, move.wireId, move.pos, geom);
    case 'annihilate':
      return annihilatePair(board, move.driverId, move.consumer);
    case 'absorbInverter':
      return absorbInverterIntoDriver(board, move.inverterId);
    case 'mergeUpstream':
      return mergeInversionsUpstream(board, move.from, geom);
    case 'materializeNot':
      return materializeInputBubble(board, move.at, geom);
  }
}

/** A naive, non-transactional attempt at `move` -- used only to render the
 *  failed-drag ghost + red-flashed truth-table rows the spec calls for
 *  ("dragging a single input bubble forward when siblings lack bubbles").
 *  Never used to actually commit anything. */
function naiveAttempt(board: Board, move: PushMove, geom?: TransformGeom): Board | null {
  if (move.kind === 'mergeUpstream') return mergeInversionsUpstreamNaive(board, move.from, geom);
  if (move.kind !== 'inputsForward') return null;
  const gate = board.components.find((c) => c.id === move.gateId);
  if (!gate) return null;
  const pins = gateInputPins(gate);
  const bubbled = getInputBubbles(gate);
  if (pins.every((p) => bubbled.has(p))) return null; // that case is actually legal
  if (!pins.some((p) => bubbled.has(p))) return null; // nothing to drag
  let next: Board = board;
  next = {
    ...next,
    components: next.components.map((c) => (c.id === move.gateId ? toggleOutputBubble(c) : c)),
  };
  for (const p of pins) {
    if (!bubbled.has(p)) continue;
    next = {
      ...next,
      components: next.components.map((c) => (c.id === move.gateId ? toggleInputBubble(c, p) : c)),
    };
  }
  return next;
}

/** Computes what a move would do without mutating anything. Legal moves
 *  return the resulting board (defense-in-depth verified against
 *  core/boolean); illegal ones return an attempted-result ghost (if one can
 *  be constructed) plus which truth-table rows it would break. */
export function previewPush(
  board: Board,
  move: PushMove,
  lib: ChipLibrary,
  geom?: TransformGeom,
): PushPreview {
  const result = applyMove(board, move, geom);
  if (result) {
    const before = truthTableOf(board, lib);
    const after = truthTableOf(result, lib);
    if (tablesEqual(before, after)) return { legal: true, result };
    // Constructed illegal by a core bug, not a bad move -- still surfaced as
    // a failed drag rather than silently committing a wrong transformation.
    return { legal: false, attempted: result, diffRows: diffRows(before, after) };
  }
  const attempted = naiveAttempt(board, move, geom);
  if (!attempted) return { legal: false, attempted: null, diffRows: [] };
  const before = truthTableOf(board, lib);
  const after = truthTableOf(attempted, lib);
  return { legal: false, attempted, diffRows: diffRows(before, after) };
}

/** Commits `move` iff legal; returns null (no-op) otherwise -- callers
 *  should have already shown the failed-drag ghost via previewPush and
 *  must not call commitPush for a preview that came back illegal. */
export function commitPush(
  board: Board,
  move: PushMove,
  lib: ChipLibrary,
  geom?: TransformGeom,
): Board | null {
  const preview = previewPush(board, move, lib, geom);
  return preview.legal ? preview.result : null;
}
