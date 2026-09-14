// Classifies a param by how editing it interacts with a RUNNING simulation.
// Split out of paramSpecs.ts so the store can gate powered edits on it without
// importing paramSpecs, which imports the store back.

import { getPrimitive, hasPrimitive } from '../../core/sim/primitives/registry';
import type { Params } from '../../core/sim/primitives/types';
import type { ParamValue } from '../../core/model/types';

/** How editing a param interacts with a running simulation.
 *  `render`   -- no compiled artefact reads it, so a live edit provably cannot
 *                perturb the sim (verified against the primitive's own pins()
 *                below, not asserted by hand).
 *  `stimulus` -- the sim reads it every evaluate(), so a live edit is a value
 *                change the kernel can absorb through a params patch + wake,
 *                the same shape as flipping a switch.
 *  `structural` -- changes pin count or width, so the netlist itself differs
 *                and only a recompile can honour it. */
export type ParamLiveness = 'render' | 'stimulus' | 'structural';

/** Params no compiled primitive ever reads: pure glyph geometry/appearance. */
const RENDER_ONLY_KEYS = new Set(['color', 'shape', 'selSide', 'common']);

/** Params `evaluate()` reads out of `prim.params` on every call, so patching
 *  the compiled params and waking the primitive is enough to apply them. */
const STIMULUS_KEYS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['constant', new Set(['value'])],
]);

/** Classifies one (kind, key) pair for the powered-edit gate. Defaults to
 *  `structural` so a param added later is locked while powered until someone
 *  deliberately classifies it -- the safe direction to fail. */
export function paramLiveness(kind: string, key: string): ParamLiveness {
  if (RENDER_ONLY_KEYS.has(key) && !widthBearingKey(kind, key)) return 'render';
  if (STIMULUS_KEYS.get(kind)?.has(key)) return 'stimulus';
  return 'structural';
}

/** The real value domain of each render-only key, so the guard below probes
 *  values a primitive would actually receive rather than sentinels that both
 *  fall to the same default branch and prove nothing. */
const RENDER_KEY_DOMAIN: ReadonlyMap<string, readonly ParamValue[]> = new Map([
  ['color', ['red', 'green', 'blue']],
  ['shape', ['round', 'square']],
  ['selSide', ['top', 'bottom']],
  ['common', ['cathode', 'anode']],
]);

/** Guards the render-only list against a kind that (now or later) does feed
 *  one of those keys into its pins(): if any value in the key's domain yields
 *  a different pin shape, it is structural for that kind whatever the list
 *  says. Compared against a `width`-bearing params base so a kind whose pins()
 *  needs other params still produces a real shape to compare. */
function widthBearingKey(kind: string, key: string): boolean {
  if (!hasPrimitive(kind)) return false;
  const domain = RENDER_KEY_DOMAIN.get(key);
  if (!domain || domain.length < 2) return false;
  const prim = getPrimitive(kind);
  const shapeFor = (v: ParamValue): string | null => {
    try {
      return JSON.stringify(
        prim.pins({ [key]: v } as Params).map((pin) => [pin.name, pin.width, pin.dir]),
      );
    } catch {
      return null;
    }
  };
  const shapes = domain.map(shapeFor);
  // A kind whose pins() cannot be built at all here tells us nothing, so it
  // does not get to veto the render classification.
  if (shapes.some((sh) => sh === null)) return false;
  return shapes.some((sh) => sh !== shapes[0]);
}

/** True when every key in `keys` can be edited without dropping power. */
export function isLiveEditable(kind: string, keys: Iterable<string>): boolean {
  for (const k of keys) if (paramLiveness(kind, k) === 'structural') return false;
  return true;
}

/** Strips the params a powered board cannot honour from an overlay commit.
 *
 *  The param overlay always writes its whole field set, not just the field that
 *  was touched: committing a colour change on an LED also writes `width` and
 *  `pinView`. On a component that carried no explicit `width`, that write is a
 *  NEW key, which reads as a pin-shape change and drops power -- the exact
 *  thing greying those fields out is meant to prevent. So while powered, a
 *  commit carries only what can actually be applied live. */
export function liveParamsOnly(
  kind: string,
  params: Readonly<Record<string, ParamValue>>,
  powered: boolean,
): Record<string, ParamValue> {
  if (!powered) return { ...params };
  const out: Record<string, ParamValue> = {};
  for (const [key, value] of Object.entries(params))
    if (paramLiveness(kind, key) !== 'structural') out[key] = value;
  return out;
}
