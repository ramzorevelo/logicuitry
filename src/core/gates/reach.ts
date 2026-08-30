// Per-output analysis support: which table inputs actually
// reach a given output, and same-net terminal dedup so a switch wired straight
// to an In port reads as one variable, not two.

import type { CompiledCircuit } from '../model/compile';
import { parseBitPath, resolveInputNet, resolveOutputNet } from '../boolean/truthTable';

/** Kinds whose output bit b depends only on bit b of each input (parallel
 *  1-bit lanes); everything else is treated as full bit crossover. */
const LANE_PRESERVING: ReadonlySet<string> = new Set([
  'and',
  'or',
  'nand',
  'nor',
  'xor',
  'xnor',
  'not',
  'buf',
]);

const bitKey = (net: number, bit: number) => net * 33 + bit;

/** Input bit-columns (`path` or `path[b]`) reaching `outputPath`'s addressed
 *  bit, via reverse BFS over (net, bit) pairs -- lane-preserving primitives
 *  keep the bit index, all others pull every bit of every input. */
export function reachableInputBits(
  circuit: CompiledCircuit,
  inputCols: readonly string[],
  outputCol: string,
): string[] {
  const out = parseBitPath(outputCol);
  const visited = new Set<number>();
  const queue: { net: number; bit: number }[] = [
    { net: resolveOutputNet(circuit, out.base), bit: out.bit ?? 0 },
  ];
  visited.add(bitKey(queue[0]!.net, queue[0]!.bit));
  while (queue.length > 0) {
    const { net, bit } = queue.pop()!;
    for (const prim of circuit.primitives) {
      if (!prim.outputs.includes(net)) continue;
      const lanes = LANE_PRESERVING.has(prim.kind);
      for (const inNet of prim.inputs) {
        const w = circuit.nets[inNet]!.width;
        const bits = lanes ? (bit < w ? [bit] : []) : Array.from({ length: w }, (_, b) => b);
        for (const b of bits) {
          const key = bitKey(inNet, b);
          if (visited.has(key)) continue;
          visited.add(key);
          queue.push({ net: inNet, bit: b });
        }
      }
    }
  }
  return inputCols.filter((p) => {
    const { base, bit } = parseBitPath(p);
    return visited.has(bitKey(resolveInputNet(circuit, base), bit ?? 0));
  });
}

export interface TerminalRef {
  path: string;
  /** Component kind ('inport'/'outport' beats device kinds in dedup). */
  kind: string;
  /** Explicit user label present (wins dedup outright). */
  labeled: boolean;
}

/** One representative terminal per resolved net: labeled first, then pure
 *  ports over device kinds, then id order (deterministic). */
export function dedupTerminals(
  circuit: CompiledCircuit,
  terminals: readonly TerminalRef[],
  resolve: (circuit: CompiledCircuit, path: string) => number,
): TerminalRef[] {
  const rank = (t: TerminalRef): number =>
    (t.labeled ? 0 : 2) + (t.kind === 'inport' || t.kind === 'outport' ? 0 : 1);
  const byNet = new Map<number, TerminalRef>();
  const order: number[] = [];
  for (const t of terminals) {
    const net = resolve(circuit, t.path);
    const cur = byNet.get(net);
    if (!cur) {
      byNet.set(net, t);
      order.push(net);
    } else if (rank(t) < rank(cur)) {
      byNet.set(net, t);
    }
  }
  return order.map((n) => byNet.get(n)!);
}
