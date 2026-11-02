import type { CompiledCircuit } from '../../core/model/compile';
import type { SettleReport } from '../../core/sim/kernel';

const TOP = 'main/';
const AUTO_NET = /^n\d+$/;
const MAX_NAMED = 3;

/** Up to three of a loop's nets, each by its label, else a part pin on it, else
 *  the part driving it: a gate's own output net carries only an auto name. */
export function loopNetNames(c: CompiledCircuit, nets: readonly number[]): string[] {
  const names = new Set<string>();
  for (const n of nets) {
    const name = netName(c, n);
    if (name) names.add(name);
    if (names.size === MAX_NAMED) break;
  }
  // A loop wholly inside a chip still names the instance it runs in.
  if (names.size === 0) {
    for (const n of nets) names.add(c.nets[n]!.paths[0]!.slice(TOP.length).split(/[/:]/)[0]!);
  }
  return [...names].slice(0, MAX_NAMED);
}

function netName(c: CompiledCircuit, n: number): string | undefined {
  const top = c.nets[n]!.paths.filter((p) => p.startsWith(TOP) && !p.includes('/', TOP.length)).map(
    (p) => p.slice(TOP.length),
  );
  if (top.length === 0) return undefined;
  const named = top.filter((p) => !AUTO_NET.test(p));
  const driver = c.drivers[n]?.[0];
  const part = driver && c.primitives[driver.prim]!.path.slice(TOP.length).split(/[/:]/)[0];
  return named.find((p) => !p.includes('.')) ?? named[0] ?? (part || undefined);
}

/** The loop a settle could not quiet, or null when it went quiet. */
export function loopOf(c: CompiledCircuit, report: SettleReport): string[] | null {
  return report.oscillation ? loopNetNames(c, report.oscillation.nets) : null;
}
