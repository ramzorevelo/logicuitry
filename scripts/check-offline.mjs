// Offline guarantee check (architecture.md §1): dist/ must reference no external URLs.
//
// The second documented network exception, the desktop update endpoint, is not
// checked here because it never reaches dist/: it lives in
// src-tauri/tauri.conf.json and is contacted only by the shell, only on an
// update check, and only in the desktop build.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const roots = ['dist'];
const offenders = [];
const maps = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith('.map')) maps.push(p);
    else if (/\.(html|css|js)$/.test(name)) {
      const hits = readFileSync(p, 'utf8').match(/https?:\/\/[^\s"'()]+/g) ?? [];
      // docs.google.com/forms is a deliberate, documented exception to the
      // offline rule (architecture.md section 1, CLAUDE.md rule 4). Two urls
      // match it: the form posted to when a user submits a bug report, and the
      // form opened in a tab when a user asks to attach a screenshot. Neither
      // is fetched at load.
      //
      // Inert URLs: namespaces, license comments, framework error-docs links,
      // Workbox's own console.warn text (bit.ly/wb-precache),
      // JSON Schema vocabulary $id constants (ajv bundles the meta-schemas;
      // never fetched), and ptm.asu.edu (a provenance comment inside the ngspice
      // model cards bundled by eecircuit-engine). All appear in strings, not loads.
      const real = hits.filter(
        (u) =>
          !/(docs\.google\.com\/forms|bit\.ly\/wb-precache|w3\.org|sourcemap|licenses?|github\.com|githubusercontent\.com\/ajv-validator|json-schema\.org|reactjs\.org\/docs\/error-decoder|react\.dev\/errors|ptm\.asu\.edu)/i.test(
            u,
          ),
      );
      if (real.length) offenders.push({ file: p, urls: real });
    }
  }
}

try {
  for (const r of roots) walk(r);
} catch {
  console.error('dist/ not found, run `npm run build` first.');
  process.exit(2);
}

// Shipping no readable original source is a decision (vite.config.ts's
// build.sourcemap), not an inherited default that may flip on an upgrade.
if (maps.length) {
  console.error('Source maps found in build output:');
  for (const m of maps) console.error(` ${m}`);
  process.exit(1);
}

if (offenders.length) {
  console.error('External URLs found in build output:');
  for (const o of offenders) console.error(` ${o.file}: ${o.urls.join(', ')}`);
  process.exit(1);
}
console.log('offline check passed: no external URLs in dist/.');
