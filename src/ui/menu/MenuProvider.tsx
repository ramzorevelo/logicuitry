import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { isSeparator, isSubmenu, type Menu, type MenuCommand, type MenuId } from './menuModel';

type Contributions = Record<string, readonly Menu[]>;

interface MenuContext {
  contributions: Contributions;
  contribute: (source: string, menus: readonly Menu[] | null) => void;
}

const Ctx = createContext<MenuContext | null>(null);

/** Menus are contributed per source (the shell, the active workbench) and
 *  merged at the bar, so File can mean "board" while Circuit is active without
 *  the shell knowing anything about boards. */
export function MenuProvider({ children }: { children: React.ReactNode }) {
  const [contributions, setContributions] = useState<Contributions>({});
  const contribute = useCallback((source: string, menus: readonly Menu[] | null) => {
    setContributions((prev) => {
      if (menus === null) {
        if (!(source in prev)) return prev;
        const next = { ...prev };
        delete next[source];
        return next;
      }
      return { ...prev, [source]: menus };
    });
  }, []);
  const value = useMemo(() => ({ contributions, contribute }), [contributions, contribute]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMenuContributions(): readonly (readonly Menu[])[] {
  const ctx = useContext(Ctx);
  return useMemo(() => Object.values(ctx?.contributions ?? {}), [ctx?.contributions]);
}

/** Publishes `menus` for as long as the calling component is mounted. Rebuild
 *  the array whenever the state its handlers read changes -- a menu item is a
 *  closure, and a stale one runs against a stale store read. */
export function useContributeMenus(source: string, menus: readonly Menu[]): void {
  const ctx = useContext(Ctx);
  const contribute = ctx?.contribute;
  useEffect(() => {
    if (!contribute) return;
    contribute(source, menus);
    return () => contribute(source, null);
  }, [contribute, source, menus]);
}

/** Looks up a contributed command so a button elsewhere can run it. Chrome
 *  outside the bar (a toolbar shortcut on a phone) then shares the menu's own
 *  handler instead of growing a second copy of it, and goes away by itself
 *  whenever the command is not contributed. */
export function useMenuCommand(menu: MenuId, id: string): MenuCommand | undefined {
  const contributions = useMenuContributions();
  return useMemo(() => {
    for (const menus of contributions)
      for (const m of menus) {
        if (m.id !== menu) continue;
        for (const entry of m.items) {
          if (isSeparator(entry)) continue;
          if (isSubmenu(entry)) {
            const hit = entry.items.find((c) => c.id === id);
            if (hit) return hit;
            continue;
          }
          if (entry.id === id) return entry;
        }
      }
    return undefined;
  }, [contributions, menu, id]);
}
