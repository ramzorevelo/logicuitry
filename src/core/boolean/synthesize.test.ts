import { describe, expect, it } from 'vitest';
import { evalExpr, parseExpr, printExpr, truthTableOfExpr } from './expr';
import {
  exprOfCover,
  exprOfPosCover,
  synthesizeExpr,
  synthesizeTable,
  type SynthNetlist,
} from './synthesize';

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
      case 'nor':
        out = ins.some((v) => v === 1) ? 0 : 1;
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

  it('chains a wide NAND into two-input gates without changing the function', () => {
    for (const src of ['ABCD', 'A + B + C', "A'BC + AB'D"]) {
      const net = synthesizeExpr(parseExpr(src), { nandOnly: true, twoInputGatesOnly: true });
      expect(net.parts.filter((p) => p.kind === 'nand').every((g) => g.inputs === 2)).toBe(true);
      expect(agreesWith(net, src)).toBe(true);
    }
  });

  it('builds a constant expression from a constant source', () => {
    const net = synthesizeExpr(parseExpr('1'));
    expect(net.parts.map((p) => p.kind)).toEqual(['constant', 'led']);
    expect(net.inputIds).toEqual([]);
  });
});

describe('synthesizeExpr, NOR only', () => {
  const norOnly = (net: SynthNetlist): boolean =>
    net.parts.every((p) => ['toggle', 'led', 'nor'].includes(p.kind));
  const nors = (net: SynthNetlist): number => net.parts.filter((p) => p.kind === 'nor').length;

  it('realizes the same function with NOR gates only', () => {
    for (const src of ["A'B + BC", '(A + B)(A + C)', "(AB)' + C", 'A B C + D']) {
      for (const cancelNotPairs of [false, true]) {
        const net = synthesizeExpr(parseExpr(src), { norOnly: true, cancelNotPairs });
        expect(norOnly(net)).toBe(true);
        expect(agreesWith(net, src)).toBe(true);
      }
    }
  });

  it('gives the two-level NOR-NOR form of a product of sums when pairs cancel', () => {
    const net = synthesizeExpr(parseExpr("(A + B)(A' + C)"), {
      norOnly: true,
      cancelNotPairs: true,
    });
    // One inverter for A', one NOR per sum term, one to combine them.
    expect(nors(net)).toBe(4);
    expect(agreesWith(net, "(A + B)(A' + C)")).toBe(true);
  });

  it('builds XOR from five NOR gates and XNOR from four', () => {
    const xor = synthesizeExpr(parseExpr('A ^ B'), { norOnly: true });
    expect(nors(xor)).toBe(5);
    expect(agreesWith(xor, 'A ^ B')).toBe(true);
    const xnor = synthesizeExpr(parseExpr("(A ^ B)'"), { norOnly: true, cancelNotPairs: true });
    expect(nors(xnor)).toBe(4);
    expect(agreesWith(xnor, "(A ^ B)'")).toBe(true);
  });

  it('builds wide XOR chains of either parity', () => {
    for (const src of ['A ^ B ^ C', 'A ^ B ^ C ^ D', "A'B + (A ^ C)"]) {
      const net = synthesizeExpr(parseExpr(src), { norOnly: true, cancelNotPairs: true });
      expect(norOnly(net)).toBe(true);
      expect(agreesWith(net, src)).toBe(true);
    }
  });

  it('chains a wide NOR into two-input gates without changing the function', () => {
    for (const src of ['A + B + C + D', 'ABC', "(A + B' + C)(B + D)"]) {
      const net = synthesizeExpr(parseExpr(src), { norOnly: true, twoInputGatesOnly: true });
      expect(net.parts.filter((p) => p.kind === 'nor').every((g) => g.inputs === 2)).toBe(true);
      expect(agreesWith(net, src)).toBe(true);
    }
  });

  it('refuses NAND-only and NOR-only together', () => {
    expect(() => synthesizeExpr(parseExpr('AB'), { nandOnly: true, norOnly: true })).toThrow();
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

  it('minimises to a product of sums for a NOR-only build, giving NOR-NOR', () => {
    // A + BC = (A + B)(A + C): two sum terms and one combining NOR, no inverters.
    const net = synthesizeTable(table('A + BC'), { norOnly: true, cancelNotPairs: true });
    expect(net.parts.find((p) => p.id === net.outputId)!.label).toBe('(A + B)(A + C)');
    expect(net.parts.filter((p) => p.kind === 'nor')).toHaveLength(3);
    expect(agreesWith(net, 'A + BC')).toBe(true);
  });

  it('a typed expression minimises to the same 3 NORs as the table, but builds as written without it', () => {
    const opts = { norOnly: true, cancelNotPairs: true };
    const asWritten = synthesizeExpr(parseExpr('A + BC'), opts);
    expect(asWritten.parts.filter((p) => p.kind === 'nor')).toHaveLength(5);
    const minimised = synthesizeTable(truthTableOfExpr(parseExpr('A + BC')), opts);
    expect(minimised.parts.filter((p) => p.kind === 'nor')).toHaveLength(3);
    expect(agreesWith(minimised, 'A + BC')).toBe(true);
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

describe('exprOfPosCover', () => {
  const table = (src: string) => truthTableOfExpr(parseExpr(src));
  it('builds the minimum product of sums, equal to the function', () => {
    const t = table('A + BC');
    const pos = exprOfPosCover(t);
    expect(printExpr(pos)).toBe('(A + B)(A + C)');
    for (let m = 0; m < 8; m++) {
      const env = new Map<string, 0 | 1>([
        ['A', ((m >> 2) & 1) as 0 | 1],
        ['B', ((m >> 1) & 1) as 0 | 1],
        ['C', (m & 1) as 0 | 1],
      ]);
      expect(evalExpr(pos, env)).toBe(evalExpr(parseExpr('A + BC'), env));
    }
  });

  it('is constant 1 with no zero and constant 0 when every cell is zero', () => {
    expect(printExpr(exprOfPosCover(table("AB + (AB)'")))).toBe('1');
    expect(printExpr(exprOfPosCover(table("AB(AB)'")))).toBe('0');
  });
});
