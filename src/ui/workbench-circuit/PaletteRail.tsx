// The component rail. Split out of CircuitWorkbench so collapsing a group
// re-renders the rail alone: the workbench is a very large component, and a
// group toggle used to rebuild all of it.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCircuitStore } from './circuitStore';
import { useCompact } from '../compact';
import { useBackLayer } from '../backStack';
import { useCoarsePointer } from '../pointerKind';
import { isBuiltinChipDef } from '../../core/parts/packages';
import { LONG_PRESS_MS } from './touchGestures';
import {
  PALETTE,
  PALETTE_CHIP_IDS,
  PALETTE_GROUPS,
  PARTS_GROUP,
  findAliases,
  matchesFind,
  partCaption,
  partRows,
  type PaletteItem,
} from './palette';
import { DIP_BOX_W, PaletteGlyph } from './PaletteGlyph';
import { ToolIcon } from '../components/ToolIcon';
import type { ChipDef } from '../../core/model/types';

const MY_CHIPS = 'My chips';
/** Phone only: a tab ahead of the groups whose drawer holds the field. */
const FIND_TAB = 'Find';
const ALL_PARTS = 'All';

interface Props {
  paletteRef: React.RefObject<HTMLElement>;
  /** null = the CSS default width. */
  width: number | null;
}

export function PaletteRail({ paletteRef, width }: Props) {
  const store = useCircuitStore;
  const tool = useCircuitStore((s) => s.tool);
  const mode = useCircuitStore((s) => s.mode);
  const chipLib = useCircuitStore((s) => s.chipLib);
  // On a phone the rail is a strip, and every group open at once is one long
  // scroll with no sense of where you are. Tabs instead: one group open, the
  // rest collapsed to their headings. Desktop keeps every group expandable
  // independently, exactly as before.
  const compact = useCompact();
  // Continuous placement is armed two different ways, and naming the wrong one
  // is worse than naming neither: a long press does nothing with a mouse, and
  // Ctrl+click happens on the board, not on this button.
  const coarse = useCoarsePointer();
  const keepPlacing = coarse ? 'hold to keep placing' : 'Ctrl+click as you place to keep placing';
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  // Nothing open until a group is picked: the parts row costs height a phone
  // has none of, and an arbitrary default group is the wrong one most of the
  // time. Tapping the open tab closes it again.
  const [openGroup, setOpenGroup] = useState<string>('');
  const [query, setQuery] = useState('');
  const [partsSub, setPartsSub] = useState<string>(ALL_PARTS);
  const findRef = useRef<HTMLInputElement>(null);
  const filtering = query.trim() !== '';
  // On a phone the query lives in the Find drawer alone; the groups there are
  // never filtered.
  const filterRail = filtering && !compact;

  // Leaving the Find drawer must not leave behind a filter nobody can see.
  useEffect(() => {
    if (compact && openGroup !== FIND_TAB) setQuery('');
  }, [compact, openGroup]);
  useEffect(() => {
    if (compact && openGroup === FIND_TAB) findRef.current?.focus();
  }, [compact, openGroup]);

  useBackLayer(compact && openGroup ? () => setOpenGroup('') : null);

  // The drawer floats over the board, so a press anywhere else is a press
  // outside the menu and dismisses it. Deliberately not consumed: the tool a
  // part-tap just armed should still act on the very next board press, or
  // placing anything would cost two taps instead of one.
  useEffect(() => {
    if (!compact || !openGroup) return;
    const onDown = (e: PointerEvent) => {
      const inside = paletteRef.current?.contains(e.target as Node);
      if (!inside) setOpenGroup('');
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [compact, openGroup, paletteRef]);

  // Long press latches continuous placement; a plain tap places one part and
  // returns to Select. Held here rather than in the canvas gesture reducer
  // because the press is on the palette button, not on the board.
  const holdTimer = useRef(0);
  const heldRef = useRef(false);
  const armPlace = useCallback((next: () => void, latch: () => void) => {
    heldRef.current = false;
    window.clearTimeout(holdTimer.current);
    holdTimer.current = window.setTimeout(() => {
      heldRef.current = true;
      latch();
    }, LONG_PRESS_MS);
    return next;
  }, []);
  const holdProps = (select: () => void, latch: () => void) => ({
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      armPlace(select, latch);
    },
    onPointerUp: () => window.clearTimeout(holdTimer.current),
    onPointerCancel: () => window.clearTimeout(holdTimer.current),
    onPointerLeave: () => window.clearTimeout(holdTimer.current),
    onClick: () => {
      window.clearTimeout(holdTimer.current);
      // The long press already armed the latched mode; the click that follows
      // the lift must not overwrite it with a single-shot tool.
      if (heldRef.current) {
        heldRef.current = false;
        return;
      }
      select();
    },
  });

  // Built-in parts and the instructor's own chips are both ChipDefs, but they
  // are not the same kind of thing to reach for: parts are a fixed catalogue,
  // "My chips" is whatever this board's author packaged.
  const [parts, chips] = useMemo(() => {
    const all = [...chipLib.values()].sort((a, b) => a.name.localeCompare(b.name));
    return [
      all.filter((d) => isBuiltinChipDef(d) && !PALETTE_CHIP_IDS.has(d.id)),
      all.filter((d) => !isBuiltinChipDef(d)),
    ];
  }, [chipLib]);

  const sections = useMemo<Section[]>(
    () => [
      ...PALETTE_GROUPS.map((group) => ({
        group,
        rows: [{ entries: PALETTE.filter((i) => i.group === group).map(blockEntry) }],
      })),
      ...(parts.length > 0
        ? [
            {
              group: PARTS_GROUP,
              rows: partRows(parts).map((row) => ({
                sub: row.sub,
                entries: row.defs.map(partEntry),
              })),
            },
          ]
        : []),
      ...(chips.length > 0 ? [{ group: MY_CHIPS, rows: [{ entries: chips.map(chipEntry) }] }] : []),
    ],
    [parts, chips],
  );

  const matches = (e: Entry) =>
    matchesFind(query, e.label, e.defId, e.caption, ...findAliases(e.label));
  const hasMatch = (section: Section) => section.rows.some((r) => r.entries.some(matches));
  const isOpen = (section: Section) =>
    compact
      ? openGroup === section.group
      : filterRail
        ? hasMatch(section)
        : !collapsed.has(section.group);
  const toggleGroup = (group: string) => {
    if (compact) {
      setOpenGroup((cur) => (cur === group ? '' : group));
      return;
    }
    // Every match shows while filtering, and the open state underneath is what
    // clearing the field returns to, so a click must not change it.
    if (filterRail) return;
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (!next.delete(group)) next.add(group);
      return next;
    });
  };
  const offChip = (group: string, sub: string | undefined) =>
    compact && group === PARTS_GROUP && partsSub !== ALL_PARTS && sub !== partsSub;

  const renderItem = (e: Entry, hidden: boolean) => {
    const place = (repeat: boolean) =>
      store.getState().setTool({
        kind: 'place',
        componentKind: e.kind,
        ...(e.params ? { params: e.params } : {}),
        ...(e.defId ? { defId: e.defId } : {}),
        ...(repeat ? { repeat: true } : {}),
      });
    const active =
      tool.kind === 'place' &&
      tool.componentKind === e.kind &&
      tool.params === e.params &&
      tool.defId === e.defId;
    return (
      <button
        key={e.key}
        type="button"
        hidden={hidden}
        className={`palette-item${
          active ? ` palette-item--active${tool.repeat ? ' palette-item--repeat' : ''}` : ''
        }`}
        disabled={mode === 'bubble'}
        title={`${e.caption ? `${e.label}, ${e.caption}` : e.label} (${keepPlacing})`}
        {...holdProps(
          () => place(false),
          () => place(true),
        )}
      >
        <PaletteGlyph
          kind={e.kind}
          chipLib={chipLib}
          defId={e.defId}
          params={e.params}
          boxWidth={e.glyphWidth}
        />
        {e.caption ? (
          <span className="palette-item__text">
            <span className="palette-item__label">{e.label}</span>
            <span className="palette-item__caption">{e.caption}</span>
          </span>
        ) : (
          <span className="palette-item__label">{e.label}</span>
        )}
      </button>
    );
  };

  const findField = (
    <div className="palette-find">
      <ToolIcon name="find" />
      <input
        ref={findRef}
        type="text"
        className="palette-find__input"
        placeholder="Find part"
        aria-label="Find part"
        autoComplete="off"
        spellCheck={false}
        value={query}
        disabled={mode === 'bubble'}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          // Hands the keys back to the board without cancelling an armed
          // tool: the second Esc, now on the board, is what cancels.
          if (e.key !== 'Escape') return;
          e.preventDefault();
          setQuery('');
          e.currentTarget.blur();
        }}
      />
      {query && (
        <button
          type="button"
          className="palette-find__clear"
          aria-label="Clear filter"
          title="Clear filter"
          disabled={mode === 'bubble'}
          onClick={() => {
            setQuery('');
            findRef.current?.focus();
          }}
        >
          <ToolIcon name="cancel" />
        </button>
      )}
    </div>
  );

  const found =
    compact && filtering
      ? sections.flatMap((s) => s.rows.flatMap((r) => r.entries.filter(matches)))
      : [];

  return (
    <aside
      className="circuit-palette"
      ref={paletteRef}
      style={width === null ? undefined : { width: `${width}px` }}
    >
      {!compact && findField}
      {/* Compact only: the collapsible headings become a tab row, so every
          group is a tap away and exactly one is open. */}
      {compact && (
        <div className="palette-tabs" role="tablist">
          {[FIND_TAB, ...sections.map((s) => s.group)].map((group) => (
            <button
              key={group}
              type="button"
              role="tab"
              className="palette-tab"
              aria-selected={openGroup === group}
              onClick={() => setOpenGroup((cur) => (cur === group ? '' : group))}
            >
              {group}
            </button>
          ))}
        </div>
      )}
      {compact && (
        <div className="palette-group" hidden={openGroup !== FIND_TAB}>
          {findField}
          {found.length > 0 ? (
            <div className="palette-strip">{found.map((e) => renderItem(e, false))}</div>
          ) : (
            <p className="palette-empty">
              {filtering ? 'No part matches.' : 'Type a part number or a function.'}
            </p>
          )}
        </div>
      )}
      {/* Groups stay mounted and are hidden instead of unmounted: re-expanding
          one otherwise rebuilds a canvas per item. */}
      {sections.map((section) => {
        const { group, rows } = section;
        const open = isOpen(section);
        return (
          <Fragment key={group}>
            {(!filterRail || open) && (
              <PaletteSection label={group} open={open} onToggle={() => toggleGroup(group)} />
            )}
            <div className="palette-group" hidden={!open}>
              {compact && group === PARTS_GROUP && (
                <div className="palette-chips" role="group" aria-label="Function">
                  {[ALL_PARTS, ...rows.flatMap((r) => (r.sub ? [r.sub] : []))].map((sub) => (
                    <button
                      key={sub}
                      type="button"
                      className="palette-chip"
                      aria-pressed={partsSub === sub}
                      onClick={() => setPartsSub(sub)}
                    >
                      {sub}
                    </button>
                  ))}
                </div>
              )}
              <div className="palette-strip">
                {rows.map((row) => {
                  const off = offChip(group, row.sub);
                  return (
                    <Fragment key={row.sub ?? group}>
                      {row.sub && (
                        <div
                          className="palette-subhead"
                          hidden={off || (filterRail && !row.entries.some(matches))}
                        >
                          {row.sub}
                        </div>
                      )}
                      {row.entries.map((e) => renderItem(e, off || (filterRail && !matches(e))))}
                    </Fragment>
                  );
                })}
              </div>
            </div>
          </Fragment>
        );
      })}
      {filterRail && !sections.some(hasMatch) && (
        <p className="palette-empty">No part matches. Esc clears the filter.</p>
      )}
    </aside>
  );
}

interface Entry {
  key: string;
  kind: PaletteItem['kind'];
  label: string;
  caption?: string | undefined;
  params?: PaletteItem['params'];
  defId?: string | undefined;
  glyphWidth?: number | undefined;
}

interface Section {
  group: string;
  rows: { sub?: string; entries: Entry[] }[];
}

function blockEntry(item: PaletteItem): Entry {
  return {
    key: `block:${item.label}`,
    kind: item.kind,
    label: item.label,
    params: item.params,
    defId: item.defId,
  };
}

function chipEntry(def: ChipDef): Entry {
  return { key: `chip:${def.id}`, kind: 'chip', label: def.name, defId: def.id };
}

function partEntry(def: ChipDef): Entry {
  return { ...chipEntry(def), caption: partCaption(def), glyphWidth: DIP_BOX_W };
}

function PaletteSection(props: { label: string; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="palette-section-label"
      aria-expanded={props.open}
      onClick={props.onToggle}
    >
      <span className="palette-section-label__chevron">{props.open ? '▾' : '▸'}</span>
      {props.label}
    </button>
  );
}
