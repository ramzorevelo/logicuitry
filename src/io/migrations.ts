// Format migrations: every formatVersion bump registers an upgrader here so a
// semester of saved chips/boards/lessons keeps loading. No silent drift.

export type LcirFormat = 'lcir.chip' | 'lcir.board' | 'lcir.lesson';

export const CURRENT_VERSION: Record<LcirFormat, number> = {
  'lcir.chip': 3,
  'lcir.board': 5,
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
