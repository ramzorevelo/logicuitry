// Load/save pipeline for library files. Load: parse -> migrate (old versions keep
// loading) -> validate -> typed. Save: stamp the envelope and pretty-print. The
// parse half is pure and node-testable; fsAccess supplies the bytes.

import type { Board, ChipDef, Lesson } from '../core/model/types';
import { migrate } from './migrations';
import { validateDocument } from './validate';

export type LibraryDoc = ChipDef | Board | Lesson;

export class LibraryLoadError extends Error {
  constructor(
    message: string,
    readonly errors: string[] = [],
  ) {
    super(message);
    this.name = 'LibraryLoadError';
  }
}

/** JSON text -> migrated, schema-valid, typed document. Throws on any failure. */
export function parseDocument(text: string): LibraryDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new LibraryLoadError(`not valid JSON: ${(e as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null)
    throw new LibraryLoadError('file is not a JSON object');

  const migrated = migrate(raw as Record<string, unknown>);
  const result = validateDocument(migrated);
  if (!result.valid) throw new LibraryLoadError('file failed schema validation', result.errors);
  return migrated as unknown as LibraryDoc;
}

export function serializeDocument(doc: LibraryDoc): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}
