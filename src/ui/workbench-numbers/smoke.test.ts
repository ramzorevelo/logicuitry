import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
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
    expect(html).toContain('Hide answers');
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
});
