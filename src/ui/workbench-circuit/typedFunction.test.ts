import { beforeEach, describe, expect, it } from 'vitest';
import {
  dontCaresOf,
  emptyFunction,
  exprTextOf,
  functionFromExpr,
  functionFromSigma,
  sigmaTextOf,
  tableOfFunction,
  useTypedFunction,
} from './typedFunction';

describe('typed function', () => {
  it('reads sigma notation with a default variable count', () => {
    const f = functionFromSigma('Σm(1,3) + Σd(2)', 2);
    expect(f.names).toEqual(['A', 'B']);
    expect(f.cells).toEqual(['0', '1', 'x', '1']);
    expect(dontCaresOf(f)).toEqual(new Set([2]));
  });

  it('reads the plain-ASCII d(...) the hint advertises', () => {
    const f = functionFromSigma('m(1,3) + d(7)', 3);
    expect(f.cells[7]).toBe('x');
    expect(dontCaresOf(f)).toEqual(new Set([7]));
  });

  it('takes the variables from a prefix, and reads a product of maxterms', () => {
    const f = functionFromSigma('F(P,Q,R) = ΠM(0,2,4)', 2);
    expect(f.names).toEqual(['P', 'Q', 'R']);
    expect(f.cells).toEqual(['0', '1', '0', '1', '0', '1', '1', '1']);
  });

  it('reads an expression and refuses widths the map cannot draw', () => {
    expect(functionFromExpr("A'B + BC").names).toEqual(['A', 'B', 'C']);
    expect(() => functionFromExpr('A')).toThrow(/2 to 4/);
    expect(() => functionFromExpr('ABCDE')).toThrow();
  });

  it('round-trips a function through its sigma text', () => {
    const f = functionFromSigma('Σm(0,5) + Σd(7)', 3);
    expect(functionFromSigma(sigmaTextOf(f), 3)).toEqual(f);
  });

  it('prints the canonical sum, not the minimum', () => {
    const f = functionFromSigma('Σm(2,3)', 2);
    expect(exprTextOf(f)).toBe("AB' + AB");
    expect(tableOfFunction(f).rows).toHaveLength(4);
  });
});

describe('typed function store', () => {
  beforeEach(() => {
    useTypedFunction.setState({
      source: 'board',
      mode: 'sigma',
      varCount: 3,
      fn: emptyFunction(3),
      sigmaText: '',
      exprText: '',
      error: null,
    });
  });

  it('a half-typed line keeps the function and reports the error', () => {
    const s = useTypedFunction.getState();
    s.editSigma('Σm(1,3)');
    const kept = useTypedFunction.getState().fn;
    s.editSigma('Σm(1,3');
    const after = useTypedFunction.getState();
    expect(after.fn).toEqual(kept);
    expect(after.error).not.toBeNull();
  });

  it('switching mode re-prints the function in the new form', () => {
    const s = useTypedFunction.getState();
    s.editSigma('Σm(1,3)');
    s.setMode('expr');
    expect(useTypedFunction.getState().exprText).not.toBe('');
    s.setCell(0, '1');
    s.setMode('sigma');
    expect(useTypedFunction.getState().sigmaText).toContain('m(0,1,3)');
  });

  it("marks and clears a don't-care", () => {
    const s = useTypedFunction.getState();
    s.toggleDontCare(2);
    expect(dontCaresOf(useTypedFunction.getState().fn)).toEqual(new Set([2]));
    useTypedFunction.getState().toggleDontCare(2);
    expect(dontCaresOf(useTypedFunction.getState().fn).size).toBe(0);
  });

  it('a new variable count restarts the function', () => {
    useTypedFunction.getState().editSigma('Σm(1,3)');
    useTypedFunction.getState().setVarCount(4);
    const st = useTypedFunction.getState();
    expect(st.fn.cells).toHaveLength(16);
    expect(st.fn.names).toEqual(['A', 'B', 'C', 'D']);
  });
});
