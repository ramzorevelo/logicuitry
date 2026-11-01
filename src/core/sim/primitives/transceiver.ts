import * as bv from '../../value/busValue';
import { listedPart } from '../../parts/partsDb';
import { widthParam, type EvalResult, type PrimitiveSpec } from './types';

type Level = 0 | 1 | 'x';

const levelOf = (value: bv.BusValue): Level =>
  value.x & 1 || value.z & 1 ? 'x' : ((value.v & 1) as 0 | 1);

/**
 * Bus transceiver ('245 core): `dir` 1 drives `b` from `a`, 0 drives `a` from
 * `b`; the side not driving floats, and `oe` 0 floats both. An unknown control
 * gives X on every side that might be driving. The driven side reads back its
 * own drive on the net, so it never reads that side as a source.
 */
export const transceiver: PrimitiveSpec = {
  kind: 'transceiver',
  pins: (params) => {
    const width = widthParam(params);
    return [
      { name: 'a', dir: 'inout', width, role: 'data', order: 0 },
      { name: 'b', dir: 'inout', width, role: 'data', order: 0 },
      { name: 'dir', dir: 'in', width: 1, role: 'data', order: 1 },
      { name: 'oe', dir: 'in', width: 1, role: 'enable', order: 2 },
    ];
  },
  evaluate(ctx): EvalResult {
    const width = widthParam(ctx.params);
    const [a, b, dir, oe] = ctx.inputs as [bv.BusValue, bv.BusValue, bv.BusValue, bv.BusValue];
    const enable = levelOf(oe);
    const direction = levelOf(dir);
    const floating = bv.allZ(width);
    if (enable === 0) return { outputs: [floating, floating] };
    // A floating source reads X at the far side: bv.buf turns Z into X.
    const drive = (source: bv.BusValue): bv.BusValue =>
      enable === 'x' ? bv.allX(width) : bv.buf(source, width);
    if (direction === 'x') return { outputs: [bv.allX(width), bv.allX(width)] };
    return direction === 1 ? { outputs: [floating, drive(a)] } : { outputs: [drive(b), floating] };
  },
  defaultPart: () => listedPart('74LS245'),
};
