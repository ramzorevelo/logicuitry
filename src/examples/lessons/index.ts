import type { Lesson } from '../../core/model/types';
import { migrate } from '../../io/migrations';

import aluFlags from './alu-flags.lcirl';

const current = (doc: unknown): unknown => migrate(doc as Record<string, unknown>);

/** Lessons bundled with the app, over the example boards they name. */
export const BUILTIN_LESSONS: readonly Lesson[] = [current(aluFlags) as Lesson];
