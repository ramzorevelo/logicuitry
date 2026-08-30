// Web Worker hosting ngspice (eecircuit-engine, wasm). Runs one DC sweep at a
// time off the main thread and posts back a lightweight column result. Lives at
// the UI boundary, not in src/core, because it touches worker/wasm globals.

import { Simulation } from 'eecircuit-engine';
import type {
  SpiceRequest,
  SpiceResponse,
  SpiceResult,
} from '../../../core/spice/eecircuit/protocol';

// self typed as Worker gives the right postMessage/onmessage shapes without
// pulling the webworker lib globally (tsconfig ships DOM lib).
const ctx = self as unknown as Worker;

const sim = new Simulation();
let startup: Promise<void> | null = null;
// Serialize runs: eecircuit holds one netlist/result at a time.
let queue: Promise<void> = Promise.resolve();

async function run(req: SpiceRequest): Promise<void> {
  try {
    if (!startup) startup = sim.start();
    await startup;
    sim.setNetList(req.netlist);
    const raw = await sim.runSim();
    if (raw.dataType !== 'real') throw new Error(`unexpected ${raw.dataType} result`);
    const result: SpiceResult = {
      variableNames: raw.variableNames,
      columns: raw.data.map((d) => ({ name: d.name, values: d.values })),
    };
    ctx.postMessage({ id: req.id, ok: true, result } satisfies SpiceResponse);
  } catch (err) {
    const detail = sim.getError?.() ?? [];
    const msg = `${err instanceof Error ? err.message : String(err)}${detail.length ? ` (${detail.join('; ')})` : ''}`;
    ctx.postMessage({ id: req.id, ok: false, error: msg } satisfies SpiceResponse);
  }
}

ctx.onmessage = (e: MessageEvent<SpiceRequest>) => {
  const req = e.data;
  queue = queue.then(() => run(req));
};
