import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const version = (JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string }).version;

// A build with no git available still reports something honest rather than
// failing, and never claims a commit it does not know.
function buildCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

// GitHub Pages serves a project site from a subpath. Kept in an env var so dev
// and preview stay at '/' and the deploy is the only thing that sets it.
const base = process.env['VITE_BASE'] ?? '/';

// The desktop shell serves the same dist/ from a custom scheme. A service
// worker inside a shell caches nothing anyone benefits from, and its precache
// would put a second 20MB copy of ngspice on disk.
const desktop = process.env['VITE_DESKTOP'] === '1';

// Board and chip documents carry their own extensions so the OS, the file
// pickers and a folder listing can all tell them apart, and so installing the
// desktop app never makes Logicuitry the handler for every .json on the
// machine. They are still JSON inside; Vite only needs telling that.
function logicuitryDocuments(): Plugin {
  return {
    name: 'logicuitry-documents',
    transform(code, id) {
      if (!/\.(lcirb|lcirc)$/.test(id.split('?')[0] ?? '')) return null;
      // JSON.parse first so a malformed document fails the build here rather
      // than at runtime, and so the emitted module is a literal, not a string.
      return { code: `export default ${JSON.stringify(JSON.parse(code))};`, map: null };
    },
  };
}

export default defineConfig({
  base,
  plugins: [
    logicuitryDocuments(),
    react(),
    ...(desktop
      ? []
      : [
          VitePWA({
            // Never reload mid-lecture: the app asks, the teacher decides.
            registerType: 'prompt',
            includeAssets: [
              'favicon.svg',
              'icon-192.png',
              'icon-512.png',
              'icon-maskable-192.png',
              'icon-maskable-512.png',
            ],
            workbox: {
              // Everything ships in the install, ngspice included. Precaching runs in
              // the service worker's install event, NOT on the page's critical path,
              // so the ~20MB costs nothing at launch -- the page loads from its own
              // ~750KB either way. Runtime-caching it instead was tried and reverted:
              // it bought no launch speed and cost the offline guarantee, which is
              // the entire reason to install this.
              //
              // Workbox's 2MiB default would SILENTLY skip the ngspice chunk and
              // leave Device Lab broken offline with no error at all.
              maximumFileSizeToCacheInBytes: 32 * 1024 * 1024,
              globPatterns: ['**/*.{js,css,html,woff2,png,svg,wasm}'],
            },
            manifest: {
              name: 'Logicuitry',
              short_name: 'Logicuitry',
              description: 'Teaching instruments for logic circuits and design.',
              start_url: base,
              scope: base,
              display: 'standalone',
              // An installed instance can take the whole screen where the
              // platform allows it, and falls back down this list where it
              // does not. `display` alone stops at standalone.
              display_override: ['fullscreen', 'standalone', 'minimal-ui'],
              // A schematic is landscape work, but locking a phone's rotation
              // is hostile: let the device decide.
              orientation: 'any',
              background_color: '#edeff6',
              theme_color: '#26307d',
              // Chromium only, and additive: double-clicking a document opens
              // it in the installed app, matching what the desktop shell does.
              file_handlers: [
                {
                  action: base,
                  accept: { 'application/json': ['.lcirb', '.lcirc'] },
                },
              ],
              icons: [
                { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
                { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
                // Both maskable sizes: a launcher that picks the 192 must not
                // fall back to an uncropped icon and lose the pins to the crop.
                {
                  src: 'icon-maskable-192.png',
                  sizes: '192x192',
                  type: 'image/png',
                  purpose: 'maskable',
                },
                {
                  src: 'icon-maskable-512.png',
                  sizes: '512x512',
                  type: 'image/png',
                  purpose: 'maskable',
                },
              ],
            },
          }),
        ]),
  ],
  // The PWA plugin is off in the desktop build, so its virtual module has to
  // resolve to something: a shell updates through its installer, not a worker.
  ...(desktop
    ? {
        resolve: {
          alias: {
            'virtual:pwa-register/react': '/src/ui/components/pwaRegisterStub.ts',
          },
        },
      }
    : {}),
  define: {
    __APP_VERSION__: JSON.stringify(`v${version}`),
    __BUILD_COMMIT__: JSON.stringify(buildCommit()),
  },
  // Offline guarantee: everything bundled, no CDN.
  // sourcemap is stated rather than inherited: shipping no readable original
  // source is a decision, and check-offline.mjs fails the build if a .map
  // reaches dist/.
  // chunkSizeWarningLimit is stated rather than inherited, like sourcemap above.
  // Vite's 500kB default assumes a site where every visitor pays the download on
  // every cold visit. This one is precached and installed once a term, so the
  // app bundle (~805kB, ~250kB gzipped: React, ajv, the renderer, the kernel and
  // all three workbenches) costs a student nothing after the first load, and the
  // default fires on every build for a size that is not a problem.
  //
  // 1000 still guards what can actually regress. Worker chunks are built
  // separately and never counted, so the 20MB inlined-wasm ngspice worker is
  // exempt by construction rather than by raising the limit past it: a warning
  // here means the APP bundle grew by ~200kB, which is worth looking at.
  build: { assetsInlineLimit: 0, sourcemap: false, chunkSizeWarningLimit: 1000 },
  // eecircuit-engine ships a ~20MB wasm-inlined bundle; let Vite serve it as-is
  // rather than esbuild pre-bundling it (the worker code-splits it off the main chunk).
  //
  // noDiscovery + an explicit include skips the dependency SCAN, which blocks
  // the first module request on a cold start. Measured on this machine: the
  // first /src/main.tsx request went 41s -> 2.2s, and a full index-then-entry
  // crawl 45s -> 35s. The gap between those two numbers is run-to-run variance
  // (an antivirus exclusion on the repo is the other half of this problem, and
  // needs admin), so treat this as removing one known cost, not as the fix.
  //
  // Anything imported from node_modules and NOT listed here has to be added,
  // or Vite will not pre-bundle it.
  optimizeDeps: {
    exclude: ['eecircuit-engine'],
    include: ['react', 'react-dom/client', 'react/jsx-runtime', 'zustand', 'ajv/dist/2020'],
    noDiscovery: true,
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Without this the token sheet imports as an empty string, and the test
    // asserting every theme declares every token would silently pass on nothing.
    css: true,
  },
});
