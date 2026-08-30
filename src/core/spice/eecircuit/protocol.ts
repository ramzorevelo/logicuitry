// Message protocol between the Device Lab and the eecircuit worker, plus a local
// mirror of the ngspice result shape we consume. Kept pure (no worker/DOM refs)
// so the mapper and its tests need nothing from the browser.

export interface SpiceColumn {
  name: string; // e.g. "v(vin)", "v(vout)"
  values: number[]; // real DC-sweep samples
}

export interface SpiceResult {
  variableNames: string[];
  columns: SpiceColumn[];
}

export interface SpiceRequest {
  id: number;
  netlist: string;
}

export type SpiceResponse =
  | { id: number; ok: true; result: SpiceResult }
  | { id: number; ok: false; error: string };
