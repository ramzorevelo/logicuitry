import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DeviceLabWorkbench } from './DeviceLabWorkbench';

// Render smoke: the Device Lab tree builds without throwing. Canvas-bound
// effects (VTC plot, level diagram) don't run under server render, so this
// guards the render path; the SPICE math is covered by src/core/spice tests.

describe('Device Lab render smoke', () => {
  it('renders the sub-tool switcher', () => {
    const html = renderToString(createElement(DeviceLabWorkbench));
    expect(html).toContain('CMOS VTC');
    expect(html).toContain('TTL noise margins');
  });
});
