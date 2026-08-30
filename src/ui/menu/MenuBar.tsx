import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MENU_LABELS,
  firstSelectable,
  isSeparator,
  isSubmenu,
  lastSelectable,
  nextSelectable,
  type Menu,
  type MenuCommand,
} from './menuModel';

interface Props {
  menus: readonly Menu[];
}

/** WAI-ARIA menubar: roving tabindex across the bar, arrow keys within a menu,
 *  Esc closes and returns focus. F10 (bound by the shell) focuses the bar. */
export function MenuBar({ menus }: Props) {
  const [barIndex, setBarIndex] = useState(0);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [itemIndex, setItemIndex] = useState(-1);
  // Index into the open submenu's own items; null when no flyout is open.
  const [subIndex, setSubIndex] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const barRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const close = useCallback((focusBar: boolean) => {
    setOpenIndex(null);
    setItemIndex(-1);
    setSubIndex(null);
    if (focusBar) barRefs.current[0]?.focus();
  }, []);

  // Clamp when the active workbench changes the bar out from under us.
  useEffect(() => {
    if (barIndex >= menus.length) setBarIndex(0);
    if (openIndex !== null && openIndex >= menus.length) close(false);
  }, [menus.length, barIndex, openIndex, close]);

  useEffect(() => {
    if (openIndex === null) return;
    const onDocPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener('pointerdown', onDocPointerDown, true);
    return () => document.removeEventListener('pointerdown', onDocPointerDown, true);
  }, [openIndex, close]);

  const open = (i: number) => {
    setOpenIndex(i);
    setBarIndex(i);
    setItemIndex(firstSelectable(menus[i]?.items ?? []));
    setSubIndex(null);
  };

  const submenuAt = (menuIdx: number | null, itemIdx: number) => {
    const entry = menuIdx === null ? undefined : menus[menuIdx]?.items[itemIdx];
    return entry && isSubmenu(entry) && !entry.disabled ? entry : undefined;
  };

  const activate = (menuIdx: number, itemIdx: number) => {
    const entry = menus[menuIdx]?.items[itemIdx];
    if (!entry || isSeparator(entry) || entry.disabled) return;
    if (isSubmenu(entry)) {
      // Landing on a submenu opens it rather than doing nothing.
      setItemIndex(itemIdx);
      setSubIndex(0);
      return;
    }
    close(false);
    entry.run();
  };

  const runSub = (cmd: MenuCommand) => {
    if (cmd.disabled) return;
    close(false);
    cmd.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const items = openIndex === null ? [] : (menus[openIndex]?.items ?? []);
    const moveBar = (dir: 1 | -1) => {
      const n = menus.length;
      if (n === 0) return;
      const next = (((barIndex + dir) % n) + n) % n;
      setBarIndex(next);
      barRefs.current[next]?.focus();
      if (openIndex !== null) open(next);
    };
    // While a flyout is open the arrow keys belong to it, not to the bar.
    const sub = subIndex === null ? undefined : submenuAt(openIndex, itemIndex);
    const moveSub = (dir: 1 | -1) => {
      if (!sub) return;
      const n = sub.items.length;
      for (let step = 1; step <= n; step++) {
        const i = (((subIndex! + dir * step) % n) + n) % n;
        if (!sub.items[i]!.disabled) {
          setSubIndex(i);
          return;
        }
      }
    };
    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault();
        if (!sub && submenuAt(openIndex, itemIndex)) setSubIndex(0);
        else moveBar(1);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (sub) setSubIndex(null);
        else moveBar(-1);
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (openIndex === null) open(barIndex);
        else if (sub) moveSub(1);
        else setItemIndex(nextSelectable(items, itemIndex, 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (openIndex === null) open(barIndex);
        else if (sub) moveSub(-1);
        else setItemIndex(nextSelectable(items, itemIndex, -1));
        break;
      case 'Home':
        if (openIndex !== null && !sub) {
          e.preventDefault();
          setItemIndex(firstSelectable(items));
        }
        break;
      case 'End':
        if (openIndex !== null && !sub) {
          e.preventDefault();
          setItemIndex(lastSelectable(items));
        }
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (openIndex === null) open(barIndex);
        else if (sub) runSub(sub.items[subIndex!]!);
        else activate(openIndex, itemIndex);
        break;
      case 'Escape':
        if (sub) {
          e.preventDefault();
          setSubIndex(null);
        } else if (openIndex !== null) {
          e.preventDefault();
          close(true);
        }
        break;
      case 'Tab':
        close(false);
        break;
      default:
        break;
    }
  };

  if (menus.length === 0) return null;

  return (
    <div className="menubar" role="menubar" ref={rootRef} onKeyDown={onKeyDown}>
      {menus.map((menu, i) => (
        <div className="menubar__menu" key={menu.id}>
          <button
            type="button"
            className="menubar__title"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={openIndex === i}
            tabIndex={barIndex === i ? 0 : -1}
            ref={(el) => {
              barRefs.current[i] = el;
            }}
            onClick={() => (openIndex === i ? close(false) : open(i))}
            // Once one menu is open, sliding across the bar switches menus, as
            // every desktop menu bar does; hovering a closed bar opens nothing.
            // Mouse only: a touch fires pointerenter on the tapped title just
            // before the click, which would open it and let the click close it
            // again.
            onPointerEnter={(e) => {
              if (e.pointerType !== 'mouse') return;
              if (openIndex !== null && openIndex !== i) open(i);
            }}
          >
            {MENU_LABELS[menu.id]}
          </button>
          {openIndex === i && (
            <div className="menubar__popup" role="menu" aria-label={MENU_LABELS[menu.id]}>
              {menu.items.map((entry, j) => {
                if (isSeparator(entry))
                  return <div className="menubar__sep" key={`sep${j}`} role="separator" />;
                if (isSubmenu(entry)) {
                  const openSub = itemIndex === j && subIndex !== null;
                  return (
                    <div className="menubar__submenu" key={entry.id}>
                      <button
                        type="button"
                        className="menubar__item"
                        role="menuitem"
                        aria-haspopup="menu"
                        aria-expanded={openSub}
                        disabled={entry.disabled ?? false}
                        data-active={itemIndex === j ? '' : undefined}
                        tabIndex={-1}
                        onPointerEnter={(e) => {
                          if (e.pointerType !== 'mouse') return;
                          setItemIndex(j);
                          setSubIndex(0);
                        }}
                        onClick={() => activate(i, j)}
                      >
                        <span className="menubar__check" aria-hidden="true" />
                        <span className="menubar__label">{entry.label}</span>
                        <span className="menubar__key" aria-hidden="true">
                          ›
                        </span>
                      </button>
                      {openSub && (
                        <div className="menubar__popup menubar__popup--sub" role="menu">
                          {entry.items.map((cmd, k) => (
                            <button
                              type="button"
                              key={cmd.id}
                              className="menubar__item"
                              role="menuitem"
                              disabled={cmd.disabled ?? false}
                              aria-checked={cmd.checked}
                              data-active={subIndex === k ? '' : undefined}
                              tabIndex={-1}
                              onPointerEnter={(e) => {
                                if (e.pointerType === 'mouse') setSubIndex(k);
                              }}
                              onClick={() => runSub(cmd)}
                            >
                              <span className="menubar__check" aria-hidden="true">
                                {cmd.checked ? '✓' : ''}
                              </span>
                              <span className="menubar__label">{cmd.label}</span>
                              <span className="menubar__key">{cmd.shortcut ?? ''}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                }
                return (
                  <button
                    type="button"
                    key={entry.id}
                    className="menubar__item"
                    role="menuitem"
                    disabled={entry.disabled ?? false}
                    aria-checked={entry.checked}
                    data-active={itemIndex === j ? '' : undefined}
                    tabIndex={-1}
                    onPointerEnter={(e) => {
                      if (e.pointerType !== 'mouse') return;
                      setItemIndex(j);
                      // Sliding off a submenu closes its flyout, as every
                      // desktop menu does.
                      setSubIndex(null);
                    }}
                    onClick={() => activate(i, j)}
                  >
                    <span className="menubar__check" aria-hidden="true">
                      {entry.checked ? '✓' : ''}
                    </span>
                    <span className="menubar__label">{entry.label}</span>
                    <span className="menubar__key">{entry.shortcut ?? ''}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
