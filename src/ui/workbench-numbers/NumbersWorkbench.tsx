import type { ConvertDir, Interpretation, Operator } from '../../core/numkit/types';
import './numbers.css';
import { ConvertTab, FAMILIES } from './ConvertTab';
import { ComputeTab, OPS } from './ComputeTab';
import { useNumbersStore, WIDTHS, type BitWidth, type NumbersTab } from './numbersStore';
import { useCompact } from '../compact';

const TABS: { id: NumbersTab; label: string }[] = [
  { id: 'convert', label: 'Convert' },
  { id: 'compute', label: 'Compute' },
];

export function NumbersWorkbench() {
  const { tab, width, interp, convertDir, operator, hideAnswers } = useNumbersStore();
  const setTab = useNumbersStore((s) => s.setTab);
  const setWidth = useNumbersStore((s) => s.setWidth);
  const setInterp = useNumbersStore((s) => s.setInterp);
  const setConvertDir = useNumbersStore((s) => s.setConvertDir);
  const setOperator = useNumbersStore((s) => s.setOperator);
  const toggleHideAnswers = useNumbersStore((s) => s.toggleHideAnswers);
  const compact = useCompact();

  return (
    <div className="numbers-workbench">
      <div className="numbers-workbench__bar">
        <div className="segmented">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={tab === t.id}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <label className="field">
          width
          <select
            className="select"
            value={width}
            onChange={(e) => setWidth(Number(e.target.value) as BitWidth)}
          >
            {WIDTHS.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        </label>

        <div className="segmented">
          {(['unsigned', 'twos'] as Interpretation[]).map((i) => (
            <button key={i} type="button" aria-pressed={interp === i} onClick={() => setInterp(i)}>
              {i === 'twos' ? "two's" : 'unsigned'}
            </button>
          ))}
        </div>

        {tab === 'convert' ? (
          <>
            <label className="field">
              direction
              <select
                className="select"
                value={convertDir}
                onChange={(e) => setConvertDir(e.target.value as ConvertDir)}
              >
                {FAMILIES.map((f) => (
                  <optgroup key={f.label} label={f.label}>
                    {f.dirs.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <button type="button" aria-pressed={hideAnswers} onClick={toggleHideAnswers}>
              Hide answers
            </button>
            {/* Keys, so only where there is a keyboard: on a phone this named
                three shortcuts that do not exist, and the Convert tab shows
                Step / Reveal / Reset buttons there instead. */}
            {compact ? null : <span className="hint">Space step · Enter reveal · R reset</span>}
          </>
        ) : (
          <label className="field">
            operator
            <select
              className="select"
              value={operator}
              onChange={(e) => setOperator(e.target.value as Operator)}
            >
              {OPS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="numbers-workbench__body">
        {tab === 'convert' ? <ConvertTab /> : <ComputeTab />}
      </div>
    </div>
  );
}
