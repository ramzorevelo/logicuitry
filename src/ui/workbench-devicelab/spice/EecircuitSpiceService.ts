// SpiceService backed by ngspice in a Web Worker (lazy-spawned on first sweep).
// On any failure it latches to the numeric fallback for the rest of the session
// so a live lecture never flaps between real and fallback curves.

import { resultToSweep } from '../../../core/spice/eecircuit/resultToSweep';
import type {
  SpiceRequest,
  SpiceResponse,
  SpiceResult,
} from '../../../core/spice/eecircuit/protocol';
import { inverterNetlist } from '../../../core/spice/netlists/inverter';
import { NumericSpiceService } from '../../../core/spice/numericService';
import type { InverterParams, SpiceService, SweepResult } from '../../../core/spice/types';

export class EecircuitSpiceService implements SpiceService {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<
    number,
    { resolve: (r: SpiceResult) => void; reject: (e: Error) => void }
  >();
  private readonly numeric = new NumericSpiceService();
  private degraded = false;

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./eecircuit.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (e: MessageEvent<SpiceResponse>) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data.result);
      else p.reject(new Error(e.data.error));
    };
    worker.onerror = (e) => this.degrade(e.message || 'worker error');
    this.worker = worker;
    return worker;
  }

  private degrade(reason: string): void {
    if (this.degraded) return;
    this.degraded = true;
    console.warn(`eecircuit unavailable, using numeric fallback: ${reason}`);
    for (const p of this.pending.values()) p.reject(new Error(reason));
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
  }

  async dcSweep(params: InverterParams): Promise<SweepResult> {
    if (this.degraded) return this.numeric.dcSweep(params);
    try {
      const worker = this.ensureWorker();
      const id = ++this.seq;
      const result = await new Promise<SpiceResult>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        worker.postMessage({ id, netlist: inverterNetlist(params) } satisfies SpiceRequest);
      });
      return resultToSweep(result, params.vdd);
    } catch (err) {
      this.degrade(err instanceof Error ? err.message : String(err));
      return this.numeric.dcSweep(params);
    }
  }
}
