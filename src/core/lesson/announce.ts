import type { BoardSequence, LessonAction, LessonStep } from '../model/types';
import { actionPhase } from './plan';

function announceAction(
  step: LessonStep,
  action: LessonAction,
  sequence: BoardSequence | undefined,
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
  }
}

/** The "This step" box: one line per board action, the tab excepted, so nothing changes unannounced. */
export function announceStep(step: LessonStep, sequence?: BoardSequence): string[] {
  const lines: string[] = [];
  for (const action of step.actions) {
    const line = announceAction(step, action, sequence);
    if (line) lines.push(line);
  }
  return lines;
}

export function rowMissingText(index: number): string {
  return `Row ${index + 1} is missing from the sequence: skipped`;
}

export function rowWhileOffText(index: number): string {
  return `Row ${index + 1} skipped: the board is off`;
}
