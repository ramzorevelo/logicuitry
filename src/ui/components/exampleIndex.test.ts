import { describe, expect, it } from 'vitest';
import { EXAMPLE_GROUPS, EXAMPLES } from '../../examples';
import { BUILTIN_LESSONS } from '../../examples/lessons';
import {
  LESSONS_SECTION,
  LIST_MIN_W,
  PREVIEW_MIN_W,
  buildEntries,
  clampPreviewWidth,
  entryMatches,
  filterTerms,
  highlightSegments,
  sectionInView,
  sectionize,
  type ExampleEntry,
} from './exampleIndex';

const entries = buildEntries(EXAMPLES, BUILTIN_LESSONS);
const joined = (segments: { text: string }[]) => segments.map((s) => s.text).join('');

describe('buildEntries', () => {
  it('has one entry per example and one per lesson', () => {
    expect(entries).toHaveLength(EXAMPLES.length + BUILTIN_LESSONS.length);
  });

  it('gives every entry a unique key', () => {
    expect(new Set(entries.map((e) => e.key)).size).toBe(entries.length);
  });

  it('files lessons under the Lessons section with their board resolved', () => {
    const lessonEntries = entries.filter((e) => e.lesson);
    expect(lessonEntries).toHaveLength(BUILTIN_LESSONS.length);
    for (const entry of lessonEntries) {
      const lesson = entry.lesson!;
      const board = EXAMPLES.find((e) => e.id === lesson.board);
      expect(entry.section).toBe(LESSONS_SECTION);
      expect(entry.board).toBe(board);
      expect(entry.description).toBe(`${lesson.steps.length} steps over ${board!.name}`);
    }
  });
});

describe('filterTerms', () => {
  it('returns no terms for an empty or blank query', () => {
    expect(filterTerms('')).toEqual([]);
    expect(filterTerms('   ')).toEqual([]);
  });

  it('lowercases and splits on runs of whitespace', () => {
    expect(filterTerms('  74LS138  Decoder ')).toEqual(['74ls138', 'decoder']);
  });
});

describe('entryMatches', () => {
  const entry: ExampleEntry = {
    key: 'k',
    name: 'Ripple Adder',
    description: 'Four bits of full adders',
    section: 'Arithmetic',
    board: undefined,
  };

  it('matches when every term appears', () => {
    expect(entryMatches(entry, ['ripple', 'bits'])).toBe(true);
    expect(entryMatches(entry, ['ripple', 'decoder'])).toBe(false);
  });

  it('matches on name, description and section', () => {
    expect(entryMatches(entry, ['ripple'])).toBe(true);
    expect(entryMatches(entry, ['full adders'])).toBe(true);
    expect(entryMatches(entry, ['arithmetic'])).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(entryMatches(entry, ['ripple adder'])).toBe(true);
    expect(entryMatches(entry, ['adder', 'arithmetic'])).toBe(true);
  });

  it('matches everything when there are no terms', () => {
    expect(entryMatches(entry, [])).toBe(true);
  });
});

describe('sectionize', () => {
  it('lists sections in group order then Lessons, placing every entry once', () => {
    const sections = sectionize(entries, EXAMPLE_GROUPS, []);
    expect(sections.map((s) => s.name)).toEqual([...EXAMPLE_GROUPS, LESSONS_SECTION]);
    const placed = sections.flatMap((s) => s.entries);
    expect(placed).toHaveLength(entries.length);
    expect(new Set(placed.map((e) => e.key))).toEqual(new Set(entries.map((e) => e.key)));
  });

  it('keeps empty sections when filtering, and only keeps matching entries', () => {
    const terms = ['74ls138'];
    const sections = sectionize(entries, EXAMPLE_GROUPS, terms);
    expect(sections.map((s) => s.name)).toEqual([...EXAMPLE_GROUPS, LESSONS_SECTION]);
    expect(sections.some((s) => s.entries.length === 0)).toBe(true);
    const kept = sections.flatMap((s) => s.entries);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(entries.length);
    for (const entry of kept) expect(entryMatches(entry, terms)).toBe(true);
  });

  it('appends a section that the order list lacks', () => {
    const stray: ExampleEntry = {
      key: 'stray',
      name: 'Stray',
      description: 'Lost',
      section: 'Mystery',
      board: undefined,
    };
    const sections = sectionize([stray], ['A', 'B'], []);
    expect(sections.map((s) => s.name)).toEqual(['A', 'B', 'Mystery']);
    expect(sections[2]!.entries).toEqual([stray]);
    expect(sections[0]!.entries).toEqual([]);
  });
});

describe('highlightSegments', () => {
  it('returns one plain segment when there are no terms', () => {
    expect(highlightSegments('Ripple adder', [])).toEqual([{ text: 'Ripple adder', hit: false }]);
  });

  it('returns a single empty plain segment for empty text', () => {
    expect(highlightSegments('', ['a'])).toEqual([{ text: '', hit: false }]);
  });

  it('merges overlapping hits into one run', () => {
    expect(highlightSegments('Ripple adder', ['add', 'adder'])).toEqual([
      { text: 'Ripple ', hit: false },
      { text: 'adder', hit: true },
    ]);
  });

  it('keeps the original casing of a case-insensitive hit', () => {
    expect(highlightSegments('Ripple Adder', ['adder'])).toEqual([
      { text: 'Ripple ', hit: false },
      { text: 'Adder', hit: true },
    ]);
  });

  it('treats regex specials in terms literally', () => {
    expect(highlightSegments('A + B', ['+'])).toEqual([
      { text: 'A ', hit: false },
      { text: '+', hit: true },
      { text: ' B', hit: false },
    ]);
    expect(highlightSegments('f(x)', ['('])).toEqual([
      { text: 'f', hit: false },
      { text: '(', hit: true },
      { text: 'x)', hit: false },
    ]);
  });

  it('always joins back to the input text', () => {
    const cases: [string, string[]][] = [
      ['Ripple adder', ['add', 'adder']],
      ['A + B (sum)', ['+', '(', 'sum']],
      ['aaaa', ['aa']],
      ['no match here', ['zzz']],
      ['', []],
    ];
    for (const [text, terms] of cases) expect(joined(highlightSegments(text, terms))).toBe(text);
  });
});

describe('sectionInView', () => {
  it('returns -1 when there are no headings', () => {
    expect(sectionInView([], 0, false)).toBe(-1);
  });

  it('picks the last heading at or above the scroll top', () => {
    const tops = [0, 100, 250];
    expect(sectionInView(tops, 0, false)).toBe(0);
    expect(sectionInView(tops, 120, false)).toBe(1);
    expect(sectionInView(tops, 250, false)).toBe(2);
  });

  it('tolerates one pixel: a heading 1px below the top still counts', () => {
    expect(sectionInView([0, 100, 250], 99, false)).toBe(1);
  });

  it('returns the last section when scrolled to the end', () => {
    expect(sectionInView([0, 100, 250], 0, true)).toBe(2);
  });
});

describe('clampPreviewWidth', () => {
  it('keeps a width that fits', () => {
    expect(clampPreviewWidth(400, 1120, 228)).toBe(400);
  });
  it('never goes below the floor', () => {
    expect(clampPreviewWidth(50, 1120, 228)).toBe(PREVIEW_MIN_W);
  });
  it('leaves the list its minimum', () => {
    expect(clampPreviewWidth(2000, 1120, 228)).toBe(1120 - 228 - LIST_MIN_W);
  });
  it('holds the floor when the dialog is too narrow for both', () => {
    expect(clampPreviewWidth(400, 500, 228)).toBe(PREVIEW_MIN_W);
  });
});
