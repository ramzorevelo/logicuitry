import { describe, expect, it } from 'vitest';
import { parseExpr, printExpr, truthTableOfExpr } from './expr';
import { exprOfCover, synthesizeExpr, synthesizeTable, type SynthNetlist } from './synthesize';

/** Evaluates a netlist directly, so a test proves the gates compute the
 *  function rather than only that the right parts were emitted. */
function evaluate(net: SynthNetlist, assignment: ReadonlyMap<string, 0 | 1>): 0 | 1 {
  const parts = new Map(net.parts.map((p) => [p.id, p]));
  const feeds = new Map<string, string[]>(); // part id -> source part id per pin
  for (const [from, to] of net.links) {
    const [id, pin] = to.split('.') as [string, string];
    const list = feeds.get(id) ?? [];
    list[pin.charCodeAt(0) - 97] = from;
    feeds.set(id, list);
  }
  const memo = new Map<string, 0 | 1>();
  const value = (id: string): 0 | 1 => {
    const seen = memo.get(id);
    if (seen !== undefined) return seen;
    const part = parts.get(id)!;
    const ins = (feeds.get(id) ?? []).map(value);
    let out: 0 | 1;
    switch (part.kind) {
      case 'toggle':
        out = assignment.get(part.label!) ?? 0;
        break;
      case 'constant':
        out = part.params!['value'] === 1 ? 1 : 0;
        break;
      case 'not':
        out = ins[0] === 1 ? 0 : 1;
        break;
      case 'and':
        out = ins.every((v) => v === 1) ? 1 : 0;
        break;
      case 'nand':
        out = ins.every((v) => v === 1) ? 0 : 1;
        break;
      case 'or':
        out = ins.some((v) => v === 1) ? 1 : 0;
        break;
      case 'xor':
        out = ins.reduce((acc: 0 | 1, v) => (acc ^ v) as 0 | 1, 0);
        break;
      default:
        throw new Error(`no evaluation for ${part.kind}`);
    }
    memo.set(id, out);
    return out;
  };
  // The LED has no evaluation of its own, so read whatever drives it.
  return value(feeds.get(net.outputId)![0]!);
}

/** Exhaustive equivalence between a netlist and the expression it came from. */
function agreesWith(net: SynthNetlist, src: string): boolean {
  const expr = parseExpr(src);
  const table = truthTableOfExpr(expr);
  const vars = table.inputPaths;
  for (let m = 0; m < 1 << vars.length; m++) {
    const assignment = new Map<string, 0 | 1>(
      vars.map((name, i) => [name, ((m >> (vars.length - 1 - i)) & 1) as 0 | 1]),
    );
    const want = (table.rows[m]![0]!.v & 1) as 0 | 1;
    if (evaluate(net, assignment) !== want) return false;
  }
  return true;
}

describe('synthesizeExpr', () => {
  it('builds the tree as written, one switch per variable and one LED', () => {
    const net = synthesizeExpr(parseExpr("A'B + BC"));
    expect(net.parts.filter((p) => p.kind === 'toggle').map((p) => p.label)).toEqual([
      'A',
      'B',
      'C',
    ]);
    expect(net.parts.filter((p) => p.kind === 'and')).toHaveLength(2);
    expect(net.parts.filter((p) => p.kind === 'or')).toHaveLength(1);
    expect(net.parts.filter((p) => p.kind === 'not')).toHaveLength(1);
    expect(net.parts.find((p) => p.id === net.outputId)!.label).toBe("A'B + BC");
    expect(agreesWith(net, "A'B + BC")).toBe(true);
  });

  it('shares one inverter per literal', () => {
    const net = synthesizeExpr(parseExpr("A'B + A'C + A'D"));
    expect(net.parts.filter((p) => p.kind === 'not')).toHaveLength(1);
    expect(agreesWith(net, "A'B + A'C + A'D")).toBe(true);
  });

  it('folds a wide gate into two-input gates when asked', () => {
    const wide = synthesizeExpr(parseExpr('A + B + C + D'));
    expect(wide.parts.filter((p) => p.kind === 'or')).toHaveLength(1);
    const narrow = synthesizeExpr(parseExpr('A + B + C + D'), { twoInputGatesOnly: true });
    const ors = narrow.parts.filter((p) => p.kind === 'or');
    expect(ors).toHaveLength(3);
    expect(ors.every((g) => g.inputs === 2)).toBe(true);
    expect(agreesWith(narrow, 'A + B + C + D')).toBe(true);
  });

  it('realizes the same function with NAND gates only', () => {
    const net = synthesizeExpr(parseExpr("A'B + BC"), { nandOnly: true });
    expect(net.parts.every((p) => ['toggle', 'led', 'nand'].includes(p.kind))).toBe(true);
    expect(agreesWith(net, "A'B + BC")).toBe(true);
  });

  it('cancels the inverter pairs De Morgan leaves behind', () => {
    const literal = synthesizeExpr(parseExpr("A'B + BC"), { nandOnly: true });
    const cancelled = synthesizeExpr(parseExpr("A'B + BC"), {
      nandOnly: true,
      cancelNotPairs: true,
    });
    // One inverter for A', one NAND per product term, one to combine them.
    expect(cancelled.parts.filter((p) => p.kind === 'nand')).toHaveLength(4);
    expect(cancelled.parts.length).toBeLessThan(literal.parts.length);
    expect(agreesWith(cancelled, "A'B + BC")).toBe(true);
  });

  it('leaves no orphan gate behind when a pair cancels', () => {
    const net = synthesizeExpr(parseExpr("A'B + BC"), { nandOnly: true, cancelNotPairs: true });
    const consumed = new Set(net.links.map(([from]) => from));
    expect(net.parts.filter((p) => p.id !== net.outputId).every((p) => consumed.has(p.id))).toBe(
      true,
    );
  });

  it('builds an XOR from four NAND gates', () => {
    const net = synthesizeExpr(parseExpr('A ^ B'), { nandOnly: true });
    expect(net.parts.filter((p) => p.kind === 'nand')).toHaveLength(4);
    expect(net.parts.every((p) => ['toggle', 'led', 'nand'].includes(p.kind))).toBe(true);
    expect(agreesWith(net, 'A ^ B')).toBe(true);
  });

  it('builds an XNOR and a wide XOR from NAND gates', () => {
    for (const src of ["(A ^ B)'", 'A ^ B ^ C', "A'B + (A ^ C)"]) {
      const net = synthesizeExpr(parseExpr(src), { nandOnly: true, cancelNotPairs: true });
      expect(net.parts.every((p) => ['toggle', 'led', 'nand'].includes(p.kind))).toBe(true);
      expect(agreesWith(net, src)).toBe(true);
    }
  });

  it('builds a constant expression from a constant source', () => {
    const net = synthesizeExpr(parseExpr('1'));
    expect(net.parts.map((p) => p.kind)).toEqual(['constant', 'led']);
    expect(net.inputIds).toEqual([]);
  });
});

describe('synthesizeTable', () => {
  const table = (src: string) => truthTableOfExpr(parseExpr(src));

  it('minimises before building: a redundant term never reaches the gates', () => {
    expect(printExpr(exprOfCover(table('A + AB')))).toBe('A');
    const net = synthesizeTable(table('A + AB'));
    expect(net.parts.filter((p) => p.kind === 'and')).toHaveLength(0);
    expect(agreesWith(net, 'A + AB')).toBe(true);
  });

  it('emits two-level AND-OR for a cover with several terms', () => {
    const net = synthesizeTable(table("A'B + BC"));
    expect(agreesWith(net, "A'B + BC")).toBe(true);
  });

  it('treats a constant-0 column as a constant source', () => {
    const net = synthesizeTable(table("A A' + B B'"));
    expect(net.parts.map((p) => p.kind)).toContain('constant');
  });

  it('reads a don’t-care as free choice, which shortens the cover', () => {
    const t = table('AB');
    const withDc = exprOfCover(t, 0, new Set([1, 2]));
    expect(printExpr(withDc).length).toBeLessThanOrEqual(printExpr(exprOfCover(t)).length);
  });
});
