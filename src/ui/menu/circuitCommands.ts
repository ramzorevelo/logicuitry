// Labels for the commands the Circuit workbench contributes. Shared so the
// live items and the greyed placeholders shown on other workbenches cannot
// drift apart: a menu whose wording changes as you switch tabs would be
// worse than one that changes shape.

import { SHORTCUTS } from './shortcuts';
import type { Menu, MenuEntry } from './menuModel';

export const CIRCUIT_COMMANDS = {
  import: 'Import circuit...',
  package: 'Package as chip...',
  undo: 'Undo',
  redo: 'Redo',
  copy: 'Copy',
  paste: 'Paste',
  delete: 'Delete',
  deleteHeal: 'Delete and reconnect',
  fit: 'Zoom to fit',
  power: 'Power on',
  step: 'Step one delta',
  bubble: 'Bubble-push mode',
} as const;

const stub = (id: string, label: string, shortcut?: string): MenuEntry => ({
  id,
  label,
  ...(shortcut ? { shortcut } : {}),
  disabled: true,
  run: () => {},
});

/** What File/Edit/View/Simulate look like while some other workbench is
 *  showing: present, in their usual order, and greyed. */
export function inactiveCircuitMenus(): Menu[] {
  return [
    {
      id: 'file',
      items: [stub('import', CIRCUIT_COMMANDS.import), stub('package', CIRCUIT_COMMANDS.package)],
    },
    {
      id: 'edit',
      items: [
        stub('undo', CIRCUIT_COMMANDS.undo, SHORTCUTS.undo),
        stub('redo', CIRCUIT_COMMANDS.redo, SHORTCUTS.redo),
        { separator: true },
        stub('copy', CIRCUIT_COMMANDS.copy, SHORTCUTS.copy),
        stub('paste', CIRCUIT_COMMANDS.paste, SHORTCUTS.paste),
        { separator: true },
        stub('delete', CIRCUIT_COMMANDS.delete, SHORTCUTS.delete),
        stub('deleteHeal', CIRCUIT_COMMANDS.deleteHeal, SHORTCUTS.deleteHeal),
      ],
    },
    { id: 'view', items: [stub('fit', CIRCUIT_COMMANDS.fit, 'Home')] },
    {
      id: 'simulate',
      items: [
        stub('power', CIRCUIT_COMMANDS.power, SHORTCUTS.power),
        stub('step', CIRCUIT_COMMANDS.step, SHORTCUTS.step),
        stub('bubble', CIRCUIT_COMMANDS.bubble, SHORTCUTS.bubbleMode),
      ],
    },
  ];
}
