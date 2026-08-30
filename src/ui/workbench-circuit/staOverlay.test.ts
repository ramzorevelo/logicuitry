import { describe, expect, it } from 'vitest';
import { compile } from '../../core/model/compile';
import type { ChipLibrary } from '../../core/model/types';
import { board, comp, wire } from '../../core/model/testFixtures';
import { analyzeTiming } from '../../core/timing/sta';
import { buildStaOverlay } from './staOverlay';

const noLib: ChipLibrary = new Map();

describe('buildStaOverlay', () => {
  it('maps the worst path onto wires and labels hop components', () => {
    const b = board({
      components: [comp('t', 'toggle'), comp('n1', 'not'), comp('n2', 'not'), comp('l', 'led')],
      wires: [
        wire('w1', ['t', 'y'], ['n1', 'a']),
        wire('w2', ['n1', 'y'], ['n2', 'a']),
        wire('w3', ['n2', 'y'], ['l', 'a']),
      ],
    });
    const compiled = compile(b, noLib);
    const report = analyzeTiming(compiled, { column: 'typ' });
    const data = buildStaOverlay(b, compiled, report, new Set())!;
    expect(data.path.endpoint).toBe('main/l');
    expect(data.criticalWires).toEqual(new Set(['w1', 'w2', 'w3']));
    expect(data.labels.get('n1')).toBe('+10 ns');
    expect(data.labels.get('n2')).toBe('+10 ns');
  });

  it('prefers the selected component as endpoint', () => {
    const b = board({
      components: [
        comp('t', 'toggle'),
        comp('n1', 'not'),
        comp('l1', 'led'),
        comp('n2', 'not'),
        comp('l2', 'led'),
      ],
      wires: [
        wire('w1', ['t', 'y'], ['n1', 'a']),
        wire('w2', ['n1', 'y'], ['l1', 'a']),
        wire('w3', ['n1', 'y'], ['n2', 'a']),
        wire('w4', ['n2', 'y'], ['l2', 'a']),
      ],
    });
    const compiled = compile(b, noLib);
    const report = analyzeTiming(compiled, { column: 'typ' });
    const worst = buildStaOverlay(b, compiled, report, new Set())!;
    expect(worst.path.endpoint).toBe('main/l2');
    const sel = buildStaOverlay(b, compiled, report, new Set(['l1']))!;
    expect(sel.path.endpoint).toBe('main/l1');
    // Highlight is net-level: w3 rides n1's output net, so the fan-out branch
    // lights too; w4 (past the endpoint) must not.
    expect(sel.criticalWires).toEqual(new Set(['w1', 'w2', 'w3']));
    expect(sel.criticalWires.has('w4')).toBe(false);
  });
});
