// Gate netlist only: no geometry is decided here, the caller hands the result
// to the placement and routing passes.
// An expression builds as written, so `A'B + BC` gives the gates the algebra
// shows. A truth table goes through minimalCover and comes out two-level.

import type { Expr } from './expr';
import { ExprError, exprVars, printExpr } from './expr';
import { groupTerm, minimalCover, minimumCovers, type KmapPolarity } from './kmap';
import type { TruthTable } from './truthTable';

/** `kind` is a ComponentKind name held as a plain string, so core/boolean
 *  stays independent of the model types. */
export interface SynthPart {
  id: string;
  kind: string;
  label?: string;
  /** Gate arity, for the variable-arity gates. */
  inputs?: number;
  params?: Record<string, string | number | boolean>;
}

/** `from` is a part id, meaning its `y` output; `to` is `id.pin`. */
export type SynthLink = [from: string, to: string];

export interface SynthNetlist {
  parts: SynthPart[];
  links: SynthLink[];
  /** Input switches, in the variable order the caller should show. */
  inputIds: string[];
  /** The LED observing the result. */
  outputId: string;
}

export interface SynthOptions {
  /** Fold every wider gate into a chain of two-input ones. */
  twoInputGatesOnly?: boolean;
  /** Realize the whole function with NAND gates only. Exclusive with `norOnly`. */
  nandOnly?: boolean;
  /** Realize the whole function with NOR gates only. Exclusive with `nandOnly`. */
  norOnly?: boolean;
  /** Drop the inverter pairs the De Morgan substitution leaves behind, giving
   *  the canonical two-level NAND or NOR form. Only meaningful with `nandOnly`
   *  or `norOnly`. */
  cancelNotPairs?: boolean;
  /** Text on the output LED; defaults to the printed expression. */
  outputLabel?: string;
  /** Switch names in order, kept even when the function ignores them, so a
   *  table's unused columns still exist on the board. */
  inputs?: readonly string[];
}

const GATE_PIN = (i: number): string => String.fromCharCode(97 + i); // a, b, c, ...

class Builder {
  readonly parts: SynthPart[] = [];
  readonly links: SynthLink[] = [];
  private counts = new Map<string, number>();
  /** Signal -> its inverter, so a literal and a De Morgan complement of the
   *  same variable share one gate. */
  private inverters = new Map<string, string>();
  /** Inverter id -> the signal it inverts, so a second inversion can undo it. */
  private inverted = new Map<string, string>();

  /** The one gate kind a universal-gate build is restricted to. */
  private readonly universal: 'nand' | 'nor' | null;

  constructor(private readonly opts: SynthOptions) {
    if (opts.nandOnly && opts.norOnly) throw new Error('nandOnly and norOnly are exclusive');
    this.universal = opts.nandOnly ? 'nand' : opts.norOnly ? 'nor' : null;
  }

  id(kind: string): string {
    const n = (this.counts.get(kind) ?? 0) + 1;
    this.counts.set(kind, n);
    return `${kind}${n}`;
  }

  add(part: SynthPart): string {
    this.parts.push(part);
    return part.id;
  }

  gate(kind: string, sources: readonly string[]): string {
    const id = this.add({ id: this.id(kind), kind, inputs: sources.length });
    sources.forEach((src, i) => this.links.push([src, `${id}.${GATE_PIN(i)}`]));
    return id;
  }

  /** Every kind folded here is associative, so the chain is the same
   *  function, not an approximation of it. */
  wide(kind: string, sources: readonly string[]): string {
    if (sources.length === 1) return sources[0]!;
    if (!this.opts.twoInputGatesOnly || sources.length === 2) return this.gate(kind, sources);
    return sources.slice(1).reduce((acc, src) => this.gate(kind, [acc, src]), sources[0]!);
  }

  /** NAND and NOR are not associative, so a two-input chain re-inverts each
   *  partial result before feeding it on: (abc)' = (((ab)')' c)'. */
  negatedWide(kind: 'nand' | 'nor', sources: readonly string[]): string {
    if (!this.opts.twoInputGatesOnly || sources.length <= 2) return this.gate(kind, sources);
    const first = this.gate(kind, [sources[0]!, sources[1]!]);
    return sources.slice(2).reduce((acc, src) => this.gate(kind, [this.not(acc), src]), first);
  }

  not(source: string): string {
    const seen = this.inverters.get(source);
    if (seen !== undefined) return seen;
    // Two inverters in series are a wire. The one left behind loses its only
    // consumer and is pruned with the rest of the unreachable netlist.
    if (this.opts.cancelNotPairs) {
      const undone = this.inverted.get(source);
      if (undone !== undefined) return undone;
    }
    // Both inputs tied together is the inverter, which is why a universal-gate
    // build needs no other kind.
    const id = this.universal
      ? this.gate(this.universal, [source, source])
      : this.gate('not', [source]);
    this.inverted.set(id, source);
    this.inverters.set(source, id);
    return id;
  }

  and(sources: readonly string[]): string {
    if (sources.length === 1) return sources[0]!;
    if (this.universal === 'nand') return this.not(this.negatedWide('nand', sources));
    // De Morgan: ab = (a' + b')'.
    if (this.universal === 'nor')
      return this.negatedWide(
        'nor',
        sources.map((s) => this.not(s)),
      );
    return this.wide('and', sources);
  }

  or(sources: readonly string[]): string {
    if (sources.length === 1) return sources[0]!;
    // De Morgan: a + b = (a'b')'.
    if (this.universal === 'nand')
      return this.negatedWide(
        'nand',
        sources.map((s) => this.not(s)),
      );
    if (this.universal === 'nor') return this.not(this.negatedWide('nor', sources));
    return this.wide('or', sources);
  }

  xor(sources: readonly string[]): string {
    if (this.universal === 'nand') {
      // XOR is associative, so the chain is the function, not an approximation.
      return sources.slice(1).reduce((acc, src) => this.nandXor2(acc, src), sources[0]!);
    }
    if (this.universal === 'nor') {
      // Each XNOR link adds a complement, so an odd number of links leaves one
      // to undo: (a ^ b)'' = a ^ b, and three sources chain back to a ^ b ^ c.
      const chain = sources.slice(1).reduce((acc, src) => this.norXnor2(acc, src), sources[0]!);
      return sources.length % 2 === 0 ? this.not(chain) : chain;
    }
    return this.wide('xor', sources);
  }

  /** The four-NAND XOR: with s = (ab)', a^b = a.s + b.s. */
  private nandXor2(a: string, b: string): string {
    const shared = this.gate('nand', [a, b]);
    return this.gate('nand', [this.gate('nand', [a, shared]), this.gate('nand', [b, shared])]);
  }

  /** The dual of the four-NAND XOR is an XNOR: with s = (a + b)',
   *  (a ^ b)' = (a + s)(b + s). */
  private norXnor2(a: string, b: string): string {
    const shared = this.gate('nor', [a, b]);
    return this.gate('nor', [this.gate('nor', [a, shared]), this.gate('nor', [b, shared])]);
  }
}

function buildNode(e: Expr, b: Builder, vars: ReadonlyMap<string, string>): string {
  switch (e.kind) {
    case 'const':
      return b.add({
        id: b.id('constant'),
        kind: 'constant',
        params: { value: e.value, width: 1 },
      });
    case 'var': {
      const id = vars.get(e.name);
      if (id === undefined) throw new ExprError(`no input for ${e.name}`, 0);
      return id;
    }
    case 'not':
      return b.not(buildNode(e.a, b, vars));
    case 'and':
      return b.and(e.args.map((a) => buildNode(a, b, vars)));
    case 'or':
      return b.or(e.args.map((a) => buildNode(a, b, vars)));
    case 'xor':
      return b.xor(e.args.map((a) => buildNode(a, b, vars)));
  }
}

export function synthesizeExpr(e: Expr, opts: SynthOptions = {}): SynthNetlist {
  const b = new Builder(opts);
  const names = [...new Set([...(opts.inputs ?? []), ...exprVars(e)])];
  const vars = new Map<string, string>();
  const inputIds: string[] = [];
  for (const name of names) {
    const id = b.add({ id: b.id('sw'), kind: 'toggle', label: name });
    vars.set(name, id);
    inputIds.push(id);
  }
  const result = buildNode(e, b, vars);
  const outputId = b.add({
    id: b.id('led'),
    kind: 'led',
    label: opts.outputLabel ?? printExpr(e),
  });
  b.links.push([result, `${outputId}.a`]);
  return prune({ parts: b.parts, links: b.links, inputIds, outputId });
}

/** Cancelling an inverter pair orphans the second of the two; nothing else in
 *  the builder can emit a part the output does not reach. */
function prune(net: SynthNetlist): SynthNetlist {
  const owner = (pin: string): string => pin.slice(0, pin.lastIndexOf('.'));
  const feeders = new Map<string, string[]>();
  for (const [from, to] of net.links) {
    const id = owner(to);
    const seen = feeders.get(id);
    if (seen) seen.push(from);
    else feeders.set(id, [from]);
  }
  const live = new Set<string>([net.outputId, ...net.inputIds]);
  const queue = [net.outputId];
  while (queue.length > 0) {
    for (const from of feeders.get(queue.pop()!) ?? []) {
      if (live.has(from)) continue;
      live.add(from);
      queue.push(from);
    }
  }
  if (live.size === net.parts.length) return net;
  return {
    ...net,
    parts: net.parts.filter((p) => live.has(p.id)),
    links: net.links.filter(([, to]) => live.has(owner(to))),
  };
}

/** The SOP (`ones`) or POS (`zeros`) read off explicit K-map groups, minimum
 *  or not, so a build can follow what is on screen. No group at all is the
 *  constant left when nothing is grouped. */
export function exprOfGroups(
  table: TruthTable,
  groups: readonly (readonly number[])[],
  polarity: KmapPolarity = 'ones',
  varNames?: readonly string[],
): Expr {
  const sop = polarity === 'ones';
  if (groups.length === 0) return { kind: 'const', value: sop ? 0 : 1 };
  const name = (path: string): string => {
    const i = table.inputPaths.indexOf(path);
    return varNames?.[i] ?? path;
  };
  // A group with no fixed variable is the whole map, which decides the output alone.
  const whole: Expr = { kind: 'const', value: sop ? 1 : 0 };
  const terms: Expr[] = groups.map((group) => {
    const literals = groupTerm(table, group, polarity);
    if (literals.length === 0) return whole;
    const parts: Expr[] = literals.map((lit) =>
      lit.negated
        ? { kind: 'not', a: { kind: 'var', name: name(lit.var) } }
        : { kind: 'var', name: name(lit.var) },
    );
    if (parts.length === 1) return parts[0]!;
    return { kind: sop ? 'and' : 'or', args: parts };
  });
  if (terms.includes(whole)) return whole;
  if (terms.length === 1) return terms[0]!;
  return { kind: sop ? 'or' : 'and', args: terms };
}

/** Routed through the K-map engine, so the truth-table entry point is a
 *  translation rather than a second minimiser. */
export function exprOfCover(
  table: TruthTable,
  outputIndex = 0,
  dontCares?: ReadonlySet<number>,
  varNames?: readonly string[],
): Expr {
  return exprOfGroups(table, minimalCover(table, outputIndex, dontCares), 'ones', varNames);
}

/** Minimum product-of-sums: each 0-group is a sum term, complemented where the
 *  group fixes the variable at 1. Constant 1 when there is no 0 to group. */
export function exprOfPosCover(
  table: TruthTable,
  outputIndex = 0,
  dontCares?: ReadonlySet<number>,
  varNames?: readonly string[],
): Expr {
  const cover = minimumCovers(table, outputIndex, dontCares, 'zeros')[0] ?? [];
  return exprOfGroups(table, cover, 'zeros', varNames);
}

export function synthesizeTable(
  table: TruthTable,
  opts: SynthOptions & {
    outputIndex?: number;
    dontCares?: ReadonlySet<number>;
    varNames?: readonly string[];
  } = {},
): SynthNetlist {
  // SPEC: NOR-only minimises to the product of sums, the form whose NOR-NOR
  // realization is two-level, as SOP is for NAND-NAND.
  const cover = opts.norOnly ? exprOfPosCover : exprOfCover;
  const e = cover(table, opts.outputIndex ?? 0, opts.dontCares, opts.varNames);
  return synthesizeExpr(e, { ...opts, inputs: opts.varNames ?? table.inputPaths });
}
