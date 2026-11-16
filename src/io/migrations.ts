// Format migrations: every formatVersion bump registers an upgrader here so a
// semester of saved chips/boards/lessons keeps loading. No silent drift.

export type LcirFormat = 'lcir.chip' | 'lcir.board' | 'lcir.lesson';

export const CURRENT_VERSION: Record<LcirFormat, number> = {
  'lcir.chip': 8,
  'lcir.board': 15,
  'lcir.lesson': 4,
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

// Board v7 -> v8, chip v5 -> v6: instance `contents` and `inout` pins, absent
// before; bumped so an older app refuses a file it would save back without them.
registerMigration('lcir.board', 7, (doc) => doc);
registerMigration('lcir.chip', 5, (doc) => doc);

// Board v8 -> v9, chip v6 -> v7: optional group and wire colours, absent before.
registerMigration('lcir.board', 8, (doc) => doc);
registerMigration('lcir.chip', 6, (doc) => doc);

// Board v9 -> v10: the timing vendor. Every board before it timed from TI's sheets.
registerMigration('lcir.board', 9, (doc) => {
  const timing = doc['timing'] as Record<string, unknown> | undefined;
  return timing ? { ...doc, timing: { ...timing, vendor: 'ti' } } : doc;
});

// Board v10 -> v11: the run speed, sim ps per wall second. Every board before
// it ran at 400 ps a frame, close to the 25 ns/s that is its first preset.
registerMigration('lcir.board', 10, (doc) => ({ ...doc, runSpeed: 25_000 }));

// Board v11 -> v12, chip v7 -> v8: optional silenced checks, absent before.
registerMigration('lcir.board', 11, (doc) => doc);
registerMigration('lcir.chip', 7, (doc) => doc);

// Board v12 -> v13: an optional input sequence, absent before.
registerMigration('lcir.board', 12, (doc) => doc);

// Lesson v1 -> v2: a step's free-form `type` and `params` become a kind and an
// ordered action list. `configure` and `highlight` are narrate steps with
// actions now; a type this app never knew is kept as a widget, never dropped.
const V1_NARRATED = new Set(['narrate', 'configure', 'highlight']);
const DOCK_TABS = new Set(['waveform', 'analyze', 'checks', 'sequence']);

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

function lessonActionsV1(type: string, params: Record<string, unknown>): unknown[] {
  const actions: unknown[] = [];
  const row = params['row'];
  if (typeof row === 'number' && Number.isInteger(row) && row >= 0)
    actions.push({ kind: 'row', index: row, when: type === 'predict' ? 'reveal' : 'open' });
  const power = params['power'];
  if (typeof power === 'boolean') actions.push({ kind: 'power', on: power });
  const timing = params['timing'];
  if (timing === 'ideal' || timing === 'datasheet') actions.push({ kind: 'timing', mode: timing });
  const highlight = params['highlight'] ?? params['components'];
  if (isStringArray(highlight)) actions.push({ kind: 'highlight', components: highlight });
  const tab = params['tab'];
  if (typeof tab === 'string' && DOCK_TABS.has(tab)) actions.push({ kind: 'tab', tab });
  return actions;
}

/** A non-object step passes through untouched, so the schema rejects it by name. */
function lessonStepV1(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const step = raw as Record<string, unknown>;
  const type = typeof step['type'] === 'string' ? step['type'] : 'unknown';
  const params = (step['params'] ?? {}) as Record<string, unknown>;
  const prose = typeof step['prose'] === 'string' ? step['prose'] : '';
  if (type !== 'predict' && !V1_NARRATED.has(type)) {
    const id = type === 'widget' ? params['id'] : type;
    return {
      kind: 'widget',
      prose,
      actions: [],
      widget: { id: typeof id === 'string' && id ? id : 'unknown', params },
    };
  }
  const out: Record<string, unknown> = {
    kind: type === 'predict' ? 'predict' : 'narrate',
    prose,
    actions: lessonActionsV1(type, params),
  };
  const choices = params['choices'];
  if (isStringArray(choices)) out['choices'] = choices.map((text) => ({ text }));
  const answer = params['answer'];
  if (typeof answer === 'string') out['answer'] = answer;
  return out;
}

registerMigration('lcir.lesson', 1, (doc) => {
  const steps = Array.isArray(doc['steps']) ? doc['steps'] : [];
  const first = (steps[0] as Record<string, unknown> | undefined)?.['params'] as
    | Record<string, unknown>
    | undefined;
  const board = first?.['board'];
  return {
    ...doc,
    steps: steps.map(lessonStepV1),
    ...(typeof board === 'string' && board ? { board } : {}),
  };
});

// Lesson v2 -> v3: optional notes, headline, narration placement, annotations
// and revealFreely per step, absent before.
registerMigration('lcir.lesson', 2, (doc) => doc);

// Lesson v3 -> v4: an optional autoplay `seconds` per step, absent before.
registerMigration('lcir.lesson', 3, (doc) => doc);

// Board v13 -> v14: an LED may carry `activeLow`, absent before. A bump, not a
// silent param, so an older app refuses the file instead of lighting it wrong.
registerMigration('lcir.board', 13, (doc) => doc);

// Board v14 -> v15: an optional challenge, absent before.
registerMigration('lcir.board', 14, (doc) => doc);

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
