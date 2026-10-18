import { describe, expect, it } from 'vitest';
import { claimEscape, modalKeysHeld, pushModalKeys } from './modalKeys';

describe('modal key gate', () => {
  it('is not held with no dialog open', () => {
    expect(modalKeysHeld()).toBe(false);
  });

  it('holds until the last of several dialogs releases', () => {
    const first = pushModalKeys();
    const second = pushModalKeys();
    expect(modalKeysHeld()).toBe(true);
    second();
    expect(modalKeysHeld()).toBe(true);
    first();
    expect(modalKeysHeld()).toBe(false);
  });

  it('ignores a repeated release, which StrictMode double-cleanup would send', () => {
    const release = pushModalKeys();
    const other = pushModalKeys();
    release();
    release();
    expect(modalKeysHeld()).toBe(true);
    other();
    expect(modalKeysHeld()).toBe(false);
  });
});

describe('Escape with dialogs stacked', () => {
  it('belongs to the newest dialog, then passes to the one behind it', () => {
    const behind = claimEscape();
    const front = claimEscape();
    expect([behind.isTop, front.isTop]).toEqual([false, true]);
    front.release();
    expect(behind.isTop).toBe(true);
    front.release();
    expect(behind.isTop).toBe(true);
    behind.release();
  });
});
