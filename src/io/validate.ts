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
import {
  isChipInstance,
  type BoardSequence,
  type Challenge,
  type Component,
  type Lesson,
} from '../core/model/types';
import { sequenceErrors } from '../core/model/sequence';
import { challengeErrors } from '../core/challenge/challenge';
import { anyRamPreloadError, ramPreloadError } from '../core/sim/primitives/ram';
import { patternParamError } from '../core/sim/primitives/pattern';

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
  if (!validate(doc)) return { valid: false, errors: readableErrors(validate.errors) };
  const errors = [
    ...paramErrors(doc as { components?: Component[] }),
    ...sequenceErrorsOf(doc as { sequence?: BoardSequence }),
    ...challengeErrorsOf(doc as { challenge?: Challenge }),
    ...(format === 'lcir.lesson' ? lessonErrors(doc as Lesson) : []),
  ];
  return errors.length ? { valid: false, errors } : { valid: true };
}

function sequenceErrorsOf(doc: { sequence?: BoardSequence }): string[] {
  return doc.sequence ? sequenceErrors(doc.sequence) : [];
}

function challengeErrorsOf(doc: { challenge?: Challenge }): string[] {
  return doc.challenge ? challengeErrors(doc.challenge) : [];
}

/**
 * What the lesson schema cannot express: a predict step marks at most one
 * choice right, and annotation ids are unique across the lesson.
 */
export function lessonErrors(lesson: Lesson): string[] {
  const errors: string[] = [];
  const annotIds = new Set<string>();
  lesson.steps.forEach((step, i) => {
    const right = (step.choices ?? []).filter((c) => c.right).length;
    if (right > 1)
      errors.push(`/steps/${i}/choices marks ${right} choices right, at most one may be`);
    (step.annots ?? []).forEach((a, j) => {
      if (annotIds.has(a.id)) errors.push(`/steps/${i}/annots/${j} reuses annotation id '${a.id}'`);
      annotIds.add(a.id);
    });
  });
  return errors;
}

/** Values the schema cannot express: a RAM preload must parse for its size,
 *  and a chip instance's `contents` entry for some RAM size. */
function paramErrors(doc: { components?: Component[] }): string[] {
  const errors: string[] = [];
  (doc.components ?? []).forEach((comp, i) => {
    const name = comp.label || comp.id;
    if (comp.kind === 'pattern') {
      const bad = patternParamError(comp.params ?? {});
      if (bad) errors.push(`/components/${i}/params pattern ${name}: ${bad}`);
    }
    if (comp.kind === 'ram') {
      const bad = ramPreloadError(comp.params ?? {});
      if (bad) errors.push(`/components/${i}/params/preload RAM ${name}: ${bad}`);
    }
    if (!isChipInstance(comp)) return;
    for (const [key, text] of Object.entries(comp.contents ?? {})) {
      const bad = anyRamPreloadError(text);
      const pointer = key.replace(/~/g, '~0').replace(/\//g, '~1');
      if (bad) errors.push(`/components/${i}/contents/${pointer} chip ${name}, RAM ${key}: ${bad}`);
    }
  });
  return errors;
}
