import { useMemo, useState } from 'react';
import { bomOf, bomTable } from '../../core/parts/bom';
import { exportFileName } from '../../io/exportName';
import { saveBlob } from '../../io/fsAccess';
import { useCompact } from '../compact';
import { useLessonOpen } from './ChallengePanel';
import { useCircuitStore } from './circuitStore';
import { gateLabel, optionLabel, packingSummary, problemsLine } from './partsView';
import { tableToCsv, tableToTsv } from './truthTableText';

const CSV = { description: 'CSV spreadsheet', mime: 'text/csv', ext: 'csv' };

interface Status {
  text: string;
  error: boolean;
}

export function PartsPanel({ viewOnly }: { viewOnly: boolean }) {
  const board = useCircuitStore((s) => s.board);
  const chipLib = useCircuitStore((s) => s.chipLib);
  const lessonOpen = useLessonOpen();
  const compact = useCompact();
  const [status, setStatus] = useState<Status | null>(null);
  const bom = useMemo(() => bomOf(board, chipLib, board.partChoices), [board, chipLib]);
  const canChoose = !viewOnly && !lessonOpen;
  const problem = problemsLine(bom.problems);
  const empty = bom.packages.length + bom.generic.length + bom.looseGates.length === 0;

  const copy = () => {
    const text = tableToTsv(bomTable(bom));
    navigator.clipboard.writeText(text).then(
      () =>
        setStatus({ text: 'Copied. Paste it into a spreadsheet or your report.', error: false }),
      () =>
        setStatus({ text: 'The clipboard refused the text. Use Save CSV instead.', error: true }),
    );
  };

  const save = async () => {
    const name = exportFileName(board.name, 'parts', 'csv');
    try {
      const blob = new Blob([tableToCsv(bomTable(bom))], { type: CSV.mime });
      if (await saveBlob(blob, name, CSV)) setStatus({ text: `Saved ${name}`, error: false });
    } catch (e) {
      setStatus({ text: e instanceof Error ? e.message : String(e), error: true });
    }
  };

  return (
    <div className="parts-panel">
      {empty && <div className="wave-panel__empty">No parts yet.</div>}
      {problem && (
        <div className="parts-panel__problem" role="alert">
          {problem}
        </div>
      )}
      {bom.packages.length > 0 && (
        <section>
          <h3 className="checks-panel__group">Packages</h3>
          <table className="parts-panel__table">
            <thead>
              <tr>
                <th>Part</th>
                {!compact && <th>Description</th>}
                <th className="parts-panel__num">Qty</th>
                {!compact && <th>Where</th>}
              </tr>
            </thead>
            <tbody>
              {bom.packages.map((p) => (
                <tr key={p.part}>
                  <td className="parts-panel__part">
                    {p.part}
                    {compact && <span className="parts-panel__sub">{p.caption}</span>}
                  </td>
                  {!compact && <td>{p.caption}</td>}
                  <td className="parts-panel__num">{p.qty}</td>
                  {!compact && <td>{p.where.join(', ')}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {bom.generic.length > 0 && (
        <section>
          <h3 className="checks-panel__group">Other parts</h3>
          <table className="parts-panel__table">
            <tbody>
              {bom.generic.map((g) => (
                <tr key={g.key}>
                  <td>{g.caption}</td>
                  <td className="parts-panel__num">{g.qty}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {bom.looseGates.length > 0 && (
        <section>
          <h3 className="checks-panel__group">Loose gates</h3>
          {bom.looseGates.map((g) => (
            <div key={g.key} className="parts-panel__gate">
              <span className="parts-panel__gate-name">
                {gateLabel(g)}
                <span className="parts-panel__sub">
                  {g.count} {g.count === 1 ? 'gate' : 'gates'}
                </span>
              </span>
              {g.options.length === 0 ? (
                <span className="parts-panel__sub">No 74LS package</span>
              ) : (
                <>
                  <select
                    aria-label={`Package for ${gateLabel(g)}`}
                    className="parts-panel__select"
                    disabled={!canChoose}
                    value={g.choice ?? ''}
                    onChange={(e) =>
                      useCircuitStore.getState().setPartChoice(g.key, e.target.value || undefined)
                    }
                  >
                    <option value="">Choose a package</option>
                    {g.options.map((o) => (
                      <option key={o.part} value={o.part}>
                        {optionLabel(o)}
                      </option>
                    ))}
                  </select>
                  {g.choice !== undefined && (
                    <span className="parts-panel__sub">{packingSummary(g)}</span>
                  )}
                </>
              )}
            </div>
          ))}
        </section>
      )}
      {!empty && (
        <div className="parts-panel__foot">
          <span className="parts-panel__total">ICs: {bom.icTotal}</span>
          <span className="parts-panel__sub">Resistors, capacitors and wire are not counted.</span>
          <button type="button" className="tool-btn" onClick={copy}>
            Copy as text
          </button>
          <button type="button" className="tool-btn" onClick={() => void save()}>
            Save CSV
          </button>
          {status && (
            <span
              className={`parts-panel__status${status.error ? ' parts-panel__status--error' : ''}`}
              role={status.error ? 'alert' : 'status'}
            >
              {status.text}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
