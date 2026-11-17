import type { ChipLibrary, Circuit } from '../../core/model/types';
import { paintWithoutGlyphCache } from '../../render/glyphCache';
import type { Theme } from '../../render/theme';
import { renderBoard, type RenderParams } from '../workbench-circuit/editorScene';
import { circuitDrawnBounds } from '../workbench-circuit/fitView';
import type { ExportPicture } from './exportPicture';

const NO_SELECTION: ReadonlySet<string> = new Set();
const UNPOWERED = () => undefined;

export interface SchematicSignals {
  pinSignal: RenderParams['pinSignal'];
  pinRawValue?: RenderParams['pinRawValue'];
  heldOf?: RenderParams['heldOf'];
}

/**
 * The circuit at one CSS pixel per world unit, framed by its drawn bounds plus
 * two grid cells, with none of the editing overlays. Null when nothing draws.
 */
export function schematicPicture(
  theme: Theme,
  circuit: Circuit,
  chipLib: ChipLibrary,
  opts: { grid: boolean; signals?: SchematicSignals | undefined },
): ExportPicture | null {
  const bounds = circuitDrawnBounds(circuit, chipLib, theme);
  if (!bounds) return null;
  const margin = 2 * theme.gridSchematic;
  const width = Math.ceil(bounds.w + 2 * margin);
  const height = Math.ceil(bounds.h + 2 * margin);
  const viewport = { panX: bounds.x - margin, panY: bounds.y - margin, zoom: 1 };
  return {
    width,
    height,
    draw: (ctx) => {
      // renderBoard sets its own transform from dpr, so the scale comes in as dpr.
      const dpr = ctx.getTransform().a;
      paintWithoutGlyphCache(() =>
        renderBoard(ctx, theme, {
          board: circuit,
          chipLib,
          viewport,
          selection: NO_SELECTION,
          pinSignal: opts.signals?.pinSignal ?? UNPOWERED,
          ...(opts.signals?.pinRawValue ? { pinRawValue: opts.signals.pinRawValue } : {}),
          ...(opts.signals?.heldOf ? { heldOf: opts.signals.heldOf } : {}),
          grid: theme.gridSchematic,
          hideGrid: !opts.grid,
          dpr,
        }),
      );
    },
  };
}
