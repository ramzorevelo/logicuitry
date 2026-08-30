import { describe, expect, it } from 'vitest';
import { offersHideAnswers } from './numbersStore';

// A predicate rather than an assertion on rendered html: zustand serves React's
// server snapshot under renderToString, so a store written in a test is not the
// store the markup is built from.
const masked = { hideAnswers: true, stepIndex: -1, answersShown: false };

describe('offersHideAnswers', () => {
  it('is hidden while masking with nothing revealed, having nothing to hide', () => {
    expect(offersHideAnswers(masked)).toBe(false);
  });

  it('appears once the current step is revealed', () => {
    expect(offersHideAnswers({ ...masked, answersShown: true })).toBe(true);
  });

  it('appears once any step has been stepped through', () => {
    expect(offersHideAnswers({ ...masked, stepIndex: 0 })).toBe(true);
  });

  it('is always offered while nothing is masked, since that is what it starts', () => {
    expect(offersHideAnswers({ ...masked, hideAnswers: false })).toBe(true);
  });
});
