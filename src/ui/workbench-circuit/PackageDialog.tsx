import { CHIP_EXT } from '../../io/docExtensions';
// "Package as chip..." dialog. Sides stay direction-fixed (inputs left,
// outputs right, matching the box glyph); name and top-to-bottom order per
// side are the only editable fields, widths/roles are inferred from the
// source In/Out components.

import { useMemo, useState } from 'react';
import type { ChipDef, ChipLibrary, Circuit, PinDef, PinDir } from '../../core/model/types';
import { useCircuitStore } from './circuitStore';
import { useShellStore } from '../store';
import { exportDoc, pickDirectory, writeDoc } from '../../io/fsAccess';
import { CHIP_TINTS, colorName, readTheme, type ChipTint } from '../../render/theme';
import {
  cloneCircuit,
  derivePins,
  extractSelection,
  slugId,
  stripInteractiveComponents,
} from './packaging';

interface Props {
  source: Circuit;
  selection: ReadonlySet<string>;
  chipLib: ChipLibrary;
  onClose: () => void;
}

function movePin(pins: PinDef[], id: string, dir: -1 | 1): PinDef[] {
  const target = pins.find((p) => p.id === id)!;
  const side = pins.filter((p) => p.dir === target.dir).sort((a, b) => a.order - b.order);
  const i = side.findIndex((p) => p.id === id);
  const j = i + dir;
  if (j < 0 || j >= side.length) return pins;
  const a = side[i]!;
  const b = side[j]!;
  const swapped = new Map([
    [a.id, { ...a, order: b.order }],
    [b.id, { ...b, order: a.order }],
  ]);
  return pins.map((p) => swapped.get(p.id) ?? p);
}

function bySide(pins: readonly PinDef[], dir: PinDir): PinDef[] {
  return pins.filter((p) => p.dir === dir).sort((a, b) => a.order - b.order);
}

// Module-level so it keeps a stable identity across PackageDialog re-renders --
// an inline component here would remount on every keystroke and drop focus.
function PinColumn({
  dir,
  title,
  pins,
  onRename,
  onMove,
}: {
  dir: PinDir;
  title: string;
  pins: PinDef[];
  onRename: (id: string, next: string) => void;
  onMove: (id: string, dir: -1 | 1) => void;
}) {
  const side = bySide(pins, dir);
  return (
    <div className="package-pin-col">
      <h4>{title}</h4>
      {side.map((p) => (
        <div key={p.id} className="package-pin-row">
          <input
            className="package-pin-name"
            value={p.name}
            onChange={(e) => onRename(p.id, e.target.value)}
          />
          <span className="package-pin-width">{p.width > 1 ? `[${p.width - 1}:0]` : ''}</span>
          <button type="button" className="tool-btn" onClick={() => onMove(p.id, -1)}>
            ↑
          </button>
          <button type="button" className="tool-btn" onClick={() => onMove(p.id, 1)}>
            ↓
          </button>
        </div>
      ))}
      {side.length === 0 && <p className="package-pin-empty">none</p>}
    </div>
  );
}

interface Swatch {
  tint: ChipTint;
  css: string;
  label: string;
}

/** Module scope, not inline: an inline component remounts on every parent
 *  render and drops focus (the bug PinColumn hit). */
function SwatchRow({
  title,
  value,
  onPick,
  swatches,
}: {
  title: string;
  value: ChipTint | '';
  onPick: (v: ChipTint | '') => void;
  swatches: readonly Swatch[];
}) {
  return (
    <div className="package-swatch-row">
      <span>{title}</span>
      <div className="package-swatches" role="radiogroup" aria-label={title}>
        <button
          type="button"
          className={`package-swatch package-swatch--none${value === '' ? ' is-selected' : ''}`}
          aria-pressed={value === ''}
          aria-label="No colour"
          title="No colour"
          onClick={() => onPick('')}
        />
        {swatches.map(({ tint, css, label }) => (
          <button
            key={tint}
            type="button"
            className={`package-swatch${value === tint ? ' is-selected' : ''}`}
            style={{ background: css }}
            aria-pressed={value === tint}
            aria-label={label}
            title={label}
            onClick={() => onPick(tint)}
          />
        ))}
      </div>
    </div>
  );
}

export function PackageDialog({ source, selection, chipLib, onClose }: Props) {
  const chipsDir = useShellStore((s) => s.chipsDir);
  const setChipsDir = useShellStore((s) => s.setChipsDir);

  // Clone: the new def's arrays must never alias the live board's -- an edit
  // on one side would otherwise silently mutate the other. Switches/LEDs are
  // board-only testing aids -- packaged in, they'd still drive/read their net
  // as real primitives and collide with whatever the def gets wired to once
  // placed elsewhere.
  const draftSource = stripInteractiveComponents(
    cloneCircuit(selection.size > 0 ? extractSelection(source, selection) : source),
  );
  const [name, setName] = useState('');
  // Stored as a token NAME, not a hex: the chip has to stay legible in all
  // seven themes and both appearances (render/theme.ts CHIP_TINTS).
  const [color, setColor] = useState<ChipTint | ''>('');
  const [borderColor, setBorderColor] = useState<ChipTint | ''>('');
  // Named from the colour the ACTIVE theme resolved each token to -- the user
  // should never read "warn" or "accent2" for a colour they are looking at.
  const swatches = useMemo(() => {
    const theme = readTheme();
    return CHIP_TINTS.map((tint) => ({
      tint,
      css: theme.colors[tint],
      label: colorName(theme.colors[tint]),
    }));
  }, []);
  const [pins, setPins] = useState<PinDef[]>(() => derivePins([], draftSource.components).pins);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const rename = (id: string, next: string) =>
    setPins((ps) => ps.map((p) => (p.id === id ? { ...p, name: next } : p)));

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Name the chip before saving.');
      return;
    }
    const id = slugId(trimmed, new Set(chipLib.keys()));
    const def: ChipDef = {
      format: 'lcir.chip',
      formatVersion: 3,
      id,
      name: trimmed,
      version: 1,
      components: draftSource.components,
      wires: draftSource.wires,
      junctions: draftSource.junctions,
      pins,
      ...(color || borderColor
        ? { appearance: { ...(color ? { color } : {}), ...(borderColor ? { borderColor } : {}) } }
        : {}),
    };
    const result = useCircuitStore.getState().commitNewChip(def);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    // The def is already placeable in-memory; file persistence never blocks
    // the demo -- picker decline or write failure falls back to a download.
    setSaving(true);
    try {
      let dir = chipsDir;
      if (!dir) {
        try {
          dir = await pickDirectory('chips');
          setChipsDir(dir);
        } catch {
          dir = null;
        }
      }
      if (dir) await writeDoc(dir, 'chips', `${id}${CHIP_EXT}`, def);
      else exportDoc(def, `${id}${CHIP_EXT}`);
    } catch {
      exportDoc(def, `${id}${CHIP_EXT}`);
    } finally {
      setSaving(false);
      onClose();
    }
  };

  return (
    <div
      className="package-overlay"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="package-dialog">
        <h3>Package as chip</h3>
        <label className="package-field">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <div className="package-field">
          <SwatchRow
            title="Border colour (optional)"
            value={borderColor}
            onPick={setBorderColor}
            swatches={swatches}
          />
          <SwatchRow
            title="Body tint (optional)"
            value={color}
            onPick={setColor}
            swatches={swatches}
          />
        </div>
        <div className="package-pins">
          <PinColumn
            dir="in"
            title="Inputs"
            pins={pins}
            onRename={rename}
            onMove={(id, dir) => setPins((ps) => movePin(ps, id, dir))}
          />
          <PinColumn
            dir="out"
            title="Outputs"
            pins={pins}
            onRename={rename}
            onMove={(id, dir) => setPins((ps) => movePin(ps, id, dir))}
          />
        </div>
        {error && <p className="circuit-error">{error}</p>}
        <div className="package-actions">
          <button type="button" className="tool-btn" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="tool-btn" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
