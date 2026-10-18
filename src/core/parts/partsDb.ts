import rawDb from './74ls.json';

export interface TypMax {
  /** Absent when the datasheet publishes a max only (74LS47/'48 leave the typ
   *  column blank). Readers fall back to max rather than invent a figure. */
  typ?: number;
  max: number;
}

/** One arc's figures. An async arc may publish one edge only (CLR to Q falls, never rises). */
export interface ArcRow {
  tplh?: TypMax;
  tphl?: TypMax;
}

/** A 3-state output's enable (Z to a level) and disable (a level to Z) times. */
export interface EnableRow {
  tpzh: TypMax;
  tpzl: TypMax;
  tphz: TypMax;
  tplz: TypMax;
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
  paths?: Record<string, ArcRow>;
  enable?: EnableRow;
  setup_min?: number;
  hold_min?: number;
  /** Per-class minimums where the datasheet splits them; a missing class takes `setup_min`. */
  setup?: Partial<Record<SetupClass, number>>;
  hold?: Partial<Record<SetupClass, number>>;
  verified: boolean;
  source: string;
}

export interface PartsDb {
  family: string;
  levels: { vcc: number; vohMin: number; volMax: number; vihMin: number; vilMax: number };
  parts: PartEntry[];
}

/** Which setup and hold row a sampled pin is held to. */
export type SetupClass = 'data' | 'enable' | 'load' | 'clear';

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
 * A primitive's datasheet binding, only once the part's row is in the table:
 * an unlisted part would label a fallback figure with a real part number.
 */
export function listedPart(part: string): string | undefined {
  return byPart.has(part) ? part : undefined;
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
    for (const path of Object.values(p.paths)) {
      const fig = edge === 'lh' ? path.tplh : path.tphl;
      if (fig) slowest = Math.max(slowest, column(fig, col));
    }
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

/** Setup and hold minimums in ns for one class of sampled pin; 0 when unpublished. */
export function setupHoldNs(
  entry: PartEntry | undefined,
  cls: SetupClass,
): { setupNs: number; holdNs: number } {
  return {
    setupNs: entry?.setup?.[cls] ?? entry?.setup_min ?? 0,
    holdNs: entry?.hold?.[cls] ?? entry?.hold_min ?? 0,
  };
}

/** 0.35 x typ in whole ns, or to 0.1 ns where whole ns would round a real delay to zero. */
export function estimatedContaminationNs(typNs: number): number {
  return Math.round(0.35 * typNs) || Math.round(3.5 * typNs) / 10;
}

/**
 * Contamination delay in ns. 74LS datasheets guarantee no minimums, so the
 * documented estimate is 0.35 x typical propagation; surfaces with an
 * "estimated" caveat wherever it is drawn. On a max-only part the typical is
 * itself the max, which typPublished reports so the caveat can say so.
 */
export function contaminationNs(part: string, edge: OutputEdge): number | undefined {
  const tpd = propagationNs(part, edge, 'typ');
  return tpd === undefined ? undefined : estimatedContaminationNs(tpd);
}
