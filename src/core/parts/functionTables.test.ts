// Each table below is transcribed from the datasheet named in its `source`,
// row by row, and never derived from the primitive it checks. H and L are the
// datasheet's levels; X is its "irrelevant", run here at both levels.

import { describe, expect, it } from 'vitest';
import { getPrimitive } from '../sim/primitives/registry';
import * as bv from '../value/busValue';
import { partCore } from './packages';
import { run } from './testHarness';

interface FunctionTable {
  part: string;
  source: string;
  /** Core pin per column, inputs then outputs, in the datasheet's column order. */
  inputs: string[];
  outputs: string[];
  /** `inputs | outputs`, one level per column. */
  rows: string[];
  /** Package pin names per column, one entry per section the table covers. */
  dip: { inputs: string[]; outputs: string[] }[];
  /** For a table that reads fewer outputs than the core has (each half of the '283 reads three of five). */
  readsSubsetOfOutputs?: true;
  /** Rows to run through the DIP when the full set is too many boards to build. */
  dipRows?: string[];
}

function expandIrrelevant(levels: string[]): string[][] {
  const at = levels.indexOf('X');
  if (at < 0) return [levels];
  return ['H', 'L'].flatMap((level) =>
    expandIrrelevant([...levels.slice(0, at), level, ...levels.slice(at + 1)]),
  );
}

function evaluateCore(part: string, levels: Record<string, string>): Record<string, string> {
  const core = partCore(part)!;
  const spec = getPrimitive(core.kind);
  const pins = spec.pins(core.params ?? {});
  const inputs = pins
    .filter((p) => p.dir === 'in')
    .map((p) => {
      const level = levels[p.name];
      if (level === undefined) throw new Error(`${part}: table leaves input ${p.name} undriven`);
      return bv.known(level === 'H' ? 1 : 0, 1);
    });
  const result = spec.evaluate({
    params: core.params ?? {},
    state: undefined,
    inputs,
    prevInputs: inputs,
    time: 0,
  });
  const out: Record<string, string> = {};
  pins
    .filter((p) => p.dir === 'out')
    .forEach((p, i) => {
      const level = bv.toString(result.outputs[i]!, 1);
      if (level !== '0' && level !== '1')
        throw new Error(`${part}: output ${p.name} is ${level}, not a driven level`);
      out[p.name] = level === '1' ? 'H' : 'L';
    });
  return out;
}

function check(table: FunctionTable): void {
  for (const row of table.rows) {
    const [ins, outs] = row.split('|').map((side) => side.trim().split(/\s+/)) as [
      string[],
      string[],
    ];
    expect(ins.length, `${table.part} row "${row}"`).toBe(table.inputs.length);
    expect(outs.length, `${table.part} row "${row}"`).toBe(table.outputs.length);
    for (const levels of expandIrrelevant(ins)) {
      const got = evaluateCore(
        table.part,
        Object.fromEntries(table.inputs.map((pin, i) => [pin, levels[i]!])),
      );
      expect(
        table.outputs.map((pin) => got[pin]),
        `${table.part} ${levels.join(' ')}`,
      ).toEqual(outs);
    }
  }
}

// The core run above expands every irrelevant input both ways; a DIP run builds
// a board per row, so it samples four fills instead: all H, all L and the two
// alternations. A pin wired to the wrong core input still fails on one of them.
function fillIrrelevant(levels: string[]): string[][] {
  return [0, 1, 2, 3].map((variant) =>
    levels.map((level, i) => {
      if (level !== 'X') return level;
      if (variant < 2) return variant === 0 ? 'H' : 'L';
      return i % 2 === variant % 2 ? 'H' : 'L';
    }),
  );
}

/** The same table through the generated DIP, by the pin names the datasheet prints. */
function checkDip(table: FunctionTable): void {
  expect(table.dip.length, table.part).toBeGreaterThan(0);
  for (const section of table.dip) {
    expect(section.inputs.length, table.part).toBe(table.inputs.length);
    expect(section.outputs.length, table.part).toBe(table.outputs.length);
    for (const row of table.dipRows ?? table.rows) {
      const [ins, outs] = row.split('|').map((side) => side.trim().split(/\s+/)) as [
        string[],
        string[],
      ];
      for (const levels of fillIrrelevant(ins)) {
        const read = run(table.part, {
          VCC: true,
          GND: false,
          ...Object.fromEntries(section.inputs.map((pin, i) => [pin, levels[i] === 'H'])),
        });
        const got = section.outputs.map((pin) => {
          const level = read(pin);
          if (level !== '0' && level !== '1')
            throw new Error(`${table.part} ${pin} is ${level} for ${levels.join(' ')}`);
          return level === '1' ? 'H' : 'L';
        });
        expect(got, `${table.part} DIP ${section.inputs.join(',')} ${levels.join(' ')}`).toEqual(
          outs,
        );
      }
    }
  }
}

const Y8 = ['y0', 'y1', 'y2', 'y3', 'y4', 'y5', 'y6', 'y7'];

// The datasheet prints one G2 column with the note G2 = G2A + G2B: G2 is H
// when either pin is high. Its G2 = H row is the two rows 1 and 2 here.
const LS138: FunctionTable = {
  part: '74LS138',
  source: "TI SDLS014, December 1972, revised March 1988, 'LS138 function table",
  inputs: ['enh0', 'enl0', 'enl1', 'a2', 'a1', 'a0'],
  outputs: Y8,
  rows: [
    'X H X X X X | H H H H H H H H',
    'X X H X X X | H H H H H H H H',
    'L X X X X X | H H H H H H H H',
    'H L L L L L | L H H H H H H H',
    'H L L L L H | H L H H H H H H',
    'H L L L H L | H H L H H H H H',
    'H L L L H H | H H H L H H H H',
    'H L L H L L | H H H H L H H H',
    'H L L H L H | H H H H H L H H',
    'H L L H H L | H H H H H H L H',
    'H L L H H H | H H H H H H H L',
  ],
  dip: [
    {
      inputs: ['G1', '/G2A', '/G2B', 'C', 'B', 'A'],
      outputs: ['/Y0', '/Y1', '/Y2', '/Y3', '/Y4', '/Y5', '/Y6', '/Y7'],
    },
  ],
};

const LS139: FunctionTable = {
  part: '74LS139',
  source: 'TI SDLS013A, December 1972, revised March 1988, function table (one section)',
  inputs: ['enl0', 'a1', 'a0'],
  outputs: ['y0', 'y1', 'y2', 'y3'],
  rows: [
    'H X X | H H H H',
    'L L L | L H H H',
    'L L H | H L H H',
    'L H L | H H L H',
    'L H H | H H H L',
  ],
  dip: [1, 2].map((n) => ({
    inputs: [`/${n}G`, `${n}B`, `${n}A`],
    outputs: [0, 1, 2, 3].map((y) => `/${n}Y${y}`),
  })),
};

const LS148: FunctionTable = {
  part: '74LS148',
  source: "TI SDLS053B, October 1976, revised May 2004, function table '148, 'LS148",
  inputs: ['ei', 'i0', 'i1', 'i2', 'i3', 'i4', 'i5', 'i6', 'i7'],
  outputs: ['a2', 'a1', 'a0', 'gs', 'eo'],
  rows: [
    'H X X X X X X X X | H H H H H',
    'L H H H H H H H H | H H H H L',
    'L X X X X X X X L | L L L L H',
    'L X X X X X X L H | L L H L H',
    'L X X X X X L H H | L H L L H',
    'L X X X X L H H H | L H H L H',
    'L X X X L H H H H | H L L L H',
    'L X X L H H H H H | H L H L H',
    'L X L H H H H H H | H H L L H',
    'L L H H H H H H H | H H H L H',
  ],
  dip: [
    {
      inputs: ['/EI', '/0', '/1', '/2', '/3', '/4', '/5', '/6', '/7'],
      outputs: ['/A2', '/A1', '/A0', '/GS', '/EO'],
    },
  ],
};

// The datasheet's output columns read D0..D7 and their complements: Y is the
// level of the selected D input, W its complement. Written out for both levels.
const LS151_SELECT = ['L L L', 'L L H', 'L H L', 'L H H', 'H L L', 'H L H', 'H H L', 'H H H'];
const LS151: FunctionTable = {
  part: '74LS151',
  source: "TI SDLS054, December 1972, revised March 1988, function table '151A, 'LS151, 'S151",
  inputs: ['s2', 's1', 's0', 'en', 'd0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'],
  outputs: ['y', 'w'],
  rows: [
    'X X X H X X X X X X X X | L H',
    ...LS151_SELECT.flatMap((select, n) =>
      ['L', 'H'].map((level) => {
        const data = Array.from({ length: 8 }, (_, i) => (i === n ? level : 'X')).join(' ');
        return `${select} L ${data} | ${level} ${level === 'H' ? 'L' : 'H'}`;
      }),
    ),
  ],
  dip: [
    {
      inputs: ['C', 'B', 'A', '/G', 'D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7'],
      outputs: ['Y', 'W'],
    },
  ],
};

const LS153: FunctionTable = {
  part: '74LS153',
  source: 'TI SDLS055A, December 1972, revised May 2007, function table (one section)',
  inputs: ['s1', 's0', 'd0', 'd1', 'd2', 'd3', 'en'],
  outputs: ['y'],
  rows: [
    'X X X X X X H | L',
    'L L L X X X L | L',
    'L L H X X X L | H',
    'L H X L X X L | L',
    'L H X H X X L | H',
    'H L X X L X L | L',
    'H L X X H X L | H',
    'H H X X X L L | L',
    'H H X X X H L | H',
  ],
  dip: [1, 2].map((n) => ({
    inputs: ['B', 'A', `${n}C0`, `${n}C1`, `${n}C2`, `${n}C3`, `/${n}G`],
    outputs: [`${n}Y`],
  })),
};

const Y16 = Array.from({ length: 16 }, (_, i) => `y${i}`);
const selected = (n: number) => Y16.map((_, i) => (i === n ? 'L' : 'H')).join(' ');
const LS154: FunctionTable = {
  part: '74LS154',
  source: 'National DM74LS154 TL/F/6394, May 1989, function table (G1 and G2 are the strobes)',
  inputs: ['enl0', 'enl1', 'a3', 'a2', 'a1', 'a0'],
  outputs: Y16,
  rows: [
    `L L L L L L | ${selected(0)}`,
    `L L L L L H | ${selected(1)}`,
    `L L L L H L | ${selected(2)}`,
    `L L L L H H | ${selected(3)}`,
    `L L L H L L | ${selected(4)}`,
    `L L L H L H | ${selected(5)}`,
    `L L L H H L | ${selected(6)}`,
    `L L L H H H | ${selected(7)}`,
    `L L H L L L | ${selected(8)}`,
    `L L H L L H | ${selected(9)}`,
    `L L H L H L | ${selected(10)}`,
    `L L H L H H | ${selected(11)}`,
    `L L H H L L | ${selected(12)}`,
    `L L H H L H | ${selected(13)}`,
    `L L H H H L | ${selected(14)}`,
    `L L H H H H | ${selected(15)}`,
    `L H X X X X | ${selected(-1)}`,
    `H L X X X X | ${selected(-1)}`,
    `H H X X X X | ${selected(-1)}`,
  ],
  dip: [
    {
      inputs: ['/G1', '/G2', 'D', 'C', 'B', 'A'],
      outputs: Y16.map((_, i) => `/Y${i}`),
    },
  ],
};

// Columns: strobe, select (A/B), A, B. Select low passes A, high passes B.
const LS157: FunctionTable = {
  part: '74LS157',
  source: "TI SDLS058, March 1974, revised March 1988, function table, '157/'LS157/'S157 column",
  inputs: ['en', 's0', 'd0', 'd1'],
  outputs: ['y'],
  rows: ['H X X X | L', 'L L L X | L', 'L L H X | H', 'L H X L | L', 'L H X H | H'],
  dip: [1, 2, 3, 4].map((n) => ({
    inputs: ['/G', 'A/B', `${n}A`, `${n}B`],
    outputs: [`${n}Y`],
  })),
};

// `A1 B1 A2 B2 | sums and carry when C0 = L | when C0 = H`. The datasheet reads
// the same rows a second time as A3 B3 A4 B4 with the internal carry C2 in
// place of C0, giving S3, S4 and C4.
const LS283_HALF_ADDER_ROWS = [
  'L L L L | L L L | H L L',
  'H L L L | H L L | L H L',
  'L H L L | H L L | L H L',
  'H H L L | L H L | H H L',
  'L L H L | L H L | H H L',
  'H L H L | H H L | L L H',
  'L H H L | H H L | L L H',
  'H H H L | L L H | H L H',
  'L L L H | L H L | H H L',
  'H L L H | H H L | L L H',
  'L H L H | H H L | L L H',
  'H H L H | L L H | H L H',
  'L L H H | L L H | H L H',
  'H L H H | H L H | L H H',
  'L H H H | H L H | L H H',
  'H H H H | L H H | H H H',
];
const ls283Rows = (place: (pairs: string, carryIn: 'L' | 'H') => string): string[] =>
  LS283_HALF_ADDER_ROWS.flatMap((row) => {
    const [pairs, whenLow, whenHigh] = row.split('|').map((side) => side.trim()) as [
      string,
      string,
      string,
    ];
    return [`${place(pairs, 'L')} | ${whenLow}`, `${place(pairs, 'H')} | ${whenHigh}`];
  });
const LS283_SOURCE = "TI SDLS095A, October 1976, revised March 1988, function table '283, 'LS283";
const LS283_INPUTS = ['a0', 'b0', 'a1', 'b1', 'a2', 'b2', 'a3', 'b3', 'cin'];
const LS283_DIP_INPUTS = ['A1', 'B1', 'A2', 'B2', 'A3', 'B3', 'A4', 'B4', 'C0'];

// C2 is internal, so it shows on S3 with A3, B3, A4 and B4 low.
const LS283_LOW: FunctionTable = {
  part: '74LS283',
  source: `${LS283_SOURCE}, bits 1 and 2`,
  inputs: LS283_INPUTS,
  outputs: ['sum0', 'sum1', 'sum2'],
  rows: ls283Rows((pairs, carryIn) => `${pairs} L L L L ${carryIn}`),
  dip: [{ inputs: LS283_DIP_INPUTS, outputs: ['S1', 'S2', 'S3'] }],
  readsSubsetOfOutputs: true,
};

// C2 is set from bits 1 and 2: both A2 and B2 high generate it, all low leave it low.
const LS283_HIGH: FunctionTable = {
  part: '74LS283',
  source: `${LS283_SOURCE}, bits 3 and 4`,
  inputs: LS283_INPUTS,
  outputs: ['sum2', 'sum3', 'cout'],
  rows: ls283Rows((pairs, carryIn) => `L L ${carryIn} ${carryIn} ${pairs} L`),
  dip: [{ inputs: LS283_DIP_INPUTS, outputs: ['S3', 'S4', 'C4'] }],
  readsSubsetOfOutputs: true,
};

// Each comparing column is A against B: '>' is A high and B low, '<' the
// reverse, '=' either equal pair. Cascade columns are A>B, A<B, A=B, and the
// outputs follow the same order.
const LS85_ROWS: [string, string, string, string, string][] = [
  ['>', 'X', 'X', 'X', 'X X X | H L L'],
  ['<', 'X', 'X', 'X', 'X X X | L H L'],
  ['=', '>', 'X', 'X', 'X X X | H L L'],
  ['=', '<', 'X', 'X', 'X X X | L H L'],
  ['=', '=', '>', 'X', 'X X X | H L L'],
  ['=', '=', '<', 'X', 'X X X | L H L'],
  ['=', '=', '=', '>', 'X X X | H L L'],
  ['=', '=', '=', '<', 'X X X | L H L'],
  ['=', '=', '=', '=', 'H L L | H L L'],
  ['=', '=', '=', '=', 'L H L | L H L'],
  ['=', '=', '=', '=', 'X X H | L L H'],
  ['=', '=', '=', '=', 'H H L | L L L'],
  ['=', '=', '=', '=', 'L L L | H H L'],
];
const comparedPair = (symbol: string): string[] =>
  symbol === '>' ? ['H L'] : symbol === '<' ? ['L H'] : symbol === 'X' ? ['X X'] : ['H H', 'L L'];
const LS85: FunctionTable = {
  part: '74LS85',
  source: "TI SDLS123, March 1974, revised March 1988, function table '85, 'LS85, 'S85",
  inputs: ['a3', 'b3', 'a2', 'b2', 'a1', 'b1', 'a0', 'b0', 'igt', 'ilt', 'ieq'],
  outputs: ['gt', 'lt', 'eq'],
  rows: LS85_ROWS.flatMap(([c3, c2, c1, c0, rest]) => {
    const [cascade, outs] = rest.split('|') as [string, string];
    const words = [c3, c2, c1, c0]
      .map(comparedPair)
      .reduce<
        string[]
      >((acc, options) => acc.flatMap((prefix) => options.map((o) => `${prefix} ${o}`.trim())), ['']);
    return words.map((word) => `${word} ${cascade.trim()} | ${outs.trim()}`);
  }),
  dip: [
    {
      inputs: ['A3', 'B3', 'A2', 'B2', 'A1', 'B1', 'A0', 'B0', 'A>Bin', 'A<Bin', 'A=Bin'],
      outputs: ['A>Bout', 'A<Bout', 'A=Bout'],
    },
  ],
};

// The datasheet's table is by count of high inputs. Parity is symmetric, so the
// DIP rows catch a pin left off the core but not two swapped data pins.
const parityRow = (bits: number): string => {
  const levels = Array.from({ length: 9 }, (_, i) => ((bits >> i) & 1 ? 'H' : 'L'));
  const high = levels.filter((level) => level === 'H').length;
  return `${levels.join(' ')} | ${high % 2 === 0 ? 'H L' : 'L H'}`;
};
const lowestK = (k: number) => (1 << k) - 1;
const highestK = (k: number) => lowestK(k) << (9 - k);
const SPREAD_ORDER = [0, 2, 4, 6, 8, 1, 3, 5, 7];
const spread = (k: number) => SPREAD_ORDER.slice(0, k).reduce((bits, i) => bits | (1 << i), 0);
const LS280: FunctionTable = {
  part: '74LS280',
  source: "TI SDLS152, December 1972, revised March 1988, function table '280, 'LS280",
  inputs: ['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8'],
  outputs: ['even', 'odd'],
  rows: Array.from({ length: 512 }, (_, bits) => parityRow(bits)),
  dipRows: [
    ...new Set(Array.from({ length: 10 }, (_, k) => [lowestK(k), highestK(k), spread(k)]).flat()),
  ].map(parityRow),
  dip: [
    {
      inputs: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'],
      outputs: ['EVEN', 'ODD'],
    },
  ],
};

const ALL_TABLES = [
  LS138,
  LS139,
  LS148,
  LS151,
  LS153,
  LS154,
  LS157,
  LS283_LOW,
  LS283_HIGH,
  LS85,
  LS280,
];

describe('datasheet function tables', () => {
  for (const table of ALL_TABLES) {
    it(`${table.part} matches its table (${table.source})`, () => {
      expect(partCore(table.part), table.part).toBeDefined();
      check(table);
    });
  }

  for (const table of ALL_TABLES) {
    it(`${table.part} DIP matches its table through the package pins (${table.source})`, () => {
      checkDip(table);
    });
  }

  it('each table drives every input of its core and reads only pins it has', () => {
    for (const table of ALL_TABLES) {
      const core = partCore(table.part)!;
      const pins = getPrimitive(core.kind).pins(core.params ?? {});
      const names = (dir: string) => pins.filter((p) => p.dir === dir).map((p) => p.name);
      expect([...table.inputs].sort(), table.part).toEqual(names('in').sort());
      if (table.readsSubsetOfOutputs) {
        for (const pin of table.outputs) expect(names('out'), table.part).toContain(pin);
      } else {
        expect([...table.outputs].sort(), table.part).toEqual(names('out').sort());
      }
      for (const p of pins) expect(p.width, `${table.part} ${p.name}`).toBe(1);
    }
  });

  it('the 74LS283 adds every a, b and carry-in word, on the core and on sampled DIP words', () => {
    const level = (bit: number) => (bit ? 'H' : 'L');
    const driven = (a: number, b: number, cin: number) =>
      Object.fromEntries([
        ...[0, 1, 2, 3].flatMap((i) => [
          [`a${i}`, level((a >> i) & 1)],
          [`b${i}`, level((b >> i) & 1)],
        ]),
        ['cin', level(cin)],
      ]);
    for (let a = 0; a < 16; a++) {
      for (let b = 0; b < 16; b++) {
        for (const cin of [0, 1]) {
          const total = a + b + cin;
          const got = evaluateCore('74LS283', driven(a, b, cin));
          const word = [0, 1, 2, 3].map((i) => got[`sum${i}`]);
          expect(word, `${a}+${b}+${cin}`).toEqual(
            [0, 1, 2, 3].map((i) => level((total >> i) & 1)),
          );
          expect(got['cout'], `${a}+${b}+${cin} carry`).toBe(level(total >> 4));
        }
      }
    }
    for (const [a, b, cin] of [
      [0, 0, 0],
      [15, 15, 1],
      [9, 7, 0],
      [5, 10, 1],
      [8, 8, 0],
      [1, 14, 1],
    ] as const) {
      const total = a + b + cin;
      const read = run('74LS283', {
        VCC: true,
        GND: false,
        ...Object.fromEntries(
          [1, 2, 3, 4].flatMap((n) => [
            [`A${n}`, ((a >> (n - 1)) & 1) === 1],
            [`B${n}`, ((b >> (n - 1)) & 1) === 1],
          ]),
        ),
        C0: cin === 1,
      });
      const sums = [1, 2, 3, 4].map((n) => read(`S${n}`));
      expect(sums, `DIP ${a}+${b}+${cin}`).toEqual(
        [0, 1, 2, 3].map((i) => String((total >> i) & 1)),
      );
      expect(read('C4'), `DIP ${a}+${b}+${cin} carry`).toBe(String(total >> 4));
    }
  });
});
