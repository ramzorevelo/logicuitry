// Injected by vite.config.ts's `define`. Nothing in src/ read a version before
// Settings > About and the bug report needed one.
declare const __APP_VERSION__: string;
declare const __BUILD_COMMIT__: string;

interface ReleaseSection {
  heading: string;
  items: string[];
}
interface Release {
  version: string;
  date: string;
  sections: ReleaseSection[];
  /** Prose or bullets written under the version with no `###` heading. */
  body: string[];
}
declare const __RELEASE_NOTES__: Release[];
