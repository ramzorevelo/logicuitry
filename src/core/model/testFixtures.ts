// Shared builders for core tests: terse construction of boards and defs.

import type { Board, ChipDef, Component, ComponentKind, PinDef, Wire } from './types';
import type { ChipInstance, ParamValue } from './types';

export function comp(
  id: string,
  kind: ComponentKind,
  params?: Record<string, ParamValue>,
  label?: string,
): Component {
  return {
    id,
    kind,
    pos: { x: 0, y: 0 },
    ...(params ? { params } : {}),
    ...(label ? { label } : {}),
  };
}

export function wire(id: string, [ca, pa]: [string, string], [cb, pb]: [string, string]): Wire {
  return {
    id,
    a: { kind: 'pin', component: ca, pin: pa },
    b: { kind: 'pin', component: cb, pin: pb },
    points: [],
  };
}

/** A tap wire: one pin end, one sub-range tap off the named bus wire. */
export function tapWire(
  id: string,
  [comp, pin]: [string, string],
  busWire: string,
  range: { hi: number; lo: number },
): Wire {
  return {
    id,
    a: { kind: 'pin', component: comp, pin },
    b: { kind: 'tap', wire: busWire, range, pos: { x: 0, y: 0 } },
    points: [],
  };
}

export function board(over: Partial<Board>): Board {
  return {
    format: 'lcir.board',
    formatVersion: 12,
    id: 'test-board',
    name: 'test',
    components: [],
    wires: [],
    junctions: [],
    probes: [],
    view: { x: 0, y: 0, zoom: 1 },
    timing: { mode: 'ideal', datasheet: 'typ', vendor: 'ti' },
    runSpeed: 25_000,
    ...over,
  };
}

export function chipDef(over: Partial<ChipDef> & Pick<ChipDef, 'id' | 'name' | 'pins'>): ChipDef {
  return {
    format: 'lcir.chip',
    formatVersion: 8,
    version: 1,
    components: [],
    wires: [],
    junctions: [],
    ...over,
  };
}

export function pin(
  name: string,
  dir: PinDef['dir'],
  boundComponent: string,
  order: number,
  width = 1,
): PinDef {
  return { id: `pin-${name}`, name, dir, width, role: 'data', order, boundComponent };
}

/** Cross-coupled NAND SR latch (active-low inputs), the canonical week-12 chip. */
export function srLatchDef(): ChipDef {
  return chipDef({
    id: 'sr-latch',
    name: 'sr-latch',
    pins: [
      pin('sn', 'in', 'inSn', 0),
      pin('rn', 'in', 'inRn', 1),
      pin('q', 'out', 'outQ', 0),
      pin('qn', 'out', 'outQn', 1),
    ],
    components: [
      comp('inSn', 'inport'),
      comp('inRn', 'inport'),
      comp('g1', 'nand'),
      comp('g2', 'nand'),
      comp('outQ', 'outport'),
      comp('outQn', 'outport'),
    ],
    wires: [
      wire('w1', ['inSn', 'y'], ['g1', 'a']),
      wire('w2', ['g2', 'y'], ['g1', 'b']),
      wire('w3', ['inRn', 'y'], ['g2', 'a']),
      wire('w4', ['g1', 'y'], ['g2', 'b']),
      wire('w5', ['g1', 'y'], ['outQ', 'a']),
      wire('w6', ['g2', 'y'], ['outQn', 'a']),
    ],
  });
}

/** A user chip around a 2 x 8 RAM `r1` that always reads: address in `A`,
 *  the addressed cell on `Q`. */
export function memChipDef(preload = '01 02'): ChipDef {
  return chipDef({
    id: 'mem',
    name: 'mem',
    pins: [pin('A', 'in', 'inA', 0), pin('Q', 'out', 'outQ', 0, 8)],
    components: [
      comp('inA', 'inport', undefined, 'A'),
      comp('one', 'constant', { value: 1 }),
      comp('zero', 'constant', { value: 0 }),
      comp('r1', 'ram', { width: 8, addressBits: 1, preload }),
      comp('outQ', 'outport', { width: 8 }, 'Q'),
    ],
    wires: [
      wire('w1', ['inA', 'y'], ['r1', 'a']),
      wire('w2', ['zero', 'y'], ['r1', 'we']),
      wire('w3', ['one', 'y'], ['r1', 'cs']),
      wire('w4', ['r1', 'q'], ['outQ', 'a']),
    ],
  });
}

/** A chip instance of `defId`, with `contents` when given. */
export function chipComp(
  id: string,
  defId: string,
  label: string,
  contents?: Record<string, string>,
): ChipInstance {
  return {
    ...comp(id, 'chip', undefined, label),
    kind: 'chip',
    defId,
    ...(contents ? { contents } : {}),
  };
}

/** A chip holding one `mem` instance labelled `M`, passing `A` and `Q` through. */
export function memWrapDef(innerContents?: Record<string, string>): ChipDef {
  return chipDef({
    id: 'wrap',
    name: 'wrap',
    pins: [pin('A', 'in', 'inA', 0), pin('Q', 'out', 'outQ', 0, 8)],
    components: [
      comp('inA', 'inport', undefined, 'A'),
      chipComp('m1', 'mem', 'M', innerContents),
      comp('outQ', 'outport', { width: 8 }, 'Q'),
    ],
    wires: [wire('w1', ['inA', 'y'], ['m1', 'A']), wire('w2', ['m1', 'Q'], ['outQ', 'a'])],
  });
}
