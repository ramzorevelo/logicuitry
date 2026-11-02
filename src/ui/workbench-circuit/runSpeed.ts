import { RUN_SPEEDS } from '../../core/model/types';
import { formatTimePs } from '../../render/waveform';

export interface RunSpeedPreset {
  ps: number;
  label: string;
  /** What the speed is for, by the time scale it shows. */
  hint: string;
}

const HINTS = [
  'gate delays',
  'MHz clocks',
  'kHz clocks, contact bounce',
  'clocks of tens of Hz',
  'clocks of a few Hz',
];

const REAL_TIME = 1_000_000_000_000;

/** A speed as the toolbar shows it: sim time per wall second. */
export function runSpeedLabel(ps: number): string {
  return ps === REAL_TIME ? 'Real time' : `${formatTimePs(ps)}/s`;
}

export const RUN_SPEED_PRESETS: readonly RunSpeedPreset[] = RUN_SPEEDS.map((ps, i) => ({
  ps,
  label: runSpeedLabel(ps),
  hint: HINTS[i]!,
}));

/** Longest wall gap one frame may cover: a hidden tab pauses rAF, and its return must not jump. */
export const MAX_FRAME_MS = 100;

/**
 * Whole ps to advance for a frame `dtMs` long at `speed`, carrying the
 * fraction to the next frame so slow speeds do not lose time to rounding.
 */
export function frameAdvance(
  speed: number,
  dtMs: number,
  carry: number,
): { ps: number; carry: number } {
  const exact = (speed * Math.min(Math.max(dtMs, 0), MAX_FRAME_MS)) / 1000 + carry;
  const ps = Math.floor(exact);
  return { ps, carry: exact - ps };
}
