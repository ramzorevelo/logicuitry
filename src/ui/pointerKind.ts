// Companion to compact.ts, and deliberately a second axis rather than a second
// threshold: layout is a question about width, gesture affordances are a
// question about the input device. A touchscreen laptop at 1440px needs finger
// sized grips; a narrow desktop window driven by a mouse does not.

import { useEffect, useState } from 'react';

export const COARSE_QUERY = '(pointer: coarse)';

function matches(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.(COARSE_QUERY).matches;
}

/** True while the primary input device is a finger rather than a mouse. */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(matches);
  useEffect(() => {
    const mq = window.matchMedia(COARSE_QUERY);
    const onChange = () => setCoarse(mq.matches);
    mq.addEventListener('change', onChange);
    onChange();
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return coarse;
}

/** Per-event truth, for handlers a hybrid device reaches with either input. */
export function isTouchEvent(e: { pointerType?: string }): boolean {
  return e.pointerType === 'touch';
}
