// Format migrations: every formatVersion bump registers an upgrader here so a
// semester of saved chips/boards/lessons keeps loading. No silent drift.

export type LcirFormat = 'lcir.chip' | 'lcir.board' | 'lcir.lesson';

export const CURRENT_VERSION: Record<LcirFormat, number> = {
  'lcir.chip': 5,
  'lcir.board': 7,
  'lcir.lesson': 1,
};

type Migration = (doc: Record<string, unknown>) => Record<string, unknown>;

/** Key: `${format}:${fromVersion}`; upgrader returns the next version's shape. */
const migrations = new Map<string, Migration>();

export function registerMigration(format: LcirFormat, from: number, fn: Migration): void {
  const key = `${format}:${from}`;
  if (migrations.has(key)) throw new Error(`duplicate migration ${key}`);
  migrations.set(key, fn);
}

// Board v1 -> v2: adds the free WireEnd variant. Shape-only -- v1 files
// contain no free ends, so the document passes through unchanged.
registerMigration('lcir.board', 1, (doc) => doc);

// In/Out labels are named ports now: kind 'input' -> 'inport', 'output' ->
// 'outport'. Same rename in both formats, since a chip def holds components too.
function renamePortKinds(doc: Record<string, unknown>): Record<string, unknown> {
  const components = doc['components'];
  if (!Array.isArray(components)) return doc;
  const RENAMED: Record<string, string> = { input: 'inport', output: 'outport' };
  return {
    ...doc,
    components: components.map((c) => {
      const comp = c as Record<string, unknown>;
      const renamed = RENAMED[comp['kind'] as string];
      return renamed ? { ...comp, kind: renamed } : comp;
    }),
  };
}

registerMigration('lcir.board', 2, renamePortKinds);
registerMigration('lcir.chip', 1, renamePortKinds);

// Board v3 -> v4, chip v2 -> v3: a bus wire's width badge gained an optional
// position along its own route. Absent everywhere in older files, so both
// documents pass through untouched.
registerMigration('lcir.board', 3, (doc) => doc);
registerMigration('lcir.chip', 2, (doc) => doc);

// Board v4 -> v5: components gained an optional `group`, and the board an
// optional `groups` list. An older board has neither, so every component is
// board-scoped exactly as it was and the document passes through unchanged.
registerMigration('lcir.board', 4, (doc) => doc);

// Board v5 -> v6, chip v3 -> v4: `amber` left the LED palette. Existing LEDs
// take yellow, the nearer of the two hues it sat between.
function retireAmberLeds(doc: Record<string, unknown>): Record<string, unknown> {
  const components = doc['components'];
  if (!Array.isArray(components)) return doc;
  return {
    ...doc,
    components: components.map((c) => {
      const comp = c as Record<string, unknown>;
      const params = comp['params'] as Record<string, unknown> | undefined;
      if (comp['kind'] !== 'led' || params?.['color'] !== 'amber') return comp;
      return { ...comp, params: { ...params, color: 'yellow' } };
    }),
  };
}

registerMigration('lcir.board', 5, retireAmberLeds);
registerMigration('lcir.chip', 3, retireAmberLeds);

// Board v6 -> v7, chip v4 -> v5: the 7-segment display grew the second common
// its real 10-pin package has, so the single `common` pin became `com1`/`com2`.
// A wire that landed on the old pin lands on `com1`, which is the same node:
// the two are tied inside the package.
function splitSevenSegCommon(doc: Record<string, unknown>): Record<string, unknown> {
  const components = doc['components'];
  const wires = doc['wires'];
  if (!Array.isArray(components) || !Array.isArray(wires)) return doc;
  const displays = new Set(
    components
      .filter((c) => (c as Record<string, unknown>)['kind'] === 'sevenseg')
      .map((c) => (c as Record<string, unknown>)['id']),
  );
  if (displays.size === 0) return doc;
  const rename = (end: unknown): unknown => {
    const e = end as Record<string, unknown> | undefined;
    if (e?.['kind'] !== 'pin' || e['pin'] !== 'common' || !displays.has(e['component'])) return end;
    return { ...e, pin: 'com1' };
  };
  return {
    ...doc,
    wires: wires.map((w) => {
      const wire = w as Record<string, unknown>;
      return { ...wire, a: rename(wire['a']), b: rename(wire['b']) };
    }),
  };
}

registerMigration('lcir.board', 6, splitSevenSegCommon);
registerMigration('lcir.chip', 4, splitSevenSegCommon);

// Files written under an earlier name carry an older format prefix: `logiclab.`
// from the original name, `lcir.` from the Logic Design Workbench one. Rewriting
// the prefix is not a formatVersion bump -- the shape is identical -- so it
// happens once at the door and every migration below sees the current token.
const LEGACY_PREFIXES = ['logiclab.', 'ldw.'];

function renameLegacyFormat(doc: Record<string, unknown>): Record<string, unknown> {
  const format = doc['format'];
  if (typeof format !== 'string') return doc;
  const legacy = LEGACY_PREFIXES.find((p) => format.startsWith(p));
  if (!legacy) return doc;
  return { ...doc, format: `lcir.${format.slice(legacy.length)}` };
}

export function migrate(input: Record<string, unknown>): Record<string, unknown> {
  const doc = renameLegacyFormat(input);
  const format = doc['format'] as LcirFormat;
  const target = CURRENT_VERSION[format];
  if (target === undefined) throw new Error(`unknown format '${String(doc['format'])}'`);
  let current = doc;
  let version = doc['formatVersion'] as number;
  if (typeof version !== 'number' || version > target)
    throw new Error(`file is version ${String(version)}, app supports up to ${target}`);
  while (version < target) {
    const fn = migrations.get(`${format}:${version}`);
    if (!fn) throw new Error(`no migration for ${format} v${version} -> v${version + 1}`);
    current = { ...fn(current), formatVersion: version + 1 };
    version += 1;
  }
  return current;
}
