// Runs Tidy wiring's router off the main thread: a project-size board takes
// seconds on a phone, and the page must stay live meanwhile.

import { autoRoute, type AutoRouteInput } from './autoRoute';

// Typed as Worker for its postMessage/onmessage shapes; tsconfig ships the DOM lib only.
const ctx = self as unknown as Worker;

ctx.onmessage = (e: MessageEvent<AutoRouteInput>) => {
  ctx.postMessage(autoRoute(e.data));
};
