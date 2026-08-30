import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

// Right-edge slide-out reference drawer (the bitwise.html #tt-sidebar pattern):
// a persistent vertical tab that width-animates a content panel open. Workbenches
// supply content through context; when none is supplied the strip hides entirely.
// Open state lives in the provider so a workbench action (e.g. the Circuit
// workbench's Analyze button) can open the panel programmatically, not just
// the tab click.

export interface DrawerContent {
  label: string; // vertical tab caption
  body: ReactNode;
}

interface DrawerApi {
  content: DrawerContent | null;
  setContent: (c: DrawerContent | null) => void;
  open: boolean;
  setOpen: (v: boolean) => void;
}

const ReferenceContext = createContext<DrawerApi | null>(null);

export function ReferenceDrawerProvider({ children }: { children: ReactNode }) {
  const [content, setContent] = useState<DrawerContent | null>(null);
  const [open, setOpen] = useState(false);
  const api = useMemo(() => ({ content, setContent, open, setOpen }), [content, open]);
  return <ReferenceContext.Provider value={api}>{children}</ReferenceContext.Provider>;
}

/** Register drawer content for the active workbench; clears on unmount. */
export function useReferenceDrawer(content: DrawerContent | null): void {
  const api = useContext(ReferenceContext);
  useEffect(() => {
    if (!api) return;
    api.setContent(content);
    return () => api.setContent(null);
    // Callers pass memoized content; body identity drives updates.
  }, [api, content]);
}

/** Programmatic open/close for the panel (tab click still toggles it too). */
export function useReferenceDrawerControl(): { open: boolean; setOpen: (v: boolean) => void } {
  const api = useContext(ReferenceContext);
  return { open: api?.open ?? false, setOpen: api?.setOpen ?? (() => undefined) };
}

/** The right-edge drawer itself, rendered once by the app shell. */
export function ReferenceDrawer() {
  const api = useContext(ReferenceContext);
  const content = api?.content ?? null;
  if (!api || !content) return null;
  const { open, setOpen } = api;

  return (
    <>
      {/* Compact only (CSS decides): a real element rather than a pseudo one,
          because tapping the dimmed area has to close the sheet, and a
          pseudo-element's hits land on the sheet itself. */}
      {open ? (
        <div className="ref-drawer__scrim" onClick={() => setOpen(false)} aria-hidden="true" />
      ) : null}
      <div className={`ref-drawer${open ? ' ref-drawer--open' : ''}`}>
        <button
          type="button"
          className="ref-drawer__tab"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <span className="ref-drawer__chevron" aria-hidden="true">
            {open ? '›' : '‹'}
          </span>
          <span className="ref-drawer__tab-label">{content.label}</span>
        </button>
        <div className="ref-drawer__inner">
          <div className="ref-drawer__content">{content.body}</div>
        </div>
      </div>
    </>
  );
}
