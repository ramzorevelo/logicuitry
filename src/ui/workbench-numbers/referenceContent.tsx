import type { ReactNode } from 'react';
import type { ConvertDir, Operator } from '../../core/numkit/types';

// Presentation copy for the reference drawer (issue 6): per-operator rule cards
// and per-conversion notation cards. Pure UI text, not core logic.

function TruthTable({ inputs, rows }: { inputs: string[]; rows: [string[], string][] }) {
  return (
    <table className="ref-truth mono">
      <thead>
        <tr>
          {inputs.map((h) => (
            <th key={h}>{h}</th>
          ))}
          <th>Y</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([ins, y], i) => (
          <tr key={i}>
            {ins.map((v, j) => (
              <td key={j}>{v}</td>
            ))}
            <td className="ref-truth__out">{y}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const AND_ROWS: [string[], string][] = [
  [['0', '0'], '0'],
  [['0', '1'], '0'],
  [['1', '0'], '0'],
  [['1', '1'], '1'],
];
const OR_ROWS: [string[], string][] = [
  [['0', '0'], '0'],
  [['0', '1'], '1'],
  [['1', '0'], '1'],
  [['1', '1'], '1'],
];
const XOR_ROWS: [string[], string][] = [
  [['0', '0'], '0'],
  [['0', '1'], '1'],
  [['1', '0'], '1'],
  [['1', '1'], '0'],
];
const NOT_ROWS: [string[], string][] = [
  [['0'], '1'],
  [['1'], '0'],
];

const ADDER_CARD: ReactNode = (
  <div className="ref-prose">
    <p className="mono">S = A ⊕ B ⊕ Cin</p>
    <p className="mono">Cout = AB + Cin(A ⊕ B)</p>
    <p>Carries ripple LSB → MSB.</p>
    <p>
      Unsigned overflow: Cout = 1 out of the MSB. Two&apos;s-complement overflow:{' '}
      <span className="mono">V = Cin(MSB) ⊕ Cout(MSB)</span>.
    </p>
  </div>
);

const SUB_CARD: ReactNode = (
  <div className="ref-prose">
    <p className="mono">A − B = A + ~B + 1</p>
    <p>Reuses the adder: invert B, add with Cin = 1.</p>
    <p>
      Here Cout = 1 means <b>no borrow</b> (result valid); Cout = 0 means a borrow occurred, the
      opposite of the ADD reading.
    </p>
    <p>
      Two&apos;s-complement overflow: <span className="mono">V = Cin(MSB) ⊕ Cout(MSB)</span>.
    </p>
  </div>
);

const shiftCard = (lines: string[]): ReactNode => (
  <ul className="ref-prose">
    {lines.map((l, i) => (
      <li key={i}>{l}</li>
    ))}
  </ul>
);

export function operatorReference(op: Operator): { label: string; body: ReactNode } {
  switch (op) {
    case 'AND':
      return { label: 'AND', body: <TruthTable inputs={['A', 'B']} rows={AND_ROWS} /> };
    case 'OR':
      return { label: 'OR', body: <TruthTable inputs={['A', 'B']} rows={OR_ROWS} /> };
    case 'XOR':
      return { label: 'XOR', body: <TruthTable inputs={['A', 'B']} rows={XOR_ROWS} /> };
    case 'NOT':
      return { label: 'NOT', body: <TruthTable inputs={['A']} rows={NOT_ROWS} /> };
    case 'ADD':
      return { label: 'Full adder', body: ADDER_CARD };
    case 'SUB':
      return { label: 'Subtract', body: SUB_CARD };
    case 'SHL':
      return {
        label: 'Shift left',
        body: shiftCard([
          'Bits move toward the MSB.',
          'Vacated LSBs fill with 0.',
          'Bits shifted past the MSB are discarded.',
        ]),
      };
    case 'SHR':
      return {
        label: 'Shift right',
        body: shiftCard([
          'Bits move toward the LSB.',
          'Vacated MSBs fill with 0 (logical shift).',
          'Bits shifted past the LSB are discarded.',
        ]),
      };
    case 'SAR':
      return {
        label: 'Arithmetic shift right',
        body: shiftCard([
          'Bits move toward the LSB.',
          'Vacated MSBs copy the sign bit (sign-extend).',
          'Preserves the sign of a two’s-complement value.',
        ]),
      };
    case 'NEG':
      return {
        label: 'Negate',
        body: (
          <div className="ref-prose">
            <p className="mono">−A = ~A + 1</p>
            <p>Two’s-complement negation: invert every bit, then add 1.</p>
          </div>
        ),
      };
  }
}

// Convert-tab notation cards, chosen by the source base of the direction.
type RefTopic = 'binary' | 'hex' | 'octal' | 'twos';

function topicFor(dir: ConvertDir): RefTopic {
  if (dir === 'twos-encode' || dir === 'twos-decode') return 'twos';
  if (dir === 'bin2hex' || dir === 'hex2bin' || dir === 'hex2dec' || dir === 'dec2hex')
    return 'hex';
  if (dir === 'bin2oct' || dir === 'oct2bin') return 'octal';
  return 'binary';
}

const TOPIC_CARDS: Record<RefTopic, { label: string; body: ReactNode }> = {
  binary: {
    label: 'Binary places',
    body: (
      <div className="ref-prose">
        <p>Each bit is a power of two; sum the weights of the 1-bits.</p>
        <p className="mono">…128 64 32 16 8 4 2 1</p>
        <p>MSB leftmost. bit n has weight 2ⁿ.</p>
      </div>
    ),
  },
  hex: {
    label: 'Hex nibbles',
    body: (
      <div className="ref-prose">
        <p>Group bits into nibbles of 4; each nibble is one hex digit.</p>
        <p className="mono">A=1010 B=1011 C=1100 D=1101 E=1110 F=1111</p>
        <p>Hex place values: …256 16 1.</p>
      </div>
    ),
  },
  octal: {
    label: 'Octal groups',
    body: (
      <div className="ref-prose">
        <p>Group bits into threes; each group is one octal digit (0–7).</p>
        <p className="mono">000=0 … 111=7</p>
        <p>Octal place values: …64 8 1.</p>
      </div>
    ),
  },
  twos: {
    label: "Two's complement",
    body: (
      <div className="ref-prose">
        <p>Represent a negative: invert every bit, then add 1.</p>
        <p>Read a pattern: the MSB carries weight −2ⁿ⁻¹; add the remaining positive weights.</p>
        <p className="mono">−x = ~x + 1</p>
      </div>
    ),
  },
};

export function convertReference(dir: ConvertDir): { label: string; body: ReactNode } {
  return TOPIC_CARDS[topicFor(dir)];
}
