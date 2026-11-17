import { describe, expect, it } from 'vitest';
import type { TruthTable } from '../../core/boolean/truthTable';
import { tableToCsv, tableToHtml, tableToTsv, truthTableModel } from './truthTableText';

const k = (b: 0 | 1) => ({ v: b, x: 0, z: 0 });
const X = { v: 0, x: 1, z: 0 };
const Z = { v: 0, x: 0, z: 1 };

const table: TruthTable = {
  inputPaths: ['main/A.y', 'main/B.y'],
  outputPaths: ['main/F.a', 'main/G.a'],
  rows: [
    [k(0), X],
    [k(1), Z],
    [k(1), k(0)],
    [k(0), k(1)],
  ],
};
const label = (p: string) => p.split('/')[1]!.split('.')[0]!;

describe('truthTableModel', () => {
  const m = truthTableModel(table, label);

  it('splits inputs from outputs and labels headings', () => {
    expect(m.headings).toEqual(['A', 'B', 'F', 'G']);
    expect(m.inputCount).toBe(2);
  });

  it('counts inputs MSB-first, first input leftmost', () => {
    expect(m.rows.map((r) => r.slice(0, 2).join(''))).toEqual(['00', '01', '10', '11']);
  });

  it('prints X and Z outputs as the drawer does', () => {
    expect(m.rows[0]).toEqual(['0', '0', '0', '–']);
    expect(m.rows[1]![3]).toBe('–');
    expect(m.rows[2]!.slice(2)).toEqual(['1', '0']);
  });
});

describe('exports', () => {
  const m = {
    headings: ['A,1', 'Q"x"', '<Y&>'],
    inputCount: 2,
    rows: [['0', '1', '–']],
  };

  it('writes TSV with a header row', () => {
    expect(tableToTsv({ ...m, headings: ['A', 'B', 'Y'] })).toBe('A\tB\tY\n0\t1\t–');
  });

  it('quotes CSV fields per RFC 4180 with CRLF', () => {
    expect(tableToCsv(m)).toBe('﻿"A,1","Q""x""",<Y&>\r\n0,1,–');
  });

  it('escapes HTML in every cell', () => {
    const html = tableToHtml(m);
    expect(html).toContain('&lt;Y&amp;&gt;');
    expect(html).toContain('Q&quot;x&quot;');
    expect(html).not.toContain('<Y');
    expect(html).toContain('<thead>');
    expect(html).toContain('<tbody>');
    expect(html).not.toMatch(/https?:/);
  });
});

describe('tableToCsv formula guard', () => {
  it('keeps a label that starts like a formula as text', () => {
    const m = { headings: ['=SUM', '+A', '@B', 'C'], inputCount: 3, rows: [['0', '1', '0', '1']] };
    expect(tableToCsv(m).split('\r\n')[0]).toBe("\uFEFF'=SUM,'+A,'@B,C");
  });
});
