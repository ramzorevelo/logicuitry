// Number-workbench vocabulary. numkit is pure: generators turn a value into an
// ordered list of narrated steps, so the UI just plays them back teacher-paced.

export type Interpretation = 'unsigned' | 'twos';

/** Which on-screen row/cell a step highlights. Compute uses a/b/result; Convert uses value. */
export type RowId = 'value' | 'a' | 'b' | 'result';

export interface BitRef {
  row: RowId;
  bit: number;
}

export type NarrationKind =
  | 'weight'
  | 'digit'
  | 'group'
  | 'accumulate'
  | 'complement'
  | 'add-one'
  | 'note';

export interface NarrationStep {
  kind: NarrationKind;
  text: string;
  highlights: BitRef[];
  /** Running result rendered so far, when the step advances it. The badge is
      the single place running/final values appear; the UI masks it with ▯
      while the step is hidden. */
  partial?: string;
  /** Hide-answers prose variant with predict-worthy values blanked (▯).
      Present only when the prose itself states such a value (division
      quotient/remainder, group digit); result accumulation lives in partial. */
  maskedText?: string;
}

export type ConvertDir =
  | 'bin2dec'
  | 'dec2bin'
  | 'bin2hex'
  | 'hex2bin'
  | 'bin2oct'
  | 'oct2bin'
  | 'twos-encode'
  | 'twos-decode'
  | 'hex2dec'
  | 'dec2hex';

/** dec2bin is taught two ways; the instructor picks per run. */
export type Dec2BinMethod = 'division' | 'weight-subtraction';

/** dec2hex is taught two ways, same shape as dec2bin's. */
export type Dec2HexMethod = 'division' | 'weight-subtraction';

/** Two's complement is taught two ways: bit manipulation, or the 2^n - |x| alternative. */
export type TwosMethod = 'invert-add' | 'alternative';

/** Subtraction is taught two ways: the section 1.4 borrow columns, or A + ~B + 1. */
export type SubMethod = 'borrow' | 'complement';

export type BinaryOp = 'ADD' | 'SUB' | 'AND' | 'OR' | 'XOR';
export type UnaryOp = 'NOT' | 'SHL' | 'SHR' | 'SAR' | 'NEG';
export type Operator = BinaryOp | UnaryOp;
