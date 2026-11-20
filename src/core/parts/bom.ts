import { GATE_KINDS, isPackageDef } from '../challenge/allowed';
import { partsCensus, type PartsProblem } from '../challenge/parts';
import type { Board, ChipLibrary, Circuit, Component, ComponentKind } from '../model/types';
import { sevenSegCommon } from '../sim/primitives/display';
import { intParam, widthParam } from '../sim/primitives/types';
import { getPackage, packageEntries } from './packages';

export const BOARD_SCOPE = 'Board';

export interface BomPackageRow {
  part: string;
  caption: string;
  qty: number;
  /** User chip names holding it, or `Board`; deduped and sorted. */
  where: string[];
}

export interface BomGenericRow {
  key: string;
  caption: string;
  qty: number;
}

export interface BomGateOption {
  part: string;
  perPackage: number;
}

export interface BomGateRow {
  key: string;
  kind: ComponentKind;
  inputs: number;
  /** Gate bits: a width-N gate is N gates. */
  count: number;
  options: BomGateOption[];
  choice?: string;
  ics?: number;
  spare?: number;
}

export interface Bom {
  packages: BomPackageRow[];
  generic: BomGenericRow[];
  looseGates: BomGateRow[];
  problems: PartsProblem[];
  icTotal: number;
  /** Loose gates with no package chosen: none of them is in `icTotal`. */
  unpackedGates: number;
}

/** What a bench build buys besides gates and packages; probes, ports, clocks and constants are not parts. */
const GENERIC: ReadonlyMap<ComponentKind, { order: number; caption: string }> = new Map([
  ['timer555', { order: 0, caption: '555 timer' }],
  ['sevenseg', { order: 1, caption: 'Seven-segment display' }],
  ['busdisplay', { order: 2, caption: 'LED bar display' }],
  ['ledmatrix', { order: 3, caption: 'LED matrix' }],
  ['led', { order: 4, caption: 'LED' }],
  ['button', { order: 5, caption: 'Push button' }],
  ['toggle', { order: 6, caption: 'Toggle switch' }],
  ['spdt', { order: 7, caption: 'SPDT switch' }],
]);

const GATE_ORDER = [...GATE_KINDS];

/** packages.json names a gate section's device by `primitive`, not by ComponentKind. */
const GATE_PRIMITIVES: Record<string, { kind: ComponentKind; inputs: number }> = {
  nand2: { kind: 'nand', inputs: 2 },
  nor2: { kind: 'nor', inputs: 2 },
  and2: { kind: 'and', inputs: 2 },
  or2: { kind: 'or', inputs: 2 },
  xor2: { kind: 'xor', inputs: 2 },
  not: { kind: 'not', inputs: 1 },
};

const gateInputs = (c: Component): number =>
  c.kind === 'not' || c.kind === 'buf' ? 1 : intParam(c.params ?? {}, 'inputs', 2);

const gateOptions = (kind: ComponentKind, inputs: number): BomGateOption[] =>
  packageEntries()
    .filter((e) => {
      const g = GATE_PRIMITIVES[e.primitive];
      return g !== undefined && g.kind === kind && g.inputs === inputs;
    })
    .map((e) => ({ part: e.part, perPackage: e.gates }));

const genericKey = (c: Component): string =>
  c.kind === 'sevenseg' ? `sevenseg:${sevenSegCommon(c.params ?? {})}` : c.kind;

function genericCaption(c: Component, base: string): string {
  return c.kind === 'sevenseg' ? `${base}, common ${sevenSegCommon(c.params ?? {})}` : base;
}

/**
 * Counts what a bench build needs, walking each chip instance afresh so a
 * chip used twice counts its parts twice. A student chip is its contents; a
 * package def is one IC. A `partChoices` entry (loose-gate key -> part number)
 * packs those gates into ICs; one that is not an option for that gate is ignored.
 */
export function bomOf(
  board: Board,
  library: ChipLibrary,
  partChoices: Readonly<Record<string, string>> = {},
): Bom {
  const packages = new Map<string, { qty: number; where: Set<string> }>();
  const generic = new Map<string, { order: number; caption: string; qty: number }>();
  const gates = new Map<string, BomGateRow>();

  const walk = (circuit: Circuit, scope: string, onPath: ReadonlySet<string>) => {
    for (const c of circuit.components) {
      if (c.kind === 'chip') {
        const defId = c.defId ?? '';
        const def = library.get(defId);
        if (!def || onPath.has(defId)) continue;
        if (isPackageDef(def)) {
          const row = packages.get(def.id) ?? { qty: 0, where: new Set<string>() };
          row.qty += 1;
          row.where.add(scope);
          packages.set(def.id, row);
        } else {
          walk(def, def.name || def.id, new Set(onPath).add(defId));
        }
        continue;
      }
      if (GATE_KINDS.has(c.kind)) {
        const inputs = gateInputs(c);
        const key = `${c.kind}:${inputs}`;
        const row = gates.get(key) ?? {
          key,
          kind: c.kind,
          inputs,
          count: 0,
          options: gateOptions(c.kind, inputs),
        };
        row.count += widthParam(c.params ?? {});
        gates.set(key, row);
        continue;
      }
      const spec = GENERIC.get(c.kind);
      if (!spec) continue;
      const key = genericKey(c);
      const row = generic.get(key) ?? {
        order: spec.order,
        caption: genericCaption(c, spec.caption),
        qty: 0,
      };
      row.qty += 1;
      generic.set(key, row);
    }
  };
  walk(board, BOARD_SCOPE, new Set());

  const packageRows = [...packages]
    .map(([part, p]) => ({
      part,
      caption: getPackage(part)?.caption ?? part,
      qty: p.qty,
      where: [...p.where].sort(),
    }))
    .sort((a, b) => a.part.localeCompare(b.part));

  const genericRows = [...generic]
    .sort(([ka, a], [kb, b]) => a.order - b.order || ka.localeCompare(kb))
    .map(([key, g]) => ({ key, caption: g.caption, qty: g.qty }));

  const looseGates = [...gates.values()]
    .sort((a, b) => GATE_ORDER.indexOf(a.kind) - GATE_ORDER.indexOf(b.kind) || a.inputs - b.inputs)
    .map((g): BomGateRow => {
      const picked = g.options.find((o) => o.part === partChoices[g.key]);
      if (!picked) return g;
      const ics = Math.ceil(g.count / picked.perPackage);
      return { ...g, choice: picked.part, ics, spare: ics * picked.perPackage - g.count };
    });

  const icTotal =
    packageRows.reduce((n, p) => n + p.qty, 0) +
    (generic.get('timer555')?.qty ?? 0) +
    looseGates.reduce((n, g) => n + (g.ics ?? 0), 0);

  return {
    packages: packageRows,
    generic: genericRows,
    looseGates,
    problems: partsCensus(board, library).problems,
    icTotal,
    unpackedGates: looseGates.reduce((n, g) => n + (g.choice === undefined ? g.count : 0), 0),
  };
}

const gateName = (g: BomGateRow): string =>
  g.inputs === 1 ? g.kind.toUpperCase() : `${g.inputs}-input ${g.kind.toUpperCase()}`;

/** Structurally the UI's TableModel, so its TSV and CSV helpers take it; core cannot import render. */
export interface BomTable {
  headings: string[];
  inputCount: number;
  rows: string[][];
}

/** One flat table for copy and CSV: Part, Description, Qty, Notes. */
export function bomTable(bom: Bom): BomTable {
  const rows: string[][] = [];
  for (const p of bom.packages) rows.push([p.part, p.caption, String(p.qty), p.where.join(', ')]);
  for (const g of bom.generic) rows.push([g.caption, '', String(g.qty), '']);
  for (const g of bom.looseGates) {
    if (g.choice !== undefined)
      rows.push([
        g.choice,
        gateName(g),
        String(g.ics),
        `${g.count} ${g.count === 1 ? 'gate' : 'gates'}, ${g.spare} spare`,
      ]);
    else rows.push([gateName(g), 'No package chosen', String(g.count), '']);
  }
  return { headings: ['Part', 'Description', 'Qty', 'Notes'], inputCount: 1, rows };
}
