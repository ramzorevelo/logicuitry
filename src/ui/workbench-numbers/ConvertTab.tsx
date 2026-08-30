import { useEffect, useMemo, useRef } from 'react';
import { allX, norm, type BusValue } from '../../core/value/busValue';
import {
  bin2dec,
  bin2hex,
  bin2oct,
  dec2bin,
  dec2hex,
  hex2bin,
  hex2dec,
  oct2bin,
  twosDecode,
  twosEncode,
} from '../../core/numkit/convert';
import {
  renderBin,
  renderHex,
  renderOct,
  toDecimal,
  toSigned,
  toUnsigned,
} from '../../core/numkit/format';
import type {
  ConvertDir,
  Dec2BinMethod,
  Dec2HexMethod,
  Interpretation,
  NarrationStep,
  TwosMethod,
} from '../../core/numkit/types';
import type { WeightMode } from '../../render/bitGrid';
import { useReferenceDrawer } from '../components/ReferenceDrawer';
import { useCompact } from '../compact';
import { BitGrid } from './BitGrid';
import { ValueEntry, type EntryField } from './ValueEntry';
import { convertReference } from './referenceContent';
import { useNumbersStore } from './numbersStore';

// Harris & Harris avoid the encode/decode verb framing for two's complement.
// Grouped by base family; digit chips follow flat order 1-9, 0.
export const FAMILIES: { label: string; dirs: { id: ConvertDir; label: string }[] }[] = [
  {
    label: 'bin ↔ dec',
    dirs: [
      { id: 'bin2dec', label: 'bin → dec' },
      { id: 'dec2bin', label: 'dec → bin' },
    ],
  },
  {
    label: 'bin ↔ hex',
    dirs: [
      { id: 'bin2hex', label: 'bin → hex' },
      { id: 'hex2bin', label: 'hex → bin' },
    ],
  },
  {
    label: 'bin ↔ oct',
    dirs: [
      { id: 'bin2oct', label: 'bin → oct' },
      { id: 'oct2bin', label: 'oct → bin' },
    ],
  },
  {
    label: "two's complement",
    dirs: [
      { id: 'twos-encode', label: "dec → two's comp" },
      { id: 'twos-decode', label: "two's comp → dec" },
    ],
  },
  {
    label: 'hex ↔ dec',
    dirs: [
      { id: 'hex2dec', label: 'hex → dec' },
      { id: 'dec2hex', label: 'dec → hex' },
    ],
  },
];
const FLAT_DIRS = FAMILIES.flatMap((f) => f.dirs.map((d) => d.id));

// The single entry field shown per direction: its source base.
const SOURCE_FIELD: Record<ConvertDir, EntryField> = {
  bin2dec: 'bits',
  dec2bin: 'dec',
  bin2hex: 'bits',
  hex2bin: 'hex',
  bin2oct: 'bits',
  oct2bin: 'oct',
  'twos-encode': 'dec',
  'twos-decode': 'bits',
  hex2dec: 'hex',
  dec2hex: 'dec',
};

// Hex and octal are read one group at a time, so each group restarts at 8 4 2 1
// (or 4 2 1) and the wider gap moves to match; every other direction reads the
// whole word's place values.
function gridWeights(dir: ConvertDir): { weights: WeightMode; groupBits: number } {
  if (dir === 'bin2hex' || dir === 'hex2bin') return { weights: 'nibble', groupBits: 4 };
  if (dir === 'bin2oct' || dir === 'oct2bin') return { weights: 'triplet', groupBits: 3 };
  return { weights: 'power', groupBits: 4 };
}

/**
 * Whether the narration walks binary at all. hex<->dec sums hex-digit weights
 * or divides by 16 directly, so a bit grid there is noise, except that
 * hex->dec under two's complement expands to bits first.
 */
function narratesBinary(dir: ConvertDir, twos: boolean): boolean {
  if (dir === 'dec2hex') return false;
  if (dir === 'hex2dec') return twos;
  return true;
}

interface ConvertMethods {
  dec2bin: Dec2BinMethod;
  dec2hex: Dec2HexMethod;
  twosEncode: TwosMethod;
  twosDecode: TwosMethod;
}

function buildSteps(
  dir: ConvertDir,
  a: BusValue,
  width: number,
  interp: Interpretation,
  methods: ConvertMethods,
): NarrationStep[] {
  const twos = interp === 'twos';
  switch (dir) {
    case 'bin2dec':
      return bin2dec(a, width, twos);
    case 'dec2bin':
      return dec2bin(a, width, methods.dec2bin);
    case 'bin2hex':
      return bin2hex(a, width);
    case 'hex2bin':
      return hex2bin(a, width);
    case 'bin2oct':
      return bin2oct(a, width);
    case 'oct2bin':
      return oct2bin(a, width);
    case 'twos-encode':
      return twosEncode(toSigned(a, width), width, methods.twosEncode);
    case 'twos-decode':
      return twosDecode(a, width, methods.twosDecode);
    case 'hex2dec':
      return hex2dec(a, width, twos);
    case 'dec2hex':
      return dec2hex(a, width, methods.dec2hex);
  }
}

// Method toggle per direction (fix-5: sits below the entry, above the steps
// panel; not every direction has a taught alternative).
const METHOD_OPTIONS: Partial<Record<ConvertDir, readonly string[]>> = {
  dec2bin: ['division', 'weight-subtraction'],
  dec2hex: ['division', 'weight-subtraction'],
  'twos-encode': ['invert-add', 'alternative'],
  'twos-decode': ['invert-add', 'alternative'],
};

// Source -> target framing for the final-answer plate.
function plateText(dir: ConvertDir, a: BusValue, width: number, interp: Interpretation): string {
  const bin = `0b${renderBin(a, width)}`;
  const hex = `0x${renderHex(a, width)}`;
  const oct = `0o${renderOct(a, width)}`;
  const dec = String(toDecimal(a, width, interp));
  const signed = String(toSigned(a, width));
  const uns = String(toUnsigned(a, width));
  switch (dir) {
    case 'bin2dec':
      return `${bin} = ${dec}`;
    case 'dec2bin':
      return `${uns} = ${bin}`;
    case 'bin2hex':
      return `${bin} = ${hex}`;
    case 'hex2bin':
      return `${hex} = ${bin}`;
    case 'bin2oct':
      return `${bin} = ${oct}`;
    case 'oct2bin':
      return `${oct} = ${bin}`;
    case 'twos-encode':
      return `${signed} = ${bin}`;
    case 'twos-decode':
      return `${bin} = ${signed}`;
    case 'hex2dec':
      return `${hex} = ${dec}`;
    case 'dec2hex':
      return `${uns} = ${hex}`;
  }
}

/** Latest bit pattern stated by a consumed step, '.' bits as X (undiscovered). */
function narrationValue(consumed: NarrationStep[], width: number): BusValue {
  for (let i = consumed.length - 1; i >= 0; i--) {
    const p = consumed[i]?.partial;
    if (p !== undefined && p.length === width && /^[01.]+$/.test(p)) {
      let v = 0;
      let x = 0;
      for (let c = 0; c < width; c++) {
        const bit = width - 1 - c;
        if (p[c] === '1') v |= 1 << bit;
        else if (p[c] === '.') x |= 1 << bit;
      }
      return norm({ v: v >>> 0, x: x >>> 0, z: 0 }, width);
    }
  }
  return allX(width);
}

export function ConvertTab() {
  const {
    a,
    width,
    interp,
    convertDir,
    dec2binMethod,
    dec2hexMethod,
    twosEncodeMethod,
    twosDecodeMethod,
    stepIndex,
    hideAnswers,
    answersShown,
  } = useNumbersStore();
  const setA = useNumbersStore((s) => s.setA);
  const setConvertDir = useNumbersStore((s) => s.setConvertDir);
  const setDec2binMethod = useNumbersStore((s) => s.setDec2binMethod);
  const setDec2hexMethod = useNumbersStore((s) => s.setDec2hexMethod);
  const setTwosEncodeMethod = useNumbersStore((s) => s.setTwosEncodeMethod);
  const setTwosDecodeMethod = useNumbersStore((s) => s.setTwosDecodeMethod);
  const advanceStep = useNumbersStore((s) => s.advanceStep);
  const revealAll = useNumbersStore((s) => s.revealAll);
  const remask = useNumbersStore((s) => s.remask);
  const resetSteps = useNumbersStore((s) => s.resetSteps);
  const stepsRef = useRef<HTMLOListElement>(null);

  const methods: ConvertMethods = {
    dec2bin: dec2binMethod,
    dec2hex: dec2hexMethod,
    twosEncode: twosEncodeMethod,
    twosDecode: twosDecodeMethod,
  };

  const steps = useMemo(
    () => buildSteps(convertDir, a, width, interp, methods),
    [
      convertDir,
      a,
      width,
      interp,
      dec2binMethod,
      dec2hexMethod,
      twosEncodeMethod,
      twosDecodeMethod,
    ],
  );

  // dec -> two's complement is inherently a signed-source operation: the
  // field must show/accept negative numbers regardless of the workbench's
  // shared unsigned/twos toggle (that toggle means something else for
  // bin2dec/hex2dec and Compute), otherwise it can display e.g. "251" while
  // the narration below opens with "encode -5" for the same bit pattern.
  const entryInterp: Interpretation = convertDir === 'twos-encode' ? 'twos' : interp;

  const currentMethod: { value: string; set: (m: string) => void } | undefined = (() => {
    switch (convertDir) {
      case 'dec2bin':
        return { value: dec2binMethod, set: setDec2binMethod as (m: string) => void };
      case 'dec2hex':
        return { value: dec2hexMethod, set: setDec2hexMethod as (m: string) => void };
      case 'twos-encode':
        return { value: twosEncodeMethod, set: setTwosEncodeMethod as (m: string) => void };
      case 'twos-decode':
        return { value: twosDecodeMethod, set: setTwosDecodeMethod as (m: string) => void };
      default:
        return undefined;
    }
  })();

  useReferenceDrawer(useMemo(() => convertReference(convertDir), [convertDir]));

  // While hiding, Space stops short of the final step: it belongs to the
  // reveal, otherwise the step before it un-masks and leaks the answer badge.
  const hiding = hideAnswers && !answersShown;
  const visibleMax = hiding ? steps.length - 1 : steps.length;
  const compact = useCompact();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === ' ' || e.key === '.') {
        e.preventDefault();
        if (stepIndex < visibleMax - 1) advanceStep(visibleMax);
      } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
        // Focused buttons keep native Enter=click; the global reveal firing too
        // double-toggled. Toggle: a second Enter on the revealed final re-masks.
        if (hideAnswers && answersShown && stepIndex === steps.length - 1) remask();
        else revealAll(steps.length);
      } else if (e.key === 'r' || e.key === 'R') {
        resetSteps();
      } else if (!e.ctrlKey && /^[0-9]$/.test(e.key)) {
        const dir = FLAT_DIRS[e.key === '0' ? 9 : Number.parseInt(e.key, 10) - 1];
        if (dir) setConvertDir(dir);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    steps.length,
    visibleMax,
    advanceStep,
    revealAll,
    remask,
    resetSteps,
    setConvertDir,
    hideAnswers,
    answersShown,
    stepIndex,
  ]);

  // Newest step stays in view as narration advances.
  useEffect(() => {
    stepsRef.current?.lastElementChild?.scrollIntoView({ block: 'nearest' });
  }, [stepIndex]);

  const shown = steps.slice(0, stepIndex + 1);
  const current = steps[stepIndex];
  const currentMasked =
    hideAnswers &&
    !answersShown &&
    current !== undefined &&
    (current.maskedText !== undefined || current.partial !== undefined);
  const onFinal = stepIndex === steps.length - 1;
  // dec2bin weight-subtraction skips non-fitting weights, so which bit gets
  // highlighted next IS the answer (unlike division's fixed LSB-first order,
  // or grouping's fixed nibble ranges) -- suppress just that one case while
  // masked, or the ring points at the prediction before the reveal.
  const suppressHighlight =
    currentMasked && convertDir === 'dec2bin' && dec2binMethod === 'weight-subtraction';
  const highlight = useMemo(
    () =>
      suppressHighlight
        ? new Set<number>()
        : new Set(current?.highlights.filter((h) => h.row === 'value').map((h) => h.bit) ?? []),
    [current, suppressHighlight],
  );

  const sourceField = SOURCE_FIELD[convertDir];
  const showsGrid = narratesBinary(convertDir, interp === 'twos');
  const { weights, groupBits } = gridWeights(convertDir);
  const narrValue = useMemo(
    () => narrationValue(currentMasked ? shown.slice(0, -1) : shown, width),
    [shown, currentMasked, width],
  );

  return (
    <div className="convert-tab">
      <div className="convert-tab__group">
        <ValueEntry
          label="value"
          value={a}
          width={width}
          interp={entryInterp}
          fields={[sourceField]}
          highlight={sourceField === 'bits' ? highlight : undefined}
          weights={sourceField === 'bits' ? weights : undefined}
          groupBits={groupBits}
          onChange={setA}
        />

        {sourceField !== 'bits' && showsGrid && (
          <div className="narration-grid">
            <BitGrid
              value={narrValue}
              width={width}
              highlight={highlight}
              weights={weights}
              groupBits={groupBits}
            />
          </div>
        )}

        {currentMethod && (
          <div className="convert-tab__method segmented">
            {METHOD_OPTIONS[convertDir]!.map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={currentMethod.value === m}
                onClick={() => currentMethod.set(m)}
              >
                {m}
              </button>
            ))}
          </div>
        )}

        {/* Touch equivalents of Space / Enter / R. Rendered on compact only:
            a phone has no keyboard, so without these the narration cannot be
            advanced at all and the keyboard hints name keys that are not
            there. */}
        {compact && (
          <div className="steps-controls">
            <button
              type="button"
              className="reveal-btn"
              disabled={stepIndex >= visibleMax - 1}
              onClick={() => advanceStep(visibleMax)}
            >
              Step
            </button>
            <button
              type="button"
              className="reveal-btn"
              onClick={() =>
                hideAnswers && answersShown && stepIndex === steps.length - 1
                  ? remask()
                  : revealAll(steps.length)
              }
            >
              {hideAnswers && answersShown && stepIndex === steps.length - 1 ? 'Hide' : 'Reveal'}
            </button>
            <button type="button" className="reveal-btn" onClick={resetSteps}>
              Reset
            </button>
          </div>
        )}
        <ol className="steps-panel" ref={stepsRef}>
          {shown.length === 0 && (
            <li className="steps-panel__empty">
              {compact ? 'tap Step to begin' : 'press Space to begin'}
            </li>
          )}
          {shown.map((s, i) => {
            const isCurrent = i === stepIndex;
            const masked = isCurrent && currentMasked;
            return (
              <li
                key={i}
                className={`step step--${s.kind}${masked ? ' step--masked' : ''}${
                  isCurrent ? ' step--current' : ' step--done'
                }`}
              >
                <span className="step__text">
                  {masked && s.maskedText !== undefined ? s.maskedText : s.text}
                </span>
                {masked && stepIndex === visibleMax - 1 && (
                  <span className="step__hint">Enter to reveal</span>
                )}
                {s.partial !== undefined && (
                  <span className="step__partial mono">{masked ? '▯' : s.partial}</span>
                )}
              </li>
            );
          })}
        </ol>

        {onFinal && !currentMasked && (
          <div className="final-plate mono">{plateText(convertDir, a, width, interp)}</div>
        )}
      </div>
    </div>
  );
}
