import type { PrimitiveSpec } from './types';
import {
  andGate,
  bufGate,
  nandGate,
  norGate,
  notGate,
  orGate,
  tristateBuf,
  xnorGate,
  xorGate,
} from './gates';
import {
  busTapDrive,
  busTapRead,
  constant,
  gndRail,
  inputPin,
  merge,
  netLabel,
  outputPin,
  pullDown,
  pullUp,
  split,
  tunnel,
  vccRail,
} from './structural';
import { dff, dlatch, register, srlatch } from './sequential';
import { counter } from './counter';
import { shiftreg } from './shiftreg';
import { ram } from './ram';
import { clock, led, probe, pushButton, spdtSwitch, toggleSwitch } from './stimulus';
import { pattern } from './pattern';
import { mux } from './mux';
import { demux } from './demux';
import { busdisplay, ledmatrix, sevenseg } from './display';
import { decoder, encoder } from './coder';
import { bcd7seg } from './bcd7seg';
import { adder, comparator, parity } from './arith';
import { transceiver } from './transceiver';
import { timer555 } from './timer555';

const specs = new Map<string, PrimitiveSpec>();

export function registerPrimitive(spec: PrimitiveSpec): void {
  if (specs.has(spec.kind)) throw new Error(`primitive '${spec.kind}' already registered`);
  specs.set(spec.kind, spec);
}

export function getPrimitive(kind: string): PrimitiveSpec {
  const spec = specs.get(kind);
  if (!spec) throw new Error(`unknown primitive kind '${kind}'`);
  return spec;
}

export function hasPrimitive(kind: string): boolean {
  return specs.has(kind);
}

/** Compile strips these: they shape connectivity but never simulate. */
export const CONNECTIVITY_KINDS = new Set(['tunnel', 'pullup', 'pulldown']);

for (const spec of [
  nandGate,
  andGate,
  orGate,
  norGate,
  xorGate,
  xnorGate,
  bufGate,
  notGate,
  tristateBuf,
  inputPin,
  outputPin,
  netLabel,
  constant,
  split,
  merge,
  busTapRead,
  busTapDrive,
  tunnel,
  pullUp,
  pullDown,
  vccRail,
  gndRail,
  dff,
  dlatch,
  register,
  srlatch,
  counter,
  shiftreg,
  ram,
  mux,
  demux,
  clock,
  pattern,
  timer555,
  toggleSwitch,
  pushButton,
  spdtSwitch,
  led,
  probe,
  sevenseg,
  busdisplay,
  ledmatrix,
  decoder,
  encoder,
  bcd7seg,
  adder,
  comparator,
  parity,
  transceiver,
]) {
  registerPrimitive(spec);
}
