import * as bv from '../../value/busValue';
import { listedPart } from '../../parts/partsDb';
import { InputCursor, isPinExpanded, lanePins, reindexPins, splitBus } from './busPins';
import { parsePreload, preloadError, resizePreload } from './ramPreload';
import { assertedLevel, type Level } from './sequential';
import type { EvalContext, EvalResult, Params, PrimitivePin, PrimitiveSpec } from './types';
import { boolParam, intParam } from './types';

export const RAM_DEFAULT_WIDTH = 8;
export const RAM_DEFAULT_ADDRESS_BITS = 4;
/** 256 cells: keeps undo snapshots and the preload string small. */
export const RAM_MAX_ADDRESS_BITS = 8;

interface RamShape {
  width: number;
  addressBits: number;
  csLow: boolean;
  weLow: boolean;
  /** `q` carries the complement of the cell (the '189). */
  invertedOut: boolean;
  aLanes: boolean;
  dLanes: boolean;
  qLanes: boolean;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function shapeOf(params: Params): RamShape {
  const width = clamp(intParam(params, 'width', RAM_DEFAULT_WIDTH), 1, bv.MAX_WIDTH);
  const addressBits = clamp(
    intParam(params, 'addressBits', RAM_DEFAULT_ADDRESS_BITS),
    1,
    RAM_MAX_ADDRESS_BITS,
  );
  return {
    width,
    addressBits,
    csLow: boolParam(params, 'csLow'),
    weLow: boolParam(params, 'weLow'),
    invertedOut: boolParam(params, 'invertedOut'),
    aLanes: addressBits > 1 && isPinExpanded(params, 'a'),
    dLanes: width > 1 && isPinExpanded(params, 'd'),
    qLanes: width > 1 && isPinExpanded(params, 'q'),
  };
}

/** The size a RAM's params give, clamped as the primitive clamps them. */
export function ramSize(params: Params): {
  width: number;
  addressBits: number;
  invertedOut: boolean;
} {
  const sh = shapeOf(params);
  return { width: sh.width, addressBits: sh.addressBits, invertedOut: sh.invertedOut };
}

/** The address on `a` from the RAM's input values in pins() order, or null while any bit is unknown. */
export function ramAddress(params: Params, inputs: readonly bv.BusValue[]): number | null {
  const sh = shapeOf(params);
  const a = new InputCursor(inputs).bus(sh.addressBits, sh.aLanes);
  return bv.isFullyKnown(a, sh.addressBits) ? a.v & bv.widthMask(sh.addressBits) : null;
}

function preloadText(params: Params): string {
  const raw = params['preload'];
  return typeof raw === 'string' ? raw : '';
}

/** Why a RAM's `preload` param cannot load, or null when it can. */
export function ramPreloadError(params: Params): string | null {
  const raw = params['preload'];
  if (raw !== undefined && typeof raw !== 'string') return 'preload must be a string';
  const sh = shapeOf(params);
  return preloadError(preloadText(params), sh.width, 1 << sh.addressBits);
}

/** Why no RAM could load `text`. Checked at the largest size, since the RAM a
 *  chip instance's `contents` entry reaches is only known once the library is. */
export function anyRamPreloadError(text: string): string | null {
  return preloadError(text, bv.MAX_WIDTH, 1 << RAM_MAX_ADDRESS_BITS);
}

/** `next` with its preload rewritten to the size `next` gives, when the size changed. */
export function withResizedPreload<T extends Params>(prev: Params, next: T): T {
  if (typeof next['preload'] !== 'string') return next;
  const from = shapeOf(prev);
  const to = shapeOf(next);
  if (from.width === to.width && from.addressBits === to.addressBits) return next;
  const preload = resizePreload(
    next['preload'],
    { width: from.width, count: 1 << from.addressBits },
    { width: to.width, count: 1 << to.addressBits },
  );
  return { ...next, preload };
}

export interface RamState {
  /** One value per address, `width` bits each. */
  cells: readonly bv.BusValue[];
  /** Whether `cs` / `we` has read 0 or 1 since power-on. */
  csSeen: boolean;
  weSeen: boolean;
}

/** Candidate addresses for a partly unknown address: every value its known bits allow. */
function candidates(a: bv.BusValue, addressBits: number): number[] {
  const m = bv.widthMask(addressBits);
  const unknown = (a.x | a.z) & m;
  const fixed = a.v & ~unknown & m;
  const out: number[] = [];
  for (let i = 0; i <= m; i++) if ((i & ~unknown & m) === fixed) out.push(i);
  return out;
}

/**
 * Static RAM, the '189 core: a write floats `q` as the '189 table does, and is
 * level-sensitive, so an address moving mid-write writes each cell it passes.
 * A possible write leaves each candidate cell only the bits its old value and `d` agree on.
 */
export const ram: PrimitiveSpec = {
  kind: 'ram',
  pins: (params) => {
    const sh = shapeOf(params);
    const control = (name: string, low: boolean): PrimitivePin => ({
      name,
      dir: 'in',
      width: 1,
      role: 'enable',
      order: 0,
      ...(low ? { activeLow: true } : {}),
    });
    return reindexPins([
      ...lanePins({ name: 'a', dir: 'in', width: sh.addressBits, role: 'data', order: 0 }, params),
      ...lanePins({ name: 'd', dir: 'in', width: sh.width, role: 'data', order: 0 }, params),
      control('we', sh.weLow),
      control('cs', sh.csLow),
      ...lanePins(
        { name: 'q', dir: 'out', width: sh.width, role: 'data', order: 0, threeState: true },
        params,
      ),
    ]);
  },
  init: (params): RamState => {
    const sh = shapeOf(params);
    return {
      cells: parsePreload(preloadText(params), sh.width, 1 << sh.addressBits),
      csSeen: false,
      weSeen: false,
    };
  },
  evaluate(ctx: EvalContext): EvalResult {
    const sh = shapeOf(ctx.params);
    const w = sh.width;
    const state = ctx.state as RamState;
    const at = new InputCursor(ctx.inputs);
    const a = at.bus(sh.addressBits, sh.aLanes);
    const d = bv.buf(at.bus(w, sh.dLanes), w);
    const we = at.one();
    const cs = at.one();
    const weLevel = assertedLevel(we, sh.weLow);
    const csLevel = assertedLevel(cs, sh.csLow);
    const csSeen = state.csSeen || csLevel !== null;
    const weSeen = state.weSeen || weLevel !== null;

    // SPEC: a line still X from power-on is not driven yet, so the kernel's all-X start keeps the preload.
    const settling = (level: Level, seen: boolean): Level => (level === null && !seen ? 0 : level);
    const csWrite = settling(csLevel, csSeen);
    const weWrite = settling(weLevel, weSeen);
    const where = candidates(a, sh.addressBits);
    let cells = state.cells;
    if (csWrite !== 0 && weWrite !== 0) {
      const certain = csWrite === 1 && weWrite === 1 && where.length === 1;
      const next = [...cells];
      for (const i of where) next[i] = certain ? d : bv.agree([cells[i]!, d], w);
      if (next.some((cell, i) => !bv.equal(cell, cells[i]!))) cells = next;
    }

    let q: bv.BusValue;
    if (csLevel === 0 || weLevel === 1) q = bv.allZ(w);
    else if (csLevel === 1 && weLevel === 0) {
      const read = bv.agree(
        where.map((i) => state.cells[i]!),
        w,
      );
      q = sh.invertedOut ? bv.not(read, w) : read;
    } else q = bv.allX(w);

    const changed = cells !== state.cells || csSeen !== state.csSeen || weSeen !== state.weSeen;
    return {
      outputs: sh.qLanes ? splitBus(q, w) : [q],
      ...(changed ? { state: { cells, csSeen, weSeen } satisfies RamState } : {}),
    };
  },
  defaultPart: () => listedPart('74LS189'),
};
