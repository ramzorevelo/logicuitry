import { useState, type ReactNode } from 'react';
import { productNeedsDot, type Expr } from '../../core/boolean/expr';
import './BoolExpr.css';

export interface ExprSelection {
  at: number[];
  /** Operands of the n-ary node at `at`; omitted, the node itself. */
  operands?: number[];
}

const PRECEDENCE: Record<Expr['kind'], number> = {
  const: 4,
  var: 4,
  not: 3,
  and: 2,
  xor: 1,
  or: 0,
};

const samePath = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

function isSelected(sel: ExprSelection | undefined, path: readonly number[]): boolean {
  if (!sel) return false;
  if (!sel.operands) return samePath(sel.at, path);
  return (
    path.length === sel.at.length + 1 &&
    samePath(sel.at, path.slice(0, -1)) &&
    sel.operands.includes(path[path.length - 1]!)
  );
}

interface Ctx {
  selected?: ExprSelection | undefined;
  marked?: ExprSelection | undefined;
  /** The node a click would select, outlined on hover. */
  target: number[] | null;
  onHover: (leaf: number[] | null) => void;
  onSelect?: ((leaf: number[]) => void) | undefined;
}

// A complement is an inline-block with a top border rather than a CSS
// overline: overline on nested spans draws every bar at one height, so
// (A'B)' would show one merged bar. Nesting the boxes stacks the bars.
function render(e: Expr, path: number[], minimum: number, ctx: Ctx): ReactNode {
  const parens = PRECEDENCE[e.kind] < minimum;
  let body: ReactNode;
  switch (e.kind) {
    case 'const':
      body = String(e.value);
      break;
    case 'var':
      body = e.name;
      break;
    case 'not':
      body = <span className="boolexpr__not">{render(e.a, [...path, 0], 0, ctx)}</span>;
      break;
    case 'and':
      // Same-kind children keep their brackets: the laws table prints X(YZ).
      body = e.args.map((a, i) => (
        <span key={i}>
          {i > 0 && productNeedsDot(e.args[i - 1]!, a) ? '·' : null}
          {render(a, [...path, i], a.kind === 'and' ? 3 : PRECEDENCE.and, ctx)}
        </span>
      ));
      break;
    case 'xor':
      body = e.args.map((a, i) => (
        <span key={i}>
          {i > 0 ? ' ⊕ ' : null}
          {render(a, [...path, i], a.kind === 'xor' ? 3 : PRECEDENCE.xor, ctx)}
        </span>
      ));
      break;
    case 'or':
      body = e.args.map((a, i) => (
        <span key={i}>
          {i > 0 ? ' + ' : null}
          {render(a, [...path, i], a.kind === 'or' ? 3 : 0, ctx)}
        </span>
      ));
      break;
  }
  const inner = parens ? <>({body})</> : body;
  const classes = ['boolexpr__node'];
  if (isSelected(ctx.selected, path)) classes.push('boolexpr__node--selected');
  if (isSelected(ctx.marked, path)) classes.push('boolexpr__node--marked');
  if (ctx.target && samePath(ctx.target, path)) classes.push('boolexpr__node--target');
  // The bar of a complement already spans its operand, so a not node is
  // never bracketed by its own parent; brackets sit inside it, not around.
  return (
    <span
      className={classes.join(' ')}
      data-path={path.join('.')}
      onClick={
        ctx.onSelect
          ? (ev) => {
              ev.stopPropagation();
              ctx.onSelect!(path);
            }
          : undefined
      }
      onMouseOver={
        ctx.onSelect
          ? (ev) => {
              ev.stopPropagation();
              ctx.onHover(path);
            }
          : undefined
      }
    >
      {inner}
    </span>
  );
}

/** A Boolean expression with stacked overbars. With `onSelect` it is
 *  clickable: `targetOf` maps the deepest node under the pointer to the node a
 *  click selects, and only that one is outlined on hover. */
export function BoolExpr({
  expr,
  selected,
  marked,
  onSelect,
  targetOf,
  bracketed,
}: {
  expr: Expr;
  selected?: ExprSelection | undefined;
  /** Nodes a pending choice would use, shown apart from the selection. */
  marked?: ExprSelection | undefined;
  onSelect?: ((path: number[]) => void) | undefined;
  targetOf?: ((leaf: number[]) => number[]) | undefined;
  /** Force brackets round the whole thing, for a maxterm shown on its own. */
  bracketed?: boolean;
}) {
  const [hover, setHover] = useState<number[] | null>(null);
  const resolve = targetOf ?? ((leaf: number[]) => leaf);
  const body = render(expr, [], 0, {
    selected,
    marked,
    target: onSelect && hover ? resolve(hover) : null,
    onHover: setHover,
    onSelect: onSelect && ((leaf) => onSelect(resolve(leaf))),
  });
  return (
    <span
      className={onSelect ? 'boolexpr boolexpr--interactive' : 'boolexpr'}
      onMouseLeave={onSelect ? () => setHover(null) : undefined}
    >
      {bracketed ? <>({body})</> : body}
    </span>
  );
}
