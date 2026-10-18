import { describe, expect, it, vi } from 'vitest';
import { createBackStack, type HistoryPort } from './backStack';

/** A session history modelled on Chrome: a traversal lands asynchronously, and one asked for
 *  while another is pending in the same task is folded into it (dropped). `states` seeds the
 *  entries a reload kept, oldest first. */
function fakeHistory(states: unknown[] = [null]) {
  let entries = [...states];
  let index = entries.length - 1;
  let pending: number | null = null;
  let folded = 0;
  const history: HistoryPort = {
    pushState: (data) => {
      entries = [...entries.slice(0, index + 1), data];
      index++;
    },
    go: (delta) => {
      if (pending !== null) folded++;
      else pending = delta;
    },
    get state() {
      return entries[index];
    },
  };
  const land = (delta: number, backStack: { onPop(): void }) => {
    const next = Math.max(0, Math.min(entries.length - 1, index + delta));
    if (next === index) return;
    index = next;
    backStack.onPop();
  };
  return {
    history,
    /** Entries up to the current one: what Back can still reach. */
    get entries() {
      return index + 1;
    },
    get folded() {
      return folded;
    },
    /** Delivers queued traversals (each may queue another), then a user's Back presses. */
    flush(backStack: { onPop(): void }, userBacks = 0) {
      while (pending !== null) {
        const delta = pending;
        pending = null;
        land(delta, backStack);
      }
      for (let i = 0; i < userBacks; i++) {
        land(-1, backStack);
        this.flush(backStack);
      }
    },
    forward(backStack: { onPop(): void }) {
      land(1, backStack);
      this.flush(backStack);
    },
  };
}

describe('createBackStack', () => {
  it('Back closes the top layer and only that one', () => {
    const h = fakeHistory();
    const stack = createBackStack(h.history);
    const sheet = vi.fn();
    const dialog = vi.fn();
    stack.open(sheet);
    stack.open(dialog);
    expect(h.entries).toBe(3);
    h.flush(stack, 1);
    expect(dialog).toHaveBeenCalledOnce();
    expect(sheet).not.toHaveBeenCalled();
    h.flush(stack, 1);
    expect(sheet).toHaveBeenCalledOnce();
    expect(stack.depth).toBe(0);
    expect(h.entries).toBe(1);
  });

  it('a layer closed by its own button removes its entry without closing another', () => {
    const h = fakeHistory();
    const stack = createBackStack(h.history);
    const sheet = vi.fn();
    stack.open(sheet);
    const releaseDialog = stack.open(vi.fn());
    releaseDialog();
    h.flush(stack);
    expect(sheet).not.toHaveBeenCalled();
    expect(stack.depth).toBe(1);
    expect(h.entries).toBe(2);
  });

  it('two layers closing in one task remove both entries, so the next Back still works', () => {
    const h = fakeHistory();
    const stack = createBackStack(h.history);
    const sheet = vi.fn();
    stack.open(sheet);
    const releaseA = stack.open(vi.fn());
    const releaseB = stack.open(vi.fn());
    releaseB();
    releaseA();
    h.flush(stack);
    expect(h.folded).toBe(0);
    expect(h.entries).toBe(2);
    h.flush(stack, 1);
    expect(sheet).toHaveBeenCalledOnce();
    expect(h.entries).toBe(1);
  });

  it('every layer closing at once returns to the base entry', () => {
    const h = fakeHistory();
    const stack = createBackStack(h.history);
    const releases = [stack.open(vi.fn()), stack.open(vi.fn()), stack.open(vi.fn())];
    for (const release of releases.reverse()) release();
    h.flush(stack);
    expect(h.folded).toBe(0);
    expect(h.entries).toBe(1);
    expect(stack.depth).toBe(0);
  });

  it('a layer opened while a traversal is in flight still gets its entry', () => {
    const h = fakeHistory();
    const stack = createBackStack(h.history);
    const releaseMenu = stack.open(vi.fn());
    releaseMenu();
    const dialog = vi.fn();
    stack.open(dialog);
    h.flush(stack);
    expect(h.entries).toBe(2);
    expect(dialog).not.toHaveBeenCalled();
    h.flush(stack, 1);
    expect(dialog).toHaveBeenCalledOnce();
    expect(h.entries).toBe(1);
  });

  it('a layer opened while an entry is owed takes that entry over', () => {
    const h = fakeHistory();
    const stack = createBackStack(h.history);
    const releaseA = stack.open(vi.fn());
    const releaseB = stack.open(vi.fn());
    releaseB();
    releaseA();
    const dialog = vi.fn();
    stack.open(dialog);
    h.flush(stack);
    expect(h.entries).toBe(2);
    h.flush(stack, 1);
    expect(dialog).toHaveBeenCalledOnce();
    expect(h.entries).toBe(1);
  });

  it('releasing a layer Back already closed does nothing', () => {
    const h = fakeHistory();
    const stack = createBackStack(h.history);
    const release = stack.open(vi.fn());
    h.flush(stack, 1);
    release();
    h.flush(stack);
    expect(h.entries).toBe(1);
  });

  it('Forward onto a closed layer entry steps back off it without closing a live layer', () => {
    const h = fakeHistory();
    const stack = createBackStack(h.history);
    const sheet = vi.fn();
    stack.open(sheet);
    stack.open(vi.fn());
    h.flush(stack, 1);
    h.forward(stack);
    expect(sheet).not.toHaveBeenCalled();
    expect(h.entries).toBe(2);
    h.flush(stack, 1);
    expect(sheet).toHaveBeenCalledOnce();
    expect(h.entries).toBe(1);
  });

  it('Back with nothing open is left to the browser', () => {
    const h = fakeHistory();
    const stack = createBackStack(h.history);
    expect(() => stack.onPop()).not.toThrow();
    expect(stack.depth).toBe(0);
  });

  it('a reload with layers open drops their entries, so the next Back reaches a live layer', () => {
    const layer = { lcirLayer: true };
    const h = fakeHistory([null, layer, layer]);
    const stack = createBackStack(h.history);
    stack.dropStale();
    const dialog = vi.fn();
    stack.open(dialog);
    h.flush(stack);
    expect(h.entries).toBe(2);
    h.flush(stack, 1);
    expect(dialog).toHaveBeenCalledOnce();
    expect(h.entries).toBe(1);
  });

  it('a load on an ordinary entry leaves the history alone', () => {
    const h = fakeHistory();
    const stack = createBackStack(h.history);
    stack.dropStale();
    h.flush(stack);
    expect(h.entries).toBe(1);
  });
});
