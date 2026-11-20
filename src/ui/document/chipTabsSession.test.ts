import { beforeEach, describe, expect, it } from 'vitest';
import { useCircuitStore } from '../workbench-circuit/circuitStore';
import { EXAMPLES } from '../../examples';
import type { ChipDef } from '../../core/model/types';
import type { Session } from '../../io/sessionStore';
import {
  chipTabsOf,
  chipsDivergedFromLibrary,
  restoreChipTabs,
  withoutUnsavedTabs,
} from './chipTabsSession';
import { chipSourceOf } from './chipSave';
import type { DocFile } from '../../io/platform';

const st = () => useCircuitStore.getState();
const example = EXAMPLES.find((e) => e.id === 'full-adder')!;
const halfAdder = example.chips![0]!;
const edited: ChipDef = { ...halfAdder, name: 'Half adder, edited' };

/** A fresh page: the example's board and chips, nothing open. */
function reload() {
  st().loadChipDefs(structuredClone(example.chips!));
  st().loadBoard(structuredClone(example.board));
}

function sessionOf(): Session {
  return { board: st().board, dirty: false, savedAt: 0, ...chipTabsOf(st(), () => undefined) };
}

beforeEach(() => {
  useCircuitStore.setState({ powered: false, running: false });
  reload();
});

describe('chip tabs across a reload', () => {
  it('reopens every chip tab in order, unsaved edits and the tab in front included', () => {
    st().openDefTab(halfAdder.id, `main/ha1:${halfAdder.id}/`, 'ha1');
    st().openDefTab(halfAdder.id, `${halfAdder.id}/`, 'Half adder');
    st().loadChipDefs([edited]);
    const front = st().tabs[1]!.id;
    st().setActiveTab(front);
    const session = sessionOf();
    expect(session.chipTabs).toHaveLength(2);
    expect(session.activeChipTab).toBe(0);

    reload();
    restoreChipTabs(session);
    const tabs = st().tabs.filter((t) => t.kind === 'def');
    expect(tabs.map((t) => t.kind === 'def' && t.prefix)).toEqual([
      `main/ha1:${halfAdder.id}/`,
      `${halfAdder.id}/`,
    ]);
    expect(st().chipLib.get(halfAdder.id)?.name).toBe('Half adder, edited');
    expect(st().chipTabDirty(tabs[0]!.id)).toBe(true);
    expect(st().activeTabId).toBe(tabs[0]!.id);
  });

  it('a saved chip comes back clean', () => {
    st().openDefTab(halfAdder.id, `${halfAdder.id}/`, 'Half adder');
    const session = sessionOf();
    reload();
    restoreChipTabs(session);
    const tab = st().tabs.find((t) => t.kind === 'def')!;
    expect(st().chipTabDirty(tab.id)).toBe(false);
  });

  it('skips a tab whose part is gone, and the board comes to the front', () => {
    st().openDefTab(halfAdder.id, `main/ha1:${halfAdder.id}/`, 'ha1');
    const session = sessionOf();
    session.board = {
      ...session.board,
      components: session.board.components.filter((c) => c.id !== 'ha1'),
    };
    st().loadBoard(session.board);
    restoreChipTabs(session);
    expect(st().tabs).toHaveLength(1);
    expect(st().activeTabId).toBe('board');
  });

  it('a session from before chip tabs opens the board alone', () => {
    restoreChipTabs({ board: st().board, dirty: false, savedAt: 0 });
    expect(st().tabs).toHaveLength(1);
  });

  it('a library load leaves an unsaved chip tab alone', () => {
    st().openDefTab(halfAdder.id, `${halfAdder.id}/`, 'Half adder');
    expect(withoutUnsavedTabs([halfAdder])).toEqual([halfAdder]);
    st().loadChipDefs([edited]);
    expect(withoutUnsavedTabs([halfAdder])).toEqual([]);
  });

  it('Save still targets the file a chip was opened from', () => {
    const file = { name: 'half-adder.lcirc' } as DocFile;
    st().openDefTab(halfAdder.id, `${halfAdder.id}/`, 'Half adder');
    const session = {
      board: st().board,
      dirty: false,
      savedAt: 0,
      ...chipTabsOf(st(), () => file),
    };
    reload();
    restoreChipTabs(session);
    expect(chipSourceOf(halfAdder.id)).toEqual({ kind: 'file', file });
  });

  it('skips a stored chip that no longer reads as a chip', () => {
    const broken = { ...halfAdder, formatVersion: 999 } as unknown as ChipDef;
    restoreChipTabs({
      board: st().board,
      dirty: false,
      savedAt: 0,
      chipTabs: [{ def: broken, saved: broken, prefix: 'x/', breadcrumb: 'x' }],
      activeChipTab: 0,
    });
    expect(st().tabs).toHaveLength(1);
    expect(st().activeTabId).toBe('board');
  });

  it('a clean tab takes the library copy when it is newer', () => {
    st().openDefTab(halfAdder.id, `${halfAdder.id}/`, 'Half adder');
    const session = sessionOf();
    reload();
    st().loadChipDefs([edited]);
    restoreChipTabs(session);
    const tab = st().tabs.find((t) => t.kind === 'def')!;
    expect(st().chipLib.get(halfAdder.id)?.name).toBe('Half adder, edited');
    expect(st().chipTabDirty(tab.id)).toBe(false);
  });
  it('a library copy newer than the session base wins over restored edits', () => {
    st().openDefTab(halfAdder.id, `${halfAdder.id}/`, 'Half adder');
    st().loadChipDefs([edited]);
    const session = sessionOf();
    const newer: ChipDef = { ...halfAdder, name: 'Half adder, newer on disk', version: 9 };
    reload();
    st().loadChipDefs([newer]);
    useCircuitStore.setState({ error: null });
    restoreChipTabs(session);
    const tab = st().tabs.find((t) => t.kind === 'def')!;
    expect(st().chipLib.get(halfAdder.id)?.name).toBe('Half adder, newer on disk');
    expect(st().chipTabDirty(tab.id)).toBe(false);
    expect(st().error).toMatch(/Half adder, edited.*unsaved edits.*dropped/);
  });

  it('a live dirty tab is kept when the library holds a different copy', () => {
    st().openDefTab(halfAdder.id, `${halfAdder.id}/`, 'Half adder');
    st().loadChipDefs([edited]);
    const newer: ChipDef = { ...halfAdder, name: 'Half adder, newer on disk', version: 9 };
    expect(withoutUnsavedTabs([newer])).toEqual([]);
    expect(chipsDivergedFromLibrary([newer])).toEqual(['Half adder, newer on disk']);
    expect(chipsDivergedFromLibrary([halfAdder])).toEqual([]);
    const tab = st().tabs.find((t) => t.kind === 'def')!;
    expect(st().chipLib.get(halfAdder.id)?.name).toBe('Half adder, edited');
    expect(st().chipTabDirty(tab.id)).toBe(true);
  });
});
