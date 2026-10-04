import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AlgebraTab } from './AlgebraTab';
import { CanonicalSection } from './CanonicalSection';
import { SimplifySection } from './SimplifySection';
import { ComputeTab } from './ComputeTab';
import { ConvertTab } from './ConvertTab';
import { NumbersWorkbench } from './NumbersWorkbench';
import { useNumbersStore } from './numbersStore';

// Render smoke: the workbench tree must build without throwing. Canvas-bound
// effects don't run under server render, so this guards the render path (hooks,
// store wiring, prop types) that unit tests on the pure generators can't.

describe('Numbers workbench render smoke', () => {
  it('renders the workbench shell with both tab labels', () => {
    const html = renderToString(createElement(NumbersWorkbench));
    expect(html).toContain('Convert');
    expect(html).toContain('Compute');
    expect(html).toContain('Algebra');
  });

  it('renders the Convert tab step panel', () => {
    const html = renderToString(createElement(ConvertTab));
    expect(html).toContain('press Space to begin');
  });

  it('renders the Compute tab operator strip and result label', () => {
    useNumbersStore.getState().setOperator('ADD');
    const html = renderToString(createElement(ComputeTab));
    expect(html).toContain('A + B');
    expect(html).toContain('Sum');
    expect(html).toContain('Show (Enter)');
  });

  it('renders each Algebra section', () => {
    // Server render reads a store's initial state, so each section is rendered
    // on its own rather than by switching the tab.
    expect(renderToString(createElement(AlgebraTab))).toContain('Annulment Law');
    expect(renderToString(createElement(CanonicalSection))).toContain('Canonical sum of products');
    expect(renderToString(createElement(SimplifySection))).toContain('Type an expression');
  });
});
