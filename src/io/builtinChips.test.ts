import { describe, expect, it } from 'vitest';
import { builtinChipLibrary } from '../core/parts/packages';
import { migrate } from './migrations';
import { validateDocument } from './validate';

describe('built-in chip library', () => {
  // The hand-authored defs are bundled JSON cast to ChipDef, so the schema is
  // the only check on a typo tsc cannot see. They may sit a version behind.
  it('every built-in def passes the chip schema', () => {
    for (const def of builtinChipLibrary().values())
      expect(validateDocument(migrate({ ...def })), def.id).toEqual({ valid: true });
  });
});
