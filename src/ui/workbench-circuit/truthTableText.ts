import type { TruthTable } from '../../core/boolean/truthTable';
import type { TableModel } from '../../render/truthTable';
import { bitChar } from './analyzeLogic';

export type { TableModel };

/** Same headings and cells as the drawer's full table: inputs as the row-index
 *  bits MSB-first, outputs through bitChar ('–' for an unknown X/Z cell). */
export function truthTableModel(
  table: TruthTable,
  labelOf: (path: string) => string,
  dontCares?: ReadonlySet<number>,
): TableModel {
  const n = table.inputPaths.length;
  return {
    headings: [...table.inputPaths, ...table.outputPaths].map(labelOf),
    inputCount: n,
    rows: table.rows.map((_, r) => [
      ...table.inputPaths.map((_p, i) => String((r >> (n - 1 - i)) & 1)),
      ...table.outputPaths.map((_p, o) => bitChar(table, r, o, dontCares)),
    ]),
  };
}

const allRows = (m: TableModel): string[][] => [m.headings, ...m.rows];

export function tableToTsv(m: TableModel): string {
  return allRows(m)
    .map((r) => r.map((c) => c.replace(/[\t\r\n]+/g, ' ')).join('\t'))
    .join('\n');
}

// A leading = + @ makes a spreadsheet read the cell as a formula.
const FORMULA_LEAD = /^[=+@]/;

const csvCell = (raw: string): string => {
  const c = FORMULA_LEAD.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c;
};

/** With a byte-order mark: without one Excel reads UTF-8 as ANSI and garbles the unknown-cell dash. */
export function tableToCsv(m: TableModel): string {
  const body = allRows(m)
    .map((r) => r.map(csvCell).join(','))
    .join('\r\n');
  return `﻿${body}`;
}

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const CELL_STYLE = 'border:1px solid #000;padding:2px 8px;text-align:center';

export function tableToHtml(m: TableModel): string {
  const row = (cells: string[], tag: 'th' | 'td'): string =>
    `<tr>${cells.map((c) => `<${tag} style="${CELL_STYLE}">${escapeHtml(c)}</${tag}>`).join('')}</tr>`;
  return (
    '<table style="border-collapse:collapse;border:1px solid #000">' +
    `<thead>${row(m.headings, 'th')}</thead>` +
    `<tbody>${m.rows.map((r) => row(r, 'td')).join('')}</tbody>` +
    '</table>'
  );
}
