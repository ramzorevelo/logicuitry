import { behaviorReport, type BehaviorReport } from '../../core/challenge/behavior';
import type { Board, Challenge, ChipLibrary, TimingSetting } from '../../core/model/types';
import { runInBackground, type BackgroundRun, type RunWorker } from './inBackground';

export interface CheckInput {
  board: Board;
  library: ChipLibrary;
  challenge: Challenge;
  timing: TimingSetting;
}

export type BackgroundCheck = BackgroundRun<BehaviorReport>;
export type CheckWorker = RunWorker<CheckInput, BehaviorReport>;

export function spawnCheckWorker(): CheckWorker | null {
  if (typeof Worker === 'undefined') return null;
  try {
    return new Worker(new URL('./challenge.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
}

const checkOnMainThread = (input: CheckInput) =>
  behaviorReport(input.board, input.library, input.challenge, input.timing);

/** Check challenge's behavior run in a Worker, never on the live sim. */
export function checkInBackground(
  input: CheckInput,
  spawn: () => CheckWorker | null = spawnCheckWorker,
): BackgroundCheck {
  return runInBackground(input, spawn, checkOnMainThread);
}
