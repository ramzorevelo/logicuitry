import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { EecircuitSpiceService } from './spice/EecircuitSpiceService';
import { inverterNetlist } from '../../core/spice/netlists/inverter';
import {
  familyLevels,
  interopMargins,
  marginSteps,
  type FamilyMargins,
  type LevelSet,
} from '../../core/spice/noiseMargins';
import { analyzeVtc } from '../../core/spice/vtcAnalysis';
import type { InverterParams, Region, SweepResult } from '../../core/spice/types';
import { useReferenceDrawer } from '../components/ReferenceDrawer';
import { VtcPlot } from './VtcPlot';
import { NoiseMarginDiagram } from './NoiseMarginDiagram';
import { useCompact } from '../compact';
import './devicelab.css';

type SubTool = 'cmos' | 'ttl';

// Short plain-language notes for the three lines the student actually drives.
function drivenAnnotation(line: string): string | undefined {
  if (line.startsWith('VDD ')) return 'supply rail, VDD slider';
  if (line.startsWith('MP ')) return 'PMOS width scales with the Wp/Wn slider';
  if (line.startsWith('MN ')) return 'NMOS reference width (fixed)';
  if (line.startsWith('.dc ')) return 'DC sweep Vin 0→VDD : this is the plotted curve';
  return undefined;
}

// Debug/provenance drawer: highlight the slider-driven lines, tuck the fixed
// BSIM3 model card behind a collapsed disclosure so it is not ambient noise.
function NetlistDrawerBody({ params }: { params: InverterParams }) {
  const { main, model } = useMemo(() => {
    const lines = inverterNetlist(params).split('\n');
    const mainLines: string[] = [];
    const modelLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('.model') || line.startsWith('+')) modelLines.push(line);
      else mainLines.push(line);
    }
    return { main: mainLines, model: modelLines };
  }, [params]);

  return (
    <div className="netlist-drawer">
      <p className="netlist-drawer__note">
        The highlighted lines are what your sliders change; the rest is fixed device physics.
      </p>
      <ul className="netlist-lines mono">
        {main.map((line, i) => {
          const note = drivenAnnotation(line);
          return (
            <li key={i} className={`netlist-line${note ? ' netlist-line--driven' : ''}`}>
              <code>{line}</code>
              {note && <span className="netlist-line__note">{note}</span>}
            </li>
          );
        })}
      </ul>
      <details className="netlist-model">
        <summary>full model card ({model.length} lines)</summary>
        <pre className="mono">{model.join('\n')}</pre>
      </details>
    </div>
  );
}

function regionRuns(
  vin: number[],
  regions: Region[],
): { region: Region; from: number; to: number }[] {
  const runs: { region: Region; from: number; to: number }[] = [];
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i]!;
    const last = runs[runs.length - 1];
    if (last && last.region === r) last.to = vin[i]!;
    else runs.push({ region: r, from: vin[i]!, to: vin[i]! });
  }
  return runs;
}

function CmosLab({ toolField }: { toolField: ReactNode }) {
  const [vdd, setVdd] = useState(5);
  const [wpwn, setWpwn] = useState(2);
  const [temperature, setTemperature] = useState(25);
  const [sweep, setSweep] = useState<SweepResult | null>(null);
  const ghost = useRef<SweepResult | null>(null);
  // Spawns the ngspice worker lazily on first sweep, i.e. when the CMOS lab opens.
  const spiceRef = useRef<EecircuitSpiceService | null>(null);
  if (!spiceRef.current) spiceRef.current = new EecircuitSpiceService();
  const params: InverterParams = useMemo(
    () => ({ vdd, wpwn, temperature, points: 401 }),
    [vdd, wpwn, temperature],
  );

  useReferenceDrawer(
    useMemo(
      () => ({ label: 'SPICE netlist', body: <NetlistDrawerBody params={params} /> }),
      [params],
    ),
  );

  useEffect(() => {
    let live = true;
    void spiceRef.current!.dcSweep(params).then((next) => {
      if (!live) return;
      // Capture the prior curve as the ghost via the updater, so the effect
      // needs no dependency on the current sweep.
      setSweep((prev) => {
        ghost.current = prev;
        return next;
      });
    });
    return () => {
      live = false;
    };
  }, [params]);

  const metrics = useMemo(() => (sweep ? analyzeVtc(sweep) : null), [sweep]);

  return (
    <div className="devicelab__cmos">
      <div className="param-panel">
        {toolField}
        <Slider label="VDD" min={2} max={6} step={0.1} value={vdd} onChange={setVdd} unit="V" />
        <Slider
          label="Wp/Wn"
          min={0.5}
          max={4}
          step={0.1}
          value={wpwn}
          onChange={setWpwn}
          unit="×"
        />
        <Slider
          label="Temp"
          min={-20}
          max={100}
          step={5}
          value={temperature}
          onChange={setTemperature}
          unit="°C"
        />
      </div>

      <div className="devicelab__main">
        {sweep && metrics && (
          <VtcPlot sweep={sweep} ghost={ghost.current} metrics={metrics} vdd={vdd} />
        )}
        {metrics && (
          <div className="metrics-panel mono">
            <Metric name="VOH" v={metrics.voh} />
            <Metric name="VOL" v={metrics.vol} />
            <Metric name="VIH" v={metrics.vih} />
            <Metric name="VIL" v={metrics.vil} />
            <Metric name="VM" v={metrics.vm} />
            <Metric name="NMH" v={metrics.nmh} />
            <Metric name="NML" v={metrics.nml} />
          </div>
        )}
      </div>

      {sweep?.engine === 'numeric' && (
        <div className="approx-flag mono">⚠ approximate model (SPICE unavailable)</div>
      )}

      {sweep && (
        <>
          {(
            [
              ['NMOS', sweep.regionN],
              ['PMOS', sweep.regionP],
            ] as const
          ).map(([name, regions]) => (
            <div key={name} className="region-legend mono">
              {name}:{' '}
              {regionRuns(sweep.vin, regions).map((r, i) => (
                <span key={i} className="region-legend__run">
                  {r.region} [{r.from.toFixed(1)}–{r.to.toFixed(1)}V]
                </span>
              ))}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function TtlLab({ toolField }: { toolField: ReactNode }) {
  const families = useMemo(() => familyLevels(), []);
  const keys = Object.keys(families);
  const [driver, setDriver] = useState('74LS');
  const [receiver, setReceiver] = useState('CMOS-5V');
  const d = families[driver]!;
  const r = families[receiver]!;
  const margins = interopMargins(d, r);

  return (
    <div className="devicelab__ttl">
      <div className="param-panel">
        {toolField}
        <label className="field">
          driver
          <select className="select" value={driver} onChange={(e) => setDriver(e.target.value)}>
            {keys.map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
        <label className="field">
          receiver
          <select className="select" value={receiver} onChange={(e) => setReceiver(e.target.value)}>
            {keys.map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
      </div>

      {/* The diagram and the worked solution below already carry NMH/NML; a
          side metrics panel would be a third copy of the same two numbers. */}
      <div className="devicelab__main">
        <NoiseMarginDiagram driver={d} receiver={r} maxV={Math.max(d.vohMin, r.vihMin, 5)} />
      </div>

      <MarginWork driver={d} receiver={r} margins={margins} />
    </div>
  );
}

// The NM derivation written out as the exam poses it. Teacher-paced: nothing
// appears until the reveal, like every other answer surface in the suite.
function MarginWork({
  driver,
  receiver,
  margins,
}: {
  driver: LevelSet;
  receiver: LevelSet;
  margins: FamilyMargins;
}) {
  const [shown, setShown] = useState(false);
  const steps = marginSteps(driver, receiver);
  return (
    <div className="margin-work">
      <button
        type="button"
        className="drawer-toggle"
        aria-pressed={shown}
        onClick={() => setShown((v) => !v)}
      >
        {shown ? 'Hide solution' : 'Show solution'}
      </button>
      {shown && (
        <div className="margin-work__body mono">
          {steps.map((s) => (
            <div
              key={s.label}
              className={`margin-work__row${s.ok ? '' : ' margin-work__row--bad'}`}
            >
              <span className="margin-work__formula">{s.formula}</span>
              <span className="margin-work__sub">= {s.substitution}</span>
              <span className="margin-work__result">= {s.result}</span>
            </div>
          ))}
          <div className="margin-work__verdict">
            {margins.violations.length === 0 ? (
              <span className="ok-flag">margins OK</span>
            ) : (
              margins.violations.map((v, i) => (
                <span key={i} className="violation-flag">
                  ⚠ {v}
                </span>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const TOOLS: { id: SubTool; label: string }[] = [
  { id: 'cmos', label: 'CMOS VTC' },
  { id: 'ttl', label: 'TTL noise margins' },
];

/** The sub-tool picker. On a phone it joins the lab's own controls as one more
 *  field, so TTL reads as a single row of tool, driver and receiver rather
 *  than a bar above two more rows; a segmented control could not fit both
 *  labels there anyway. */
function ToolField({ tool, setTool }: { tool: SubTool; setTool: (t: SubTool) => void }) {
  return (
    <label className="field">
      tool
      <select className="select" value={tool} onChange={(e) => setTool(e.target.value as SubTool)}>
        {TOOLS.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function DeviceLabWorkbench() {
  const [tool, setTool] = useState<SubTool>('cmos');
  const compact = useCompact();
  const toolField = compact ? <ToolField tool={tool} setTool={setTool} /> : null;
  return (
    <div className="devicelab">
      {compact ? null : (
        <div className="devicelab__bar">
          <div className="segmented">
            {TOOLS.map((t) => (
              <button
                key={t.id}
                type="button"
                aria-pressed={tool === t.id}
                onClick={() => setTool(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {tool === 'cmos' ? <CmosLab toolField={toolField} /> : <TtlLab toolField={toolField} />}
    </div>
  );
}

function Slider(props: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  unit: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="slider-field">
      <span className="slider-field__label">
        {props.label}{' '}
        <span className="mono">
          {props.value}
          {props.unit}
        </span>
      </span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </label>
  );
}

function Metric({ name, v }: { name: string; v: number }) {
  return (
    <span className="metric">
      <span className="metric__name">{name}</span>
      <span className="metric__value">{v.toFixed(2)}V</span>
    </span>
  );
}
