// Touch's replacement for the modifier keys and the hover-scoped shortcuts.
// A finger has no Ctrl, no Alt and no hover, so every edit that a mouse
// qualifies with one of those needs somewhere to be tapped instead.
//
// It renders CONTRIBUTED MENU COMMANDS rather than its own handlers: an edit
// must behave identically however it was reached, and a second copy of
// "delete the selection" is how the two drift apart.

import { useMenuCommand } from '../menu/MenuProvider';
import type { MenuCommand } from '../menu/menuModel';

/** Edit-menu command ids the bar offers, in the order a thumb meets them. */
const ACTIONS = [
  'connect',
  'convertBubble',
  'delete',
  'deleteHeal',
  'rotate',
  'rotateGroup',
  'mirror',
  'duplicate',
  'group',
  'ungroup',
] as const;

const LABELS: Record<string, string> = {
  connect: 'Connect',
  convertBubble: 'Bubble ⇄ NOT',
  delete: 'Delete',
  deleteHeal: 'Delete + reconnect',
  rotate: 'Rotate',
  rotateGroup: 'Rotate group',
  mirror: 'Mirror',
  duplicate: 'Duplicate',
  group: 'Group',
  ungroup: 'Ungroup',
};

export function SelectionActionBar({ visible }: { visible: boolean }) {
  // Hooks cannot be called in a loop over a dynamic list, and the id set is
  // fixed, so each is looked up by name.
  const cmds: (MenuCommand | undefined)[] = [
    useMenuCommand('edit', 'connect'),
    useMenuCommand('edit', 'convertBubble'),
    useMenuCommand('edit', 'delete'),
    useMenuCommand('edit', 'deleteHeal'),
    useMenuCommand('edit', 'rotate'),
    useMenuCommand('edit', 'rotateGroup'),
    useMenuCommand('edit', 'mirror'),
    useMenuCommand('edit', 'duplicate'),
    useMenuCommand('edit', 'group'),
    useMenuCommand('edit', 'ungroup'),
  ];

  if (!visible) return null;
  // Anything inapplicable is absent, never greyed: a phone has no room to
  // show what you cannot do.
  const available: { id: string; cmd: MenuCommand }[] = [];
  ACTIONS.forEach((id, i) => {
    const cmd = cmds[i];
    if (cmd && !cmd.disabled) available.push({ id, cmd });
  });
  if (available.length === 0) return null;

  return (
    <div className="selection-actions" role="toolbar" aria-label="Selection actions">
      {available.map(({ id, cmd }) => (
        <button key={id} type="button" className="tool-btn" onClick={cmd.run}>
          <span className="tool-btn__label">{LABELS[id] ?? cmd.label}</span>
        </button>
      ))}
    </div>
  );
}
