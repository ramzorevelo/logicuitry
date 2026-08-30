// STA slack report card: combinational totals for the shown path plus the
// sequential inequalities rendered symbol-by-symbol with real numbers
// substituted. Pure over props; M7 lesson 6 reuses the inequality rendering.

import type { PathTiming, SeqPathTiming, SequentialTiming } from '../../core/timing/sta';
import { formatTimePs } from '../../render/waveform';

const short = (path: string) => (path.startsWith('main/') ? path.slice(5) : path);

/** Bare ns figure for the inequality terms (units stated once in the header). */
const ns = (ps: number) => String(Math.round(ps / 100) / 10);

/** `Tc >= t_pcq + t_pd + t_setup + skew: 40 >= 25 + 62 + 20 + 0  ✗` */
export function SetupInequality({ p }: { p: SeqPathTiming }) {
  const ok = p.setupSlackPs >= 0;
  const f = ns;
  return (
    <div className={`sta-ineq${ok ? '' : ' sta-ineq--fail'}`}>
      <span className="sta-ineq__sym">
        T<sub>c</sub> ≥ t<sub>pcq</sub> + t<sub>pd</sub> + t<sub>setup</sub> + skew:
      </span>{' '}
      {f(p.clockPeriodPs)} ≥ {f(p.tpcqPs)} + {f(p.tpdCombPs)} + {f(p.tsetupPs)} + {f(p.skewPs)}
      {'  '}
      {ok ? '✓' : '✗'}
    </div>
  );
}

export function HoldInequality({ p }: { p: SeqPathTiming }) {
  const ok = p.holdMarginPs >= 0;
  const f = ns;
  return (
    <div className={`sta-ineq${ok ? '' : ' sta-ineq--fail'}`}>
      <span className="sta-ineq__sym">
        t<sub>ccq</sub> + t<sub>cd</sub> ≥ t<sub>hold</sub> + skew:
      </span>{' '}
      {f(p.tccqPs)} + {f(p.tcdCombPs)} ≥ {f(p.tholdPs)} + {f(p.skewPs)}
      {'  '}
      {ok ? '✓' : '✗'}
    </div>
  );
}

export function StaCard(props: {
  path: PathTiming;
  sequential: SequentialTiming | null;
  onClose: () => void;
}) {
  const { path, sequential } = props;
  return (
    <div className="sta-card">
      <div className="sta-card__head">
        <span>
          Critical path {short(path.startpoint)} → {short(path.endpoint)}
        </span>
        <button type="button" className="tool-btn" onClick={props.onClose}>
          ×
        </button>
      </div>
      <div>
        t<sub>pd</sub> = {path.critical.map((h) => formatTimePs(h.tpdPs)).join(' + ') || '0'} ={' '}
        <strong>{formatTimePs(path.totalTpdPs)}</strong>
      </div>
      <div className="sta-card__muted">
        t<sub>cd</sub> (short, {short(path.shortStartpoint)}) ={' '}
        {path.short.length > 1 && (
          <>{path.short.map((h) => formatTimePs(h.tcdPs)).join(' + ')} = </>
        )}
        <strong>{formatTimePs(path.totalTcdPs)}</strong>
        {path.estimated && ' · t_cd estimated (0.35 × t_pd typ)'}
      </div>
      {sequential && (
        <div className="sta-card__seq">
          <div className="sta-card__muted">sequential paths: inequality figures in ns</div>
          {sequential.minPeriodPs !== null && (
            <div>
              min clock period = <strong>{formatTimePs(sequential.minPeriodPs)}</strong>
              {sequential.multiDomain && ' · multiple clock domains: cross-domain paths skipped'}
            </div>
          )}
          {sequential.paths.map((p, i) => (
            <div key={i} className="sta-card__seqpath">
              <div className="sta-card__muted">
                {short(p.launch)} → {short(p.capture)} · slack {formatTimePs(p.setupSlackPs)} · hold
                margin {formatTimePs(p.holdMarginPs)}
              </div>
              <SetupInequality p={p} />
              <HoldInequality p={p} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
