// The pure numeric MOSFET model, now the labeled fallback when the eecircuit
// worker is unavailable. Async to match the SpiceService interface.

import { inverterVtc } from './mosfetModel';
import type { InverterParams, SpiceService, SweepResult } from './types';

export class NumericSpiceService implements SpiceService {
  dcSweep(params: InverterParams): Promise<SweepResult> {
    return Promise.resolve({ ...inverterVtc(params), engine: 'numeric' });
  }
}
