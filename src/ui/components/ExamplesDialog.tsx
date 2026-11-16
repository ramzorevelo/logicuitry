// A dialog, not a submenu: on a phone and on an empty first launch nobody looks at the menu bar.
// Phone rows preview on hold, since a finger cannot hover.

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { Lesson } from '../../core/model/types';
import { CHALLENGES, EXAMPLES, EXAMPLE_GROUPS, type Example } from '../../examples';
import { BUILTIN_LESSONS } from '../../examples/lessons';
import { useCompact } from '../compact';
import { useModalKeys } from '../modalKeys';
import { useCoarsePointer } from '../pointerKind';
import { LONG_PRESS_MS, TAP_SLOP } from '../workbench-circuit/touchGestures';
import { BoardThumbnail } from './BoardThumbnail';
import {
  LESSONS_SECTION,
  PREVIEW_DEFAULT_W,
  PREVIEW_MIN_W,
  buildEntries,
  clampPreviewWidth,
  filterTerms,
  highlightSegments,
  sectionInView,
  sectionize,
  type ExampleEntry,
} from './exampleIndex';
import { holdTipPosition } from './HoldTip';
import './examplesDialog.css';

const ENTRIES = buildEntries(EXAMPLES, BUILTIN_LESSONS);
const SECTION_ORDER = [...EXAMPLE_GROUPS, LESSONS_SECTION];
const TOTAL = ENTRIES.length;

/** How long a click on the index owns the scroll position: the smooth scroll
 *  would otherwise light every section it passes on the way. */
const INDEX_JUMP_MS = 800;

const PREVIEW_WIDTH_KEY = 'lcir.examplesPreviewWidth';
const SPLIT_KEY_STEP = 16;

// A remembered width is a convenience: blocked storage just means the default.
function loadPreviewWidth(): number {
  try {
    const w = Number(localStorage.getItem(PREVIEW_WIDTH_KEY));
    return w >= PREVIEW_MIN_W ? w : PREVIEW_DEFAULT_W;
  } catch {
    return PREVIEW_DEFAULT_W;
  }
}

function savePreviewWidth(w: number): void {
  try {
    localStorage.setItem(PREVIEW_WIDTH_KEY, String(w));
  } catch {
    // Not saved; the next open starts from the default.
  }
}

function Highlighted({ text, terms }: { text: string; terms: readonly string[] }) {
  return (
    <>
      {highlightSegments(text, terms).map((s, i) =>
        s.hit ? <mark key={i}>{s.text}</mark> : <span key={i}>{s.text}</span>,
      )}
    </>
  );
}

function Preview({ entry, onOpen }: { entry: ExampleEntry; onOpen: () => void }) {
  return (
    <>
      <div className="examples-preview__thumb">
        {entry.board ? (
          <BoardThumbnail board={entry.board.board} chips={entry.board.chips} />
        ) : (
          <span className="examples-preview__missing">No board to show</span>
        )}
      </div>
      <span className="examples-preview__section">{entry.section}</span>
      <span className="examples-preview__name">{entry.name}</span>
      <span className="examples-preview__desc">{entry.description}</span>
      <button type="button" className="tool-btn examples-preview__open" onClick={onOpen}>
        Open
      </button>
    </>
  );
}

interface Held {
  key: string;
  anchor: { left: number; top: number; right: number; bottom: number };
}

export function ExamplesDialog({
  onOpen,
  onOpenLesson,
  onCancel,
}: {
  onOpen: (example: Example) => void;
  /** A lesson opens its example board, then plays from step 1. */
  onOpenLesson: (lesson: Lesson) => void;
  onCancel: () => void;
}) {
  const compact = useCompact();
  const coarse = useCoarsePointer();
  const [query, setQuery] = useState('');
  // Keyed on the terms, not the text: a trailing space must not rescroll the list.
  const termKey = filterTerms(query).join(' ');
  const terms = useMemo(() => (termKey ? termKey.split(' ') : []), [termKey]);
  const sections = useMemo(() => sectionize(ENTRIES, SECTION_ORDER, terms), [terms]);
  const shown = useMemo(() => sections.filter((s) => s.entries.length > 0), [sections]);
  const visible = useMemo(() => shown.flatMap((s) => s.entries), [shown]);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<string | undefined>(shown[0]?.name);
  const [held, setHeld] = useState<Held | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const indexRef = useRef<HTMLElement>(null);
  const holdCardRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLElement>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const [previewWidth, setPreviewWidth] = useState(loadPreviewWidth);
  const splitDrag = useRef(false);
  const swallowSplitClick = useRef(false);
  const jumpUntil = useRef(0);
  const hold = useRef({ timer: 0, x: 0, y: 0, swallow: false });

  useModalKeys(onCancel, () => (query ? setQuery('') : onCancel()));

  const preview = visible.find((e) => e.key === previewKey) ?? visible[0];
  const heldEntry = held ? ENTRIES.find((e) => e.key === held.key) : undefined;

  const open = (entry: ExampleEntry) => {
    if (entry.lesson) onOpenLesson(entry.lesson);
    else if (entry.board) onOpen(entry.board);
  };

  // A new filter starts the list from the top, so the first match is in view.
  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 });
    setActiveSection(shown[0]?.name);
  }, [shown]);

  useEffect(() => {
    if (!compact || !activeSection) return;
    const chip = indexRef.current?.querySelector<HTMLElement>(
      `[data-section="${CSS.escape(activeSection)}"]`,
    );
    chip?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeSection, compact]);

  useEffect(() => () => window.clearTimeout(hold.current.timer), []);

  useLayoutEffect(() => {
    const el = holdCardRef.current;
    if (!held || !el) return;
    el.style.left = '0px';
    const { x, y } = holdTipPosition(
      held.anchor,
      { w: el.offsetWidth, h: el.offsetHeight },
      { w: window.innerWidth, h: window.innerHeight },
    );
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }, [held]);

  const rows = () => [...(listRef.current?.querySelectorAll<HTMLElement>('.examples-item') ?? [])];

  const focusRow = (row: HTMLElement | undefined) => {
    if (!row) return;
    row.focus({ preventScroll: true });
    row.scrollIntoView({ block: 'nearest' });
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const inFilter = e.target === inputRef.current;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const all = rows();
      const at = all.indexOf(e.target as HTMLElement);
      if (!inFilter && at < 0) return;
      e.preventDefault();
      if (e.key === 'ArrowDown') focusRow(inFilter ? all[0] : all[at + 1]);
      else if (at === 0) inputRef.current?.focus();
      else if (at > 0) focusRow(all[at - 1]);
      return;
    }
    if (e.key === 'Enter' && inFilter) {
      e.preventDefault();
      if (visible[0]) open(visible[0]);
      return;
    }
    // Typing anywhere goes to the filter. Focusing on keydown lets the browser
    // deliver this same key to the input. Space stays with a focused button.
    const printable = e.key.length === 1 && e.key !== ' ';
    if (printable && !inFilter && !e.ctrlKey && !e.metaKey && !e.altKey) {
      inputRef.current?.focus();
    }
  };

  const onListScroll = () => {
    if (performance.now() < jumpUntil.current) return;
    const list = listRef.current;
    if (!list) return;
    const heads = [...list.querySelectorAll<HTMLElement>('.examples-section')];
    const bottom = list.scrollTop + list.clientHeight;
    const atEnd = bottom >= list.scrollHeight - 2;
    // At the end several headings share the screen; a section picked there stays picked.
    const current = heads.find((h) => h.dataset.section === activeSection);
    if (atEnd && current && current.offsetTop >= list.scrollTop && current.offsetTop < bottom) {
      return;
    }
    const i = sectionInView(
      heads.map((h) => h.offsetTop),
      list.scrollTop,
      atEnd,
    );
    const name = heads[i]?.dataset.section;
    if (name && name !== activeSection) setActiveSection(name);
  };

  const jumpTo = (name: string) => {
    const list = listRef.current;
    const head = list?.querySelector<HTMLElement>(
      `.examples-section[data-section="${CSS.escape(name)}"]`,
    );
    if (!list || !head) return;
    jumpUntil.current = performance.now() + INDEX_JUMP_MS;
    setActiveSection(name);
    list.scrollTo({ top: head.offsetTop });
  };

  const endHold = () => {
    window.clearTimeout(hold.current.timer);
    hold.current.timer = 0;
    setHeld(null);
  };

  const onListPointerDown = (e: ReactPointerEvent) => {
    const h = hold.current;
    // A hold that ended without a click must not swallow the next real one.
    h.swallow = false;
    window.clearTimeout(h.timer);
    if (e.pointerType !== 'touch') return;
    const row = (e.target as Element).closest<HTMLElement>('.examples-item');
    if (!row?.dataset.key) return;
    const key = row.dataset.key;
    h.x = e.clientX;
    h.y = e.clientY;
    h.timer = window.setTimeout(() => {
      h.timer = 0;
      h.swallow = true;
      const r = row.getBoundingClientRect();
      setHeld({ key, anchor: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } });
    }, LONG_PRESS_MS);
  };

  const onListPointerMove = (e: ReactPointerEvent) => {
    const h = hold.current;
    if (e.pointerType === 'mouse') {
      const key = (e.target as Element).closest<HTMLElement>('.examples-item')?.dataset.key;
      if (key && key !== previewKey) setPreviewKey(key);
      return;
    }
    if (h.timer && Math.hypot(e.clientX - h.x, e.clientY - h.y) > TAP_SLOP) {
      window.clearTimeout(h.timer);
      h.timer = 0;
    }
  };

  // Capture, so the row never sees the lift that ended a hold.
  const onListClickCapture = (e: ReactMouseEvent) => {
    if (!hold.current.swallow) return;
    hold.current.swallow = false;
    e.preventDefault();
    e.stopPropagation();
  };

  const resizePreview = (w: number, save: boolean) => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const fixed = (indexRef.current?.offsetWidth ?? 0) + (splitRef.current?.offsetWidth ?? 0);
    const next = clampPreviewWidth(w, dialog.clientWidth, fixed);
    setPreviewWidth(next);
    if (save) savePreviewWidth(next);
  };

  const splitWidthAt = (clientX: number) => {
    const right = previewRef.current?.getBoundingClientRect().right ?? clientX;
    return right - clientX - (splitRef.current?.offsetWidth ?? 0) / 2;
  };

  const onSplitKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // The preview sits right of the bar, so Left widens it, as dragging left does.
    const step =
      e.key === 'ArrowLeft' ? SPLIT_KEY_STEP : e.key === 'ArrowRight' ? -SPLIT_KEY_STEP : 0;
    if (!step) return;
    e.preventDefault();
    resizePreview(previewWidth + step, true);
  };

  return (
    <div
      className="package-overlay"
      onPointerDown={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div
        ref={dialogRef}
        className="package-dialog examples-dialog"
        style={{ '--examples-preview-w': `${previewWidth}px` } as CSSProperties}
        role="dialog"
        // Focusable, so a click on its text keeps keys here rather than on body.
        tabIndex={-1}
        aria-label="Examples"
        onKeyDown={onKeyDown}
        // A drag that ends over a row must not also open it.
        onClickCapture={(e) => {
          if (!swallowSplitClick.current) return;
          swallowSplitClick.current = false;
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <div className="examples-head">
          <h3>Examples</h3>
          <input
            ref={inputRef}
            type="search"
            className="examples-filter"
            placeholder="Filter by name, part or idea"
            aria-label="Filter examples"
            autoComplete="off"
            spellCheck={false}
            // A soft keyboard would cover half the sheet before anything is chosen.
            autoFocus={!compact && !coarse}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <nav ref={indexRef} className="examples-index" aria-label="Sections">
          {sections.map((s) => (
            <button
              key={s.name}
              type="button"
              data-section={s.name}
              className={
                'examples-index__item' +
                (s.name === activeSection ? ' examples-index__item--active' : '')
              }
              disabled={s.entries.length === 0}
              aria-current={s.name === activeSection ? 'true' : undefined}
              onClick={() => jumpTo(s.name)}
            >
              <span>{s.name}</span>
              <span className="examples-index__count">{s.entries.length}</span>
            </button>
          ))}
        </nav>
        <div
          ref={listRef}
          className="examples-list"
          onScroll={onListScroll}
          onPointerDown={onListPointerDown}
          onPointerMove={onListPointerMove}
          onPointerUp={endHold}
          onPointerCancel={endHold}
          onClickCapture={onListClickCapture}
          onContextMenu={(e) => {
            if (coarse) e.preventDefault();
          }}
        >
          {shown.map((s) => (
            <section key={s.name} className="examples-section" data-section={s.name}>
              <h4 className="examples-group">{s.name}</h4>
              <ul>
                {s.entries.map((entry) => (
                  <li key={entry.key}>
                    <button
                      type="button"
                      className="examples-item"
                      data-key={entry.key}
                      onFocus={() => setPreviewKey(entry.key)}
                      onClick={() => open(entry)}
                    >
                      <span className="examples-item__head">
                        <span className="examples-item__name">
                          <Highlighted text={entry.name} terms={terms} />
                        </span>
                        {entry.lesson && <span className="examples-tag">Lesson</span>}
                        {entry.section === CHALLENGES && (
                          <span className="examples-tag examples-tag--challenge">Challenge</span>
                        )}
                      </span>
                      <span className="examples-item__desc">
                        <Highlighted text={entry.description} terms={terms} />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {visible.length === 0 && (
            <p className="examples-none">No example matches &quot;{query.trim()}&quot;.</p>
          )}
        </div>
        {!compact && (
          <div
            ref={splitRef}
            className="examples-split"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize preview"
            aria-valuenow={previewWidth}
            aria-valuemin={PREVIEW_MIN_W}
            tabIndex={0}
            onKeyDown={onSplitKeyDown}
            onDoubleClick={() => resizePreview(PREVIEW_DEFAULT_W, true)}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
              splitDrag.current = true;
            }}
            onPointerMove={(e) => {
              if (splitDrag.current) resizePreview(splitWidthAt(e.clientX), false);
            }}
            onPointerUp={(e) => {
              if (!splitDrag.current) return;
              splitDrag.current = false;
              resizePreview(splitWidthAt(e.clientX), true);
              swallowSplitClick.current = true;
              // The click, if any, follows this lift in the same turn.
              window.setTimeout(() => (swallowSplitClick.current = false));
            }}
            onPointerCancel={() => {
              splitDrag.current = false;
            }}
          />
        )}
        {!compact && (
          <aside ref={previewRef} className="examples-preview" aria-label="Preview">
            {preview && <Preview entry={preview} onOpen={() => open(preview)} />}
          </aside>
        )}
        <div className="label-conflict-buttons examples-foot">
          <span
            className={'examples-hint' + (terms.length > 0 ? '' : ' examples-hint--idle')}
            aria-live="polite"
          >
            {terms.length > 0
              ? `${visible.length} of ${TOTAL} match.`
              : 'An example opens as a new untitled board, so the example itself is never overwritten.'}
          </span>
          <button type="button" className="tool-btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
      {heldEntry && (
        <div ref={holdCardRef} className="examples-holdcard" aria-hidden="true">
          <div className="examples-preview__thumb">
            {heldEntry.board && (
              <BoardThumbnail board={heldEntry.board.board} chips={heldEntry.board.chips} />
            )}
          </div>
          <span className="examples-preview__name">{heldEntry.name}</span>
          <span className="examples-preview__desc">{heldEntry.description}</span>
        </div>
      )}
    </div>
  );
}
