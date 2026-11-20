import { beforeEach, describe, expect, it } from 'vitest';
import { useOnboardingStore } from './onboardingStore';

const s = () => useOnboardingStore.getState();

beforeEach(() => s().end());

describe('build completion latch', () => {
  it('holds once set, until the tutorial ends', () => {
    s().startBuild();
    expect(s().buildCompleted).toBe(false);
    s().completeBuild();
    expect(s().buildCompleted).toBe(true);
    expect(s().phase).toBe('build');
    s().end();
    expect(s().buildCompleted).toBe(false);
  });

  it('is cleared by a fresh tutorial start and by Esc leaving the build', () => {
    s().startBuild();
    s().completeBuild();
    s().startBuild();
    expect(s().buildCompleted).toBe(false);
    s().completeBuild();
    s().idleEscape();
    expect(s().phase).toBe('off');
    expect(s().buildCompleted).toBe(false);
  });
});
