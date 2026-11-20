import { isBuiltinChipDef } from '../parts/packages';
import type { Board, ChipDef } from './types';

/**
 * The user chips a board needs, transitively through chip definitions. A def
 * missing from the library falls back to the board's previously embedded copy.
 */
export function chipsUsedBy(
  board: Board,
  library: ReadonlyMap<string, ChipDef>,
  previous: readonly ChipDef[] = [],
): ChipDef[] {
  const prior = new Map(previous.map((d) => [d.id, d]));
  const seen = new Set<string>();
  const found = new Map<string, ChipDef>();
  const visit = (defId: string | undefined): void => {
    if (defId === undefined || seen.has(defId)) return;
    seen.add(defId);
    const def = library.get(defId) ?? prior.get(defId);
    if (!def) return;
    if (!isBuiltinChipDef(def)) found.set(def.id, def);
    for (const c of def.components) visit(c.defId);
  };
  for (const c of board.components) visit(c.defId);
  return [...found.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/** Version and silenced checks are bookkeeping, not what the chip does. */
export function sameBehavior(a: ChipDef, b: ChipDef): boolean {
  const strip = (d: ChipDef) => {
    return canonical({ ...d, version: 0, hiddenChecks: undefined });
  };
  return strip(a) === strip(b);
}

/** Wires reach a chip by pin name, so a changed pin set leaves them dangling. */
export function pinsDiffer(a: ChipDef, b: ChipDef): boolean {
  const key = (d: ChipDef) =>
    d.pins
      .map((p) => `${p.name}/${p.dir}/${p.width}`)
      .sort()
      .join('|');
  return key(a) !== key(b);
}

/** Ids of embedded chips whose content differs from the already loaded def of the same id. */
export function chipsThatDiffer(
  embedded: readonly ChipDef[],
  loaded: ReadonlyMap<string, ChipDef>,
): string[] {
  return embedded
    .filter((e) => {
      const have = loaded.get(e.id);
      return have !== undefined && !isBuiltinChipDef(have) && !sameBehavior(e, have);
    })
    .map((e) => e.id);
}
