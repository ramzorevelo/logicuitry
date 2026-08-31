// The component rail. Split out of CircuitWorkbench so collapsing a group
// re-renders the rail alone: the workbench is a very large component, and a
// group toggle used to rebuild all of it.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCircuitStore } from './circuitStore';
import { useCompact } from '../compact';
import { useCoarsePointer } from '../pointerKind';
import { isBuiltinChipId } from '../../core/parts/packages';
import { LONG_PRESS_MS } from './touchGestures';
import { PALETTE, PALETTE_GROUPS, PARTS_GROUP } from './palette';
import { PaletteGlyph } from './PaletteGlyph';

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
  const isOpen = useCallback(
    (group: string) => (compact ? openGroup === group : !collapsed.has(group)),
    [compact, openGroup, collapsed],
  );
  const toggleGroup = useCallback(
    (group: string) => {
      if (compact) {
        setOpenGroup((cur) => (cur === group ? '' : group));
        return;
      }
      setCollapsed((cur) => {
        const next = new Set(cur);
        if (!next.delete(group)) next.add(group);
        return next;
      });
    },
    [compact],
  );

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
    return [all.filter((d) => isBuiltinChipId(d.id)), all.filter((d) => !isBuiltinChipId(d.id))];
  }, [chipLib]);

  // Groups stay mounted and are hidden instead of unmounted: re-expanding one
  // otherwise rebuilds a canvas per item, and each of those is a full
  // schematic draw.
  const groups = [
    ...PALETTE_GROUPS,
    ...(parts.length > 0 ? [PARTS_GROUP] : []),
    ...(chips.length > 0 ? ['My chips'] : []),
  ];

  return (
    <aside
      className="circuit-palette"
      ref={paletteRef}
      style={width === null ? undefined : { width: `${width}px` }}
    >
      {/* Compact only: the collapsible headings become a tab row, so all five
          groups are visible at once and exactly one is open. */}
      {compact && (
        <div className="palette-tabs" role="tablist">
          {groups.map((group) => (
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
      {PALETTE_GROUPS.map((group) => (
        <Fragment key={group}>
          <PaletteSection label={group} open={isOpen(group)} onToggle={() => toggleGroup(group)} />
          <div className="palette-group" hidden={!isOpen(group)}>
            {PALETTE.filter((item) => item.group === group).map((item) => (
              <button
                key={item.label}
                type="button"
                className={`palette-item${
                  tool.kind === 'place' &&
                  tool.componentKind === item.kind &&
                  tool.params === item.params
                    ? ` palette-item--active${tool.repeat ? ' palette-item--repeat' : ''}`
                    : ''
                }`}
                disabled={mode === 'bubble'}
                title={`${item.label} (${keepPlacing})`}
                {...holdProps(
                  () =>
                    store.getState().setTool({
                      kind: 'place',
                      componentKind: item.kind,
                      ...(item.params ? { params: item.params } : {}),
                    }),
                  () =>
                    store.getState().setTool({
                      kind: 'place',
                      componentKind: item.kind,
                      ...(item.params ? { params: item.params } : {}),
                      repeat: true,
                    }),
                )}
              >
                <PaletteGlyph kind={item.kind} chipLib={chipLib} params={item.params} />
                <span className="palette-item__label">{item.label}</span>
              </button>
            ))}
          </div>
        </Fragment>
      ))}
      {[[PARTS_GROUP, parts] as const, ['My chips', chips] as const].map(([label, defs]) =>
        defs.length === 0 ? null : (
          <Fragment key={label}>
            <PaletteSection
              label={label}
              open={isOpen(label)}
              onToggle={() => toggleGroup(label)}
            />
            <div className="palette-group" hidden={!isOpen(label)}>
              {defs.map((def) => (
                <button
                  key={def.id}
                  type="button"
                  className={`palette-item${
                    tool.kind === 'place' && tool.componentKind === 'chip' && tool.defId === def.id
                      ? ` palette-item--active${tool.repeat ? ' palette-item--repeat' : ''}`
                      : ''
                  }`}
                  disabled={mode === 'bubble'}
                  title={`${def.name} (${keepPlacing})`}
                  {...holdProps(
                    () =>
                      store
                        .getState()
                        .setTool({ kind: 'place', componentKind: 'chip', defId: def.id }),
                    () =>
                      store.getState().setTool({
                        kind: 'place',
                        componentKind: 'chip',
                        defId: def.id,
                        repeat: true,
                      }),
                  )}
                >
                  <PaletteGlyph kind="chip" chipLib={chipLib} defId={def.id} />
                  <span className="palette-item__label">{def.name}</span>
                </button>
              ))}
            </div>
          </Fragment>
        ),
      )}
    </aside>
  );
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
