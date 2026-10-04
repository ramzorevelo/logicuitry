import { useMemo } from 'react';
import { canonicalPos, canonicalRows, canonicalSop, sigmaOf } from '../../core/boolean/canonical';
import { BoolExpr } from '../components/BoolExpr';
import { nextCell } from '../workbench-circuit/buildGrid';
import { TypedEntry } from '../workbench-circuit/TypedEntry';
import { dontCaresOf, tableOfFunction } from '../workbench-circuit/typedFunction';
import { useCanonicalFunction } from './algebraStore';

export function CanonicalSection() {
  const typed = useCanonicalFunction();
  const { fn } = typed;
  const table = useMemo(() => tableOfFunction(fn), [fn]);
  const dc = useMemo(() => dontCaresOf(fn), [fn]);
  const rows = useMemo(() => canonicalRows(table, dc), [table, dc]);
  const sop = useMemo(() => canonicalSop(table, dc), [table, dc]);
  const pos = useMemo(() => canonicalPos(table, dc), [table, dc]);
  const idx = useMemo(() => sigmaOf(table, dc), [table, dc]);
  const dcList = idx.dontCares.join(', ');

  const editable = typed.mode === 'table';
  return (
    <div className="algebra-section">
      <TypedEntry typed={typed} />
      <table className="algebra-canon">
        <thead>
          <tr>
            <th scope="col">#</th>
            {fn.names.map((n) => (
              <th key={n} scope="col">
                {n}
              </th>
            ))}
            <th scope="col">Y</th>
            <th scope="col">
              m<sub>i</sub>
            </th>
            <th scope="col">
              M<sub>i</sub>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.index} className={r.value === 1 ? 'algebra-canon__true' : undefined}>
              <th scope="row">{r.index}</th>
              {fn.names.map((n, i) => (
                <td key={n} className="mono">
                  {(r.index >> (fn.names.length - 1 - i)) & 1}
                </td>
              ))}
              <td className="mono">
                {editable ? (
                  <button
                    type="button"
                    aria-label={`Row ${r.index}, ${r.value}. Cycle 0, 1, don't-care`}
                    onClick={() => typed.setCell(r.index, nextCell(fn.cells[r.index]!))}
                  >
                    {r.value}
                  </button>
                ) : (
                  r.value
                )}
              </td>
              <td>
                {r.value === 1 && (
                  <>
                    m<sub>{r.index}</sub> = <BoolExpr expr={r.minterm} />
                  </>
                )}
              </td>
              <td>
                {r.value === 0 && (
                  <>
                    M<sub>{r.index}</sub> = <BoolExpr expr={r.maxterm} bracketed />
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="algebra-forms">
        <div>
          <div className="algebra-forms__label">Canonical sum of products</div>
          <div className="algebra-forms__expr">
            <BoolExpr expr={sop} />
          </div>
          <div className="algebra-forms__sigma mono">{`Σm(${idx.ones.join(', ')})${dcList ? ` + Σd(${dcList})` : ''}`}</div>
        </div>
        <div>
          <div className="algebra-forms__label">Canonical product of sums</div>
          <div className="algebra-forms__expr">
            <BoolExpr expr={pos} />
          </div>
          <div className="algebra-forms__sigma mono">{`ΠM(${idx.zeros.join(', ')})${dcList ? ` · ΠD(${dcList})` : ''}`}</div>
        </div>
      </div>
    </div>
  );
}
