import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Lesson } from '../../core/model/types';
import { newLesson } from '../../core/lesson';
import { BUILTIN_LESSONS } from '../../examples/lessons';
import type { LibraryDir } from '../../io/fsAccess';
import { useShellStore } from '../store';
import { useCircuitStore } from '../workbench-circuit/circuitStore';
import { lessonDirty, useLessonEditorStore } from './lessonEditorStore';
import { saveLessonDraft } from './lessonSave';

const written: { sub: string; name: string; doc: Lesson }[] = [];
const fileWrites: { file: string; text: string }[] = [];
const picks: string[] = [];
let lapsed = false;
let gone = false;
vi.mock('../../io/fsAccess', async (orig) => {
  const real = await orig<typeof import('../../io/fsAccess')>();
  return {
    ...real,
    writeDoc: vi.fn(async (_root: unknown, sub: string, name: string, doc: Lesson) => {
      written.push({ sub, name, doc });
    }),
    filePickersSupported: () => true,
    pickSavePath: vi.fn(async (name: string) => {
      picks.push(name);
      return { name: `picked-${name}` };
    }),
    writeDocFile: vi.fn(async (file: { name: string }, text: string) => {
      if (lapsed && !file.name.startsWith('picked-')) throw new real.PermissionLapsedError();
      if (gone && !file.name.startsWith('picked-'))
        throw Object.assign(new Error('gone'), { name: 'NotFoundError' });
      fileWrites.push({ file: file.name, text });
    }),
  };
});
const remembered: { lesson: Lesson; file: { name: string } }[] = [];
vi.mock('../../io/lessonFiles', () => ({
  rememberFileLesson: vi.fn(async (entry: { lesson: Lesson; file: { name: string } }) => {
    remembered.push(entry);
  }),
}));

const ed = () => useLessonEditorStore.getState();

beforeEach(() => {
  written.length = 0;
  fileWrites.length = 0;
  picks.length = 0;
  remembered.length = 0;
  lapsed = false;
  gone = false;
  ed().close();
  useShellStore.setState({ chipsDir: {} as LibraryDir });
});

describe('saveLessonDraft', () => {
  it('names a new lesson from its title at the first save, undo history included', async () => {
    const taken = new Set(['untitled-lesson', 'v-flag']);
    ed().open(newLesson('board-1', taken), 'untitled-lesson-2.lcirl', {
      isNew: true,
      takenIds: taken,
    });
    ed().beginText();
    ed().editText((l) => ({ ...l, title: 'V flag' }));
    expect(await saveLessonDraft()).toBe(true);
    expect(written).toMatchObject([{ sub: 'lessons', name: 'v-flag-2.lcirl' }]);
    expect(written[0]!.doc.id).toBe('v-flag-2');
    expect(lessonDirty(ed())).toBe(false);
    expect(ed().past.every((s) => s.lesson.id === 'v-flag-2')).toBe(true);
  });

  it('keeps the id and file of a lesson already saved, whatever its title becomes', async () => {
    const lesson = BUILTIN_LESSONS[0]!;
    ed().open(structuredClone(lesson), 'my-flags.lcirl');
    ed().beginText();
    ed().editText((l) => ({ ...l, title: 'Renamed' }));
    await saveLessonDraft();
    expect(written).toMatchObject([{ name: 'my-flags.lcirl', doc: { id: lesson.id } }]);
    expect(useCircuitStore.getState().error).toBe('lesson: Saved lessons/my-flags.lcirl');
  });

  it('refuses a blank title and stays unsaved', async () => {
    ed().open(structuredClone(BUILTIN_LESSONS[0]!), 'x.lcirl');
    ed().editText((l) => ({ ...l, title: '  ' }));
    expect(await saveLessonDraft()).toBe(false);
    expect(written).toHaveLength(0);
    expect(lessonDirty(ed())).toBe(true);
  });
});

describe('saveLessonDraft without a library', () => {
  beforeEach(() => useShellStore.setState({ chipsDir: null }));

  it('asks where once, then writes back to that file and lists it', async () => {
    ed().open(structuredClone(BUILTIN_LESSONS[0]!), 'flags.lcirl');
    expect(await saveLessonDraft()).toBe(true);
    ed().editText((l) => ({ ...l, title: 'Second' }));
    expect(await saveLessonDraft()).toBe(true);
    expect(picks).toEqual(['flags.lcirl']);
    expect(fileWrites.map((w) => w.file)).toEqual(['picked-flags.lcirl', 'picked-flags.lcirl']);
    expect(remembered.at(-1)!.lesson.title).toBe('Second');
    expect(useCircuitStore.getState().error).toBe('lesson: Saved picked-flags.lcirl');
  });

  it('writes a lesson opened from a file back to it, even with a library connected', async () => {
    useShellStore.setState({ chipsDir: {} as LibraryDir });
    ed().open(structuredClone(BUILTIN_LESSONS[0]!), 'mine.lcirl', {
      file: { name: 'mine.lcirl' } as never,
    });
    expect(await saveLessonDraft()).toBe(true);
    expect(written).toHaveLength(0);
    expect(fileWrites.map((w) => w.file)).toEqual(['mine.lcirl']);
  });

  it('asks again when the held file has lost its permission', async () => {
    lapsed = true;
    ed().open(structuredClone(BUILTIN_LESSONS[0]!), 'mine.lcirl', {
      file: { name: 'mine.lcirl' } as never,
    });
    expect(await saveLessonDraft()).toBe(true);
    expect(picks).toEqual(['mine.lcirl']);
    expect(ed().file).toEqual({ name: 'picked-mine.lcirl' });
  });

  it('asks where when the held file was moved or deleted', async () => {
    gone = true;
    ed().open(structuredClone(BUILTIN_LESSONS[0]!), 'mine.lcirl', {
      file: { name: 'mine.lcirl' } as never,
    });
    expect(await saveLessonDraft()).toBe(true);
    expect(picks).toEqual(['mine.lcirl']);
  });

  it('says so when the held file is refused and no file is picked, then asks next time', async () => {
    lapsed = true;
    const pick = vi.mocked((await import('../../io/fsAccess')).pickSavePath);
    pick.mockResolvedValueOnce(undefined);
    ed().open(structuredClone(BUILTIN_LESSONS[0]!), 'mine.lcirl', {
      file: { name: 'mine.lcirl' } as never,
    });
    expect(await saveLessonDraft()).toBe(false);
    expect(useCircuitStore.getState().error).toBe(
      'save: Could not write mine.lcirl: Save again to choose a file',
    );
    expect(ed().file).toBeNull();
  });
});
