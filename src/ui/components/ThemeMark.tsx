// Per-theme identity mark beside the app title: the one place a theme signs
// itself, so a glance tells you which one you are in. Same 24-unit viewBox and
// stroke weight as the toolbar icons; the teaching defaults show nothing.

import type { ThemeName } from '../../render/theme';

const MARKS: Partial<Record<ThemeName, JSX.Element>> = {
  // Diamond outline, from her pupils and her ability nameplate.
  cyrene: <path d="M12 3 L20 12 L12 21 L4 12 Z M12 7.5 L16.5 12 L12 16.5 L7.5 12 Z" />,
  // Four-point star, reused as the junction dot.
  himeko: <path d="M12 2 L14 10 L22 12 L14 14 L12 22 L10 14 L2 12 L10 10 Z" />,
  // Step-fret (greca), orthogonal strokes only.
  kinich: <path d="M3 20 H18 V7 H8 V16 H14" />,
  // A ring quantised into visible pixel steps.
  silverwolf: <path d="M8 4 H16 V8 H20 V16 H16 V20 H8 V16 H4 V8 H8 Z" />,
  // Angular shard / X-clasp.
  firefly: <path d="M5 5 L12 11 L19 5 M5 19 L12 13 L19 19 M12 11 V13" />,
};

export function ThemeMark({ theme }: { theme: ThemeName }) {
  const mark = MARKS[theme];
  if (!mark) return null;
  return (
    <svg
      className="theme-mark"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      {mark}
    </svg>
  );
}
