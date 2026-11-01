import { compile } from '../model/compile';
import type { Board, ChipLibrary, Component, Wire } from '../model/types';
import { board, comp, wire } from '../model/testFixtures';
import { toString } from '../value/busValue';
import { idealDelay, type DelayModel } from '../sim/delay';
import { Simulator } from '../sim/kernel';
import { builtinChipLibrary } from './packages';

const builtins: ChipLibrary = builtinChipLibrary();

/** A pin's drive: a switch level, 'x' for an unknown driver, null for unwired. */
export type Drive = boolean | 'x' | null;

/**
 * One chip on a board, its pins driven by toggles and read by probes. An
 * inout pin always gets a probe, so a row can drive it or read it.
 */
function chipBoard(part: string, drive: Record<string, Drive>, from: ChipLibrary): Board {
  const def = from.get(part)!;
  const comps: Component[] = [{ ...comp('u1', 'chip', undefined, 'U1'), defId: part }];
  const wires: Wire[] = [];
  let n = 0;
  for (const [pin, value] of Object.entries(drive)) {
    if (value === null) continue;
    if (value === 'x') {
      // A NOT with a floating input is the plainest source of a driven X.
      const id = `x${++n}`;
      comps.push(comp(id, 'not'));
      wires.push(wire(`wx${n}`, [id, 'y'], ['u1', pin]));
      continue;
    }
    const id = `t${++n}`;
    comps.push(comp(id, 'toggle', undefined, toggleLabel(drive, pin)));
    wires.push(wire(`wi${n}`, [id, 'y'], ['u1', pin]));
  }
  for (const pin of def.pins.filter((p) => p.dir === 'out' || p.dir === 'inout')) {
    const id = `pr${++n}`;
    comps.push(comp(id, 'probe', undefined, pin.name));
    wires.push(wire(`wo${n}`, ['u1', pin.name], [id, 'a']));
  }
  return board({ components: comps, wires });
}

/** Switches are numbered IN1.. in drive order, counting only switch-driven pins. */
function toggleLabel(drive: Record<string, Drive>, pin: string): string {
  const switched = Object.keys(drive).filter((k) => typeof drive[k] === 'boolean');
  return `IN${switched.indexOf(pin) + 1}`;
}

export function run(
  part: string,
  drive: Record<string, Drive>,
  from: ChipLibrary = builtins,
  delay: DelayModel = idealDelay,
): (pin: string) => string {
  const sim = new Simulator(compile(chipBoard(part, drive, from), from), delay);
  // powerOn re-runs every primitive's init, so the switches have to be set
  // after it, not before.
  sim.powerOn();
  for (const [pin, value] of Object.entries(drive)) {
    if (typeof value === 'boolean') sim.setToggle(`main/${toggleLabel(drive, pin)}`, value);
  }
  sim.settle();
  return (pin: string) => toString(sim.netValueByPath(`main/${pin}`), 1);
}

export interface Bench {
  /** Drive one package input and let the board settle. */
  set(pin: string, level: boolean): void;
  read(pin: string): string;
}

/**
 * A powered chip whose every input has its own switch, kept live between
 * changes so a sequential part can be stepped. Inputs start low.
 */
export function bench(
  part: string,
  from: ChipLibrary = builtins,
  delay: DelayModel = idealDelay,
): Bench {
  const def = from.get(part)!;
  const inputs = def.pins.filter((p) => p.dir === 'in').map((p) => p.name);
  const drive = Object.fromEntries(inputs.map((pin) => [pin, false]));
  const sim = new Simulator(compile(chipBoard(part, drive, from), from), delay);
  sim.powerOn();
  const set = (pin: string, level: boolean) => {
    const at = inputs.indexOf(pin);
    if (at < 0) throw new Error(`${part} has no input ${pin}`);
    sim.setToggle(`main/IN${at + 1}`, level);
    sim.settle();
  };
  set('VCC', true);
  return { set, read: (pin) => toString(sim.netValueByPath(`main/${pin}`), 1) };
}
