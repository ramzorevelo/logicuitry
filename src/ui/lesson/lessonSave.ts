import {
  exportDoc,
  filePickersSupported,
  pickSavePath,
  PermissionLapsedError,
  writeDoc,
  writeDocFile,
  type DocFile,
} from '../../io/fsAccess';
import { rememberFileLesson } from '../../io/lessonFiles';
import { LESSON_EXT } from '../../io/docExtensions';
import { serializeDocument } from '../../io/library';
import { slugify, uniqueId } from '../../core/lesson';
import { validateDocument } from '../../io/validate';
import { useShellStore } from '../store';
import { useCircuitStore } from '../workbench-circuit/circuitStore';
import { useLessonEditorStore } from './lessonEditorStore';

export function lessonFileName(id: string): string {
  return `${id}${LESSON_EXT}`;
}

const notice = (text: string) => useCircuitStore.setState({ error: text });

/** Writes to a file already held; null when it was refused or has gone, so the picker asks instead. */
async function writeBack(file: DocFile, text: string): Promise<DocFile | null> {
  try {
    await writeDocFile(file, text);
    return file;
  } catch (e) {
    if (e instanceof PermissionLapsedError) return null;
    if (e instanceof Error && e.name === 'NotFoundError') return null;
    throw e;
  }
}

async function pickAndWrite(fileName: string, text: string): Promise<DocFile | null> {
  const file = await pickSavePath(fileName);
  if (!file) return null;
  await writeDocFile(file, text);
  return file;
}

/**
 * Writes the draft back to the file it came from; else to the library's
 * `lessons/` folder; else to a file the user picks once, or a download where
 * there is no save picker. False when nothing was written, so a prompt that
 * asked to save stays up.
 */
export async function saveLessonDraft(): Promise<boolean> {
  if (!useLessonEditorStore.getState().draft?.title.trim()) {
    notice('save: The lesson needs a title');
    return false;
  }
  const taken = useLessonEditorStore.getState().takenIds;
  if (taken) {
    const id = uniqueId(slugify(useLessonEditorStore.getState().draft!.title), taken);
    useLessonEditorStore.getState().assignId(id, lessonFileName(id));
  }
  const ed = useLessonEditorStore.getState();
  const draft = ed.draft!;
  const check = validateDocument(draft);
  if (!check.valid) {
    notice(`save: ${check.errors[0]}`);
    return false;
  }
  const library = ed.file ? null : useShellStore.getState().chipsDir;
  let file: DocFile | null = null;
  try {
    if (library) await writeDoc(library, 'lessons', ed.fileName, draft);
    else if (filePickersSupported()) {
      const text = serializeDocument(draft);
      const held = ed.file;
      file = held && (await writeBack(held, text));
      if (!file && held) {
        // A refused permission prompt can use up the click, so the picker may not open now.
        useLessonEditorStore.setState({ file: null });
        file = await pickAndWrite(ed.fileName, text);
        if (!file) notice(`save: Could not write ${held.name}: Save again to choose a file`);
      } else if (!file) file = await pickAndWrite(ed.fileName, text);
      if (!file) return false;
    } else exportDoc(draft, ed.fileName);
  } catch (e) {
    notice(`save: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  // Before markSaved, whose count reloads the Lesson menu. The listing is a
  // convenience: the file itself is already written.
  if (file) await rememberFileLesson({ lesson: draft, file, savedAt: Date.now() }).catch(() => {});
  // The draft written, not the one now: typing during the write leaves it unsaved.
  useLessonEditorStore.getState().markSaved(draft, file ?? undefined);
  notice(
    library ? `lesson: Saved lessons/${ed.fileName}` : `lesson: Saved ${file?.name ?? ed.fileName}`,
  );
  return true;
}
