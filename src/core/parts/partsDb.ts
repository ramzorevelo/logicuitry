import rawDb from './74ls.json';
import rawFairchild from './74ls-fairchild.json';

export interface TypMax {
  /** Published minimum; only some sheets print one (Fairchild's gate sheets). */
  min?: number;
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
  /** The sheet's test condition for the plain and the worst rows ('86: the other input's level). */
  condition?: string;
  condition_worst?: string;
  tplh_clk_q?: TypMax;
  tphl_clk_q?: TypMax;
  paths?: Record<string, ArcRow>;
  enable?: EnableRow;
  /** Core input pin -> its own enable row, where the sheet times one control apart
   *  ('189 R/W against /S); any other moved input takes `enable`. */
  enable_from?: Record<string, EnableRow>;
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

/** Whose sheets time a board. TI covers every bound part; another vendor's table
 *  covers a few, and a part it lacks falls back to its TI row. */
export type Vendor = 'ti' | 'fairchild';
export const VENDOR_NAME: Record<Vendor, string> = { ti: 'TI', fairchild: 'Fairchild' };

/** Which setup and hold row a sampled pin is held to. */
export type SetupClass = 'data' | 'enable' | 'load' | 'clear';

export type DatasheetColumn = 'min' | 'typ' | 'max';
export type OutputEdge = 'lh' | 'hl';

/** Read one column. An unpublished typ falls back to max; an unpublished min to the contamination estimate. */
export function column(fig: TypMax, col: DatasheetColumn): number {
  if (col === 'max') return fig.max;
  if (col === 'min') return fig.min ?? estimatedContaminationNs(fig.typ ?? fig.max);
  return fig.typ ?? fig.max;
}

const db = rawDb as PartsDb;
const byPart = new Map(db.parts.map((p) => [p.part, p]));
const byVendor: Record<Vendor, Map<string, PartEntry>> = {
  ti: byPart,
  fairchild: new Map((rawFairchild.parts as PartEntry[]).map((p) => [p.part, p])),
};

export function partsDb(): PartsDb {
  return db;
}

export function getPart(part: string, vendor: Vendor = 'ti'): PartEntry | undefined {
  return byVendor[vendor].get(part) ?? byPart.get(part);
}

/** False when a vendor other than TI has no row for the part, so TI's times it. */
export function vendorHasRow(part: string, vendor: Vendor): boolean {
  return byVendor[vendor].has(part) || !byPart.has(part);
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
  vendor: Vendor = 'ti',
): number | undefined {
  const p = getPart(part, vendor);
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
export function typPublished(part: string, vendor: Vendor = 'ti'): boolean {
  const present = delayFigures(part, vendor);
  return present.length === 0 || present.some((f) => f.typ !== undefined);
}

/** True when every delay figure the part has carries a printed min, so its t_cd is not estimated. */
export function minPublished(part: string, vendor: Vendor = 'ti'): boolean {
  const present = delayFigures(part, vendor);
  return present.length > 0 && present.every((f) => f.min !== undefined);
}

function delayFigures(part: string, vendor: Vendor): TypMax[] {
  const p = getPart(part, vendor);
  if (!p) return [];
  const figs = [p.tplh, p.tphl, p.tplh_worst, p.tphl_worst, p.tplh_clk_q, p.tphl_clk_q];
  for (const path of Object.values(p.paths ?? {})) figs.push(path.tplh, path.tphl);
  return figs.filter((f): f is TypMax => f !== undefined);
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
 * Contamination delay in ns: the printed min where the sheet has one, else the
 * documented estimate of 0.35 x typical propagation, which surfaces with an
 * "estimated" caveat wherever it is drawn (minPublished tells the two apart).
 * On a max-only part the typical is itself the max, which typPublished reports.
 */
export function contaminationNs(
  part: string,
  edge: OutputEdge,
  vendor: Vendor = 'ti',
): number | undefined {
  return propagationNs(part, edge, 'min', vendor);
}
