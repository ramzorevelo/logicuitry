import { beforeEach, describe, expect, it } from 'vitest';
import * as bv from '../../core/value/busValue';
import { offeredRun, useCircuitStore } from './circuitStore';
import type { Board } from '../../core/model/types';
import { board, chipComp, comp, memChipDef, wire } from '../../core/model/testFixtures';
import type { RamEntry } from '../../core/model/ramView';
import { usePrefsStore } from '../prefs';

const st = () => useCircuitStore.getState();

/** RAM `m` (8 x 2) with address, write and select on switches and data on a constant. */
function ramBoard(preload = ''): Board {
  return board({
    components: [
      comp('A', 'toggle', undefined, 'A'),
      comp('W', 'toggle', undefined, 'W'),
      comp('C', 'toggle', undefined, 'C'),
      comp('D', 'constant', { value: 0x5a, width: 8 }, 'D'),
      comp('S', 'toggle', undefined, 'S'),
      comp('m', 'ram', { width: 8, addressBits: 1, ...(preload ? { preload } : {}) }, 'MEM'),
    ],
    wires: [
      wire('wa', ['A', 'y'], ['m', 'a']),
      wire('ww', ['W', 'y'], ['m', 'we']),
      wire('wc', ['C', 'y'], ['m', 'cs']),
      wire('wd', ['D', 'y'], ['m', 'd']),
    ],
  });
}

const ram = (): RamEntry => {
  const r = st().memoryRams();
  if ('error' in r) throw new Error(r.error);
  return r.rams[0]!;
};

const liveHex = () =>
  st()
    .ramLive(ram().index)!
    .cells.map((c) => (bv.isFullyKnown(c, 8) ? c.v.toString(16) : 'X'));

/** Powers on and writes 5A to address 0 through we and cs. */
function writeOnce() {
  st().power();
  st().toggleInput('C');
  st().toggleInput('W');
  st().settle();
  st().toggleInput('W');
  st().settle();
}

beforeEach(() => {
  usePrefsStore.getState().setPref('keepSwitchesAcrossPower', false);
  st().loadBoard(ramBoard('11'));
});

describe('memoryRams', () => {
  it('lists the RAM unpowered, memoized on the board', () => {
    expect(ram()).toMatchObject({ title: 'MEM', preload: '11', width: 8, addressBits: 1 });
    expect(st().memoryRams()).toBe(st().memoryRams());
  });

  it("names a '189 core by its package, through the store's lowered compile", () => {
    st().loadBoard(board({ components: [chipComp('u4', '74LS189', 'U4')] }));
    expect(ram()).toMatchObject({ title: 'U4', invertedOut: true, width: 4 });
  });

  it('reports a board that does not compile instead of throwing', () => {
    st().loadBoard(board({ components: [comp('m', 'ram', { preload: 'zz' })] }));
    expect(st().memoryRams()).toHaveProperty('error');
  });
});

describe('live view', () => {
  it('follows writes and the address while powered, null while off', () => {
    expect(st().ramLive(0)).toBeNull();
    writeOnce();
    expect(liveHex()).toEqual(['5a', 'X']);
    expect(st().ramLive(ram().index)!.address).toBe(0);
    st().toggleInput('A');
    st().settle();
    expect(st().ramLive(ram().index)!.address).toBe(1);
  });
});

describe('setRamPreload', () => {
  it('commits one undo step and is refused while powered', () => {
    expect(st().setRamPreload(ram(), '22 33')).toBe(true);
    expect(st().board.components.find((c) => c.id === 'm')!.params!['preload']).toBe('22 33');
    st().undo();
    expect(st().board.components.find((c) => c.id === 'm')!.params!['preload']).toBe('11');
    st().redo();
    expect(ram().preload).toBe('22 33');
    st().power();
    expect(st().setRamPreload(ram(), '44')).toBe(false);
  });

  it('drops the key for an all-X preload', () => {
    st().setRamPreload(ram(), '');
    expect(st().board.components.find((c) => c.id === 'm')!.params).not.toHaveProperty('preload');
  });

  it('writes a chip instance contents entry without touching other keys', () => {
    st().loadChipDefs([memChipDef()]);
    st().loadBoard(board({ components: [chipComp('u1', 'mem', 'U1', { r1: '01', old: '7' })] }));
    expect(ram().target).toEqual({ kind: 'contents', instanceId: 'u1', key: 'r1' });
    expect(st().setRamPreload(ram(), 'AA BB')).toBe(true);
    const u1 = st().board.components.find((c) => c.id === 'u1') as { contents?: object };
    expect(u1.contents).toEqual({ r1: 'AA BB', old: '7' });
    expect(ram().preload).toBe('AA BB');
  });

  it('refuses a misfit slot, which holds a kept entry', () => {
    st().loadChipDefs([memChipDef()]);
    st().loadBoard(board({ components: [chipComp('u1', 'mem', 'U1', { r1: '1 2 3' })] }));
    expect(ram().misfit).toBe(true);
    expect(st().setRamPreload(ram(), 'AA')).toBe(false);
  });
});

describe('Keep last run as preload', () => {
  it('offers the final cells after Space off, applies as one undo step', () => {
    writeOnce();
    st().power();
    expect(offeredRun(st(), 'main/m')).not.toBeNull();
    st().keepLastRun(ram());
    expect(ram().preload).toBe('5A');
    expect(offeredRun(st(), 'main/m')).toBeNull();
    st().undo();
    expect(ram().preload).toBe('11');
  });

  it('is retired by any other edit and by power-on', () => {
    writeOnce();
    st().power();
    st().setComponentParams('S', { width: 2 });
    expect(offeredRun(st(), 'main/m')).toBeNull();
    writeOnce();
    st().power();
    st().power();
    expect(offeredRun(st(), 'main/m')).toBeNull();
  });
});

describe('two RAMs', () => {
  it("keeping one RAM's run leaves the other offer up", () => {
    const b = ramBoard();
    b.components.push(comp('m2', 'ram', { width: 8, addressBits: 1 }, 'MEM2'));
    b.wires.push(
      wire('wa2', ['A', 'y'], ['m2', 'a']),
      wire('ww2', ['W', 'y'], ['m2', 'we']),
      wire('wc2', ['C', 'y'], ['m2', 'cs']),
      wire('wd2', ['D', 'y'], ['m2', 'd']),
    );
    st().loadBoard(b);
    writeOnce();
    st().power();
    st().keepLastRun(ram());
    expect(offeredRun(st(), 'main/m')).toBeNull();
    expect(offeredRun(st(), 'main/m2')).not.toBeNull();
  });
});

describe('held cells across a powered edit', () => {
  it('restores the cells after a powered topology edit, pref off', () => {
    writeOnce();
    st().setComponentParams('S', { width: 2 });
    expect(st().powered).toBe(false);
    st().power();
    expect(liveHex()).toEqual(['5a', 'X']);
  });

  it('keeps them through a later unpowered edit, then consumes them', () => {
    writeOnce();
    st().setComponentParams('S', { width: 2 });
    st().setComponentParams('S', { width: 3 });
    st().power();
    expect(liveHex()).toEqual(['5a', 'X']);
    st().power();
    st().power();
    expect(liveHex()).toEqual(['11', 'X']);
  });

  it('holds across undo of a powered edit', () => {
    st().setComponentParams('S', { width: 2 });
    writeOnce();
    st().undo();
    st().power();
    expect(liveHex()).toEqual(['5a', 'X']);
  });

  it('holds across redo of a powered edit', () => {
    st().setComponentParams('S', { width: 2 });
    st().undo();
    writeOnce();
    st().redo();
    st().power();
    expect(liveHex()).toEqual(['5a', 'X']);
  });

  it('reloads the preload after a Space power cycle', () => {
    writeOnce();
    st().power();
    st().power();
    expect(liveHex()).toEqual(['11', 'X']);
  });

  it('starts a resized RAM from its preload', () => {
    writeOnce();
    st().setComponentParamsBatch([
      { id: 'm', params: { width: 4 } },
      { id: 'D', params: { width: 4 } },
    ]);
    st().power();
    expect(
      st()
        .ramLive(ram().index)!
        .cells.map((c) => (bv.isFullyKnown(c, 4) ? c.v.toString(16) : 'X')),
    ).toEqual(['1', 'X']);
  });

  it('drops a RAM whose preload was edited, and everything on load', () => {
    writeOnce();
    st().setComponentParams('S', { width: 2 });
    expect(st().heldRamIds().has('main/m')).toBe(true);
    st().setRamPreload(ram(), '22');
    expect(st().heldRamIds().has('main/m')).toBe(false);
    writeOnce();
    st().setComponentParams('S', { width: 3 });
    st().loadBoard(ramBoard('11'));
    expect(st().heldRamIds().size).toBe(0);
  });
});

describe('dock tab', () => {
  it('clears scrub replay when Memory opens', () => {
    writeOnce();
    st().setReplayTime(0);
    st().setDockTab('memory');
    expect(st().replayTimePs).toBeNull();
    expect(st().dockTab).toBe('memory');
  });
});
