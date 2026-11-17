import { beforeEach, describe, expect, it } from 'vitest';
import { presetLayout } from './workspaceLayout';
import { currentLayout, narrowShownArea, useWorkspaceStore } from './workspaceStore';

const ws = () => useWorkspaceStore.getState();

beforeEach(() => {
  useWorkspaceStore.setState({
    layouts: { write: presetLayout('write') },
    maxArea: null,
    narrow: false,
    narrowArea: null,
    hoverArea: null,
    focusArea: null,
    announce: '',
  });
});

describe('workspace store', () => {
  it('swaps views and announces it', () => {
    ws().setView('a1', 'insp');
    expect(currentLayout(ws())).toMatchObject({
      kids: [{ view: 'insp' }, { view: 'board' }, { view: 'steps' }],
    });
    expect(ws().announce).toBe('Inspector and Steps swapped areas.');
  });

  it('maximises the given area, then hover, then focus, then the Board', () => {
    ws().toggleMax();
    expect(ws().maxArea).toBe('a2');
    ws().toggleMax();
    useWorkspaceStore.setState({ hoverArea: 'a1', focusArea: 'a3' });
    ws().toggleMax();
    expect(ws().maxArea).toBe('a1');
    ws().restore();
    useWorkspaceStore.setState({ hoverArea: null });
    ws().toggleMax();
    expect(ws().maxArea).toBe('a3');
    ws().toggleMax();
    ws().toggleMax('a1');
    expect(ws().maxArea).toBe('a1');
  });

  it('shows only the maximised view', () => {
    ws().toggleMax('a1');
    expect(ws().shown('steps')).toBe(true);
    expect(ws().shown('board')).toBe(false);
  });

  it('narrow shows the Board area by default, drops maximise and refuses it', () => {
    ws().toggleMax('a1');
    ws().setNarrow(true);
    expect(ws().maxArea).toBeNull();
    expect(narrowShownArea(ws())).toBe('a2');
    expect(ws().shown('board')).toBe(true);
    expect(ws().shown('insp')).toBe(false);
    ws().toggleMax('a1');
    expect(ws().maxArea).toBeNull();
    ws().pickNarrow('a3');
    expect(ws().shown('insp')).toBe(true);
    ws().setNarrow(false);
    expect(ws().shown('steps')).toBe(true);
  });

  it('a drag measures from its base layout', () => {
    const base = currentLayout(ws());
    ws().resize('', 0, 100, 1000, base);
    ws().resize('', 0, 50, 1000, base);
    expect((currentLayout(ws()) as { sizes: number[] }).sizes[0]).toBeCloseTo(24);
  });

  it('Reset layout restores the preset and clears maximise', () => {
    ws().setView('a1', 'board');
    ws().resize('', 1, -100, 1000);
    ws().toggleMax('a1');
    ws().resetLayout();
    expect(currentLayout(ws())).toEqual(presetLayout('write'));
    expect(ws().maxArea).toBeNull();
  });
});
