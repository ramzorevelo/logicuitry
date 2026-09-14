// Keep a Changelog -> structured release notes, read at build time so the app
// ships its own notes and fetches nothing. The offline rule is untouched.

/**
 * @typedef {{ heading: string, items: string[] }} ReleaseSection
 * @typedef {{ version: string, date: string, sections: ReleaseSection[], body: string[] }} Release
 */

/**
 * @param {string} text
 * @returns {Release[]}
 */
export function parseChangelog(text) {
  /** @type {Release[]} */
  const releases = [];
  /** @type {Release | null} */
  let release = null;
  /** @type {ReleaseSection | null} */
  let section = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const head = /^##\s+\[([^\]]+)\]\s*-\s*(.+)$/.exec(line);
    if (head) {
      release = { version: head[1], date: head[2], sections: [], body: [] };
      releases.push(release);
      section = null;
      continue;
    }
    if (!release) continue;
    const sub = /^###\s+(.+)$/.exec(line);
    if (sub) {
      section = { heading: sub[1], items: [] };
      release.sections.push(section);
      continue;
    }
    const item = /^-\s+(.+)$/.exec(line);
    if (item) {
      if (section) section.items.push(item[1]);
      else release.body.push(item[1]);
      continue;
    }
    // A release with prose instead of bullets (the 0.1.0 entry) keeps it, so
    // the sheet is never blank for a version that did have something to say.
    if (line && !section) release.body.push(line);
    else if (line && section) section.items[section.items.length - 1] += ` ${line}`;
  }
  return releases;
}
