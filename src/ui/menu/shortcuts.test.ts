import { describe, expect, it } from 'vitest';
import { historyKey } from './shortcuts';

const key = (k: string, mods: { ctrl?: boolean; meta?: boolean; shift?: boolean } = {}) => ({
  key: k,
  ctrlKey: mods.ctrl ?? false,
  metaKey: mods.meta ?? false,
  shiftKey: mods.shift ?? false,
});

describe('historyKey', () => {
  it('reads Ctrl+Z as undo and both redo spellings as redo', () => {
    expect(historyKey(key('z', { ctrl: true }))).toBe('undo');
    expect(historyKey(key('Z', { ctrl: true, shift: true }))).toBe('redo');
    expect(historyKey(key('y', { ctrl: true }))).toBe('redo');
    expect(historyKey(key('z', { meta: true }))).toBe('undo');
  });

  it('ignores the letters without Ctrl, and Ctrl+Shift+Y', () => {
    expect(historyKey(key('y'))).toBeNull();
    expect(historyKey(key('z'))).toBeNull();
    expect(historyKey(key('Y', { ctrl: true, shift: true }))).toBeNull();
  });
});
