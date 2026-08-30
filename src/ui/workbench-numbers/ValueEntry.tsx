import { known, xor, type BusValue } from '../../core/value/busValue';
import {
  parseBinTyped,
  parseDec,
  parseHex,
  parseOct,
  renderBin,
  renderDec,
  renderHex,
  renderOct,
  toUnsigned,
} from '../../core/numkit/format';
import type { Interpretation } from '../../core/numkit/types';
import { defaultMetrics, layoutBitRow, type WeightMode } from '../../render/bitGrid';
import { BitGrid } from './BitGrid';

export type EntryField = 'hex' | 'dec' | 'oct' | 'bits';

const DEFAULT_FIELDS: EntryField[] = ['hex', 'dec', 'bits'];

interface ValueEntryProps {
  label: string;
  value: BusValue;
  width: number;
  interp: Interpretation;
  /** Which entry paths to render; Convert passes just the source base. */
  fields?: EntryField[] | undefined;
  highlight?: ReadonlySet<number> | undefined;
  /** Which input is the primary/emphasized one for the current task. */
  emphasis?: 'dec' | 'hex' | 'bits' | undefined;
  /** Live preview overlay for the result grid; no effect on committed value. */
  preview?: BusValue | undefined;
  /** Column weights above the bit grid. */
  weights?: WeightMode | undefined;
  /** Where the wider gap falls: 4 for hex nibbles, 3 for octal triplets. */
  groupBits?: number | undefined;
  onChange: (v: BusValue) => void;
  onHoverBit?: ((bit: number | undefined) => void) | undefined;
}

// One operand: the clickable bit row plus hex / decimal / octal fields and a
// slider (coarse-stepped past 16 bits). Every entry path writes back a
// BusValue so readouts stay in sync (the parse(render(v)) === v guarantee
// from numkit/format).
export function ValueEntry({
  label,
  value,
  width,
  interp,
  fields = DEFAULT_FIELDS,
  highlight,
  emphasis,
  preview,
  weights,
  groupBits = 4,
  onChange,
  onHoverBit,
}: ValueEntryProps) {
  const toggleBit = (bit: number) => onChange(xor([value, known(1 << bit, width)], width));
  // Editing overwrites in place at a fixed width, so every keystroke is a
  // complete value -- no draft state, and the row never shifts mid-edit.
  const typeBits = (digits: string) => onChange(parseBinTyped(digits, width, interp));
  const primary = (which: 'dec' | 'hex' | 'bits') =>
    emphasis === which ? ' value-entry__primary' : '';
  const has = (f: EntryField) => fields.includes(f);

  return (
    <div className="value-entry">
      <div className="value-entry__head">
        <span className="value-entry__label">{label}</span>
        {has('hex') && (
          <label className={`field${primary('hex')}`}>
            hex
            <input
              className="field__input mono"
              value={renderHex(value, width)}
              spellCheck={false}
              onChange={(e) => onChange(parseHex(e.target.value, width))}
            />
          </label>
        )}
        {has('dec') && (
          <label className={`field${primary('dec')}`}>
            dec
            <input
              className="field__input mono"
              value={renderDec(value, width, interp)}
              spellCheck={false}
              onChange={(e) => onChange(parseDec(e.target.value, width))}
            />
          </label>
        )}
        {has('oct') && (
          <label className="field">
            oct
            <input
              className="field__input mono"
              value={renderOct(value, width)}
              spellCheck={false}
              onChange={(e) => onChange(parseOct(e.target.value, width))}
            />
          </label>
        )}
      </div>
      {has('bits') && (
        <div className={`value-entry__bits${primary('bits')}`}>
          <BitGrid
            value={value}
            width={width}
            highlight={highlight}
            preview={preview}
            weights={weights}
            groupBits={groupBits}
            editable
            onToggleBit={toggleBit}
            onHoverBit={onHoverBit}
            onTypeBits={typeBits}
            text={renderBin(value, width)}
          />
        </div>
      )}
      {/* Track spans the full bit row so wide widths get finer drag positions. */}
      <input
        type="range"
        className="value-entry__slider"
        style={{ width: layoutBitRow(width, 4, 4, defaultMetrics, groupBits).width + 8 }}
        min={0}
        max={2 ** width - 1}
        step={1}
        value={toUnsigned(value, width)}
        onChange={(e) => onChange(known(Number(e.target.value), width))}
      />
    </div>
  );
}
