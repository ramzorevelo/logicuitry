// Level of detail for glyph decoration. Silhouette and state colour never
// degrade: they are the teaching content; only additive decoration drops, in
// the order it costs the most for what it says.

export type LodLevel = 'full' | 'reduced' | 'flat';

/** Zoomed further out than this, decoration is sub-pixel noise anyway. */
const ZOOM_REDUCED = 0.75;
const ZOOM_FLAT = 0.45;
/** Above this many components a frame is redraw-bound rather than fill-bound. */
const DENSE = 120;
const VERY_DENSE = 300;

export function lodFor(zoom: number, componentCount: number): LodLevel {
  if (zoom < ZOOM_FLAT || componentCount > VERY_DENSE) return 'flat';
  if (zoom < ZOOM_REDUCED || componentCount > DENSE) return 'reduced';
  return 'full';
}

/** Corner motifs go first: smallest marks, least meaning. */
export function showsCorners(lod: LodLevel): boolean {
  return lod === 'full';
}

/** Relief and rim-lines survive one step past the motifs. */
export function showsRelief(lod: LodLevel): boolean {
  return lod !== 'flat';
}

/** Body patterns are the largest fill cost, and read as texture at best. */
export function showsPattern(lod: LodLevel): boolean {
  return lod === 'full';
}

/** Real shadowBlur is budgeted per frame and never survives a reduced frame. */
export function showsBloom(lod: LodLevel): boolean {
  return lod === 'full';
}
