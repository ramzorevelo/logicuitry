// Built-in 74-series ChipDefs, generated from the datasheet pinouts in
// packages.json. Generated rather than hand-authored so a pinout correction
// lands in one place; a committed golden per part keeps the output inspectable
// and catches drift (packages.test.ts).

import rawPackages from './packages.json';
import halfAdder from './chips/half-adder.chip.json';
import fullAdder from './chips/full-adder.chip.json';
import type { ChipDef, Component, ComponentKind, ParamValue, PinDef, Wire } from '../model/types';
import { getPart } from './partsDb';
import { getPrimitive } from '../sim/primitives/registry';
import type { PrimitivePin } from '../sim/primitives/types';

export interface PackagePin {
  pin: number;
  name: string;
  /** Section this pin belongs to: one, a list, or 'all' for a select, strobe,
   *  clock or clear that one package pin feeds to every section. Absent on
   *  chip-level pins (power, output enable, no-connect). */
  gate?: number | readonly number[] | 'all';
  /** The core primitive pin this wires to, or a chip-level role: 'vcc',
   *  'gnd', 'oe' (active-low output enable) or 'nc'. */
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
  /** Palette sub-heading and one-line caption under the part number. */
  group?: string;
  caption?: string;
  pins: PackagePin[];
}

/** The primitive that does a package section's work, with its params. */
export interface PackageCore {
  kind: ComponentKind;
  params?: Record<string, ParamValue>;
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
const PRIMITIVE_KINDS: Record<string, PackageCore> = {
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

// A package's pins are single lines, so a core's address bus is expanded.
const EXPANDED_ADDRESS = 'a=expanded';
const EXPANDED_ADDER = 'a=expanded;b=expanded;sum=expanded';
const EXPANDED_COMPARATOR = 'a=expanded;b=expanded';
const EXPANDED_COUNTER = 'd=expanded;q=expanded';

const COUNTER_74LS16X = {
  width: 4,
  hasLoad: true,
  dualEnable: true,
  activeLow: true,
  pinView: EXPANDED_COUNTER,
} as const;

/**
 * Parts whose core is a block primitive made faithful by hidden params. Only
 * this table sets them: a glue gate in the def would add its own datasheet
 * delay, and the chip would stop matching its datasheet.
 */
const PART_CORES: Record<string, PackageCore> = {
  '74LS138': {
    kind: 'decoder',
    params: {
      addressBits: 3,
      enablesHigh: 1,
      enablesLow: 2,
      activeLowOut: true,
      pinView: EXPANDED_ADDRESS,
    },
  },
  '74LS139': {
    kind: 'decoder',
    params: { addressBits: 2, enablesLow: 1, activeLowOut: true, pinView: EXPANDED_ADDRESS },
  },
  '74LS154': {
    kind: 'decoder',
    params: { addressBits: 4, enablesLow: 2, activeLowOut: true, pinView: EXPANDED_ADDRESS },
  },
  '74LS148': {
    kind: 'encoder',
    params: { addressBits: 3, activeLow: true, cascade: true, pinView: EXPANDED_ADDRESS },
  },
  '74LS151': { kind: 'mux', params: { selectBits: 3, strobeLow: true, invertedOut: true } },
  '74LS153': { kind: 'mux', params: { selectBits: 2, strobeLow: true } },
  '74LS157': { kind: 'mux', params: { selectBits: 1, strobeLow: true } },
  '74LS283': { kind: 'adder', params: { pinView: EXPANDED_ADDER } },
  '74LS85': { kind: 'comparator', params: { hasCascade: true, pinView: EXPANDED_COMPARATOR } },
  '74LS280': { kind: 'parity' },
  '74LS74': { kind: 'dff', params: { asyncSet: true, asyncClear: true } },
  '74LS175': { kind: 'dff', params: { asyncClear: true } },
  '74LS273': { kind: 'dff', params: { asyncClear: true } },
  '74LS374': { kind: 'dff' },
  '74LS377': { kind: 'register', params: { enableLow: true } },
  '74LS161': { kind: 'counter', params: { ...COUNTER_74LS16X, clear: 'async' } },
  '74LS163': { kind: 'counter', params: { ...COUNTER_74LS16X, clear: 'sync' } },
  '74LS164': {
    kind: 'shiftreg',
    params: {
      width: 8,
      serialAnd: true,
      clear: 'async',
      activeLow: true,
      pinView: 'q=expanded',
    },
  },
  '74LS165': {
    kind: 'shiftreg',
    params: {
      width: 8,
      hasLoad: true,
      asyncLoad: true,
      clockInhibit: true,
      invertedOut: true,
      activeLow: true,
      parallelOut: false,
      pinView: 'd=expanded',
    },
  },
};

/** The core a part number is built on, before any packages.json entry exists for it. */
export function partCore(part: string): PackageCore | undefined {
  return PART_CORES[part];
}

const OUTPUT_ENABLE_FN = 'oe';
const CHIP_LEVEL_FNS = new Set(['vcc', 'gnd', 'nc', OUTPUT_ENABLE_FN]);

export function packageCore(entry: PackageEntry): PackageCore {
  const faithful = PART_CORES[entry.part];
  if (faithful) return faithful;
  const spec = PRIMITIVE_KINDS[entry.primitive];
  if (!spec) throw new Error(`no ComponentKind for package primitive '${entry.primitive}'`);
  return {
    kind: spec.kind,
    params: { ...(spec.params ?? {}), ...(PART_PARAMS[entry.part] ?? {}) },
  };
}

function sectionsOf(p: PackagePin, sections: number): readonly number[] {
  if (p.gate === undefined) return [];
  if (p.gate === 'all') return Array.from({ length: sections }, (_, i) => i + 1);
  return typeof p.gate === 'number' ? [p.gate] : p.gate;
}

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

// Power gate and output buffers exist to float an unpowered chip, not to model
// silicon: marked so neither the sim nor timing analysis charges them a delay.
const STRUCTURAL = { delay: 'none' } as const;

const pinEnd = (component: string, pin: string): Wire['a'] => ({ kind: 'pin', component, pin });

/**
 * Build one part's ChipDef.
 *
 * Every internal output goes through a `tristate` enabled by
 * `vcc AND NOT gnd`, so an unpowered chip floats its outputs to Z the way the
 * real part does. That needs no new compile rule and no new core semantics --
 * it costs three hidden components per chip, and a student who opens the chip
 * sees exactly why the rails have to be wired.
 */
export function buildPackageChipDef(
  entry: PackageEntry,
  core: PackageCore = packageCore(entry),
): ChipDef {
  const primitive = getPrimitive(core.kind);
  const gateParams: Record<string, ParamValue> = { ...(core.params ?? {}) };
  // A primitive that serves several parts binds one by default (a decoder is
  // a '138); name the part wherever that default would take another's rows.
  const defaultPart =
    typeof primitive.defaultPart === 'function'
      ? primitive.defaultPart(gateParams)
      : primitive.defaultPart;
  if (defaultPart !== entry.part) gateParams['part'] = entry.part;
  const corePins = new Map(primitive.pins(gateParams).map((p) => [p.name, p]));
  const corePin = (p: PackagePin): PrimitivePin | undefined => {
    if (CHIP_LEVEL_FNS.has(p.fn)) return undefined;
    const pin = corePins.get(p.fn);
    if (!pin) throw new Error(`${entry.part} pin ${p.pin}: ${core.kind} has no pin '${p.fn}'`);
    if (pin.width !== 1)
      throw new Error(`${entry.part} pin ${p.pin}: ${core.kind} pin '${p.fn}' is a bus`);
    return pin;
  };

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
  const oePin = sorted.find((p) => p.fn === OUTPUT_ENABLE_FN);

  // Ports down both sides in pin order, mirroring the physical package so the
  // opened chip reads like its own pinout diagram.
  for (const [i, p] of sorted.entries()) {
    const fn = corePin(p);
    const isOut = fn?.dir === 'out';
    if (isOut && sectionsOf(p, entry.gates).length !== 1)
      throw new Error(`${entry.part} pin ${p.pin}: an output belongs to exactly one section`);
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
      role: fn?.role ?? (p.fn === OUTPUT_ENABLE_FN ? 'enable' : 'data'),
      order: i,
      boundComponent: portId(p.pin),
    });
  }

  // powerOK = VCC AND NOT GND. Each rail is weakly pulled to its own
  // unpowered level, so a pin nobody wired reads as "not connected to the
  // rail" rather than unknown -- an undriven net is Z, and NOT(Z) is X, which
  // would otherwise make a chip with no rails output X instead of floating.
  components.push({
    id: 'pwr_dn',
    kind: 'pulldown',
    pos: { x: 0, y: -2 * ROW },
    params: STRUCTURAL,
  });
  components.push({ id: 'pwr_up', kind: 'pullup', pos: { x: 0, y: -3 * ROW }, params: STRUCTURAL });
  components.push({ id: 'pwr_inv', kind: 'not', pos: { x: COL, y: -2 * ROW }, params: STRUCTURAL });
  components.push({
    id: 'pwr_ok',
    kind: 'and',
    pos: { x: 2 * COL, y: -2 * ROW },
    params: STRUCTURAL,
  });
  nextWire(pinEnd(portId(vccPin.pin), 'y'), pinEnd('pwr_dn', 'p'));
  nextWire(pinEnd(portId(gndPin.pin), 'y'), pinEnd('pwr_up', 'p'));
  nextWire(pinEnd(portId(gndPin.pin), 'y'), pinEnd('pwr_inv', 'a'));
  nextWire(pinEnd('pwr_inv', 'y'), pinEnd('pwr_ok', 'b'));
  nextWire(pinEnd(portId(vccPin.pin), 'y'), pinEnd('pwr_ok', 'a'));

  // An active-low output enable gates every output buffer at once, so it is
  // one term per chip beside the power gate, never a gate per output.
  let bufferEnable = 'pwr_ok';
  if (oePin) {
    components.push({
      id: 'oe_inv',
      kind: 'not',
      pos: { x: COL, y: -4 * ROW },
      params: STRUCTURAL,
    });
    components.push({
      id: 'oe_ok',
      kind: 'and',
      pos: { x: 2 * COL, y: -4 * ROW },
      params: STRUCTURAL,
    });
    nextWire(pinEnd(portId(oePin.pin), 'y'), pinEnd('oe_inv', 'a'));
    nextWire(pinEnd('pwr_ok', 'y'), pinEnd('oe_ok', 'a'));
    nextWire(pinEnd('oe_inv', 'y'), pinEnd('oe_ok', 'b'));
    bufferEnable = 'oe_ok';
  }

  for (let gate = 1; gate <= entry.gates; gate++) {
    const gatePins = sorted.filter((p) => sectionsOf(p, entry.gates).includes(gate));
    if (gatePins.length === 0) throw new Error(`${entry.part} gate ${gate} has no pins`);
    components.push({
      id: gateId(gate),
      kind: core.kind,
      pos: { x: 2 * COL, y: (gate - 1) * 4 * ROW },
      ...(Object.keys(gateParams).length > 0 ? { params: gateParams } : {}),
    });
    for (const p of gatePins) {
      if (corePin(p)?.dir !== 'out') {
        nextWire(pinEnd(portId(p.pin), 'y'), pinEnd(gateId(gate), p.fn));
        continue;
      }
      components.push({
        id: bufId(p.pin),
        kind: 'tristate',
        pos: { x: 3 * COL, y: (gate - 1) * 4 * ROW },
        params:
          oePin && getPart(entry.part)?.enable
            ? { ...STRUCTURAL, enableTiming: entry.part }
            : STRUCTURAL,
      });
      nextWire(pinEnd(gateId(gate), p.fn), pinEnd(bufId(p.pin), 'a'));
      nextWire(pinEnd(bufferEnable, 'y'), pinEnd(bufId(p.pin), 'en'));
      nextWire(pinEnd(bufId(p.pin), 'y'), pinEnd(portId(p.pin), 'a'));
    }
  }

  return {
    format: 'lcir.chip',
    formatVersion: 5,
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

// Built-ins that are not packages (openable gate-level teaching chips) are
// hand-authored .chip.json files, listed here to join the same library.
const HAND_AUTHORED = [halfAdder, fullAdder] as readonly ChipDef[];

let cached: ReadonlyMap<string, ChipDef> | undefined;

/** The read-only built-in library every board starts from. */
export function builtinChipLibrary(): ReadonlyMap<string, ChipDef> {
  cached ??= new Map([
    ...file.packages.map((e): [string, ChipDef] => [e.part, buildPackageChipDef(e)]),
    ...HAND_AUTHORED.map((d): [string, ChipDef] => [d.id, d]),
  ]);
  return cached;
}

export function isBuiltinChipId(id: string): boolean {
  return builtinChipLibrary().has(id);
}

/**
 * Built-in is a fact about the def object, not its id: a user chip saved
 * under a part number replaces that part on the board, and must then behave
 * as the user's own (editable, listed with their chips).
 */
export function isBuiltinChipDef(def: ChipDef): boolean {
  return builtinChipLibrary().get(def.id) === def;
}
