import { useEffect, useRef } from 'react';
import { readTheme, type Theme } from '../../render/theme';
import { themeRevision } from '../theme/useThemeRevision';
import type { ExportPicture, ExportView } from './exportPicture';
import { fitScale } from './exportPicture';

export type Paper = 'light' | 'current';

const exportThemes = new Map<string, Theme>();

/**
 * Tokens for an export: light paper or the app's own theme, never presentation
 * sizes. Reads straight from the root rather than through sharedTheme, so the
 * shared cache never holds a theme the screen is not showing; the attributes
 * are put back before anything can paint. Each swap still wakes every observer
 * on <html> once, so a read is kept until the app's theme changes.
 */
export function readExportTheme(paper: Paper): Theme {
  const key = `${paper}|${themeRevision()}`;
  const cached = exportThemes.get(key);
  if (cached) return cached;
  const theme = readSwappedTheme(paper);
  for (const k of exportThemes.keys())
    if (!k.endsWith(`|${themeRevision()}`)) exportThemes.delete(k);
  exportThemes.set(key, theme);
  return theme;
}

function readSwappedTheme(paper: Paper): Theme {
  const root = document.documentElement;
  const themeAttr = root.getAttribute('data-theme');
  const className = root.className;
  try {
    if (paper === 'light') {
      root.setAttribute('data-theme', 'light');
      root.classList.remove('powered');
    }
    root.classList.remove('presentation');
    const theme = readTheme(root);
    // The light theme's paper is tinted for a screen; a printed page wants the white surface.
    return paper === 'light'
      ? { ...theme, colors: { ...theme.colors, paper: theme.colors.surface } }
      : theme;
  } finally {
    if (themeAttr === null) root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', themeAttr);
    root.className = className;
  }
}

/** A view the open board cannot draw by itself, offered while its panel is mounted. */
export interface PanelSource {
  /** Cheap check for the dialog's view list; a picture is only drawn for a view that has one. */
  available?: () => boolean;
  picture: (theme: Theme) => ExportPicture | null;
  /** The truth table as text, for Copy as table and the ZIP's CSV. */
  text?: () => { tsv: string; csv: string; html: string } | null;
}

const panelSources = new Map<ExportView, PanelSource>();

export function panelSource(view: ExportView): PanelSource | undefined {
  return panelSources.get(view);
}

/** Registers while mounted; the latest closure always answers, so callers never see stale state. */
export function useExportSource(view: ExportView, source: PanelSource | null): void {
  const ref = useRef(source);
  ref.current = source;
  const present = source !== null;
  useEffect(() => {
    if (!present) return;
    const live: PanelSource = {
      available: () => ref.current?.available?.() ?? ref.current !== null,
      picture: (theme) => ref.current?.picture(theme) ?? null,
      text: () => ref.current?.text?.() ?? null,
    };
    panelSources.set(view, live);
    return () => {
      if (panelSources.get(view) === live) panelSources.delete(view);
    };
  }, [view, present]);
}

export interface Raster {
  canvas: HTMLCanvasElement;
  scale: number;
  reduced: boolean;
}

export function rasterize(picture: ExportPicture, wantedScale: number): Raster | null {
  const { scale, reduced } = fitScale(picture.width, picture.height, wantedScale);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(picture.width * scale));
  canvas.height = Math.max(1, Math.round(picture.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  picture.draw(ctx);
  return { canvas, scale, reduced };
}

export function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('the image is too large to encode'))),
      'image/png',
    ),
  );
}
