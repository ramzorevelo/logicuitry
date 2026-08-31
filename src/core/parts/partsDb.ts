import rawDb from './74ls.json';

export interface TypMax {
  /** Absent when the datasheet publishes a max only (74LS47/'48 leave the typ
   *  column blank). Readers fall back to max rather than invent a figure. */
  typ?: number;
  max: number;
}

export interface PartEntry {
  part: string;
  primitive: string;
  tplh?: TypMax;
  tphl?: TypMax;
  tplh_worst?: TypMax;
  tphl_worst?: TypMax;
  tplh_clk_q?: TypMax;
  tphl_clk_q?: TypMax;
  paths?: Record<string, { tplh: TypMax; tphl: TypMax }>;
  setup_min?: number;
  hold_min?: number;
  verified: boolean;
  source: string;
}

export interface PartsDb {
  family: string;
  levels: { vcc: number; vohMin: number; volMax: number; vihMin: number; vilMax: number };
  parts: PartEntry[];
}

export type DatasheetColumn = 'typ' | 'max';
export type OutputEdge = 'lh' | 'hl';

/** Read one column, falling back to max when the typ column is unpublished. */
export function column(fig: TypMax, col: DatasheetColumn): number {
  return col === 'max' ? fig.max : (fig.typ ?? fig.max);
}

const db = rawDb as PartsDb;
const byPart = new Map(db.parts.map((p) => [p.part, p]));

export function partsDb(): PartsDb {
  return db;
}

export function getPart(part: string): PartEntry | undefined {
  return byPart.get(part);
}

/**
 * Propagation delay in ns for one output edge. Worst-case condition figures
 * (74LS86) are used only when col is 'max'; clocked parts use their clk->q
 * figures; multi-path parts (74LS283) report their slowest path here, the
 * per-path numbers belong to static timing analysis.
 */
export function propagationNs(
  part: string,
  edge: OutputEdge,
  col: DatasheetColumn,
): number | undefined {
  const p = byPart.get(part);
  if (!p) return undefined;
  const plain = edge === 'lh' ? p.tplh : p.tphl;
  const worst = edge === 'lh' ? p.tplh_worst : p.tphl_worst;
  const clkQ = edge === 'lh' ? p.tplh_clk_q : p.tphl_clk_q;
  const chosen = clkQ ?? (col === 'max' && worst ? worst : plain);
  if (chosen) return column(chosen, col);
  if (p.paths) {
    let slowest = 0;
    for (const path of Object.values(p.paths))
      slowest = Math.max(slowest, column(edge === 'lh' ? path.tplh : path.tphl, col));
    return slowest || undefined;
  }
  return undefined;
}

/**
 * False when the part's delay figures carry no typ column, so every "typ"
 * number it reports is really the published max. Drawn as a caveat next to the
 * figure, the same way an estimated t_cd is.
 */
export function typPublished(part: string): boolean {
  const p = byPart.get(part);
  if (!p) return true;
  const figs = [p.tplh, p.tphl, p.tplh_worst, p.tphl_worst, p.tplh_clk_q, p.tphl_clk_q];
  for (const path of Object.values(p.paths ?? {})) figs.push(path.tplh, path.tphl);
  const present = figs.filter((f): f is TypMax => f !== undefined);
  return present.length === 0 || present.some((f) => f.typ !== undefined);
}

/**
 * Contamination delay in ns. 74LS datasheets guarantee no minimums, so the
 * documented estimate is 0.35 x typical propagation; surfaces with an
 * "estimated" caveat wherever it is drawn. On a max-only part the typical is
 * itself the max, which typPublished reports so the caveat can say so.
 */
export function contaminationNs(part: string, edge: OutputEdge): number | undefined {
  const tpd = propagationNs(part, edge, 'typ');
  return tpd === undefined ? undefined : Math.round(0.35 * tpd);
}
