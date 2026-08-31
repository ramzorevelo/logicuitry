// Toolbar icon set: one stroke vocabulary shared with the schematic glyphs, so
// the chrome reads as part of the same drawing system. Geometry is identical in
// every theme (only the container and font vary); a 24-unit viewBox is three
// 8px schematic cells, and every vertex sits on a half-cell.

export type IconName =
  | 'select'
  | 'lasso'
  | 'wire'
  | 'junction'
  | 'cut'
  | 'connect'
  | 'fit'
  | 'undo'
  | 'redo'
  | 'align'
  | 'package'
  | 'bubble'
  | 'analyze'
  | 'power'
  | 'run'
  | 'pause'
  | 'step'
  | 'timing'
  | 'sta'
  | 'open'
  | 'doubleNot'
  | 'cancel';

const PATHS: Record<IconName, JSX.Element> = {
  cancel: <path d="M6 6 L18 18 M18 6 L6 18" />,
  select: <path d="M6 3 L6 19 L10 15 L13 21 L16 20 L13 14 L18 14 Z" />,
  wire: (
    <>
      <path d="M4 19 H12 V6 H20" />
      <circle cx="4" cy="19" r="1.5" />
      <circle cx="20" cy="6" r="1.5" />
    </>
  ),
  junction: (
    <>
      <path d="M4 12 H20 M12 4 V20" />
      <circle cx="12" cy="12" r="2.5" fill="currentColor" />
    </>
  ),
  // The marquee itself, dashed, with the corner the drag starts from marked.
  lasso: (
    <>
      <path d="M4 4 H20 V20 H4 Z" strokeDasharray="3 3" />
      <circle cx="4" cy="4" r="1.5" fill="currentColor" />
    </>
  ),
  cut: <path d="M4 12 H20 M8 19 L16 5" />,
  // Two pins meeting: what smart connect does, drawn as the wire it proposes.
  connect: (
    <>
      <path d="M4 8 H10 M14 8 H20 M4 16 H10 M14 16 H20" />
      <circle cx="12" cy="8" r="2" />
      <circle cx="12" cy="16" r="2" />
    </>
  ),
  open: <path d="M3 19 V6 H9 L11 8 H21 V19 Z M3 19 L6 12 H21" />,
  fit: <path d="M4 8 V4 H8 M16 4 H20 V8 M20 16 V20 H16 M8 20 H4 V16" />,
  undo: (
    <>
      <path d="M8 8 H14 A5 5 0 1 1 14 18 H9" />
      <path d="M11 5 L8 8 L11 11" />
    </>
  ),
  redo: (
    <>
      <path d="M16 8 H10 A5 5 0 1 0 10 18 H15" />
      <path d="M13 5 L16 8 L13 11" />
    </>
  ),
  align: <path d="M5 4 V20 M9 8 H20 M9 12 H16 M9 16 H20" />,
  package: <path d="M4 6 H20 V19 H4 Z M4 11 H20 M12 11 V19" />,
  bubble: (
    <>
      <path d="M7 5 L16 12 L7 19 Z" />
      <circle cx="18.5" cy="12" r="2.5" />
    </>
  ),
  analyze: <path d="M4 5 H20 V19 H4 Z M12 5 V19 M4 12 H20" />,
  power: <path d="M12 4 V11 M6.5 7 A7 7 0 1 0 17.5 7" />,
  run: <path d="M7 4 L19 12 L7 20 Z" />,
  pause: <path d="M9 5 V19 M15 5 V19" />,
  step: <path d="M6 5 L15 12 L6 19 Z M18 5 V19" />,
  timing: <path d="M3 17 V7 H9 V17 H15 V7 H21" />,
  sta: (
    <>
      <circle cx="12" cy="13" r="7" />
      <path d="M12 9 V13 H15 M9 3 H15" />
    </>
  ),
  doubleNot: (
    <>
      <path d="M3 12 H21" />
      <circle cx="9" cy="12" r="2.5" />
      <circle cx="15" cy="12" r="2.5" />
    </>
  ),
};

export function ToolIcon({ name }: { name: IconName }) {
  return (
    <svg
      className="tool-icon"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
