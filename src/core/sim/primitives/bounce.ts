import type { Params } from './types';

/**
 * Contact edges after first touch, in ps; even index closes, odd opens.
 * Jack G. Ganssle, "A Guide to Debouncing", rev 3 (2008), switch O, read off
 * the 100 us/div capture at 2 us per pixel. A one-pixel spike at 503 us, under
 * the 6 us minimum the text reports for that actuation, is left out.
 */
export const BOUNCE_EDGES_PS: readonly number[] = [
  0, 14, 64, 80, 92, 150, 172, 224, 317, 405, 457, 493, 499,
].map((us) => us * 1_000_000);

/** A make whose bounce is long over: restored positions and power-on start here. */
export const SETTLED = Number.NEGATIVE_INFINITY;

export function bounceOn(params: Params): boolean {
  return params['bounce'] === true;
}

/**
 * Whether a contact that began closing at `since` is closed at `time`, and the
 * next edge still to come. Without bounce a make is clean.
 */
export function contactAt(
  since: number,
  time: number,
  bounce: boolean,
): { closed: boolean; nextWake?: number } {
  if (!bounce) return { closed: true };
  const elapsed = time - since;
  const passed = BOUNCE_EDGES_PS.findIndex((edge) => edge > elapsed);
  if (passed === -1) return { closed: true };
  return { closed: passed % 2 === 1, nextWake: since + BOUNCE_EDGES_PS[passed]! };
}
