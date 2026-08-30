// Whether a waiting build may install itself without asking.
//
// An installed app announces itself and waits: that is the one running in
// front of a class, and a reload it did not ask for is the worst thing that
// could happen mid-lecture. A browser tab just updates, because someone
// opening the url expects the current build rather than a stale one behind a
// prompt they have to notice and accept.
//
// Its own module, with no imports, so it can be tested: the component pulls in
// the service worker's virtual module, which does not resolve outside a build.

export interface UpdateContext {
  /** Running as an installed app rather than in a browser tab. */
  installed: boolean;
  presentation: boolean;
  /** Somebody has used a pointer or a key on this page since it loaded. */
  touched: boolean;
}

export function appliesSilently(c: UpdateContext): boolean {
  return !c.installed && !c.presentation && !c.touched;
}
