// Per-theme glyph overrides. A theme registers a variant only for the devices
// it wants to redraw; everything else falls through to the canonical glyph, so
// seven themes never mean seven full glyph sets.
//
// A variant may redraw the silhouette freely but must keep the canonical
// bounding box and pin anchors (variants.test.ts enforces this): wiring,
// hit-testing, routing obstacles, splice, rotation and lasso all read them.

import type { SignalState, Theme } from '../theme';
import type { GeometryInput, Placement } from './symbol';

/** Devices a theme may redraw. Gates and boxes are excluded on purpose -- a
 *  gate's silhouette is its logic function, and stays canonical everywhere. */
export type VariantDevice =
  | 'toggle'
  | 'button'
  | 'led'
  | 'clock'
  | 'probe'
  | 'inport'
  | 'outport'
  | 'busdisplay';

export const VARIANT_DEVICES: VariantDevice[] = [
  'toggle',
  'button',
  'led',
  'clock',
  'probe',
  'inport',
  'outport',
  'busdisplay',
];

/** Same shape as the canonical draw functions, plus the live per-pin state a
 *  glyph colours from. Returns false to DECLINE -- the caller then falls
 *  through to the canonical glyph, so a variant only has to cover the forms it
 *  actually redraws (e.g. the 1-bit LED but not the multi-bit bank). */
export type VariantDraw = (
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  input: GeometryInput,
  placement: Placement,
  ctxState: VariantState,
) => boolean;

export interface VariantState {
  /** Aggregate state of a pin, or undefined when the board is unpowered. */
  state: (pin: string) => SignalState | undefined;
  /** Per-bit value, for bank glyphs that colour each cell. */
  raw: (pin: string) => { v: number; x: number; z: number };
  label?: string | undefined;
}

const registry = new Map<string, VariantDraw>();

const key = (theme: string, device: VariantDevice) => `${theme}|${device}`;

export function registerGlyphVariant(
  theme: string,
  device: VariantDevice,
  draw: VariantDraw,
): void {
  registry.set(key(theme, device), draw);
}

export function glyphVariant(theme: Theme, device: string): VariantDraw | undefined {
  return registry.get(`${theme.name}|${device}`);
}

export function registeredVariants(): { theme: string; device: VariantDevice }[] {
  return [...registry.keys()].map((k) => {
    const [theme, device] = k.split('|');
    return { theme: theme as string, device: device as VariantDevice };
  });
}
