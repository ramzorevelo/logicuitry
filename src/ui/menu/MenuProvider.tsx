import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { isSeparator, isSubmenu, type Menu, type MenuCommand, type MenuId } from './menuModel';

type Contributions = Record<string, readonly Menu[]>;

interface MenuContext {
  contributions: Contributions;
  /** Sources in the order they first contributed. */
  order: readonly string[];
  contribute: (source: string, menus: readonly Menu[] | null) => void;
}

const Ctx = createContext<MenuContext | null>(null);

/** Menus are contributed per source (the shell, the active workbench) and
 *  merged at the bar, so File can mean "board" while Circuit is active without
 *  the shell knowing anything about boards. */
export function MenuProvider({ children }: { children: React.ReactNode }) {
  const [contributions, setContributions] = useState<Contributions>({});
  // A rebuilt contribution is removed then re-added by its effect; without a fixed order it
  // would move to the end and the File menu's sections would swap places.
  const order = useRef<string[]>([]);
  const contribute = useCallback((source: string, menus: readonly Menu[] | null) => {
    if (menus !== null && !order.current.includes(source)) order.current.push(source);
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
  const value = useMemo(
    () => ({ contributions, order: order.current, contribute }),
    [contributions, contribute],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMenuContributions(): readonly (readonly Menu[])[] {
  const ctx = useContext(Ctx);
  return useMemo(() => {
    const contributions = ctx?.contributions ?? {};
    const rank = (s: string) => ctx?.order.indexOf(s) ?? 0;
    return Object.keys(contributions)
      .sort((a, b) => rank(a) - rank(b))
      .map((s) => contributions[s]!);
  }, [ctx?.contributions, ctx?.order]);
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
