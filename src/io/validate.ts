// Schema validation on load. One Ajv 2020 instance holds the four draft-2020-12
// schemas from schemas/; refs resolve by $id (chip/board/lesson all $ref common).
// A file that fails validation is rejected loudly with path-qualified errors, so
// a bad file surfaces at load, never mid-class.

import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020';
import commonSchema from '../../schemas/common.schema.json';
import chipSchema from '../../schemas/chip.schema.json';
import boardSchema from '../../schemas/board.schema.json';
import lessonSchema from '../../schemas/lesson.schema.json';
import type { LcirFormat } from './migrations';

const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addSchema(commonSchema);

const validators: Record<LcirFormat, ValidateFunction> = {
  'lcir.chip': ajv.compile(chipSchema),
  'lcir.board': ajv.compile(boardSchema),
  'lcir.lesson': ajv.compile(lessonSchema),
};

export type ValidationResult = { valid: true } | { valid: false; errors: string[] };

function readableErrors(errors: ErrorObject[] | null | undefined): string[] {
  if (!errors?.length) return ['unknown validation failure'];
  return errors.map((e) => `${e.instancePath || '(root)'} ${e.message ?? 'is invalid'}`);
}

/** Validate a parsed document against the schema for its declared format. */
export function validateDocument(doc: unknown): ValidationResult {
  if (typeof doc !== 'object' || doc === null)
    return { valid: false, errors: ['(root) must be an object'] };
  const format = (doc as Record<string, unknown>)['format'];
  if (typeof format !== 'string' || !(format in validators))
    return { valid: false, errors: [`(root) unknown or missing format '${String(format)}'`] };
  const validate = validators[format as LcirFormat];
  if (validate(doc)) return { valid: true };
  return { valid: false, errors: readableErrors(validate.errors) };
}
