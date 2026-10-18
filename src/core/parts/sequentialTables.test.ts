// Each table is transcribed row by row from the datasheet in its `source`, never derived
// from the primitive, and run through the generated DIP by the datasheet's pin names.
// H and L are its levels, ^ its rising clock edge, X its "irrelevant".

import { describe, expect, it } from 'vitest';
import { bench, type Bench } from './testHarness';

interface SequentialTable {
  part: string;
  source: string;
  /** Column heads, inputs then outputs, as the datasheet prints them. */
  inputs: string[];
  outputs: string[];
  /** The input column that is the clock. */
  clock: string;
  /**
   * `inputs | outputs`. An output is H, L or Z, or a stored level the row
   * keeps: Q0 (or QH0, QA0) is the level stored before the row, /Q0 its
   * complement, and QAn or QGn the level of that stage before the edge.
   */
  rows: string[];
  /** Package pins per column, one entry per section; a column may drive several pins. */
  sections: { inputs: (string | string[])[]; outputs: string[] }[];
  /** Leaves a section storing `level` everywhere, with its clock high. */
  store: (b: Bench, section: number, level: boolean) => void;
}

const H = true;
const L = false;

function clockIn(b: Bench, clk: string): void {
  b.set(clk, L);
  b.set(clk, H);
}

/**
 * Four fills of the irrelevant inputs: all H, all L, and each with the other
 * clock reading, so an X clock is run held low, held high and rising.
 */
const FILLS = [
  { other: 'H', clock: '^' },
  { other: 'L', clock: 'L' },
  { other: 'H', clock: 'H' },
  { other: 'L', clock: '^' },
] as const;

function expected(token: string, stored: boolean): string {
  if (token === 'H') return '1';
  if (token === 'L') return '0';
  if (token === 'Z') return 'Z';
  // Every stage holds the same stored level, so "before the row" and "the
  // stage before, before the edge" read alike.
  if (/^Q[A-H]?(0|n)$/.test(token)) return stored ? '1' : '0';
  if (/^\/Q[A-H]?0$/.test(token)) return stored ? '0' : '1';
  throw new Error(`unknown output token ${token}`);
}

function check(table: SequentialTable): void {
  const clockAt = table.inputs.indexOf(table.clock);
  for (const row of table.rows) {
    const [ins, outs] = row.split('|').map((side) => side.trim().split(/\s+/)) as [
      string[],
      string[],
    ];
    expect(ins.length, `${table.part} "${row}"`).toBe(table.inputs.length);
    expect(outs.length, `${table.part} "${row}"`).toBe(table.outputs.length);
    table.sections.forEach((section, s) => {
      for (const fill of FILLS)
        for (const stored of [L, H]) {
          const b = bench(table.part);
          table.store(b, s, stored);
          const level = (i: number) => (ins[i] === 'X' ? fill.other : ins[i]!) === 'H';
          section.inputs.forEach((pins, i) => {
            if (i === clockAt) return;
            for (const pin of [pins].flat()) b.set(pin, level(i));
          });
          const clk = section.inputs[clockAt] as string;
          const edge = ins[clockAt] === 'X' ? fill.clock : ins[clockAt]!;
          if (edge === '^') clockIn(b, clk);
          else b.set(clk, edge === 'H');
          const got = section.outputs.map((pin) => b.read(pin));
          const want = outs.map((token) => expected(token, stored));
          expect(
            got,
            `${table.part} section ${s + 1}, "${row}", fill ${fill.other}/${fill.clock}, stored ${stored ? 'H' : 'L'}`,
          ).toEqual(want);
        }
    });
  }
}

const LS74: SequentialTable = {
  part: '74LS74',
  source: 'TI SDLS119, December 1983, revised March 1988, function table',
  inputs: ['PRE', 'CLR', 'CLK', 'D'],
  outputs: ['Q', '/Q'],
  clock: 'CLK',
  rows: [
    'L H X X | H L',
    'H L X X | L H',
    'L L X X | H H',
    'H H ^ H | H L',
    'H H ^ L | L H',
    'H H L X | Q0 /Q0',
  ],
  sections: [1, 2].map((n) => ({
    inputs: [`/${n}PRE`, `/${n}CLR`, `${n}CLK`, `${n}D`],
    outputs: [`${n}Q`, `/${n}Q`],
  })),
  store: (b, s, level) => {
    const n = s + 1;
    b.set(`/${n}PRE`, H);
    b.set(`/${n}CLR`, H);
    b.set(`${n}D`, level);
    clockIn(b, `${n}CLK`);
  },
};

const LS175: SequentialTable = {
  part: '74LS175',
  source:
    "TI SDLS068A, December 1972, revised October 2001, function table (each flip-flop), 'LS175 /Q",
  inputs: ['CLEAR', 'CLOCK', 'D'],
  outputs: ['Q', '/Q'],
  clock: 'CLOCK',
  rows: ['L X X | L H', 'H ^ H | H L', 'H ^ L | L H', 'H L X | Q0 /Q0'],
  sections: [1, 2, 3, 4].map((n) => ({
    inputs: ['/CLR', 'CLK', `${n}D`],
    outputs: [`${n}Q`, `/${n}Q`],
  })),
  store: (b, s, level) => {
    b.set('/CLR', H);
    b.set(`${s + 1}D`, level);
    clockIn(b, 'CLK');
  },
};

const OCTAL = [1, 2, 3, 4, 5, 6, 7, 8];

const LS273: SequentialTable = {
  part: '74LS273',
  source: 'TI SDLS090, October 1976, revised March 1988, function table (each flip-flop)',
  inputs: ['CLEAR', 'CLOCK', 'D'],
  outputs: ['Q'],
  clock: 'CLOCK',
  rows: ['L X X | L', 'H ^ H | H', 'H ^ L | L', 'H L X | Q0'],
  sections: OCTAL.map((n) => ({ inputs: ['/CLR', 'CLK', `${n}D`], outputs: [`${n}Q`] })),
  store: (b, s, level) => {
    b.set('/CLR', H);
    b.set(`${s + 1}D`, level);
    clockIn(b, 'CLK');
  },
};

const LS374: SequentialTable = {
  part: '74LS374',
  source: "TI SDLS165B, October 1975, revised August 2002, 'LS374 function table (each latch)",
  inputs: ['OC', 'CLK', 'D'],
  outputs: ['Q'],
  clock: 'CLK',
  rows: ['L ^ H | H', 'L ^ L | L', 'L L X | Q0', 'H X X | Z'],
  sections: OCTAL.map((n) => ({ inputs: ['/OC', 'CLK', `${n}D`], outputs: [`${n}Q`] })),
  store: (b, s, level) => {
    b.set('/OC', L);
    b.set(`${s + 1}D`, level);
    clockIn(b, 'CLK');
  },
};

const LS377: SequentialTable = {
  part: '74LS377',
  source: 'TI SDLS167, October 1976, revised March 1988, function table (each flip-flop), Q column',
  inputs: ['G', 'CLOCK', 'DATA'],
  outputs: ['Q'],
  clock: 'CLOCK',
  rows: ['H X X | Q0', 'L ^ H | H', 'L ^ L | L', 'X L X | Q0'],
  sections: OCTAL.map((n) => ({ inputs: ['/G', 'CLK', `${n}D`], outputs: [`${n}Q`] })),
  store: (b, s, level) => {
    b.set('/G', L);
    b.set(`${s + 1}D`, level);
    clockIn(b, 'CLK');
  },
};

const LS164: SequentialTable = {
  part: '74LS164',
  source: 'TI SDLS061, March 1974, revised March 1988, function table',
  inputs: ['CLEAR', 'CLOCK', 'A', 'B'],
  outputs: ['QA', 'QB', 'QH'],
  clock: 'CLOCK',
  rows: [
    'L X X X | L L L',
    'H L X X | QA0 QB0 QH0',
    'H ^ H H | H QAn QGn',
    'H ^ L X | L QAn QGn',
    'H ^ X L | L QAn QGn',
  ],
  sections: [{ inputs: ['/CLR', 'CLK', 'A', 'B'], outputs: ['QA', 'QB', 'QH'] }],
  store: (b, _s, level) => {
    b.set('/CLR', L);
    b.set('/CLR', H);
    b.set('A', level);
    b.set('B', level);
    for (let i = 0; i < 8; i++) clockIn(b, 'CLK');
  },
};

const PARALLEL = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

// The datasheet's a...h column is one level across A to H here; QH shows h.
const LS165: SequentialTable = {
  part: '74LS165',
  source: 'TI SDLS062D, October 1976, revised February 2002, function table, output QH',
  inputs: ['SH/LD', 'CLK INH', 'CLK', 'SER', 'A...H'],
  outputs: ['QH'],
  clock: 'CLK',
  rows: [
    'L X X X H | H',
    'L X X X L | L',
    'H L L X X | QH0',
    'H L ^ H X | QGn',
    'H L ^ L X | QGn',
    'H H X X X | QH0',
  ],
  sections: [{ inputs: ['SH/LD', 'CLK INH', 'CLK', 'SER', PARALLEL], outputs: ['QH'] }],
  store: (b, _s, level) => {
    for (const pin of PARALLEL) b.set(pin, level);
    b.set('SH/LD', L);
    b.set('CLK', H);
    b.set('SH/LD', H);
  },
};

describe('sequential DIP function tables', () => {
  for (const table of [LS74, LS175, LS273, LS374, LS377, LS164, LS165])
    it(`${table.part}: every row, every section, from a stored 0 and a stored 1`, () =>
      check(table));
});

describe("74LS374 output control (SDLS165B: OC does not affect the flip-flops' internal operation)", () => {
  it('loads new data while the outputs float, and shows it once /OC is low', () => {
    const b = bench('74LS374');
    b.set('/OC', H);
    for (const n of OCTAL) b.set(`${n}D`, n % 2 === 1);
    clockIn(b, 'CLK');
    expect(OCTAL.map((n) => b.read(`${n}Q`)).join('')).toBe('ZZZZZZZZ');
    b.set('/OC', L);
    expect(OCTAL.map((n) => b.read(`${n}Q`)).join('')).toBe('10101010');
  });
});

/** QD QC QB QA as a number, so a count reads as the datasheet's sequence does. */
function countOf(b: Bench): number {
  const bits = ['QD', 'QC', 'QB', 'QA'].map((pin) => b.read(pin));
  for (const bit of bits) if (bit !== '0' && bit !== '1') throw new Error(`Q is ${bits.join('')}`);
  return parseInt(bits.join(''), 2);
}

function counterBench(part: string): Bench {
  const b = bench(part);
  for (const pin of ['/CLR', '/LOAD', 'ENP', 'ENT']) b.set(pin, H);
  return b;
}

function preset(b: Bench, value: number): void {
  ['A', 'B', 'C', 'D'].forEach((pin, bit) => b.set(pin, ((value >> bit) & 1) === 1));
  b.set('/LOAD', L);
  clockIn(b, 'CLK');
  b.set('/LOAD', H);
}

// SDLS060 prints no function table: these follow its description and its typical
// clear, preset, count and inhibit sequence (preset 12, count 13 to 2, inhibit).
describe('74LS161 and 74LS163 (TI SDLS060, October 1976, revised March 1988)', () => {
  for (const part of ['74LS161', '74LS163'])
    describe(part, () => {
      it('presets on the edge with /LOAD low, whatever the enables', () => {
        const b = counterBench(part);
        b.set('ENP', L);
        b.set('ENT', L);
        preset(b, 12);
        expect(countOf(b)).toBe(12);
      });

      it('counts 13, 14, 15, 0, 1, 2 with RCO high only at 15', () => {
        const b = counterBench(part);
        preset(b, 12);
        const seen: string[] = [];
        for (let i = 0; i < 6; i++) {
          clockIn(b, 'CLK');
          seen.push(`${countOf(b)}:${b.read('RCO')}`);
        }
        expect(seen).toEqual(['13:0', '14:0', '15:1', '0:0', '1:0', '2:0']);
      });

      it('counts through every state from 0 back to 0', () => {
        const b = counterBench(part);
        preset(b, 0);
        for (let n = 1; n <= 16; n++) {
          clockIn(b, 'CLK');
          expect(countOf(b), `edge ${n}`).toBe(n % 16);
          expect(b.read('RCO'), `edge ${n}`).toBe(n === 15 ? '1' : '0');
        }
      });

      it('inhibits with either enable low; ENT alone gates RCO', () => {
        const b = counterBench(part);
        preset(b, 15);
        b.set('ENP', L);
        clockIn(b, 'CLK');
        expect(countOf(b)).toBe(15);
        expect(b.read('RCO')).toBe('1');
        b.set('ENP', H);
        b.set('ENT', L);
        expect(b.read('RCO')).toBe('0');
        clockIn(b, 'CLK');
        expect(countOf(b)).toBe(15);
        expect(b.read('RCO')).toBe('0');
        b.set('ENT', H);
        expect(b.read('RCO')).toBe('1');
      });
    });

  it('74LS161: /CLR low clears at once, regardless of clock, load or enables', () => {
    const b = counterBench('74LS161');
    preset(b, 12);
    b.set('/LOAD', L);
    b.set('CLK', L);
    b.set('/CLR', L);
    expect(countOf(b)).toBe(0);
    clockIn(b, 'CLK');
    expect(countOf(b)).toBe(0);
  });

  it('74LS163: /CLR low clears on the next clock edge, regardless of the enables', () => {
    const b = counterBench('74LS163');
    preset(b, 12);
    b.set('CLK', L);
    b.set('ENP', L);
    b.set('ENT', L);
    b.set('/CLR', L);
    expect(countOf(b)).toBe(12);
    b.set('CLK', H);
    expect(countOf(b)).toBe(0);
  });
});

describe('74LS164 shift order (TI SDLS061: data shifts from QA toward QH)', () => {
  it('moves one high bit from QA to QH, one stage per edge', () => {
    const b = bench('74LS164');
    const stages = ['QA', 'QB', 'QC', 'QD', 'QE', 'QF', 'QG', 'QH'];
    b.set('/CLR', L);
    b.set('/CLR', H);
    b.set('A', H);
    b.set('B', H);
    clockIn(b, 'CLK');
    b.set('A', L);
    for (let k = 0; k < 8; k++) {
      expect(stages.map((pin) => b.read(pin)).join(''), `after edge ${k + 1}`).toBe(
        stages.map((_, i) => (i === k ? '1' : '0')).join(''),
      );
      clockIn(b, 'CLK');
    }
  });
});

describe('74LS165 shift order (TI SDLS062D: shifts from QA toward QH; SER enters at A)', () => {
  // H, G, ..., A loaded with distinct levels, so each edge shows the next stage at QH.
  const loaded: Record<string, boolean> = { A: H, B: L, C: H, D: H, E: L, F: L, G: H, H: L };

  function loadedBench(): Bench {
    const b = bench('74LS165');
    for (const [pin, level] of Object.entries(loaded)) b.set(pin, level);
    b.set('SH/LD', L);
    b.set('CLK', H);
    b.set('SH/LD', H);
    return b;
  }

  it('shows H, then G, F, ... A at QH, with /QH its complement, then SER', () => {
    const b = loadedBench();
    b.set('SER', H);
    const seen: string[] = [];
    for (const stage of ['H', 'G', 'F', 'E', 'D', 'C', 'B', 'A', 'SER']) {
      const want = stage === 'SER' ? '1' : loaded[stage] ? '1' : '0';
      expect(b.read('QH'), `QH showing ${stage}`).toBe(want);
      expect(b.read('/QH'), `/QH showing ${stage}`).toBe(want === '1' ? '0' : '1');
      seen.push(b.read('QH'));
      clockIn(b, 'CLK');
    }
    expect(seen.join('')).toBe('010011011');
  });

  // The sheet allows CLK INH to rise only while CLK is high: with CLK low that rise is an edge.
  it('holds the register while CLK INH is high', () => {
    const b = loadedBench();
    b.set('CLK INH', H);
    for (let i = 0; i < 3; i++) clockIn(b, 'CLK');
    expect(b.read('QH')).toBe('0');
    b.set('CLK INH', L);
    clockIn(b, 'CLK');
    expect(b.read('QH')).toBe('1');
  });
});
