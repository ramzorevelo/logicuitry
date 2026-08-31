import { useEffect, useMemo, useState } from 'react';
import { known, xor, type BusValue } from '../../core/value/busValue';
import {
  add,
  bitwise,
  neg,
  not,
  sar,
  shl,
  shr,
  subBorrow,
  subComplement,
} from '../../core/numkit/compute';
import { renderDec, renderHex } from '../../core/numkit/format';
import {
  arithSolution,
  borrowMarks,
  carryString,
  type BorrowMarks,
} from '../../core/numkit/solution';
import type { Interpretation, Operator, SubMethod } from '../../core/numkit/types';
import { useReferenceDrawer } from '../components/ReferenceDrawer';
import { useCoarsePointer } from '../pointerKind';
import { BitGrid } from './BitGrid';
import { ValueEntry } from './ValueEntry';
import { operatorReference } from './referenceContent';
import { useNumbersStore } from './numbersStore';

export const OPS: { id: Operator; label: string; unary: boolean; shift?: boolean }[] = [
  { id: 'ADD', label: 'A + B', unary: false },
  { id: 'SUB', label: 'A − B', unary: false },
  { id: 'AND', label: 'A & B', unary: false },
  { id: 'OR', label: 'A | B', unary: false },
  { id: 'XOR', label: 'A ^ B', unary: false },
  { id: 'NOT', label: '~A', unary: true },
  { id: 'SHL', label: 'A << n', unary: true, shift: true },
  { id: 'SHR', label: 'A >> n', unary: true, shift: true },
  { id: 'SAR', label: 'A >>> n', unary: true, shift: true },
  { id: 'NEG', label: '−A', unary: true },
];

interface Computed {
  result: BusValue;
  carryOut?: 0 | 1;
  /** Borrow out of the MSB, the borrow method's counterpart to carryOut. */
  borrowOut?: 0 | 1;
  overflow?: boolean;
  carryString?: string;
  borrows?: BorrowMarks;
  shiftedOut?: (0 | 1)[];
}

function run(
  op: Operator,
  a: BusValue,
  b: BusValue,
  amount: number,
  width: number,
  subMethod: SubMethod,
): Computed {
  switch (op) {
    case 'ADD': {
      const r = add(a, b, width);
      return {
        result: r.result,
        carryOut: r.carryOut,
        overflow: r.overflow,
        carryString: carryString(r.carries),
      };
    }
    case 'SUB': {
      if (subMethod === 'borrow') {
        const r = subBorrow(a, b, width);
        return {
          result: r.result,
          borrowOut: r.borrowOut,
          overflow: r.overflow,
          borrows: borrowMarks(r.borrows),
        };
      }
      const r = subComplement(a, b, width);
      return {
        result: r.result,
        carryOut: r.carryOut,
        overflow: r.overflow,
        carryString: carryString(r.carries),
      };
    }
    case 'AND':
    case 'OR':
    case 'XOR':
      return { result: bitwise(op, a, b, width) };
    case 'NOT':
      return { result: not(a, width) };
    case 'NEG':
      return { result: neg(a, width).result };
    case 'SHL':
      return shl(a, amount, width);
    case 'SHR':
      return shr(a, amount, width);
    case 'SAR':
      return sar(a, amount, width);
  }
}

function resultLabel(op: Operator): string {
  if (op === 'ADD') return 'Sum';
  if (op === 'SUB') return 'Difference';
  return 'Result';
}

// Cout means opposite things for ADD vs SUB by complement (A + ~B + 1); say so on screen.
function coutAnnotation(op: Operator, cout: 0 | 1): string {
  if (op === 'ADD') return cout === 1 ? 'Cout=1 (unsigned overflow)' : 'Cout=0';
  return cout === 1 ? 'Cout=1 (no borrow)' : 'Cout=0 (borrow)';
}

const SUB_METHODS: { id: SubMethod; label: string }[] = [
  { id: 'borrow', label: 'borrow' },
  { id: 'complement', label: 'A + ~B + 1' },
];

// Worked column solution for ADD/SUB, gated behind the revealed result with its
// own show/hide. Local state means re-masking the result unmounts and collapses.
function SolutionSection({
  operator,
  a,
  b,
  width,
  interp,
  subMethod,
}: {
  operator: 'ADD' | 'SUB';
  a: BusValue;
  b: BusValue;
  width: number;
  interp: Interpretation;
  subMethod: SubMethod;
}) {
  const [open, setOpen] = useState(false);
  const sol = useMemo(
    () => arithSolution(operator, a, b, width, interp, subMethod),
    [operator, a, b, width, interp, subMethod],
  );
  return (
    <div className="solution">
      <button
        type="button"
        className="drawer-toggle"
        aria-pressed={open}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? 'Hide solution' : 'Show solution'}
      </button>
      {open && (
        <div className="solution__body">
          {sol.intro.map((t) => (
            <p key={t} className="solution__note">
              {t}
            </p>
          ))}
          {sol.rows.map((r) => (
            <div key={r.label} className="notb-row">
              <span className="notb-row__label mono">{r.label}</span>
              <BitGrid value={r.bits} width={width} borrows={r.borrows} carries={r.carries} />
            </div>
          ))}
          <div className="notb-row solution__sum">
            <span className="notb-row__label mono">{sol.sum.label}</span>
            <BitGrid value={sol.sum.bits} width={width} />
          </div>
          <p className="solution__note">{sol.flags}</p>
          <div className="solution__answer mono">
            = {sol.answerDec} · 0x{sol.answerHex}
          </div>
        </div>
      )}
    </div>
  );
}

export function ComputeTab() {
  // The reveal is teacher-paced either way; only the shortcut half of the
  // label is keyboard-specific.
  const coarse = useCoarsePointer();
  const { a, b, width, interp, operator, hideAnswers, stepIndex, subMethod } = useNumbersStore();
  const setA = useNumbersStore((s) => s.setA);
  const setB = useNumbersStore((s) => s.setB);
  const setOperator = useNumbersStore((s) => s.setOperator);
  const setSubMethod = useNumbersStore((s) => s.setSubMethod);
  const toggleHideAnswers = useNumbersStore((s) => s.toggleHideAnswers);
  const revealAll = useNumbersStore((s) => s.revealAll);
  const resetSteps = useNumbersStore((s) => s.resetSteps);
  const [amount, setAmount] = useState(1);
  const [hoverA, setHoverA] = useState<number | undefined>();
  const [hoverB, setHoverB] = useState<number | undefined>();

  const meta = OPS.find((o) => o.id === operator)!;
  const computed = useMemo(
    () => run(operator, a, b, amount, width, subMethod),
    [operator, a, b, amount, width, subMethod],
  );
  const revealed = !hideAnswers || stepIndex >= 0;
  const overflow = computed.overflow === true && interp === 'twos';

  useReferenceDrawer(useMemo(() => operatorReference(operator), [operator]));

  // The strikethrough belongs to the minuend's own digits; over the difference
  // there is nothing to strike, only the borrow chain to show.
  const resultBorrows = computed.borrows && { ...computed.borrows, struck: '' };

  // Hover-preview: the would-be result when the hovered operand bit flips.
  const preview = useMemo(() => {
    if (!revealed || (hoverA === undefined && hoverB === undefined)) return undefined;
    const pa = hoverA !== undefined ? xor([a, known(1 << hoverA, width)], width) : a;
    const pb = hoverB !== undefined ? xor([b, known(1 << hoverB, width)], width) : b;
    return run(operator, pa, pb, amount, width, subMethod).result;
  }, [revealed, hoverA, hoverB, a, b, operator, amount, width, subMethod]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      // Toggle: Enter re-hides an already revealed result while hiding is on.
      // A focused button keeps its native Enter=click; firing the global reveal
      // too made the two fight (Hide-answers button after a click).
      if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
        // Mirrors the Show/Hide button: hiding a live result enables hiding mode.
        if (hideAnswers && stepIndex < 0) revealAll(1);
        else if (hideAnswers) resetSteps();
        else toggleHideAnswers();
      }
      const digit = e.key === '0' ? 10 : Number.parseInt(e.key, 10);
      const op = OPS[digit - 1];
      if (op && !e.ctrlKey) setOperator(op.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOperator, revealAll, resetSteps, toggleHideAnswers, hideAnswers, stepIndex]);

  return (
    <div className="compute-tab">
      <div className="compute-tab__group">
        <ValueEntry
          label="A"
          value={a}
          width={width}
          interp={interp}
          onChange={setA}
          onHoverBit={setHoverA}
        />

        {meta.shift ? (
          <label className="field">
            shift n
            <input
              type="number"
              className="field__input mono"
              min={0}
              max={width}
              value={amount}
              onChange={(e) => {
                setAmount(Math.max(0, Math.min(width, Number(e.target.value))));
                resetSteps(); // shift amount is an input: re-mask like any operand edit
              }}
            />
          </label>
        ) : (
          <div
            className={`value-entry-wrap${meta.unary ? ' value-entry-wrap--dimmed' : ''}`}
            aria-hidden={meta.unary || undefined}
          >
            <ValueEntry
              label="B"
              value={b}
              width={width}
              interp={interp}
              onChange={setB}
              onHoverBit={meta.unary ? undefined : setHoverB}
            />
          </div>
        )}

        <div className={`result-row${overflow ? ' result-row--overflow' : ''}`}>
          <div className="result-row__head">
            <span className="value-entry__label">
              {resultLabel(operator)} <span className="mono result-row__expr">= {meta.label}</span>
            </span>
            {/* Hiding a live result turns Hide-answers mode on; no separate mode button. */}
            <button
              type="button"
              className="reveal-btn"
              onClick={() => {
                if (!revealed) revealAll(1);
                else if (hideAnswers) resetSteps();
                else toggleHideAnswers();
              }}
            >
              {`${revealed ? 'Hide' : 'Show'}${coarse ? '' : ' (Enter)'}`}
            </button>
          </div>
          {revealed ? (
            <>
              <BitGrid
                value={computed.result}
                width={width}
                preview={preview}
                carries={computed.carryString}
                borrows={resultBorrows}
              />
              <div className="result-row__readout mono">
                {renderDec(computed.result, width, interp)}
                {` · 0x${renderHex(computed.result, width)}`}
                {/* One flag per interpretation: Cout is the unsigned story, V the
                    signed one; showing both misreads as "two overflows". */}
                {computed.carryOut !== undefined &&
                  interp === 'unsigned' &&
                  ` · ${coutAnnotation(operator, computed.carryOut)}`}
                {computed.borrowOut !== undefined &&
                  interp === 'unsigned' &&
                  (computed.borrowOut === 1 ? ' · borrow out (A < B)' : ' · no borrow (A ≥ B)')}
                {overflow && ' · V=1 overflow'}
                {computed.overflow === false && interp === 'twos' && ' · V=0'}
                {computed.shiftedOut &&
                  computed.shiftedOut.length > 0 &&
                  ` · out=${computed.shiftedOut.join('')}`}
              </div>
            </>
          ) : (
            <div className="reveal-plate">hidden</div>
          )}
        </div>

        {operator === 'SUB' && (
          <div className="convert-tab__method segmented">
            {SUB_METHODS.map((m) => (
              <button
                key={m.id}
                type="button"
                aria-pressed={subMethod === m.id}
                onClick={() => setSubMethod(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>
        )}

        {revealed && (operator === 'ADD' || operator === 'SUB') && (
          <SolutionSection
            operator={operator}
            a={a}
            b={b}
            width={width}
            interp={interp}
            subMethod={subMethod}
          />
        )}
      </div>
    </div>
  );
}
