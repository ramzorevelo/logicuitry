import { describe, expect, it } from 'vitest';
import { EXAMPLES } from './index';
import { BUILTIN_LESSONS } from './lessons/index';
import { parseDocument } from '../io/library';
import { lessonWarnings, warningText } from '../core/lesson';

describe('built-in lessons', () => {
  it('ships the ALU flags lesson first', () => {
    expect(BUILTIN_LESSONS[0]?.id).toBe('alu-flags');
  });

  for (const lesson of BUILTIN_LESSONS) {
    describe(lesson.id, () => {
      it('loads through the real parse path', () => {
        const doc = parseDocument(JSON.stringify(lesson));
        expect(doc.format).toBe('lcir.lesson');
      });

      const example = EXAMPLES.find((e) => e.id === lesson.board);

      it('names an example board', () => {
        expect(example, `board ${lesson.board ?? '(none)'}`).toBeDefined();
      });

      it('has no warnings against that board', () => {
        const board = example!.board;
        const view = {
          componentIds: new Set(board.components.map((c) => c.id)),
          sequence: board.sequence,
        };
        expect(lessonWarnings(lesson, view).map(warningText)).toEqual([]);
      });
    });
  }
});
