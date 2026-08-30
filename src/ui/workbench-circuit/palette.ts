// Placeable-component palette. Every kind here must have both a registered
// sim primitive and registered glyph geometry (asserted by palette.test.ts).

import type { ComponentKind, ParamValue } from '../../core/model/types';

export type PaletteGroup =
  | 'Inputs'
  | 'Gates'
  | 'Combinational'
  | 'Sequential'
  | 'Outputs'
  | 'Wiring';

/** Section order in the palette rail: the two panel-device groups sit together
 *  at the top, since a board is normally stimulus-first. */
export const PALETTE_GROUPS: PaletteGroup[] = [
  'Inputs',
  'Outputs',
  'Gates',
  'Combinational',
  'Sequential',
  'Wiring',
];

export interface PaletteItem {
  kind: ComponentKind;
  label: string;
  group: PaletteGroup;
  params?: Record<string, ParamValue>;
}

export const PALETTE: PaletteItem[] = [
  { kind: 'toggle', label: 'Switch', group: 'Inputs' },
  { kind: 'button', label: 'Button', group: 'Inputs' },
  { kind: 'clock', label: 'Clock', group: 'Inputs' },
  { kind: 'constant', label: 'Const 0', group: 'Inputs', params: { value: 0, width: 1 } },
  { kind: 'constant', label: 'Const 1', group: 'Inputs', params: { value: 1, width: 1 } },
  { kind: 'inport', label: 'In port', group: 'Inputs' },
  { kind: 'and', label: 'AND', group: 'Gates' },
  { kind: 'or', label: 'OR', group: 'Gates' },
  { kind: 'nand', label: 'NAND', group: 'Gates' },
  { kind: 'nor', label: 'NOR', group: 'Gates' },
  { kind: 'xor', label: 'XOR', group: 'Gates' },
  { kind: 'xnor', label: 'XNOR', group: 'Gates' },
  { kind: 'not', label: 'NOT', group: 'Gates' },
  { kind: 'buf', label: 'BUF', group: 'Gates' },
  { kind: 'mux', label: 'MUX', group: 'Combinational', params: { selectBits: 2 } },
  { kind: 'demux', label: 'DEMUX', group: 'Combinational', params: { selectBits: 2 } },
  { kind: 'decoder', label: 'Decoder', group: 'Combinational', params: { addressBits: 2 } },
  { kind: 'encoder', label: 'Encoder', group: 'Combinational', params: { addressBits: 2 } },
  { kind: 'dff', label: 'DFF', group: 'Sequential' },
  { kind: 'led', label: 'LED', group: 'Outputs' },
  { kind: 'probe', label: 'Probe', group: 'Outputs' },
  { kind: 'outport', label: 'Out port', group: 'Outputs' },
  { kind: 'netlabel', label: 'Net label', group: 'Wiring' },
];
