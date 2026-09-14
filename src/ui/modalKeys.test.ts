import { describe, expect, it } from 'vitest';
import { modalKeysHeld, pushModalKeys } from './modalKeys';

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
