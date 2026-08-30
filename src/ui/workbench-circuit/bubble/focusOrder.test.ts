import { describe, expect, it } from 'vitest';
import type { Board, Component, Wire } from '../../../core/model/types';
import { withInputBubble, withOutputBubble } from '../../../core/gates/bubbleModel';
import { focusOrder, nextFocus } from './focusOrder';

function board(components: Component[], wires: Wire[] = []): Board {
  return {
    format: 'lcir.board',
    formatVersion: 5,
    id: 'b',
    name: 'b',
    components,
    wires,
    junctions: [],
    probes: [],
    view: { x: 0, y: 0, zoom: 1 },
    timing: { mode: 'ideal', datasheet: 'typ' },
  };
}

describe('focusOrder', () => {
  it('lists a gate output bubble before its input bubbles, in board order', () => {
    let g1: Component = { id: 'g1', kind: 'and', pos: { x: 0, y: 0 } };
    g1 = withOutputBubble(g1, true);
    g1 = withInputBubble(g1, 'a', true);
    const b = board([g1]);
    expect(focusOrder(b, false)).toEqual([
      { kind: 'terminal', component: 'g1', pin: 'y', side: 'output' },
      { kind: 'terminal', component: 'g1', pin: 'a', side: 'input' },
    ]);
  });

  it('skips a gate with no bubbles at all', () => {
    const b = board([{ id: 'g1', kind: 'or', pos: { x: 0, y: 0 } }]);
    expect(focusOrder(b, false)).toEqual([]);
  });

  it('appends wires only when includeWires is set', () => {
    const w: Wire = {
      id: 'w1',
      a: { kind: 'pin', component: 'a', pin: 'y' },
      b: { kind: 'pin', component: 'b', pin: 'a' },
      points: [],
    };
    const b = board([], [w]);
    expect(focusOrder(b, false)).toEqual([]);
    expect(focusOrder(b, true)).toEqual([{ kind: 'wire', wireId: 'w1' }]);
  });
});

describe('nextFocus', () => {
  const g1 = withOutputBubble({ id: 'g1', kind: 'and', pos: { x: 0, y: 0 } }, true);
  const g2 = withOutputBubble({ id: 'g2', kind: 'or', pos: { x: 0, y: 0 } }, true);
  const b = board([g1, g2]);

  it('starts at the first entry with no prior focus', () => {
    expect(nextFocus(b, null, 1, false)).toEqual({
      kind: 'terminal',
      component: 'g1',
      pin: 'y',
      side: 'output',
    });
  });

  it('Shift+Tab from nothing focused lands on the last entry', () => {
    expect(nextFocus(b, null, -1, false)).toEqual({
      kind: 'terminal',
      component: 'g2',
      pin: 'y',
      side: 'output',
    });
  });

  it('wraps around forward and backward', () => {
    const last = { kind: 'terminal', component: 'g2', pin: 'y', side: 'output' } as const;
    expect(nextFocus(b, last, 1, false)).toEqual({
      kind: 'terminal',
      component: 'g1',
      pin: 'y',
      side: 'output',
    });
    const first = { kind: 'terminal', component: 'g1', pin: 'y', side: 'output' } as const;
    expect(nextFocus(b, first, -1, false)).toEqual(last);
  });

  it('is null when there is nothing eligible', () => {
    expect(
      nextFocus(board([{ id: 'g3', kind: 'buf', pos: { x: 0, y: 0 } }]), null, 1, false),
    ).toBeNull();
  });
});
