// Pure helpers for the double-click overlay's per-pin-group bus expand/
// collapse checkboxes, generic across every pinView-capable kind. Candidate
// group keys are looked up per kind, but whether a key is actually eligible
// and whether it's currently collapsed are both derived from the primitive's
// own pins() output via getPrimitive, never hardcoded, so this can't drift
// from what each primitive actually implements.

import { getPrimitive, hasPrimitive } from '../../core/sim/primitives/registry';
import {
  parsePinView,
  serializePinView,
  type PinViewState,
} from '../../core/sim/primitives/busPins';
import type { ParamValue } from '../../core/model/types';
import type { Params } from '../../core/sim/primitives/types';

export interface PinViewGroup {
  key: string;
  /** Short label shown beside the checkbox, e.g. "a", "select", "data". */
  label: string;
}

const GATE_LETTER_KINDS = new Set(['and', 'or', 'nand', 'nor', 'xor', 'xnor']);
const UNARY_GATE_KINDS = new Set(['buf', 'not']);
const LETTERS = 'abcdefgh';

/** Candidate pinView group keys for a kind, given its current (pre-commit)
 *  params -- e.g. a gate's own arity/width, or mux/demux's inputs/outputs
 *  size. Purely a lookup of *what to ask about*; `isGroupCollapsed` below
 *  (backed by the primitive's real pins()) decides whether asking actually
 *  changes anything, so an inapplicable candidate (e.g. mux's whole-data-
 *  group key when width >= 2) naturally produces no visible checkbox. */
export function pinViewGroupsFor(kind: string, params: Record<string, ParamValue>): PinViewGroup[] {
  const width = Number(params['width'] ?? 1);
  if (UNARY_GATE_KINDS.has(kind)) {
    return width > 1
      ? [
          { key: 'a', label: 'a' },
          { key: 'y', label: 'y' },
        ]
      : [];
  }
  if (GATE_LETTER_KINDS.has(kind)) {
    if (width <= 1) return [];
    const n = Math.max(2, Math.min(8, Number(params['inputs'] ?? 2)));
    const letters = LETTERS.slice(0, n).split('');
    return [...letters.map((l) => ({ key: l, label: l })), { key: 'y', label: 'y' }];
  }
  if (kind === 'toggle' || kind === 'inport') return width > 1 ? [{ key: 'y', label: 'y' }] : [];
  if (kind === 'led' || kind === 'probe' || kind === 'outport')
    return width > 1 ? [{ key: 'a', label: 'a' }] : [];
  if (kind === 'mux' || kind === 'demux') {
    const n = 1 << Number(params['selectBits'] ?? 2);
    const prefix = kind === 'demux' ? 'y' : 'd';
    const groups: PinViewGroup[] = [{ key: 's', label: 'select' }];
    if (width === 1) {
      groups.push({ key: prefix, label: kind === 'demux' ? 'outputs' : 'data' });
    } else {
      for (let i = 0; i < n; i++) groups.push({ key: `${prefix}${i}`, label: `${prefix}${i}` });
    }
    // mux's own `y` and demux's own `d` are single width>1 pins (not a
    // {2,4,8,16}-sized group like the data/select side) that lane-expand
    // exactly like a gate output/input.
    if (width > 1) {
      groups.push(kind === 'demux' ? { key: 'd', label: 'data' } : { key: 'y', label: 'y' });
    }
    return groups;
  }
  if (kind === 'decoder') {
    const addressBits = Number(params['addressBits'] ?? 2);
    const groups: PinViewGroup[] = [{ key: 'y', label: 'outputs' }];
    if (addressBits > 1) groups.unshift({ key: 'a', label: 'a' });
    return groups;
  }
  if (kind === 'encoder') {
    const addressBits = Number(params['addressBits'] ?? 2);
    const groups: PinViewGroup[] = [{ key: 'i', label: 'inputs' }];
    if (addressBits > 1) groups.push({ key: 'a', label: 'a' });
    return groups;
  }
  return [];
}

/** True when `key`'s group currently resolves to exactly one collapsed bus
 *  pin named `key` -- derived by forcing the view and comparing against the
 *  primitive's own unforced pins(), not a hardcoded per-kind default. */
export function isGroupCollapsed(
  kind: string,
  params: Record<string, ParamValue>,
  key: string,
): boolean {
  if (!hasPrimitive(kind)) return false;
  const view = parsePinView(params as Params);
  const collapsedParams = {
    ...params,
    pinView: serializePinView({ ...view, [key]: 'collapsed' }),
  } as Params;
  const collapsedNames = new Set(
    getPrimitive(kind)
      .pins(collapsedParams)
      .map((p) => p.name),
  );
  const actualNames = new Set(
    getPrimitive(kind)
      .pins(params as Params)
      .map((p) => p.name),
  );
  if (collapsedNames.size !== actualNames.size) return false;
  for (const n of actualNames) if (!collapsedNames.has(n)) return false;
  return true;
}

/** Full current pinView state for every candidate group of `kind`, seeding
 *  the overlay's local checkbox state on open. */
export function currentPinView(
  kind: string,
  params: Record<string, ParamValue>,
): Record<string, PinViewState> {
  const out: Record<string, PinViewState> = {};
  for (const g of pinViewGroupsFor(kind, params)) {
    out[g.key] = isGroupCollapsed(kind, params, g.key) ? 'collapsed' : 'expanded';
  }
  return out;
}
