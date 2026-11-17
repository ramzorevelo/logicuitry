import type { BoardSequence, LessonAction, LessonStep } from '../model/types';
import { actionPhase } from './plan';

function announceAction(
  step: LessonStep,
  action: LessonAction,
  sequence: BoardSequence | undefined,
  nameOf: (id: string) => string,
): string | undefined {
  switch (action.kind) {
    case 'row': {
      const held = actionPhase(step, action) === 'reveal' ? ' on reveal' : '';
      const note = sequence?.rows[action.index]?.note;
      return `Applies sequence row ${action.index + 1}${held}${note ? `: ${note}` : ''}`;
    }
    case 'power':
      return action.on ? 'Powers on' : 'Powers off';
    case 'timing':
      return `Switches to ${action.mode} timing (restarts the sim)`;
    case 'highlight': {
      const n = action.components.length;
      return `Highlights ${n} ${n === 1 ? 'part' : 'parts'}`;
    }
    case 'tab':
      return undefined;
    case 'pulse':
      return `Clocks ${nameOf(action.clock)} once${actionPhase(step, action) === 'reveal' ? ' on reveal' : ''}`;
  }
}

/** The "This step" box: one line per board action, the tab excepted, so nothing changes unannounced. */
export function announceStep(
  step: LessonStep,
  sequence?: BoardSequence,
  nameOf: (id: string) => string = (id) => id,
): string[] {
  const lines: string[] = [];
  for (const action of step.actions) {
    const line = announceAction(step, action, sequence, nameOf);
    if (line) lines.push(line);
  }
  return lines;
}

export type PulseNoteReason = 'off' | 'running' | 'missing' | 'stuck' | 'loop';

/** A pulse that did not run cleanly; `loop` ran but the board then oscillated. */
export function pulseSkippedText(clock: string, why: PulseNoteReason): string {
  if (why === 'loop') return `Clock pulse on ${clock}: the board oscillates after the edge`;
  const reason = {
    off: 'the board is off',
    running: 'Run is on, so the clock is already running',
    missing: `${clock} is not a clock on this board`,
    stuck: 'the clock did not complete a cycle',
  }[why];
  return `Clock pulse skipped: ${reason}`;
}

export function rowMissingText(index: number): string {
  return `Row ${index + 1} is missing from the sequence: skipped`;
}

export function rowWhileOffText(index: number): string {
  return `Row ${index + 1} skipped: the board is off`;
}
