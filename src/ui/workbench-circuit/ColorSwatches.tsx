import { PALETTE_SLOTS, type PaletteSlot } from '../../core/model/types';

/** Hue of each slot as every theme draws it: the themes re-tune lightness
 *  per ground, never the hue, so one name holds everywhere. */
const SLOT_NAMES: Record<PaletteSlot, string> = {
  g1: 'blue',
  g2: 'orange',
  g3: 'green',
  g4: 'purple',
  g5: 'olive',
  g6: 'pink',
  g7: 'sky',
  g8: 'brick',
};

/** The eight palette slots plus a "none" swatch. `value` undefined means a
 *  mixed selection, so no swatch reads as current. */
export function ColorSwatches({
  value,
  noneLabel,
  onPick,
}: {
  value: PaletteSlot | null | undefined;
  noneLabel: string;
  onPick: (slot: PaletteSlot | null) => void;
}) {
  return (
    <div className="circuit-swatches" role="group" aria-label="colour">
      {[...PALETTE_SLOTS, null].map((slot) => {
        const label = slot ? SLOT_NAMES[slot] : noneLabel;
        return (
          <button
            key={slot ?? 'none'}
            type="button"
            className={`circuit-swatch${slot ? '' : ' circuit-swatch--none'}`}
            style={slot ? { background: `var(--kmap-${slot})` } : undefined}
            aria-pressed={value === slot}
            aria-label={label}
            title={label}
            onClick={() => onPick(slot)}
          />
        );
      })}
    </div>
  );
}
