import type { Circuit } from '../../core/model/types';

/** A drawing in CSS pixels; the rasteriser scales the context before `draw`. */
export interface ExportPicture {
  width: number;
  height: number;
  draw: (ctx: CanvasRenderingContext2D) => void;
}

export type ExportView = 'schematic' | 'waveforms' | 'kmap' | 'table';

export const EXPORT_VIEWS: readonly ExportView[] = ['schematic', 'waveforms', 'kmap', 'table'];

export const VIEW_LABEL: Record<ExportView, string> = {
  schematic: 'Schematic',
  waveforms: 'Waveforms',
  kmap: 'K-map',
  table: 'Truth table',
};

/** File-name suffix per view. */
export const VIEW_SLUG: Record<ExportView, string> = {
  schematic: 'schematic',
  waveforms: 'waveforms',
  kmap: 'kmap',
  table: 'truth-table',
};

/** Browsers refuse or blank a canvas past these (Safari is the tightest). */
export const MAX_SIDE_PX = 8192;
export const MAX_AREA_PX = 64 * 1024 * 1024;

/**
 * The largest scale at most `wanted` that keeps the backing store inside the
 * caps, and whether it had to drop. Never below a scale that still fits one
 * pixel per CSS pixel unless the picture itself is past the caps.
 */
export function fitScale(
  width: number,
  height: number,
  wanted: number,
): { scale: number; reduced: boolean } {
  const bySide = MAX_SIDE_PX / Math.max(width, height, 1);
  const byArea = Math.sqrt(MAX_AREA_PX / Math.max(width * height, 1));
  const cap = Math.min(bySide, byArea);
  if (wanted <= cap) return { scale: wanted, reduced: false };
  // Two decimals keep the pixel size stable across calls.
  return { scale: Math.floor(cap * 100) / 100, reduced: true };
}

/** Why the schematic cannot be exported, or null. A wires-only selection has no parts to frame. */
export function schematicUnavailable(
  circuit: Circuit,
  selection: ReadonlySet<string>,
  selectionOnly: boolean,
): string | null {
  if (circuit.components.length === 0) return 'The board is empty';
  if (selectionOnly && selectionSubset(circuit, selection).components.length === 0)
    return 'The selection has no parts';
  return null;
}

/**
 * The selected part of a circuit: selected components and junctions, and a
 * wire only when both its ends stay (a free end counts when the wire itself is
 * selected), so nothing in the image dangles into what was left out.
 */
export function selectionSubset(circuit: Circuit, selection: ReadonlySet<string>): Circuit {
  const components = circuit.components.filter((c) => selection.has(c.id));
  const kept = new Set(components.map((c) => c.id));
  const junctions = circuit.junctions.filter((j) => selection.has(j.id));
  const keptJunctions = new Set(junctions.map((j) => j.id));
  const wires = circuit.wires.filter((w) =>
    [w.a, w.b].every((end) =>
      end.kind === 'pin'
        ? kept.has(end.component)
        : end.kind === 'junction'
          ? keptJunctions.has(end.junction)
          : selection.has(w.id),
    ),
  );
  const groupIds = new Set(components.flatMap((c) => (c.group ? [c.group] : [])));
  const byId = new Map((circuit.groups ?? []).map((g) => [g.id, g]));
  for (const id of [...groupIds]) {
    let parent = byId.get(id)?.parent;
    while (parent && !groupIds.has(parent)) {
      groupIds.add(parent);
      parent = byId.get(parent)?.parent;
    }
  }
  const groups = (circuit.groups ?? []).filter((g) => groupIds.has(g.id));
  return { ...circuit, components, junctions, wires, ...(circuit.groups ? { groups } : {}) };
}
