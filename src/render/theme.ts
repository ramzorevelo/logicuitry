// Bridge from CSS custom properties to the typed Theme the canvas renderer
// consumes. Read once per theme/presentation change, never per frame; no hex
// values live in TypeScript.

import type { BusValue } from '../core/value/busValue';
import { widthMask } from '../core/value/busValue';
import type { LodLevel } from './lod';

/** 'M' = a width>1 net whose lanes disagree (see busSignalState). */
export type SignalState = '0' | '1' | 'X' | 'Z' | 'M';

export interface SignalStyle {
  color: string;
  dashed: boolean;
  /** Second stroke colour, drawn on an offset dash so the two alternate. */
  alt?: string;
}

/** Per-theme canvas drawing dials. Defaults reproduce the canonical flat look. */
export interface GlyphDials {
  bodyFill: 'surface' | 'tint';
  bodyPattern: 'none' | 'facet' | 'pixel' | 'hatch';
  boxCorner: 'sharp' | 'clip' | 'stair' | 'shard';
  relief: 'flat' | 'bevel' | 'emboss';
  rimLine: 'none' | 'inset';
  corners: 'none' | 'bracket';
  emphasis: 'none' | 'halo' | 'bloom';
  pinCap: 'butt' | 'round';
  junctionDot: 'circle' | 'diamond' | 'square' | 'star';
}

/** Per-theme waveform chrome. Semantics (state colours, band meaning) are
 *  fixed; only weight, grid density and the fill-under-high cue vary. */
export interface WaveDials {
  /** The instrument's own ground, so a themed plot can sit on a different
   *  field from the page it lives on. */
  surface: string;
  ink: string;
  muted: string;
  /** Logic-1 trace ink. Wires are unaffected: this recolours the instrument,
   *  not the signal language on the board. */
  traceHigh: string;
  traceWeight: number;
  gridDensity: number;
  fillUnderHigh: boolean;
}

export interface Theme {
  name: ThemeName;
  appearance: 'light' | 'dark';
  colors: {
    paper: string;
    surface: string;
    ink: string;
    muted: string;
    line: string;
    accent: string;
    accent2: string;
    /** Third identity colour: emission/glow. Never carries signal meaning --
     *  it decorates a lit output, it does not encode one. */
    accent3: string;
    accentFill: string;
    warn: string;
    ok: string;
    signalMixed: string;
    /** 8 categorical K-map group strokes (--kmap-g1..8). */
    kmapGroups: string[];
  };
  fonts: { ui: string; mono: string; display: string };
  strokes: { min: number; wire: number; bus: number; cornerRadius: number };
  glyph: GlyphDials;
  wave: WaveDials;
  /** Decoration budget for the frame being drawn; silhouette and state colour
   *  ignore it. renderBoard lowers it per frame, readTheme never does. */
  lod: LodLevel;
  canvasTextMin: number;
  /** Font size for component names and pin labels drawn on canvas: the text
   *  floor, scaled up in presentation mode. Glyph geometry measures against
   *  this too, so a box grows with its labels instead of clipping them. */
  glyphText: number;
  gridSchematic: number;
  presentation: boolean;
}

export interface ThemeInfo {
  name: string;
  label: string;
  appearance: 'light' | 'dark';
}

/** Registry order is the T / Shift+T cycle order. */
export const THEMES = [
  { name: 'light', label: 'Light', appearance: 'light' },
  { name: 'dark', label: 'Dark', appearance: 'dark' },
  { name: 'cyrene', label: 'Cyrene', appearance: 'light' },
  { name: 'himeko', label: 'Himeko Nova', appearance: 'dark' },
  { name: 'kinich', label: 'Kinich', appearance: 'dark' },
  { name: 'silverwolf', label: 'Silver Wolf', appearance: 'dark' },
  { name: 'firefly', label: 'Firefly', appearance: 'dark' },
] as const satisfies readonly ThemeInfo[];

export type ThemeName = (typeof THEMES)[number]['name'];

/** Themes the running build offers. The character themes stay in THEMES so the
 *  variant registry and token blocks keep resolving; set VITE_ALL_THEMES=1 to
 *  put them back on the menu. */
export const SELECTABLE_THEMES: readonly (typeof THEMES)[number][] =
  import.meta.env?.VITE_ALL_THEMES === '1'
    ? THEMES
    : THEMES.filter((t) => t.name === 'light' || t.name === 'dark');

export function isSelectableTheme(name: ThemeName): boolean {
  return SELECTABLE_THEMES.some((t) => t.name === name);
}

export function themeInfo(name: ThemeName): (typeof THEMES)[number] {
  return THEMES.find((t) => t.name === name) ?? THEMES[0];
}

export function isThemeName(value: string | null): value is ThemeName {
  return THEMES.some((t) => t.name === value);
}

export function readTheme(root: HTMLElement = document.documentElement): Theme {
  const style = getComputedStyle(root);
  const token = (name: string): string => {
    const value = style.getPropertyValue(name).trim();
    if (!value) throw new Error(`missing design token ${name}`);
    return value;
  };
  const px = (name: string): number => Number.parseFloat(token(name));
  // A token whose value is outside the dial's vocabulary is an authoring typo;
  // fall back rather than crash the whole canvas over decoration.
  const dial = <T extends string>(name: string, allowed: readonly T[], fallback: T): T => {
    const value = token(name) as T;
    return allowed.includes(value) ? value : fallback;
  };

  const strokeScale = Number.parseFloat(token('--stroke-scale')) || 1;
  const attr = root.getAttribute('data-theme');
  const name: ThemeName = isThemeName(attr) ? attr : 'light';
  return {
    name,
    appearance: themeInfo(name).appearance,
    colors: {
      paper: token('--paper'),
      surface: token('--surface'),
      ink: token('--ink'),
      muted: token('--muted'),
      line: token('--line'),
      accent: token('--accent'),
      accent2: token('--accent-2'),
      accent3: token('--accent-3'),
      accentFill: token('--accent-fill'),
      warn: token('--warn'),
      ok: token('--ok'),
      signalMixed: token('--signal-mixed'),
      kmapGroups: Array.from({ length: 8 }, (_, i) => token(`--kmap-g${i + 1}`)),
    },
    fonts: { ui: token('--font-ui'), mono: token('--font-mono'), display: token('--display-font') },
    strokes: {
      min: px('--stroke-min') * strokeScale,
      wire: px('--wire-width') * strokeScale,
      bus: px('--bus-width') * strokeScale,
      cornerRadius: px('--wire-corner-radius'),
    },
    glyph: {
      bodyFill: dial('--glyph-body-fill', ['surface', 'tint'] as const, 'surface'),
      bodyPattern: dial('--glyph-pattern', ['none', 'facet', 'pixel', 'hatch'] as const, 'none'),
      boxCorner: dial('--glyph-box-corner', ['sharp', 'clip', 'stair', 'shard'] as const, 'sharp'),
      relief: dial('--glyph-relief', ['flat', 'bevel', 'emboss'] as const, 'flat'),
      rimLine: dial('--glyph-rim-line', ['none', 'inset'] as const, 'none'),
      corners: dial('--glyph-corners', ['none', 'bracket'] as const, 'none'),
      emphasis: dial('--glyph-emphasis', ['none', 'halo', 'bloom'] as const, 'none'),
      pinCap: dial('--glyph-pin-cap', ['butt', 'round'] as const, 'butt'),
      junctionDot: dial(
        '--glyph-junction',
        ['circle', 'diamond', 'square', 'star'] as const,
        'circle',
      ),
    },
    wave: {
      surface: token('--wave-surface'),
      ink: token('--wave-ink'),
      muted: token('--wave-muted'),
      traceHigh: token('--wave-trace-high'),
      traceWeight: Number.parseFloat(token('--wave-trace-weight')) || 1,
      gridDensity: Number.parseFloat(token('--wave-grid-density')) || 1,
      fillUnderHigh: token('--wave-fill-under') === '1',
    },
    lod: 'full',
    canvasTextMin: px('--canvas-text-min'),
    glyphText: px('--canvas-text-min') * (Number.parseFloat(token('--glyph-text-scale')) || 1),
    gridSchematic: px('--grid-schematic'),
    presentation: root.classList.contains('presentation'),
  };
}

/**
 * Theme for the schematic, where glyph geometry is measured rather than just
 * painted. Presentation mode scales `glyphText`, and every box, pin row and
 * DIP body sizes itself from it, so going fullscreen moved every pin and
 * reshaped every computed wire route: on a dense board the whole wiring
 * visibly shifts. The schematic therefore keeps the unscaled text, so a
 * component occupies the same space in both modes. Strokes still thicken,
 * which is what actually carries to the back of a room, and the larger
 * presentation hit radius is unaffected.
 */
export function withoutPresentationScale(t: Theme): Theme {
  return t.presentation ? { ...t, glyphText: t.canvasTextMin } : t;
}

export function schematicTheme(): Theme {
  return withoutPresentationScale(readTheme());
}

/**
 * Colours a packaged chip may be tinted with, stored on the def as a token
 * NAME rather than a hex: a chip built in one theme has to stay legible in the
 * other six and in both appearances, which a frozen hex cannot promise.
 * `accent` is deliberately absent, since it is logic 1 and a body wearing it
 * would read as a signal.
 */
export const CHIP_TINTS = ['accent2', 'accent3', 'ok', 'warn', 'muted'] as const;
export type ChipTint = (typeof CHIP_TINTS)[number];

export function isChipTint(name: string): name is ChipTint {
  return (CHIP_TINTS as readonly string[]).includes(name);
}

/** Resolves a stored tint name to this theme's colour. Tolerates the older
 *  `--token` spelling, and answers undefined for anything unknown so a
 *  hand-edited file degrades to an untinted body rather than a broken one. */
export function chipTintColor(theme: Theme, name: string | undefined): string | undefined {
  if (!name) return undefined;
  const key = name.startsWith('--')
    ? name.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())
    : name;
  return isChipTint(key) ? theme.colors[key] : undefined;
}

/** Hue centres, in degrees. Tuned against the real token palettes, not the
 *  textbook wheel: `green` sits high because every green in this project is a
 *  yellow-green through mint, and `pink` low so a light magenta reads pink. */
const HUE_NAMES: readonly (readonly [number, string])[] = [
  [0, 'red'],
  [20, 'orange'],
  [40, 'amber'],
  [55, 'yellow'],
  [80, 'lime'],
  [140, 'green'],
  [175, 'teal'],
  [193, 'cyan'],
  [215, 'blue'],
  [252, 'indigo'],
  [282, 'violet'],
  [305, 'magenta'],
  [330, 'pink'],
];

/** Saturation below this reads as a neutral; between this and CHROMA_SAT it
 *  reads as a tinted grey, which is what most "muted" tokens actually are. */
const GREY_SAT = 0.1;
const CHROMA_SAT = 0.28;
/** Above this a mid-light colour reads as vivid rather than pale. */
const VIVID_SAT = 0.75;

function parseCssColor(css: string): [number, number, number] | undefined {
  const hex = css.trim();
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  if (m) {
    const h = m[1]!;
    const wide = h.length === 6;
    const at = (i: number) =>
      wide ? Number.parseInt(h.slice(i * 2, i * 2 + 2), 16) : Number.parseInt(h[i]! + h[i]!, 16);
    return [at(0), at(1), at(2)];
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(hex);
  if (!rgb) return undefined;
  return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
}

function toHex(r: number, g: number, b: number): string {
  const p = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0');
  return `#${p(r)}${p(g)}${p(b)}`;
}

function hueName(hue: number): string {
  let best = HUE_NAMES[0]!;
  let bestGap = 360;
  for (const entry of HUE_NAMES) {
    const raw = Math.abs(hue - entry[0]);
    const gap = Math.min(raw, 360 - raw);
    if (gap < bestGap) {
      bestGap = gap;
      best = entry;
    }
  }
  return best[1];
}

/** Lightness word. Two swatches of one hue are told apart by this, so the
 *  bands are narrow enough to separate the palettes' real neighbours (a 0.45
 *  and a 0.60 blue-grey both exist in the shipped themes). */
function lightnessWord(l: number, sat: number): string {
  if (l < 0.4) return 'dark';
  if (l < 0.55) return '';
  if (l < 0.72) return sat >= VIVID_SAT ? 'bright' : 'light';
  return 'pale';
}

const join = (...parts: string[]): string => {
  const text = parts.filter(Boolean).join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

/**
 * A human name for the colour the user is actually looking at, e.g.
 * "Navy (#26307d)". Chip tints are STORED as token names so a chip survives a
 * theme switch, but a token name ("warn", "ok") is jargon for something on
 * screen, so the picker names each swatch from what the ACTIVE theme resolved
 * it to, keeping the label honest to the theme.
 *
 * Names must also be distinct within one theme's tint row, or the picker is
 * back to being unreadable; `tokens.colorName.test.ts` holds every theme to
 * that. US spelling ("gray"), per the owner.
 */
export function colorName(css: string): string {
  const rgb = parseCssColor(css);
  if (!rgb) return css;
  const [r, g, b] = rgb;
  const hex = toHex(r, g, b);
  const hi = Math.max(r, g, b);
  const lo = Math.min(r, g, b);
  const l = (hi + lo) / 2 / 255;
  const d = (hi - lo) / 255;
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));

  if (l <= 0.06) return `Black (${hex})`;
  if (l >= 0.95) return `White (${hex})`;
  if (sat < GREY_SAT) return `${join(lightnessWord(l, sat), 'gray')} (${hex})`;

  let h: number;
  if (hi === r) h = ((((g - b) / 255 / d) % 6) + 6) % 6;
  else if (hi === g) h = (b - r) / 255 / d + 2;
  else h = (r - g) / 255 / d + 4;
  h = (h * 60 + 360) % 360;

  // A warm hue that is dark, or washed out, is brown -- naming it by hue alone
  // ("dark orange", "orange gray") is technically right and reads wrong.
  const warm = h >= 12 && h < 60;
  const hue = warm ? 'brown' : hueName(h);
  // A colour that is mostly gray with a cast is named as one: "blue gray"
  // beats "blue" for a #8c92a8, and beats a bare "gray" for telling two of
  // them apart.
  if (sat < CHROMA_SAT) return `${join(lightnessWord(l, sat), hue, 'gray')} (${hex})`;

  if (warm && l < 0.4) return `${join(l < 0.26 ? 'dark' : '', 'brown')} (${hex})`;
  if (l < 0.36 && h >= 200 && h < 265) return `Navy (${hex})`;
  if (warm) return `${join(lightnessWord(l, sat), hueName(h))} (${hex})`;

  return `${join(lightnessWord(l, sat), hue)} (${hex})`;
}

/** The one signal color language, identical everywhere, all semester. */
export function signalStyle(theme: Theme, state: SignalState): SignalStyle {
  switch (state) {
    case '1':
      return { color: theme.colors.accent, dashed: false };
    case '0':
      return { color: theme.colors.muted, dashed: false };
    case 'X':
      return { color: theme.colors.warn, dashed: false };
    case 'Z':
      return { color: theme.colors.muted, dashed: true };
    case 'M':
      return { color: theme.colors.signalMixed, dashed: false, alt: theme.colors.muted };
  }
}

/** Whole-net state for colouring. The single definition of the width>1 rules:
 *  unknown dominates, all-floating is Z, and any disagreement between lanes is
 *  M so a partially-asserted bus never reads as fully set or fully clear. A
 *  1-bit net (including one lane of an expanded bus) can never be M. */
export function busSignalState(v: BusValue, width: number): SignalState {
  const m = widthMask(width);
  if (v.x & m) return 'X';
  if ((v.z & m) === m) return 'Z';
  if (v.z & m) return 'M';
  if ((v.v & m) === m) return '1';
  if (!(v.v & m)) return '0';
  return 'M';
}

export function applyTheme(name: ThemeName, root: HTMLElement = document.documentElement): void {
  root.setAttribute('data-theme', name);
}

/** Registry-order cycle; dir 1 = T, dir -1 = Shift+T. */
export function cycleTheme(current: ThemeName, dir: 1 | -1): ThemeName {
  const list = SELECTABLE_THEMES;
  const i = list.findIndex((t) => t.name === current);
  const n = list.length;
  return list[((((i < 0 ? 0 : i) + dir) % n) + n) % n]!.name;
}

export function togglePresentation(root: HTMLElement = document.documentElement): boolean {
  return root.classList.toggle('presentation');
}

/** Idempotent form, for applying a stored preference at launch: unlike
 *  togglePresentation, calling it twice with the same value is a no-op. */
export function setPresentationMode(
  on: boolean,
  root: HTMLElement = document.documentElement,
): boolean {
  root.classList.toggle('presentation', on);
  return on;
}
