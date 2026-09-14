// Gate netlist only: no geometry is decided here, the caller hands the result
// to the placement and routing passes.
// An expression builds as written, so `A'B + BC` gives the gates the algebra
// shows. A truth table goes through minimalCover and comes out two-level.

import type { Expr } from './expr';
import { ExprError, exprVars, printExpr } from './expr';
import { implicantTerm, minimalCover } from './kmap';
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
  /** Realize the whole function with NAND gates only. */
  nandOnly?: boolean;
  /** Drop the inverter pairs the De Morgan substitution leaves behind, giving
   *  the canonical two-level NAND form. Only meaningful with `nandOnly`. */
  cancelNotPairs?: boolean;
  /** Text on the output LED; defaults to the printed expression. */
  outputLabel?: string;
}

const GATE_PIN = (i: number): string => String.fromCharCode(97 + i); // a, b, c, ...

class Builder {
  readonly parts: SynthPart[] = [];
  readonly links: SynthLink[] = [];
  private counts = new Map<string, number>();
  /** One inverter per literal, shared by every term that needs it. */
  private inverters = new Map<string, string>();
  /** Inverter id -> the signal it inverts, so a second inversion can undo it. */
  private inverted = new Map<string, string>();

  constructor(private readonly opts: SynthOptions) {}

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

  nand(sources: readonly string[]): string {
    return this.wide('nand', sources);
  }

  /** Both inputs tied together is the inverter, which is why a NAND-only
   *  build needs no other kind. */
  nandNot(source: string): string {
    return this.gate('nand', [source, source]);
  }

  not(source: string, literal?: string): string {
    if (literal !== undefined) {
      const seen = this.inverters.get(literal);
      if (seen !== undefined) return seen;
    }
    // Two inverters in series are a wire. The one left behind loses its only
    // consumer and is pruned with the rest of the unreachable netlist.
    if (this.opts.cancelNotPairs) {
      const undone = this.inverted.get(source);
      if (undone !== undefined) return undone;
    }
    const id = this.opts.nandOnly ? this.nandNot(source) : this.gate('not', [source]);
    this.inverted.set(id, source);
    if (literal !== undefined) this.inverters.set(literal, id);
    return id;
  }

  and(sources: readonly string[]): string {
    if (sources.length === 1) return sources[0]!;
    return this.opts.nandOnly ? this.not(this.nand(sources)) : this.wide('and', sources);
  }

  or(sources: readonly string[]): string {
    if (sources.length === 1) return sources[0]!;
    // De Morgan: a + b = (a'b')'.
    return this.opts.nandOnly
      ? this.nand(sources.map((s) => this.not(s)))
      : this.wide('or', sources);
  }

  xor(sources: readonly string[]): string {
    if (!this.opts.nandOnly) return this.wide('xor', sources);
    // XOR is associative, so the chain is the function, not an approximation.
    return sources.slice(1).reduce((acc, src) => this.xor2(acc, src), sources[0]!);
  }

  /** The four-NAND XOR: with s = (ab)', a^b = a.s + b.s. */
  private xor2(a: string, b: string): string {
    const shared = this.gate('nand', [a, b]);
    return this.gate('nand', [this.gate('nand', [a, shared]), this.gate('nand', [b, shared])]);
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
    case 'not': {
      const source = buildNode(e.a, b, vars);
      // Only a bare variable shares an inverter; an inverted sub-expression is
      // its own signal and gets its own gate.
      return b.not(source, e.a.kind === 'var' ? e.a.name : undefined);
    }
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
  const names = exprVars(e);
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

/** Routed through the K-map engine, so the truth-table entry point is a
 *  translation rather than a second minimiser. */
export function exprOfCover(
  table: TruthTable,
  outputIndex = 0,
  dontCares?: ReadonlySet<number>,
  varNames?: readonly string[],
): Expr {
  const name = (path: string): string => {
    const i = table.inputPaths.indexOf(path);
    return varNames?.[i] ?? path;
  };
  const cover = minimalCover(table, outputIndex, dontCares);
  if (cover.length === 0) return { kind: 'const', value: 0 };
  const terms: Expr[] = cover.map((group) => {
    const literals = implicantTerm(table, group);
    // No fixed variable means the group covers the whole map: the output is 1.
    if (literals.length === 0) return { kind: 'const', value: 1 };
    const factors: Expr[] = literals.map((lit) =>
      lit.negated
        ? { kind: 'not', a: { kind: 'var', name: name(lit.var) } }
        : { kind: 'var', name: name(lit.var) },
    );
    return factors.length === 1 ? factors[0]! : { kind: 'and', args: factors };
  });
  if (terms.some((t) => t.kind === 'const' && t.value === 1)) return { kind: 'const', value: 1 };
  return terms.length === 1 ? terms[0]! : { kind: 'or', args: terms };
}

export function synthesizeTable(
  table: TruthTable,
  opts: SynthOptions & {
    outputIndex?: number;
    dontCares?: ReadonlySet<number>;
    varNames?: readonly string[];
  } = {},
): SynthNetlist {
  const e = exprOfCover(table, opts.outputIndex ?? 0, opts.dontCares, opts.varNames);
  return synthesizeExpr(e, opts);
}
