// Pure, DOM-free helpers describing which params a primitive kind exposes
// through the double-click overlay / keyboard +/- shortcuts. Single source
// of truth shared by the keydown handler, the overlay, and batch param edit
// -- width-capability in particular is derived from the primitive's own
// pins() output rather than a hand-maintained kind list, so it can't drift
// from what a primitive actually implements.

import { getPrimitive, hasPrimitive } from '../../core/sim/primitives/registry';
import type { Params } from '../../core/sim/primitives/types';
import type { ParamValue } from '../../core/model/types';
import { MAX_WIDTH } from '../../core/value/busValue';
import { VARIABLE_ARITY_GATES } from './circuitStore';

/** True when bumping `params.width` by one changes some pin's width --
 *  the width overlay/+_ shortcut should only ever touch a kind for which
 *  this holds. */
export function isWidthCapable(kind: string, params: Params): boolean {
  if (!hasPrimitive(kind)) return false;
  const w = Number(params['width'] ?? 1);
  const prim = getPrimitive(kind);
  let a: ReturnType<typeof prim.pins>;
  let b: ReturnType<typeof prim.pins>;
  try {
    a = prim.pins({ ...params, width: w });
    b = prim.pins({ ...params, width: w + 1 });
  } catch {
    return false;
  }
  if (a.length !== b.length) return true;
  return a.some((p, i) => p.width !== b[i]!.width);
}

export function clampWidth(value: number, max: number): number {
  return Math.min(max, Math.max(1, Math.round(value)));
}

/** The set of param keys `kind`'s double-click overlay can edit, excluding
 *  name/label (never batched -- decision 1) and pinView group keys (stay
 *  scoped to the double-clicked component even in a multi-selection --
 *  decision 4). Param identity is the exact key: mux and demux share
 *  `selectBits` (choosing a select width sets the data-line/output-line
 *  count as `2^selectBits`); decoder and encoder share `addressBits` (same
 *  idea for their coded `a` bus). Gates keep their own `inputs` (raw
 *  arity, unrelated to either bit-width param), so a gate never batches
 *  with mux/demux/decoder/encoder on pin count. */
export function paramKeysFor(kind: string, params: Params): ReadonlySet<string> {
  const keys = new Set<string>();
  if (isWidthCapable(kind, params)) keys.add('width');
  if (VARIABLE_ARITY_GATES.has(kind)) keys.add('inputs');
  if (kind === 'mux' || kind === 'demux') keys.add('selectBits');
  if (kind === 'decoder' || kind === 'encoder') keys.add('addressBits');
  if (kind === 'mux' || kind === 'demux' || kind === 'decoder') keys.add('hasEnable');
  if (kind === 'mux' || kind === 'demux') keys.add('selSide');
  if (kind === 'toggle') keys.add('initial');
  if (kind === 'constant') keys.add('value');
  return keys;
}

/** Coerces/clamps a raw field value (as entered against the double-clicked
 *  component's own control) into `kind`'s own domain for `key`, or null when
 *  `kind` doesn't accept that value at all -- decision 2's "domain clash ->
 *  skip illegal": the caller simply omits this (id, key) pair from the batch
 *  when this returns null, "silently leaving it unchanged". */
export function clampParamValue(kind: string, key: string, raw: ParamValue): ParamValue | null {
  switch (key) {
    case 'width': {
      const n = Number(raw);
      return Number.isFinite(n) ? clampWidth(n, MAX_WIDTH) : null;
    }
    case 'inputs': {
      const n = Math.round(Number(raw));
      if (!Number.isFinite(n)) return null;
      if (VARIABLE_ARITY_GATES.has(kind)) return Math.min(8, Math.max(2, n));
      return null;
    }
    case 'selectBits': {
      const n = Math.round(Number(raw));
      if (kind !== 'mux' && kind !== 'demux') return null;
      return Number.isFinite(n) ? Math.min(4, Math.max(1, n)) : null;
    }
    case 'addressBits': {
      const n = Math.round(Number(raw));
      if (kind !== 'decoder' && kind !== 'encoder') return null;
      return Number.isFinite(n) ? Math.min(4, Math.max(1, n)) : null;
    }
    case 'hasEnable':
      return kind === 'mux' || kind === 'demux' || kind === 'decoder' ? !!raw : null;
    case 'selSide':
      return kind === 'mux' || kind === 'demux' ? (raw === 'top' ? 'top' : 'bottom') : null;
    case 'initial': {
      if (kind !== 'toggle') return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    }
    case 'value':
      return kind === 'constant' ? raw : null;
    default:
      return null;
  }
}
