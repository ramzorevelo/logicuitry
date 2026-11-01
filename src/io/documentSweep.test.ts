import { describe, expect, it } from 'vitest';
import { CURRENT_VERSION } from './migrations';
import { parseDocument, serializeDocument } from './library';
import { parseBoard } from './boardFile';
import { board, chipComp, memChipDef } from '../core/model/testFixtures';
import { isChipInstance } from '../core/model/types';

// Shipped and instructor files stay at the version they were written in; each
// must still come up through the real load path after every format bump.
const examples = import.meta.glob('../examples/**/*.{lcirb,lcirc}', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>;
const library = import.meta.glob('../../library/**/*.{lcirb,lcirc,json}', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>;

function loadsAtCurrentVersion(raw: unknown): void {
  const doc = parseDocument(JSON.stringify(raw));
  expect(doc.formatVersion).toBe(CURRENT_VERSION[doc.format]);
}

describe('every document on disk loads', () => {
  it('finds the bundled examples', () => {
    expect(Object.keys(examples).length).toBeGreaterThan(0);
  });

  for (const [path, raw] of Object.entries({ ...examples, ...library }))
    it(path, () => loadsAtCurrentVersion(raw));

  it('loads the test fixtures written at board 7 and chip 5', () => {
    loadsAtCurrentVersion({ ...board({}), formatVersion: 7 });
    loadsAtCurrentVersion({ ...memChipDef(), formatVersion: 5 });
  });
});

describe('chip instance contents on disk', () => {
  it('round-trips through save and load', () => {
    const contents = { r1: '11 22', 'M/r1': 'X 0F' };
    const saved = board({ components: [chipComp('u1', 'mem', 'U1', contents)] });
    const loaded = parseBoard(serializeDocument(saved));
    expect(loaded).toEqual(saved);
    const inst = loaded.components[0]!;
    expect(isChipInstance(inst) && inst.contents).toEqual(contents);
  });
});
