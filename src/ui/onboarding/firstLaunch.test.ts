import { describe, expect, it } from 'vitest';
import { shouldWelcome, type LaunchFacts } from './firstLaunch';

const fresh: LaunchFacts = { seen: 'never', documentOpened: false, presentation: false };

describe('shouldWelcome', () => {
  it('welcomes a fresh profile', () => {
    expect(shouldWelcome(fresh)).toBe(true);
  });

  it('never welcomes a profile that has run before', () => {
    expect(shouldWelcome({ ...fresh, seen: 'seen' })).toBe(false);
  });

  it('stays quiet when storage cannot remember the dismissal', () => {
    expect(shouldWelcome({ ...fresh, seen: 'unreadable' })).toBe(false);
  });

  it('stays quiet over a document the app was launched with', () => {
    expect(shouldWelcome({ ...fresh, documentOpened: true })).toBe(false);
  });

  it('stays quiet on the lecture screen', () => {
    expect(shouldWelcome({ ...fresh, presentation: true })).toBe(false);
  });
});
