// Built-in 74-series ChipDefs, generated from the datasheet pinouts in
// packages.json. Generated rather than hand-authored so a pinout correction
// lands in one place; a committed golden per part keeps the output inspectable
// and catches drift (packages.test.ts).

import rawPackages from './packages.json';
import type {
  ChipDef,
  Component,
  ComponentKind,
  ParamValue,
  PinDef,
  PinRole,
  Wire,
} from '../model/types';

export interface PackagePin {
  pin: number;
  name: string;
  /** Internal gate this pin belongs to; absent on the power pins. */
  gate?: number;
  /** The pin's role in that gate, and the primitive pin name it wires to. */
  fn: string;
}

export interface PackageEntry {
  part: string;
  package: string;
  device: string;
  primitive: string;
  gates: number;
  verified: boolean;
  source: string;
  comment?: string;
  pins: PackagePin[];
}

interface PackagesFile {
  note: string;
  packages: PackageEntry[];
}

const file = rawPackages as PackagesFile;
const byPart = new Map(file.packages.map((p) => [p.part, p]));

export function packageEntries(): readonly PackageEntry[] {
  return file.packages;
}

export function getPackage(part: string): PackageEntry | undefined {
  return byPart.get(part);
}

/** packages.json's `primitive` names the device, not our ComponentKind. */
const PRIMITIVE_KINDS: Record<
  string,
  { kind: ComponentKind; params?: Record<string, ParamValue> }
> = {
  nand2: { kind: 'nand' },
  nor2: { kind: 'nor' },
  and2: { kind: 'and' },
  or2: { kind: 'or' },
  xor2: { kind: 'xor' },
  not: { kind: 'not' },
  bcd7seg: { kind: 'bcd7seg' },
};

/** Per-part overrides on the generated gate, where one primitive serves two parts. */
const PART_PARAMS: Record<string, Record<string, ParamValue>> = {
  '74LS47': { activeLow: true },
};

const POWER_FNS = new Set(['vcc', 'gnd']);
const OUTPUT_FNS = (fn: string) => fn === 'y' || fn.startsWith('seg_');
const CONTROL_FNS = new Set(['lt', 'bi', 'rbi']);

const G = 8; // schematic grid; internals are laid out on it, not routed
const COL = 16 * G;
const ROW = 6 * G;

const portId = (pin: number) => `p${pin}`;
const gateId = (gate: number) => `u${gate}`;
const bufId = (pin: number) => `t${pin}`;

/** Stable per-def id; the internals are generated, so a counter is enough. */
function wire(id: string, a: Wire['a'], b: Wire['b']): Wire {
  return { id, a, b, points: [] };
}

const pinEnd = (component: string, pin: string): Wire['a'] => ({ kind: 'pin', component, pin });

function roleOf(fn: string): PinRole {
  return CONTROL_FNS.has(fn) ? 'enable' : 'data';
}

/**
 * Build one part's ChipDef.
 *
 * Every internal output goes through a `tristate` enabled by
 * `vcc AND NOT gnd`, so an unpowered chip floats its outputs to Z the way the
 * real part does. That needs no new compile rule and no new core semantics --
 * it costs three hidden components per chip, and a student who opens the chip
 * sees exactly why the rails have to be wired.
 */
export function buildPackageChipDef(entry: PackageEntry): ChipDef {
  const spec = PRIMITIVE_KINDS[entry.primitive];
  if (!spec) throw new Error(`no ComponentKind for package primitive '${entry.primitive}'`);
  const gateParams = { ...(spec.params ?? {}), ...(PART_PARAMS[entry.part] ?? {}) };

  const components: Component[] = [];
  const wires: Wire[] = [];
  const pins: PinDef[] = [];
  let seq = 0;
  const nextWire = (a: Wire['a'], b: Wire['b']) => wires.push(wire(`w${++seq}`, a, b));

  const sorted = [...entry.pins].sort((a, b) => a.pin - b.pin);
  const half = Math.ceil(sorted.length / 2);
  const vccPin = sorted.find((p) => p.fn === 'vcc');
  const gndPin = sorted.find((p) => p.fn === 'gnd');
  if (!vccPin || !gndPin) throw new Error(`${entry.part} has no VCC/GND pin`);

  // Ports down both sides in pin order, mirroring the physical package so the
  // opened chip reads like its own pinout diagram.
  for (const [i, p] of sorted.entries()) {
    const isOut = OUTPUT_FNS(p.fn);
    const left = i < half;
    components.push({
      id: portId(p.pin),
      kind: isOut ? 'outport' : 'inport',
      pos: { x: left ? 0 : 5 * COL, y: (left ? i : sorted.length - 1 - i) * ROW },
      label: p.name,
      params: { width: 1 },
    });
    pins.push({
      id: `pin-${p.pin}`,
      name: p.name,
      dir: isOut ? 'out' : 'in',
      width: 1,
      role: roleOf(p.fn),
      order: i,
      boundComponent: portId(p.pin),
    });
  }

  // powerOK = VCC AND NOT GND. Each rail is weakly pulled to its own
  // unpowered level, so a pin nobody wired reads as "not connected to the
  // rail" rather than unknown -- an undriven net is Z, and NOT(Z) is X, which
  // would otherwise make a chip with no rails output X instead of floating.
  components.push({ id: 'pwr_dn', kind: 'pulldown', pos: { x: 0, y: -2 * ROW } });
  components.push({ id: 'pwr_up', kind: 'pullup', pos: { x: 0, y: -3 * ROW } });
  components.push({ id: 'pwr_inv', kind: 'not', pos: { x: COL, y: -2 * ROW } });
  components.push({ id: 'pwr_ok', kind: 'and', pos: { x: 2 * COL, y: -2 * ROW } });
  nextWire(pinEnd(portId(vccPin.pin), 'y'), pinEnd('pwr_dn', 'p'));
  nextWire(pinEnd(portId(gndPin.pin), 'y'), pinEnd('pwr_up', 'p'));
  nextWire(pinEnd(portId(gndPin.pin), 'y'), pinEnd('pwr_inv', 'a'));
  nextWire(pinEnd('pwr_inv', 'y'), pinEnd('pwr_ok', 'b'));
  nextWire(pinEnd(portId(vccPin.pin), 'y'), pinEnd('pwr_ok', 'a'));

  for (let gate = 1; gate <= entry.gates; gate++) {
    const gatePins = sorted.filter((p) => p.gate === gate);
    if (gatePins.length === 0) throw new Error(`${entry.part} gate ${gate} has no pins`);
    components.push({
      id: gateId(gate),
      kind: spec.kind,
      pos: { x: 2 * COL, y: (gate - 1) * 4 * ROW },
      ...(Object.keys(gateParams).length > 0 ? { params: gateParams } : {}),
    });
    for (const p of gatePins) {
      if (POWER_FNS.has(p.fn)) continue;
      if (!OUTPUT_FNS(p.fn)) {
        nextWire(pinEnd(portId(p.pin), 'y'), pinEnd(gateId(gate), p.fn));
        continue;
      }
      components.push({
        id: bufId(p.pin),
        kind: 'tristate',
        pos: { x: 3 * COL, y: (gate - 1) * 4 * ROW },
      });
      nextWire(pinEnd(gateId(gate), p.fn), pinEnd(bufId(p.pin), 'a'));
      nextWire(pinEnd('pwr_ok', 'y'), pinEnd(bufId(p.pin), 'en'));
      nextWire(pinEnd(bufId(p.pin), 'y'), pinEnd(portId(p.pin), 'a'));
    }
  }

  return {
    format: 'lcir.chip',
    formatVersion: 3,
    id: entry.part,
    name: entry.part,
    version: 1,
    pins,
    components,
    wires,
    junctions: [],
    appearance: { package: entry.package },
  };
}

let cached: ReadonlyMap<string, ChipDef> | undefined;

/**
 * The read-only built-in library, merged under any user chips so a folder of
 * the instructor's own definitions can never be shadowed by a part number.
 */
export function builtinChipLibrary(): ReadonlyMap<string, ChipDef> {
  cached ??= new Map(file.packages.map((e) => [e.part, buildPackageChipDef(e)]));
  return cached;
}

export function isBuiltinChipId(id: string): boolean {
  return byPart.has(id);
}
