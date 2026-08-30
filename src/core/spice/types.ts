// SpiceService isolates all device-level computation behind one interface.
// The current implementation is a pure numeric MOSFET
// model; a worker-backed eecircuit-engine implementation can drop in later
// without touching callers. Voltages in volts, currents in amps.

export type Region = 'cutoff' | 'linear' | 'saturation';

export interface InverterParams {
  vdd: number; // supply, 2..6 V
  wpwn: number; // Wp/Wn ratio (PMOS strength relative to NMOS)
  temperature: number; // degrees C
  points?: number; // sweep resolution (Vin samples)
}

export interface SweepResult {
  vin: number[];
  vout: number[];
  regionN: Region[]; // NMOS operating region per sample
  regionP: Region[]; // PMOS operating region per sample
  engine?: 'eecircuit' | 'numeric'; // which backend produced this curve (in-memory only)
}

export interface SpiceService {
  /** DC sweep of Vin over [0, VDD], returning the inverter VTC. */
  dcSweep(params: InverterParams): Promise<SweepResult>;
}
