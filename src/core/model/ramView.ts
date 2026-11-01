// What the Memory panel needs from a compiled board: every RAM, where its
// contents are written back to, and the cell arithmetic for one edit.

import * as bv from '../value/busValue';
import { ramSize } from '../sim/primitives/ram';
import { parsePreload, preloadDigits, printPreload } from '../sim/primitives/ramPreload';
import type { CompiledCircuit } from './compile';
import type { ChipLibrary, Circuit } from './types';

/** Where an edit to a RAM's cells is stored. */
export type RamTarget =
  /** A RAM on the board or in a group: its own `params.preload`, by bare component id. */
  | { kind: 'preload'; componentId: string }
  /** A RAM inside a chip: `contents[key]` on the top-level instance, by bare component id. */
  | { kind: 'contents'; instanceId: string; key: string };

export interface RamEntry {
  /** Primitive index in the compiled circuit. */
  index: number;
  /** The primitive's `componentId`, stable across a label rename. */
  componentId: string;
  title: string;
  width: number;
  addressBits: number;
  invertedOut: boolean;
  /** The preload the RAM loads at power-on, `contents` already applied. */
  preload: string;
  target: RamTarget;
  /** The instance holds a kept entry that no longer fits this RAM; writing would replace it. */
  misfit: boolean;
}

const MAIN = 'main/';

const bare = (id: string) => (id.startsWith(MAIN) ? id.slice(MAIN.length) : id);

/** `main/U4:cpu/M:mem/r1` -> `U4/M/r1`. */
function displayPath(path: string): string {
  return bare(path)
    .split('/')
    .map((seg) => seg.split(':')[0])
    .join('/');
}

/** Whether a RAM sits anywhere in `circuit`, chips included, without compiling it. */
export function hasRam(circuit: Circuit, lib: ChipLibrary, seen = new Set<string>()): boolean {
  return circuit.components.some((c) => {
    if (c.kind === 'ram') return true;
    if (c.kind !== 'chip' || !c.defId || seen.has(c.defId)) return false;
    seen.add(c.defId);
    const def = lib.get(c.defId);
    return !!def && hasRam(def, lib, seen);
  });
}

/** Every RAM in the compiled board, in primitive order. */
export function listRams(compiled: CompiledCircuit): RamEntry[] {
  const out: RamEntry[] = [];
  compiled.primitives.forEach((prim, index) => {
    if (prim.kind !== 'ram') return;
    const size = ramSize(prim.params);
    const slot = prim.contentsSlot;
    const target: RamTarget = slot
      ? { kind: 'contents', instanceId: bare(slot.instance), key: slot.key }
      : { kind: 'preload', componentId: bare(prim.componentId) };
    const misfit =
      !!slot &&
      compiled.staleContents.some(
        (k) => k.reason === 'misfit' && k.instanceId === slot.instance && k.key === slot.key,
      );
    const preload = prim.params['preload'];
    out.push({
      index,
      componentId: prim.componentId,
      // A built-in DIP's core is one section of the package: name it by the package.
      title: displayPath(prim.packageInstance ?? prim.path),
      ...size,
      preload: typeof preload === 'string' ? preload : '',
      target,
      misfit,
    });
  });
  return out;
}

export function ramCells(entry: RamEntry): bv.BusValue[] {
  return parsePreload(entry.preload, entry.width, 1 << entry.addressBits);
}

/** `entry`'s preload with one cell replaced; null clears it to X. */
export function withCell(entry: RamEntry, address: number, value: number | null): string {
  const cells = ramCells(entry);
  cells[address] = value === null ? bv.allX(entry.width) : bv.known(value, entry.width);
  return printPreload(cells, entry.width);
}

/** `entry`'s preload with one bit flipped. An X cell flips from all zeros:
 *  the format has no per-bit unknowns. */
export function withBitFlipped(entry: RamEntry, address: number, bit: number): string {
  const cell = ramCells(entry)[address]!;
  const base = bv.isFullyKnown(cell, entry.width) ? cell.v : 0;
  return withCell(entry, address, (base ^ (1 << bit)) >>> 0);
}

/** Hex digits one cell takes when typed. */
export const cellDigits = preloadDigits;

/**
 * The value a typed hex buffer gives, masked to the width, or null when the
 * buffer is empty. A digit beyond the width (F into a 3-bit RAM) is masked
 * rather than refused, as a preload load masks it.
 */
export function typedValue(digits: string, width: number): number | null {
  if (digits === '') return null;
  return Number.parseInt(digits, 16) & bv.widthMask(width);
}

/** Addresses whose printed cell differs, which is what Keep last run would change. */
export function changedAddresses(
  preload: readonly bv.BusValue[],
  run: readonly bv.BusValue[],
  width: number,
): number[] {
  const token = (c: bv.BusValue | undefined) => (c && bv.isFullyKnown(c, width) ? c.v >>> 0 : 'X');
  const out: number[] = [];
  for (let a = 0; a < Math.max(preload.length, run.length); a++)
    if (token(preload[a]) !== token(run[a])) out.push(a);
  return out;
}

/** The address a write between two snapshots landed on. A level-sensitive
 *  write sweeping several addresses in one frame names the highest. */
export function lastWritten(
  prev: readonly bv.BusValue[],
  next: readonly bv.BusValue[],
): number | null {
  for (let a = next.length - 1; a >= 0; a--) {
    const before = prev[a];
    if (!before || !bv.equal(before, next[a]!)) return a;
  }
  return null;
}
