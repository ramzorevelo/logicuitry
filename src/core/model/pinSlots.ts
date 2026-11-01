// Pin direction -> flat slot side; every pin-name-to-slot table must use this, or inout slots drift.

import type { PinDir } from './types';

/** An inout pin reads the resolved net, so it takes an input slot too. */
export const isInputSlot = (dir: PinDir): boolean => dir === 'in' || dir === 'inout';

/** An inout pin drives its net, so it takes an output slot too. */
export const isOutputSlot = (dir: PinDir): boolean => dir === 'out' || dir === 'inout';

export const inputSlotPins = <P extends { dir: PinDir }>(pins: readonly P[]): P[] =>
  pins.filter((p) => isInputSlot(p.dir));

export const outputSlotPins = <P extends { dir: PinDir }>(pins: readonly P[]): P[] =>
  pins.filter((p) => isOutputSlot(p.dir));

/** A pin whose drive can float, so it may share a net with other drivers. */
export const canFloat = (pin: { dir: PinDir; threeState?: boolean }): boolean =>
  pin.dir === 'inout' || pin.threeState === true;

/** Two pins may meet on one net unless both drive it and neither can float. */
export const mayShareNet = (
  a: { dir: PinDir; threeState?: boolean },
  b: { dir: PinDir; threeState?: boolean },
): boolean => !(isOutputSlot(a.dir) && isOutputSlot(b.dir)) || canFloat(a) || canFloat(b);
