// The bundled examples, as a plain list with a heading wherever a run of them
// shares a group. A dialog rather than a submenu: it is the natural entry
// point on a phone and on an empty first launch, where the menu bar is not
// where anyone looks first.

import { useEffect } from 'react';
import { EXAMPLES, type Example } from '../../examples';

export function ExamplesDialog({
  onOpen,
  onCancel,
}: {
  onOpen: (example: Example) => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  return (
    <div
      className="package-overlay"
      onPointerDown={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div className="package-dialog examples-dialog">
        <h3>Examples</h3>
        <p className="label-conflict-hint">
          An example opens as a new untitled board, so saving asks where to put it and the example
          itself is never overwritten.
        </p>
        <ul className="examples-list">
          {EXAMPLES.map((e, i) => (
            <li key={e.id}>
              {e.group !== undefined && e.group !== EXAMPLES[i - 1]?.group && (
                <h4 className="examples-group">{e.group}</h4>
              )}
              <button
                type="button"
                className="examples-item"
                autoFocus={i === 0}
                onClick={() => onOpen(e)}
              >
                <span className="examples-item__name">{e.name}</span>
                <span className="examples-item__desc">{e.description}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="label-conflict-buttons">
          <button type="button" className="tool-btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
