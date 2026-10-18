// Palette thumbnails are the real schematic glyph, drawn through the same
// render path as the board: no second artwork set to drift, and the rail
// teaches the symbol the student has to recognise on paper.

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { ChipLibrary, Component, ComponentKind, ParamValue } from '../../core/model/types';
import { symbolBounds } from '../../render/glyphs/symbol';
import { sizeCanvas, watchBackingScale } from '../canvasBacking';
import { sharedTheme } from '../theme/sharedTheme';
import { useThemeRevision } from '../theme/useThemeRevision';
import { drawComponent } from './editorScene';

const BOX_W = 46;
/** A DIP is tall and fills a thumbnail by height, using about 20 px of its
 *  width; the narrower box gives a part number that room at the same scale. */
export const DIP_BOX_W = 28;
const BOX_H = 30;
const PAD = 2;

interface Props {
  kind: ComponentKind;
  chipLib: ChipLibrary;
  defId?: string | undefined;
  params?: Record<string, ParamValue> | undefined;
  boxWidth?: number | undefined;
}

/** Fits the glyph's own bounds into the thumbnail box; never scales up past
 *  1:1, so a small glyph stays at schematic size instead of looking heavier
 *  than the board it will be placed on. */
function PaletteGlyphImpl({ kind, chipLib, defId, params, boxWidth = BOX_W }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rev = useThemeRevision();
  const component = useMemo<Component>(
    () => ({
      id: `palette-${kind}`,
      kind,
      // Empty, not absent: glyphs that fall back to the component id for a
      // name (probe) would otherwise caption the thumbnail 'palette-probe'.
      label: '',
      pos: { x: 0, y: 0 },
      ...(defId ? { defId } : {}),
      ...(params ? { params } : {}),
    }),
    [kind, defId, params],
  );

  // Drawn once first seen: a closed group is display:none and never
  // intersects, so the 74 series costs nothing until it is opened.
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (seen || !canvas) return;
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setSeen(true);
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [seen]);

  useEffect(() => {
    if (!seen) return;
    const draw = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = sizeCanvas(canvas, boxWidth, BOX_H);
      if (!ctx) return;
      const theme = sharedTheme();
      const { bounds } = symbolBounds(
        component,
        theme,
        component.defId ? chipLib.get(component.defId) : undefined,
      );
      const scale = Math.min(
        1,
        (boxWidth - PAD * 2) / Math.max(bounds.w, 1),
        (BOX_H - PAD * 2) / Math.max(bounds.h, 1),
      );
      ctx.save();
      ctx.translate(boxWidth / 2, BOX_H / 2);
      ctx.scale(scale, scale);
      ctx.translate(-(bounds.x + bounds.w / 2), -(bounds.y + bounds.h / 2));
      drawComponent(ctx, theme, component, { chipLib, pinSignal: () => undefined });
      ctx.restore();
    };
    draw();
    return watchBackingScale(draw);
  }, [seen, component, chipLib, rev, boxWidth]);

  // Sized before the first draw, or an undrawn canvas lays out at 300x150.
  return (
    <canvas
      ref={canvasRef}
      className="palette-item__glyph"
      width={boxWidth}
      height={BOX_H}
      style={{ width: boxWidth, height: BOX_H }}
      aria-hidden="true"
    />
  );
}

// A thumbnail's drawing depends only on these props and the theme, and the
// palette remounts every item in a group at once.
export const PaletteGlyph = memo(PaletteGlyphImpl);
