import { compile } from '../model/compile';
import type { Board, ChipLibrary, Component, Wire } from '../model/types';
import { board, comp, wire } from '../model/testFixtures';
import { toString } from '../value/busValue';
import { idealDelay } from '../sim/delay';
import { Simulator } from '../sim/kernel';
import { builtinChipLibrary } from './packages';

const builtins: ChipLibrary = builtinChipLibrary();

/** One chip on a board, its pins driven by toggles and read by probes. */
function chipBoard(
  part: string,
  drive: Record<string, boolean | null>,
  from: ChipLibrary = builtins,
): Board {
  const def = from.get(part)!;
  const comps: Component[] = [{ ...comp('u1', 'chip', undefined, 'U1'), defId: part }];
  const wires: Wire[] = [];
  let n = 0;
  for (const [pin, value] of Object.entries(drive)) {
    if (value === null) continue;
    const id = `t${++n}`;
    comps.push(comp(id, 'toggle', undefined, `IN${n}`));
    wires.push(wire(`wi${n}`, [id, 'y'], ['u1', pin]));
  }
  for (const pin of def.pins.filter((p) => p.dir === 'out')) {
    const id = `pr${++n}`;
    comps.push(comp(id, 'probe', undefined, pin.name));
    wires.push(wire(`wo${n}`, ['u1', pin.name], [id, 'a']));
  }
  return board({ components: comps, wires });
}

export function run(
  part: string,
  drive: Record<string, boolean | null>,
  from: ChipLibrary = builtins,
): (pin: string) => string {
  const sim = new Simulator(compile(chipBoard(part, drive, from), from), idealDelay);
  // powerOn re-runs every primitive's init, so the switches have to be set
  // after it, not before.
  sim.powerOn();
  for (const [pin, value] of Object.entries(drive)) {
    if (value === null) continue;
    const idx =
      Object.keys(drive)
        .filter((k) => drive[k] !== null)
        .indexOf(pin) + 1;
    sim.setToggle(`main/IN${idx}`, value);
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
export function bench(part: string, from: ChipLibrary = builtins): Bench {
  const def = from.get(part)!;
  const inputs = def.pins.filter((p) => p.dir === 'in').map((p) => p.name);
  const drive = Object.fromEntries(inputs.map((pin) => [pin, false]));
  const sim = new Simulator(compile(chipBoard(part, drive, from), from), idealDelay);
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
