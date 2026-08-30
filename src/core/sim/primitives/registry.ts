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
  inputPin,
  merge,
  netLabel,
  outputPin,
  pullDown,
  pullUp,
  split,
  tunnel,
} from './structural';
import { dff, dlatch, register } from './sequential';
import { clock, led, probe, pushButton, toggleSwitch } from './stimulus';
import { mux } from './mux';
import { demux } from './demux';
import { busdisplay, sevenseg, sevenseghex } from './display';
import { decoder, encoder } from './coder';

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
  dff,
  dlatch,
  register,
  mux,
  demux,
  clock,
  toggleSwitch,
  pushButton,
  led,
  probe,
  sevenseg,
  sevenseghex,
  busdisplay,
  decoder,
  encoder,
]) {
  registerPrimitive(spec);
}
