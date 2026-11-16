import type { MenuEntry } from '../menu/menuModel';

export interface ChallengeMenuState {
  has: boolean;
  /** Test rows or a truth table: without either there is nothing to check. */
  hasBehavior: boolean;
  checking: boolean;
  /** A chip tab or an open lesson: every item greys. */
  blocked: boolean;
  viewOnly: boolean;
  check: () => void;
  show: () => void;
  edit: (isNew: boolean) => void;
  remove: () => void;
}

const BLOCKED_TIP = 'Challenges live on a board, outside a lesson';

/** The Challenge menu. Without a challenge only New is offered. */
export function challengeMenuItems(m: ChallengeMenuState): MenuEntry[] {
  const off = m.blocked || !m.has;
  const editOff = off || m.viewOnly;
  const tip = m.blocked ? { title: BLOCKED_TIP } : {};
  return [
    {
      id: 'checkChallenge',
      label: 'Check challenge',
      disabled: off || m.checking || !m.hasBehavior,
      ...tip,
      run: m.check,
    },
    { id: 'showBrief', label: 'Show brief', disabled: off, ...tip, run: m.show },
    { separator: true },
    {
      id: 'editChallenge',
      label: 'Edit challenge...',
      disabled: editOff,
      ...tip,
      run: () => m.edit(false),
    },
    {
      id: 'newChallenge',
      label: 'New challenge from this board...',
      disabled: m.blocked || m.viewOnly,
      ...tip,
      run: () => m.edit(true),
    },
    { id: 'removeChallenge', label: 'Remove challenge', disabled: editOff, ...tip, run: m.remove },
  ];
}
