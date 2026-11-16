import type { Lesson } from '../../core/model/types';
import type { Example } from '../../examples';

/** The section built-in lessons sit under, after every board section. */
export const LESSONS_SECTION = 'Lessons';

export interface ExampleEntry {
  key: string;
  name: string;
  description: string;
  section: string;
  /** The board the preview draws: the example itself, or the lesson's board. */
  board: Example | undefined;
  lesson?: Lesson;
}

export interface ExampleSection {
  name: string;
  /** Entries left after the filter; empty sections are kept so the index can grey them. */
  entries: ExampleEntry[];
}

export function buildEntries(
  examples: readonly Example[],
  lessons: readonly Lesson[],
): ExampleEntry[] {
  const byId = new Map(examples.map((e) => [e.id, e]));
  return [
    ...examples.map((e) => ({
      key: e.id,
      name: e.name,
      description: e.description,
      section: e.group,
      board: e,
    })),
    ...lessons.map((lesson) => {
      const board = lesson.board === undefined ? undefined : byId.get(lesson.board);
      return {
        key: `lesson-${lesson.id}`,
        name: lesson.title,
        description: `${lesson.steps.length} steps over ${board?.name ?? lesson.board ?? 'no board'}`,
        section: LESSONS_SECTION,
        board,
        lesson,
      };
    }),
  ];
}

export function filterTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Every term must appear somewhere in the name, description or section. */
export function entryMatches(entry: ExampleEntry, terms: readonly string[]): boolean {
  const hay = `${entry.name}\n${entry.description}\n${entry.section}`.toLowerCase();
  return terms.every((t) => hay.includes(t.toLowerCase()));
}

/** Sections in `order`, then any section an entry names that `order` lacks. */
export function sectionize(
  entries: readonly ExampleEntry[],
  order: readonly string[],
  terms: readonly string[],
): ExampleSection[] {
  const names = [...order];
  for (const e of entries) if (!names.includes(e.section)) names.push(e.section);
  const sections = names.map((name): ExampleSection => ({ name, entries: [] }));
  const byName = new Map(sections.map((s) => [s.name, s]));
  for (const e of entries) if (entryMatches(e, terms)) byName.get(e.section)?.entries.push(e);
  return sections;
}

export interface TextSegment {
  text: string;
  hit: boolean;
}

/** Splits `text` into runs, marking every case-insensitive occurrence of any
 *  term. Overlapping hits merge, so "add" and "adder" mark one run. */
export function highlightSegments(text: string, terms: readonly string[]): TextSegment[] {
  const lower = text.toLowerCase();
  const ranges: [number, number][] = [];
  for (const t of terms) {
    if (!t) continue;
    for (let i = lower.indexOf(t); i >= 0; i = lower.indexOf(t, i + 1))
      ranges.push([i, i + t.length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  const out: TextSegment[] = [];
  let at = 0;
  for (const [s, e] of merged) {
    if (s > at) out.push({ text: text.slice(at, s), hit: false });
    out.push({ text: text.slice(s, e), hit: true });
    at = e;
  }
  if (at < text.length || out.length === 0) out.push({ text: text.slice(at), hit: false });
  return out;
}

/** The section whose heading is the last one at or above the list's top edge;
 *  the last section once the list is scrolled to its end, since a short last
 *  section can never reach the top. Heading offsets are relative to the list. */
export function sectionInView(
  headingTops: readonly number[],
  scrollTop: number,
  atEnd: boolean,
): number {
  if (headingTops.length === 0) return -1;
  if (atEnd) return headingTops.length - 1;
  let current = 0;
  for (let i = 0; i < headingTops.length; i++) if (headingTops[i]! <= scrollTop + 1) current = i;
  return current;
}

/** Desktop preview pane width in CSS px: default, floor, and the least the
 *  list keeps beside it. */
export const PREVIEW_DEFAULT_W = 320;
export const PREVIEW_MIN_W = 220;
export const LIST_MIN_W = 240;

/** The widest the preview may be inside a dialog of `dialogW` whose index and
 *  splitter take `fixedW`; never below the floor, even in a cramped dialog. */
export function clampPreviewWidth(w: number, dialogW: number, fixedW: number): number {
  const max = Math.max(PREVIEW_MIN_W, dialogW - fixedW - LIST_MIN_W);
  return Math.round(Math.min(max, Math.max(PREVIEW_MIN_W, w)));
}
