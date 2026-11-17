import { describe, expect, it } from 'vitest';
import { placeMenu } from './menuPlacement';

describe('placeMenu', () => {
  it('opens below when it fits there', () => {
    expect(placeMenu(300, 500, 200)).toBe('down');
  });

  it('opens above when only the space above fits', () => {
    expect(placeMenu(120, 400, 200)).toBe('up');
  });

  it('scrolls when neither side fits', () => {
    expect(placeMenu(100, 150, 200)).toBe('scroll');
  });

  it('fits exactly', () => {
    expect(placeMenu(200, 0, 200)).toBe('down');
  });
});
