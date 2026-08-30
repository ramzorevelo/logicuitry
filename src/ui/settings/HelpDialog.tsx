// The reference sheet. Everything this app can do that is not written on a
// button, in one scrollable place, reachable from inside the app itself.
//
// It shows ONE column: the keys where there is a keyboard, the gestures on a
// touchscreen. A reference is read while trying to do the thing, and half of a
// two-column table is always the half you cannot use. Rows with nothing for the
// input you are on are dropped rather than left blank, and a section that
// empties out goes with them.
//
// Every cell is the input itself, not a sentence about it: "Click", not "Click
// it". The row already says what the thing is.

import { useEffect } from 'react';
import { useCoarsePointer } from '../pointerKind';
import { SHORTCUTS } from '../menu/shortcuts';

interface Props {
  onClose: () => void;
}

interface Row {
  what: string;
  keys?: string;
  touch?: string;
}

interface Section {
  title: string;
  rows: Row[];
}

const SELECTION_BAR = 'Selection bar';

const SECTIONS: Section[] = [
  {
    title: 'Anywhere in the app',
    rows: [
      { what: 'Switch workbench', keys: 'Ctrl+1 / 2 / 3', touch: 'The bar along the bottom' },
      {
        what: 'Change the theme',
        keys: `${SHORTCUTS.theme}, ${SHORTCUTS.themeBack} back`,
        touch: 'Settings > Preferences',
      },
      { what: 'Fullscreen and presentation scaling', keys: SHORTCUTS.fullscreen },
      { what: 'Into the menu bar', keys: SHORTCUTS.menuBar },
      { what: 'This sheet', keys: '?', touch: 'Help > Keys and gestures' },
      { what: 'Close a dialog, cancel a gesture', keys: 'Esc', touch: 'Close, or tap outside' },
    ],
  },
  {
    title: 'Numbers',
    rows: [
      { what: 'Next step', keys: 'Space or .', touch: 'Step' },
      { what: 'Reveal every step', keys: 'Enter', touch: 'Reveal' },
      { what: 'Start over', keys: 'R', touch: 'Reset' },
    ],
  },
  {
    title: 'Circuit: tools',
    rows: [
      { what: 'Select and move', keys: 'Esc', touch: 'Select tool' },
      { what: 'Lasso a marquee', keys: SHORTCUTS.lasso, touch: 'Lasso tool' },
      { what: 'Draw wires', keys: SHORTCUTS.wire, touch: 'Wire tool, then pin to pin' },
      { what: 'Place a junction', keys: SHORTCUTS.junction, touch: 'Junction tool' },
      {
        what: 'Slash across wires to delete them',
        keys: SHORTCUTS.cut,
        touch: 'Cut tool, then drag across',
      },
      {
        what: 'Connect the selected parts',
        keys: SHORTCUTS.smartConnect,
        touch: `Connect tool, or ${SELECTION_BAR}`,
      },
      { what: 'Pair the pins by hand instead', keys: SHORTCUTS.smartConnectPicker },
      {
        what: 'Try a different pairing',
        keys: 'Wheel over the suggestion',
        touch: '‹ and › on the suggestion',
      },
      {
        what: 'Accept the suggested wires',
        keys: 'Enter, or a click on the board',
        touch: 'Accept',
      },
      { what: 'Bubble-push mode (De Morgan)', keys: SHORTCUTS.bubbleMode, touch: 'Bubble push' },
    ],
  },
  {
    title: 'Circuit: editing',
    rows: [
      { what: 'Delete', keys: SHORTCUTS.delete, touch: SELECTION_BAR },
      {
        what: 'Delete and reconnect the wire through the gap',
        keys: SHORTCUTS.deleteHeal,
        touch: SELECTION_BAR,
      },
      { what: 'Rotate each item', keys: SHORTCUTS.rotate, touch: SELECTION_BAR },
      { what: 'Rotate the selection as one', keys: SHORTCUTS.rotateGroup, touch: SELECTION_BAR },
      { what: 'Mirror', keys: SHORTCUTS.mirror, touch: SELECTION_BAR },
      {
        what: 'Swap a bubble for a NOT gate, and back',
        keys: SHORTCUTS.convertBubble,
        touch: SELECTION_BAR,
      },
      { what: 'Duplicate, then place the copy', keys: SHORTCUTS.duplicate, touch: SELECTION_BAR },
      { what: 'Copy / paste', keys: `${SHORTCUTS.copy} / ${SHORTCUTS.paste}` },
      { what: 'Group', keys: SHORTCUTS.group, touch: SELECTION_BAR },
      { what: 'Ungroup', keys: SHORTCUTS.ungroup, touch: SELECTION_BAR },
      {
        what: 'Undo / redo',
        keys: `${SHORTCUTS.undo} / ${SHORTCUTS.redo}`,
        touch: 'The two arrows',
      },
      { what: 'Edit a part’s parameters', keys: 'Double-click', touch: 'Long press' },
      { what: 'More or fewer pins', keys: '= and -' },
      { what: 'Wider or narrower bus', keys: '+ and _' },
      {
        what: 'Keep placing the same part',
        keys: 'Ctrl+click on the drop',
        touch: 'Long press in the palette',
      },
    ],
  },
  {
    title: 'Circuit: getting around',
    rows: [
      { what: 'Pan', keys: 'Middle-drag, Shift+drag, or Shift+wheel', touch: 'Drag anywhere' },
      { what: 'Zoom', keys: 'Wheel, or Ctrl+wheel on a trackpad', touch: 'Pinch' },
      { what: 'Fit the board to the view', keys: SHORTCUTS.fit, touch: 'Fit button' },
      { what: 'Select what is under the pointer', keys: 'Click', touch: 'Tap' },
      { what: 'Add to or remove from the selection', keys: 'Ctrl+click' },
      {
        what: 'Move a part, wire, bend or junction',
        keys: 'Drag',
        touch: 'Tap to select, then drag',
      },
    ],
  },
  {
    title: 'Circuit: simulation',
    rows: [
      { what: 'Power on and off', keys: SHORTCUTS.power, touch: 'Power button' },
      { what: 'One delta step', keys: SHORTCUTS.step, touch: 'Step button' },
    ],
  },
];

export function HelpDialog({ onClose }: Props) {
  const coarse = useCoarsePointer();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const sections = SECTIONS.map((section) => ({
    ...section,
    rows: section.rows
      .map((row) => ({ what: row.what, how: coarse ? row.touch : row.keys }))
      .filter((row): row is { what: string; how: string } => row.how !== undefined),
  })).filter((section) => section.rows.length > 0);

  return (
    <div
      className="package-overlay"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="package-dialog help-dialog">
        <h3>{coarse ? 'Gestures' : 'Keyboard shortcuts'}</h3>
        <div className="help-sheet">
          {sections.map((section) => (
            <section key={section.title} className="help-section">
              <h4 className="help-section__title">{section.title}</h4>
              <table className="help-table">
                <tbody>
                  {section.rows.map((row) => (
                    <tr key={row.what}>
                      <th scope="row">{row.what}</th>
                      <td>{coarse ? row.how : <kbd>{row.how}</kbd>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </div>
        <div className="label-conflict-buttons">
          <button type="button" className="tool-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
