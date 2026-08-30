import { describe, expect, it } from 'vitest';
import { appliesSilently } from './updatePolicy';

const base = { installed: false, presentation: false, touched: false };

describe('appliesSilently', () => {
  it('updates a fresh browser tab, which is what opening the url should give you', () => {
    expect(appliesSilently(base)).toBe(true);
  });

  it('never takes over an installed app: that is the one running in front of a class', () => {
    expect(appliesSilently({ ...base, installed: true })).toBe(false);
  });

  it('never takes over during presentation mode', () => {
    expect(appliesSilently({ ...base, presentation: true })).toBe(false);
  });

  it('asks once someone has touched the page, rather than reloading over their work', () => {
    expect(appliesSilently({ ...base, touched: true })).toBe(false);
  });
});
