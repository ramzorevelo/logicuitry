import { create } from 'zustand';
import { norm, type BusValue } from '../../core/value/busValue';
import { fromInt } from '../../core/numkit/format';
import type {
  ConvertDir,
  Dec2BinMethod,
  Dec2HexMethod,
  Interpretation,
  Operator,
  SubMethod,
  TwosMethod,
} from '../../core/numkit/types';
import { getPrefs } from '../prefs';

export type NumbersTab = 'convert' | 'compute';
export type BitWidth = 4 | 8 | 12 | 16 | 24 | 32;
export const WIDTHS: BitWidth[] = [4, 8, 12, 16, 24, 32];

interface NumbersState {
  tab: NumbersTab;
  setTab: (tab: NumbersTab) => void;
  width: BitWidth;
  setWidth: (width: BitWidth) => void;
  interp: Interpretation;
  setInterp: (interp: Interpretation) => void;

  a: BusValue;
  b: BusValue;
  setA: (a: BusValue) => void;
  setB: (b: BusValue) => void;

  operator: Operator;
  setOperator: (op: Operator) => void;
  convertDir: ConvertDir;
  setConvertDir: (dir: ConvertDir) => void;
  dec2binMethod: Dec2BinMethod;
  setDec2binMethod: (m: Dec2BinMethod) => void;
  dec2hexMethod: Dec2HexMethod;
  setDec2hexMethod: (m: Dec2HexMethod) => void;
  twosEncodeMethod: TwosMethod;
  setTwosEncodeMethod: (m: TwosMethod) => void;
  twosDecodeMethod: TwosMethod;
  setTwosDecodeMethod: (m: TwosMethod) => void;
  subMethod: SubMethod;
  setSubMethod: (m: SubMethod) => void;

  stepIndex: number; // -1 = nothing revealed yet
  advanceStep: (max: number) => void;
  revealAll: (max: number) => void;
  // Reveal toggle's hide half: re-mask and step back off the revealed final
  // (while hiding, the final step is part of the reveal, not of Space-advance).
  remask: () => void;
  resetSteps: () => void;

  // One shared hide/reveal concept for both tabs (issues 2 + 8). On by
  // default; every input change while hiding re-masks until the next reveal.
  hideAnswers: boolean;
  toggleHideAnswers: () => void;
  // Convert: true once the current step's masked answer has been revealed.
  answersShown: boolean;
}

// Resetting narration also re-masks the current step (answersShown -> false).
const RESET_STEPS = { stepIndex: -1, answersShown: false };

export const useNumbersStore = create<NumbersState>((set) => ({
  tab: 'convert',
  setTab: (tab) => set({ tab, ...RESET_STEPS }),
  width: 8,
  // Re-mask both operands to the new width so readouts never desync.
  setWidth: (width) =>
    set((s) => ({ width, a: norm(s.a, width), b: norm(s.b, width), ...RESET_STEPS })),
  interp: 'unsigned',
  setInterp: (interp) => set({ interp, ...RESET_STEPS }),

  a: fromInt(44, 8),
  b: fromInt(6, 8),
  setA: (a) => set({ a, ...RESET_STEPS }),
  setB: (b) => set({ b, ...RESET_STEPS }),

  operator: 'ADD',
  setOperator: (operator) => set({ operator, ...RESET_STEPS }),
  convertDir: 'bin2dec',
  setConvertDir: (convertDir) => set({ convertDir, ...RESET_STEPS }),
  dec2binMethod: 'division',
  setDec2binMethod: (dec2binMethod) => set({ dec2binMethod, ...RESET_STEPS }),
  dec2hexMethod: 'division',
  setDec2hexMethod: (dec2hexMethod) => set({ dec2hexMethod, ...RESET_STEPS }),
  twosEncodeMethod: 'invert-add',
  setTwosEncodeMethod: (twosEncodeMethod) => set({ twosEncodeMethod, ...RESET_STEPS }),
  twosDecodeMethod: 'invert-add',
  setTwosDecodeMethod: (twosDecodeMethod) => set({ twosDecodeMethod, ...RESET_STEPS }),
  // Section 1.4 teaches subtraction by borrowing; A + ~B + 1 is the alternative.
  subMethod: 'borrow',
  setSubMethod: (subMethod) => set({ subMethod, ...RESET_STEPS }),

  stepIndex: -1,
  // Advancing re-masks the new current step so each step gets its predict beat.
  advanceStep: (max) =>
    set((s) => ({ stepIndex: Math.min(s.stepIndex + 1, max - 1), answersShown: false })),
  revealAll: (max) => set({ stepIndex: max - 1, answersShown: true }),
  remask: () => set((s) => ({ answersShown: false, stepIndex: Math.max(-1, s.stepIndex - 1) })),
  resetSteps: () => set({ ...RESET_STEPS }),

  hideAnswers: getPrefs().hideAnswersDefault,
  // Turning hiding on must actually hide: a stale stepIndex >= 0 would keep the
  // result revealed, so the toggle re-masks in the same set.
  toggleHideAnswers: () => set((s) => ({ hideAnswers: !s.hideAnswers, ...RESET_STEPS })),
  answersShown: false,
}));

/** Whether the Hide answers toggle earns its place in the bar. With masking on
 *  and nothing revealed there is nothing for it to hide, and it was pure
 *  chrome in a bar that a phone could not spare the height for. Revealing
 *  brings it back, and it is always there while nothing is being hidden, since
 *  that is the state it exists to leave. */
export function offersHideAnswers(s: {
  hideAnswers: boolean;
  stepIndex: number;
  answersShown: boolean;
}): boolean {
  return !s.hideAnswers || s.stepIndex >= 0 || s.answersShown;
}
