import type { TypedMode, TypedState } from './typedFunction';

const MODES: readonly (readonly [TypedMode, string])[] = [
  ['sigma', 'Index list'],
  ['expr', 'Expression'],
  ['table', 'Truth table'],
];

/** The typed-function entry row, shared by the Analyze drawer and the
 *  Algebra tab; each passes its own store. */
export function TypedEntry({ typed }: { typed: TypedState }) {
  return (
    <div className="analyze-typed">
      <div className="analyze-layouts">
        <select
          aria-label="Entry"
          value={typed.mode}
          onChange={(e) => typed.setMode(e.target.value as TypedMode)}
        >
          {MODES.map(([mode, label]) => (
            <option key={mode} value={mode}>
              {label}
            </option>
          ))}
        </select>
        <select
          aria-label="Variables"
          value={typed.varCount}
          onChange={(e) => typed.setVarCount(Number(e.target.value))}
        >
          {[2, 3, 4].map((k) => (
            <option key={k} value={k}>
              {`${k} variables`}
            </option>
          ))}
        </select>
      </div>
      {typed.mode !== 'table' && (
        <input
          type="text"
          className="analyze-typed__input"
          aria-label={typed.mode === 'sigma' ? 'Function in sigma notation' : 'Boolean expression'}
          spellCheck={false}
          placeholder={typed.mode === 'sigma' ? 'm(1,3,5) + d(7)' : "A'B + BC"}
          value={typed.mode === 'sigma' ? typed.sigmaText : typed.exprText}
          onChange={(e) =>
            typed.mode === 'sigma'
              ? typed.editSigma(e.target.value)
              : typed.editExpr(e.target.value)
          }
          onKeyDown={(e) => e.stopPropagation()}
        />
      )}
      {typed.mode === 'sigma' && (
        <div className="analyze-muted">
          Type m(1,3) or sum(1,3) for minterms, M(0,2) or prod(0,2) for maxterms, d(...) for
          don't-cares.
        </div>
      )}
      {typed.error && typed.mode !== 'table' && (
        <pre className="analyze-refusal analyze-typed__error">
          {(typed.mode === 'sigma' ? typed.sigmaText : typed.exprText) +
            '\n' +
            ' '.repeat(typed.error.offset) +
            '^ ' +
            typed.error.message}
        </pre>
      )}
    </div>
  );
}
