import { useRef, type ReactNode } from 'react';
import { TIMER_MODES, timerIntervals } from '../../core/sim/primitives/timer555';
import { formatEngineering } from '../../core/value/engineering';
import { formatTimePs } from '../../render/waveform';
import {
  engineeringText,
  nearestSliderIndex,
  parseTimerFields,
  parseTimerValue,
  SLIDER_OHMS,
  sliderKey,
  type TimerFieldText,
  type TimerValueKey,
} from './timerOverlay';

interface FocusProps {
  onFocus: () => void;
  onBlur: () => void;
  disabled?: boolean;
}

interface TimerFieldsProps {
  fields: TimerFieldText;
  flash: boolean;
  visible: (key: string) => boolean;
  focusProps: (key: string) => FocusProps;
  onChange: (fields: TimerFieldText) => void;
  /** A slider step: retimes a running sim, not yet a board edit. */
  onSlide: (key: 'r1' | 'r2', ohms: number) => void;
  /** Slider let go: the value it rests on becomes one undo step. */
  onSlideEnd: (key: 'r1' | 'r2', ohms: number) => void;
}

const SLIDER_TICKS = ['100 Ω', '10k', '1M', '10M'];

function Readout({ fields }: { fields: TimerFieldText }) {
  const params = parseTimerFields(fields);
  if (!params || fields.mode === 'bistable') return null;
  const iv = timerIntervals(params);
  const rows: [string, string][] =
    fields.mode === 'astable'
      ? [
          ['first HIGH', formatTimePs(iv.firstHighPs)],
          ['tH', formatTimePs(iv.highPs)],
          ['tL', formatTimePs(iv.lowPs)],
          [
            'f',
            `${formatEngineering(1e12 / (iv.highPs + iv.lowPs), 'Hz', 0)}, duty ${Math.round(
              (100 * iv.highPs) / (iv.highPs + iv.lowPs),
            )} %`,
          ],
        ]
      : [['tw', formatTimePs(iv.pulsePs)]];
  return (
    <dl className="circuit-param-edit__readout">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The 555's rows in the param overlay: mode, R and C, the E12 slider and what they give. */
export function TimerFields({
  fields,
  flash,
  visible,
  focusProps,
  onChange,
  onSlide,
  onSlideEnd,
}: TimerFieldsProps) {
  const slid = sliderKey(fields.mode);
  // Only a value the slider itself moved to commits: a Tab landing on it, or
  // a release with no move, must not snap a typed value to the nearest E12.
  const slidTo = useRef<number | null>(null);
  const settle = (key: 'r1' | 'r2') => {
    if (slidTo.current === null) return;
    onSlideEnd(key, slidTo.current);
    slidTo.current = null;
  };
  const valueField = (key: TimerValueKey, label: string, unit: string): ReactNode =>
    visible(key) && (
      <label key={key}>
        {label}
        <span className="circuit-param-edit__unit-field">
          <input
            type="text"
            inputMode="decimal"
            spellCheck={false}
            className={
              flash && parseTimerValue(key, fields[key]) === null
                ? 'circuit-pin-rename--warn'
                : undefined
            }
            value={fields[key]}
            onChange={(e) => onChange({ ...fields, [key]: e.target.value })}
            {...focusProps(key)}
          />
          {unit}
        </span>
      </label>
    );
  const slider = (key: 'r1' | 'r2') => {
    const current = parseTimerValue(key, fields[key]) ?? 0;
    const ohmsAt = (index: string) => SLIDER_OHMS[Number(index)]!;
    return (
      <div className="circuit-param-edit__slider" key={`${key}-slider`}>
        <input
          type="range"
          aria-label={`${key === 'r2' ? 'R2' : 'R'} slider`}
          min={0}
          max={SLIDER_OHMS.length - 1}
          step={1}
          value={nearestSliderIndex(current)}
          onChange={(e) => {
            const ohms = ohmsAt(e.target.value);
            slidTo.current = ohms;
            onChange({ ...fields, [key]: engineeringText(ohms) });
            onSlide(key, ohms);
          }}
          onPointerUp={() => settle(key)}
          onPointerCancel={() => settle(key)}
          onKeyUp={() => settle(key)}
          onBlur={() => settle(key)}
        />
        <div className="circuit-param-edit__ticks" aria-hidden="true">
          {SLIDER_TICKS.map((t) => (
            <span key={t}>{t}</span>
          ))}
        </div>
      </div>
    );
  };
  return (
    <>
      {visible('mode') && (
        <label>
          mode
          <select
            className="select"
            value={fields.mode}
            onChange={(e) => {
              const mode = TIMER_MODES.find((m) => m === e.target.value) ?? 'astable';
              onChange({ ...fields, mode });
            }}
            {...focusProps('mode')}
          >
            {TIMER_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
      )}
      {fields.mode === 'astable' && [
        valueField('r1', 'R1', 'Ω'),
        valueField('r2', 'R2', 'Ω'),
        visible('r2') && slider('r2'),
      ]}
      {fields.mode === 'monostable' && [valueField('r1', 'R', 'Ω'), visible('r1') && slider('r1')]}
      {fields.mode !== 'bistable' && valueField('c', 'C', 'F')}
      {slid !== null && <Readout fields={fields} />}
    </>
  );
}
