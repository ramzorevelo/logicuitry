// Test-only primitive with an inout pin, until a shipped kind has one.

import * as bv from '../value/busValue';
import { hasPrimitive, registerPrimitive } from '../sim/primitives/registry';
import { widthParam } from '../sim/primitives/types';
import type { ComponentKind } from './types';

/** `p` drives `d` while `en` is 1 and floats otherwise; `r` reports what `p` reads. Pins
 *  are declared d, p, en, r so the input and output slot orders interleave. */
export const BIDIR = 'bidir-test' as ComponentKind;

if (!hasPrimitive(BIDIR))
  registerPrimitive({
    kind: BIDIR,
    pins: (params) => {
      const width = widthParam(params);
      return [
        { name: 'd', dir: 'in', width, role: 'data', order: 0 },
        { name: 'p', dir: 'inout', width, role: 'data', order: 1 },
        { name: 'en', dir: 'in', width: 1, role: 'enable', order: 2 },
        { name: 'r', dir: 'out', width, role: 'data', order: 0 },
      ];
    },
    evaluate(ctx) {
      const width = widthParam(ctx.params);
      const [d, p, en] = ctx.inputs as [bv.BusValue, bv.BusValue, bv.BusValue];
      const drive =
        en.x & 1 || en.z & 1 ? bv.allX(width) : en.v & 1 ? bv.buf(d, width) : bv.allZ(width);
      return { outputs: [drive, bv.buf(p, width)] };
    },
  });
