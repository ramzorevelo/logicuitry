import { describe, expect, it } from 'vitest';
import { PreviewController } from './ghostPreview';

describe('PreviewController', () => {
  it('begins, updates, and commits a proposal once', () => {
    const pc = new PreviewController<number>();
    expect(pc.active).toBe(false);
    pc.begin(1);
    pc.update(2);
    expect(pc.current?.proposal).toBe(2);
    expect(pc.commit()).toBe(2);
    expect(pc.active).toBe(false);
    expect(pc.commit()).toBeNull();
  });

  it('cancel drops the proposal without committing', () => {
    const pc = new PreviewController<string>();
    pc.begin('x');
    pc.cancel();
    expect(pc.active).toBe(false);
    expect(pc.commit()).toBeNull();
  });

  it('tracks per-sub-item flags', () => {
    const pc = new PreviewController<string>();
    pc.begin('batch');
    pc.setFlag('w1', true);
    pc.setFlag('w2', false);
    expect(pc.current?.flags.get('w1')).toBe(true);
    expect(pc.current?.flags.get('w2')).toBe(false);
  });
});
