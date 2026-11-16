import { autoRoute, type AutoRouteInput, type AutoRouteResult } from './autoRoute';
import { runInBackground, type BackgroundRun, type RunWorker } from './inBackground';

export type BackgroundRoute = BackgroundRun<AutoRouteResult>;
export type RouteWorker = RunWorker<AutoRouteInput, AutoRouteResult>;

export function spawnRouteWorker(): RouteWorker | null {
  if (typeof Worker === 'undefined') return null;
  try {
    return new Worker(new URL('./autoRoute.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
}

/** The main-thread fallback works on a copy, as the worker does: autoRoute
 *  passes untouched wires through, and the junction collapse after a commit
 *  mutates wire ends in place. */
const routeOnMainThread = (input: AutoRouteInput) =>
  autoRoute({
    ...input,
    wires: structuredClone(input.wires),
    junctions: structuredClone(input.junctions),
  });

/** Tidy wiring's router in a Worker, or on the main thread as it always ran. */
export function routeInBackground(
  input: AutoRouteInput,
  spawn: () => RouteWorker | null = spawnRouteWorker,
): BackgroundRoute {
  return runInBackground(input, spawn, routeOnMainThread);
}
