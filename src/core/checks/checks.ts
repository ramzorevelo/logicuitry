// Circuit checks: findings about one circuit level, grouped into the Checks tab's
// rows. Compile refusals and live findings become rows here too, so all read alike.

import type { ChipLibrary, Circuit, Component } from '../model/types';
import type { CompiledCircuit } from '../model/compile';
import { componentPaths } from '../model/compile';
import { pinNet } from '../model/pinNet';
import {
  circuitNets,
  componentNetPins,
  isDriver,
  isReader,
  packagePins,
  pinRef,
  type CheckNet,
  type NetPin,
} from './nets';

export type CheckSeverity = 'error' | 'warning' | 'info';

/** Pin-level kinds carry a hide key per pin; the rest are rows of their own. */
export type CheckKind =
  | 'unwired'
  | 'undriven'
  | 'power'
  | 'float'
  | 'unused'
  | 'compile'
  | 'fight'
  | 'oscillation';

/** One hideable fact: a pin, or a net keyed by its lowest pin. */
export interface CheckFinding {
  kind: Extract<CheckKind, 'unwired' | 'undriven' | 'power' | 'float' | 'unused'>;
  /** `kind:component.pin`, the form `hiddenChecks` stores. */
  key: string;
  component: string;
  pin: string;
  /** The finding's net; a float finding is about the whole net. */
  net: CheckNet;
}

export interface CheckRow {
  /** Stable while the row means the same thing: React key and selection. */
  id: string;
  kind: CheckKind;
  severity: CheckSeverity;
  title: string;
  detail?: string;
  /** Hide keys the row covers; empty for rows that cannot be hidden. */
  keys: string[];
  /** What a click selects. */
  components: string[];
  wires: string[];
  /** Pins a canvas marker rings, as `{component, pin}`. */
  pins: { component: string; pin: string }[];
  live?: boolean;
}

const SEVERITY: Record<CheckKind, CheckSeverity> = {
  compile: 'error',
  unwired: 'warning',
  undriven: 'warning',
  power: 'warning',
  float: 'warning',
  fight: 'warning',
  oscillation: 'warning',
  unused: 'info',
};

const SEVERITY_ORDER: Record<CheckSeverity, number> = { error: 0, warning: 1, info: 2 };

/** Kinds whose outputs are plumbing, not signals anyone forgot to use. */
const UNUSED_EXEMPT = new Set([
  'vcc',
  'gnd',
  'pullup',
  'pulldown',
  'netlabel',
  'tunnel',
  'tapdrive',
  'tapread',
  'split',
  'merge',
]);

/** Parts whose outputs float only while an output-enable pin is high: with
 *  every enable tied to GND they drive like plain outputs. */
const ENABLE_ONLY_FLOAT = new Set(['74LS173', '74LS374']);

export const checkKey = (kind: string, component: string, pin: string) =>
  `${kind}:${pinRef(component, pin)}`;

/** The net's pin a net-level key is anchored to: lowest by string compare,
 *  so the key survives a relabel and does not depend on board order. */
function anchorPin(net: CheckNet): NetPin | undefined {
  let best: NetPin | undefined;
  for (const p of net.pins)
    if (!best || pinRef(p.component, p.pin) < pinRef(best.component, best.pin)) best = p;
  return best;
}

/** Every static finding on one circuit level, hidden or not. */
export function staticFindings(circuit: Circuit, lib: ChipLibrary): CheckFinding[] {
  const { nets, byPin } = circuitNets(circuit, lib);
  const out: CheckFinding[] = [];
  const add = (kind: CheckFinding['kind'], p: NetPin, net: CheckNet) =>
    out.push({
      kind,
      key: checkKey(kind, p.component, p.pin),
      component: p.component,
      pin: p.pin,
      net,
    });
  const byId = new Map(circuit.components.map((c) => [c.id, c]));

  for (const comp of circuit.components) {
    for (const p of componentNetPins(comp, lib)) {
      const net = byPin.get(pinRef(comp.id, p.pin))!;
      const others = net.pins.filter((o) => o.component !== p.component || o.pin !== p.pin);
      if (p.supply) {
        if (!others.some(isDriver)) add('power', p, net);
        continue;
      }
      if (p.dir === 'in' && !p.pull && !p.openOk) {
        if (others.length === 0) add('unwired', p, net);
        else if (!others.some((o) => isDriver(o) || o.pull)) add('undriven', p, net);
      }
      if (p.dir === 'out' && !UNUSED_EXEMPT.has(comp.kind) && !others.some(isReader))
        add('unused', p, net);
    }
  }

  const floats = (p: NetPin) => p.floats && !(p.dir === 'out' && alwaysEnabled(p.component));
  const alwaysEnabled = (id: string): boolean => {
    const c = byId.get(id);
    const def = c?.kind === 'chip' && c.defId ? lib.get(c.defId) : undefined;
    if (!def || !ENABLE_ONLY_FLOAT.has(def.id)) return false;
    const enables = [...(packagePins(def) ?? [])].filter(([, p]) => p.fn === 'oe');
    return enables.every(([name]) =>
      byPin.get(pinRef(id, name))!.pins.some((o) => byId.get(o.component)?.kind === 'gnd'),
    );
  };
  for (const net of nets) {
    const drivers = net.pins.filter(isDriver);
    if (drivers.length === 0 || !drivers.every(floats)) continue;
    if (net.pins.some((p) => p.pull) || net.pins.length < 2) continue;
    const readers = net.pins.filter(isReader);
    // A display segment on an open-collector '47 is the circuit the part is for.
    if (readers.length === 0 || readers.every((p) => byId.get(p.component)?.kind === 'sevenseg'))
      continue;
    add('float', anchorPin(net)!, net);
  }
  return out;
}

interface Namer {
  /** `U1 74LS08`, `alu/U4`, `g3`: the component as the row names it. */
  part(id: string): string;
  /** `pin 12` on a package, the pin's name elsewhere. */
  pins(id: string, pins: string[]): string;
  /** The net by its label, or by the pin it is anchored to. */
  net(net: CheckNet): string;
}

function namer(circuit: Circuit, lib: ChipLibrary): Namer {
  const byId = new Map(circuit.components.map((c) => [c.id, c]));
  const groups = new Map((circuit.groups ?? []).map((g) => [g.id, g.name]));
  const shown = (c: Component) => {
    const scope = c.group ? `${groups.get(c.group) ?? c.group}/` : '';
    return scope + (c.label || c.id);
  };
  const pkgOf = (c: Component | undefined) =>
    c?.kind === 'chip' && c.defId ? packagePins(lib.get(c.defId)) : undefined;
  const pins = (id: string, names: string[]) => {
    const pkg = pkgOf(byId.get(id));
    if (!pkg) return `${names.length > 1 ? 'pins' : 'pin'} ${names.join(', ')}`;
    const numbers = names.map((n) => pkg.get(n)?.number ?? 0).sort((a, b) => a - b);
    return `${numbers.length > 1 ? 'pins' : 'pin'} ${numbers.join(', ')}`;
  };
  return {
    part: (id) => {
      const c = byId.get(id);
      if (!c) return id;
      const def = c.kind === 'chip' && c.defId ? lib.get(c.defId) : undefined;
      return def ? `${shown(c)} ${def.name}` : shown(c);
    },
    pins,
    net: (net) => {
      if (net.name) return net.name;
      const a = anchorPin(net);
      if (!a) return 'net';
      const c = byId.get(a.component);
      return `at ${c ? shown(c) : a.component} ${pins(a.component, [a.pin])}`;
    },
  };
}

/** Findings minus the hidden ones, grouped into rows: one per component per
 *  kind, one per net for floats. Hidden findings come back as rows of their
 *  own, for the Show hidden list. */
export function checkRows(
  findings: readonly CheckFinding[],
  hidden: ReadonlySet<string>,
  circuit: Circuit,
  lib: ChipLibrary,
): { shown: CheckRow[]; hidden: CheckRow[] } {
  const name = namer(circuit, lib);
  const group = (list: readonly CheckFinding[]): CheckRow[] => {
    const rows = new Map<string, CheckFinding[]>();
    for (const f of list) {
      const id = f.kind === 'float' ? f.key : `${f.kind}:${f.component}`;
      const row = rows.get(id);
      if (row) row.push(f);
      else rows.set(id, [f]);
    }
    return [...rows].map(([id, fs]) => findingRow(id, fs, name, circuit, lib));
  };
  return {
    shown: sortRows(group(findings.filter((f) => !hidden.has(f.key)))),
    hidden: sortRows(group(findings.filter((f) => hidden.has(f.key)))),
  };
}

function findingRow(
  id: string,
  fs: CheckFinding[],
  name: Namer,
  circuit: Circuit,
  lib: ChipLibrary,
): CheckRow {
  const f = fs[0]!;
  const keys = fs.map((x) => x.key);
  const base = { id, kind: f.kind, severity: SEVERITY[f.kind], keys };
  const pinList = fs.map((x) => x.pin);
  const onPins = fs.map((x) => ({ component: x.component, pin: x.pin }));
  const isPackage = !!packagePins(componentDef(circuit, lib, f.component));
  switch (f.kind) {
    case 'float':
      return {
        ...base,
        title: `Net ${name.net(f.net)} can float`,
        detail: 'Only three-state drivers. Add a pull-up or pull-down.',
        components: [],
        wires: f.net.wires,
        pins: [],
      };
    case 'power': {
      const pkg = packagePins(componentDef(circuit, lib, f.component));
      const rails = fs.map((x) => `${x.pin} (pin ${pkg?.get(x.pin)?.number ?? '?'})`).join(', ');
      return {
        ...base,
        title: `${name.part(f.component)}: ${rails} not wired`,
        detail: 'Its outputs float.',
        components: [f.component],
        wires: [],
        pins: onPins,
      };
    }
    case 'unwired':
    case 'undriven':
      return {
        ...base,
        title: `${name.part(f.component)}: ${name.pins(f.component, pinList)} not ${f.kind === 'unwired' ? 'wired' : 'driven'}`,
        detail:
          f.kind === 'undriven'
            ? 'Wired only to other inputs. Reads X.'
            : isPackage
              ? 'Reads X. A real chip drifts high.'
              : 'Reads X.',
        components: [f.component],
        wires: [],
        pins: onPins,
      };
    case 'unused':
      return {
        ...base,
        title: `${name.part(f.component)}: ${name.pins(f.component, pinList)} ${fs.length > 1 ? 'drive' : 'drives'} nothing`,
        components: [f.component],
        wires: [],
        pins: onPins,
      };
  }
}

function componentDef(circuit: Circuit, lib: ChipLibrary, id: string) {
  const c = circuit.components.find((x) => x.id === id);
  return c?.kind === 'chip' && c.defId ? lib.get(c.defId) : undefined;
}

export function sortRows(rows: CheckRow[]): CheckRow[] {
  return rows.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/** Components a compile path or a pin token names: `main/U1`, `main/alu/U4.y`,
 *  `main/U1:74LS08/t3`. The longest component path that prefixes it wins. */
function componentsNamed(circuit: Circuit, tokens: readonly string[]): string[] {
  const paths = componentPaths(circuit, 'main/');
  const found = new Set<string>();
  for (const token of tokens) {
    let best: { id: string; len: number } | undefined;
    for (const [id, path] of paths) {
      const fits = token === path || ['.', ':', '/'].some((s) => token.startsWith(path + s));
      if (fits && path.length > (best?.len ?? -1)) best = { id, len: path.length };
    }
    if (best) found.add(best.id);
  }
  return [...found];
}

const sentence = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** The one error row a compile refusal makes, located by its path and by any
 *  pins its message names. */
export function compileErrorRow(
  circuit: Circuit,
  error: { message: string; path: string },
): CheckRow {
  const tokens = error.message.match(/main\/[^\s,;]+/g) ?? [];
  const text = error.message.replace(/main\//g, '');
  const [head, ...rest] = text.split('; ');
  return {
    id: 'compile',
    kind: 'compile',
    severity: 'error',
    title: sentence(head ?? text),
    detail: rest.length > 0 ? `${sentence(rest.join('; '))}.` : 'The board will not power.',
    keys: [],
    components: componentsNamed(circuit, [error.path, ...tokens]),
    wires: [],
    pins: [],
  };
}

/** Rows for nets the running sim reports as fighting, located on this
 *  circuit level through `prefix` (a def tab reads the board's sim). */
export function fightRows(
  circuit: Circuit,
  lib: ChipLibrary,
  compiled: CompiledCircuit,
  fighting: readonly number[],
  prefix = 'main/',
): CheckRow[] {
  if (fighting.length === 0) return [];
  const { byPin } = circuitNets(circuit, lib);
  const wanted = new Set(fighting);
  const local = new Map<number, CheckNet>();
  const paths = componentPaths(circuit, prefix);
  for (const comp of circuit.components) {
    for (const p of componentNetPins(comp, lib)) {
      const n = pinNet(compiled, comp, p.pin, prefix, paths.get(comp.id));
      if (n === undefined || !wanted.has(n) || local.has(n)) continue;
      local.set(n, byPin.get(pinRef(comp.id, p.pin))!);
    }
  }
  const name = namer(circuit, lib);
  return fighting.flatMap((n): CheckRow[] => {
    const net = local.get(n);
    if (!net) return [];
    return [
      {
        id: `fight:${n}`,
        kind: 'fight',
        severity: 'warning',
        title: `Three-state fight on ${name.net(net)}`,
        detail: 'Two enabled drivers disagree.',
        keys: [],
        components: [],
        wires: net.wires,
        pins: [],
        live: true,
      },
    ];
  });
}

export function oscillationRow(nets: readonly string[]): CheckRow {
  return {
    id: 'oscillation',
    kind: 'oscillation',
    severity: 'warning',
    title: 'Oscillating: the loop never settles',
    ...(nets.length > 0 ? { detail: nets.join(', ') } : {}),
    keys: [],
    components: [],
    wires: [],
    pins: [],
    live: true,
  };
}

/** `hiddenChecks` minus keys whose component or pin is gone. A chip whose def
 *  is not loaded yet keeps its keys: its pins are unknown, not gone. */
export function pruneHiddenChecks(circuit: Circuit, lib: ChipLibrary): string[] | undefined {
  const keys = circuit.hiddenChecks;
  if (!keys) return keys;
  const byId = new Map(circuit.components.map((c) => [c.id, c]));
  const kept = keys.filter((key) => {
    const ref = parseCheckKey(key);
    const comp = ref && byId.get(ref.component);
    if (!comp) return false;
    if (comp.kind === 'chip' && !(comp.defId && lib.get(comp.defId))) return true;
    return componentNetPins(comp, lib).some((p) => p.pin === ref.pin);
  });
  if (kept.length === keys.length) return keys;
  return kept.length > 0 ? kept : undefined;
}

export function parseCheckKey(
  key: string,
): { kind: string; component: string; pin: string } | null {
  const m = /^([a-z]+):([^.]+)\.(.+)$/.exec(key);
  return m ? { kind: m[1]!, component: m[2]!, pin: m[3]! } : null;
}
