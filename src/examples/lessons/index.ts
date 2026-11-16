import type { Lesson } from '../../core/model/types';
import { migrate } from '../../io/migrations';

import aluFlags from './alu-flags.lcirl';
import adders from './adders.lcirl';
import propagationDelay from './propagation-delay.lcirl';
import basicGates from './basic-gates.lcirl';
import deMorgan from './de-morgan.lcirl';
import multiplexers from './multiplexers.lcirl';
import decoders from './decoders.lcirl';
import srLatch from './sr-latch.lcirl';

const current = (doc: unknown): unknown => migrate(doc as Record<string, unknown>);

/** Lessons bundled with the app, over the example boards they name. */
export const BUILTIN_LESSONS: readonly Lesson[] = [
  current(aluFlags) as Lesson,
  current(adders) as Lesson,
  current(propagationDelay) as Lesson,
  current(basicGates) as Lesson,
  current(deMorgan) as Lesson,
  current(multiplexers) as Lesson,
  current(decoders) as Lesson,
  current(srLatch) as Lesson,
];
