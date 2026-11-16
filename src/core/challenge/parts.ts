import { componentPaths } from '../model/compile';
import type { Board, Challenge, ChipLibrary, Circuit, Component } from '../model/types';
import { widthParam } from '../sim/primitives/types';
import { GATE_KINDS, WIRING_AIDS, allowedOf, isPackageDef } from './allowed';

/** One counted part: a primitive, or a package IC, wherever it sits. */
export interface PartUse {
  /** The board-level component it is in or is, the one a row selects. */
  component: string;
  /** Names from the board down, `alu/U1/g3`. */
  name: string;
  /** Kind, or the part number of an IC. */
  part: string;
  /** Bits for a gate, 1 for everything else. */
  width: number;
}

/** A chip instance whose definition cannot be walked. */
export interface PartsProblem {
  component: string;
  name: string;
  kind: 'missing' | 'recursive';
  defId: string;
}

export interface PartsCensus {
  parts: PartUse[];
  ics: PartUse[];
  gates: PartUse[];
  gateCount: number;
  problems: PartsProblem[];
}

export type PartsRowId = 'library' | 'allowed' | 'ics' | 'gates' | `required-${number}`;

export interface PartsRow {
  id: PartsRowId;
  met: boolean;
  /** What was counted: ICs, gate bits or matching parts. */
  count: number;
  /** Offenders for `allowed`, the matches for a count row, problems' parts for `library`. */
  uses: PartUse[];
  problems: PartsProblem[];
}

/**
 * Walks the unflattened board, so it reports on a board that does not
 * compile. A package IC is one leaf; a student chip counts by what is inside.
 */
export function partsCensus(board: Board, library: ChipLibrary): PartsCensus {
  const census: PartsCensus = { parts: [], ics: [], gates: [], gateCount: 0, problems: [] };
  const walk = (
    circuit: Circuit,
    names: ReadonlyMap<string, string>,
    top: string | undefined,
    prefix: string,
    onPath: ReadonlySet<string>,
  ) => {
    for (const c of circuit.components) {
      const component = top ?? c.id;
      const name = prefix + (names.get(c.id) ?? c.label ?? c.id);
      if (c.kind === 'chip') {
        const defId = c.defId ?? '';
        const def = library.get(defId);
        if (!def || onPath.has(defId)) {
          census.problems.push({
            component,
            name,
            kind: def ? 'recursive' : 'missing',
            defId,
          });
          continue;
        }
        if (isPackageDef(def)) {
          const use = { component, name, part: def.id, width: 1 };
          census.parts.push(use);
          census.ics.push(use);
          continue;
        }
        walk(def, innerNames(def), component, `${name}/`, new Set(onPath).add(defId));
        continue;
      }
      if (WIRING_AIDS.has(c.kind)) continue;
      const width = GATE_KINDS.has(c.kind) ? widthParam(c.params ?? {}) : 1;
      const use = { component, name, part: c.kind, width };
      census.parts.push(use);
      if (c.kind === 'timer555') census.ics.push(use);
      if (GATE_KINDS.has(c.kind)) {
        census.gates.push(use);
        census.gateCount += width;
      }
    }
  };
  walk(board, componentPaths(board, ''), undefined, '', new Set());
  return census;
}

const innerNames = (def: Circuit): Map<string, string> =>
  new Map(def.components.map((c: Component) => [c.id, c.label || c.id]));

/** Live rows, in the order the tab lists them; a constraint not set has no row. */
export function partsReport(board: Board, library: ChipLibrary, challenge: Challenge): PartsRow[] {
  const census = partsCensus(board, library);
  const rows: PartsRow[] = [];
  const row = (id: PartsRowId, met: boolean, count: number, uses: PartUse[]): PartsRow => ({
    id,
    met,
    count,
    uses,
    problems: [],
  });
  if (census.problems.length > 0)
    rows.push({ ...row('library', false, 0, []), problems: census.problems });
  if (challenge.allowed.length > 0) {
    const offenders = census.parts.filter((p) => !allowedOf(challenge.allowed, p.part));
    rows.push(row('allowed', offenders.length === 0, census.parts.length, offenders));
  }
  const { ics } = challenge;
  if (ics && (ics.min !== undefined || ics.max !== undefined)) {
    const n = census.ics.length;
    const met = n >= (ics.min ?? 0) && n <= (ics.max ?? Infinity);
    rows.push(row('ics', met, n, census.ics));
  }
  if (challenge.maxGates !== undefined)
    rows.push(row('gates', census.gateCount <= challenge.maxGates, census.gateCount, census.gates));
  challenge.required.forEach((req, i) => {
    const matches = census.parts.filter((p) => req.anyOf.includes(p.part));
    rows.push(row(`required-${i}`, matches.length >= req.count, matches.length, matches));
  });
  return rows;
}
