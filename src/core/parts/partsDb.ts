import rawDb from './74ls.json';

export interface TypMax {
  typ: number;
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
  if (chosen) return chosen[col];
  if (p.paths) {
    let slowest = 0;
    for (const path of Object.values(p.paths))
      slowest = Math.max(slowest, (edge === 'lh' ? path.tplh : path.tphl)[col]);
    return slowest || undefined;
  }
  return undefined;
}

/**
 * Contamination delay in ns. 74LS datasheets guarantee no minimums, so the
 * documented estimate is 0.35 x typical propagation; surfaces with an
 * "estimated" caveat wherever it is drawn.
 */
export function contaminationNs(part: string, edge: OutputEdge): number | undefined {
  const tpd = propagationNs(part, edge, 'typ');
  return tpd === undefined ? undefined : Math.round(0.35 * tpd);
}
