import { beforeEach, describe, expect, it } from 'vitest';
import { parseExpr } from '../../core/boolean/expr';
import { useAlgebraStore } from './algebraStore';

const st = () => useAlgebraStore.getState();

const startWith = (text: string) => {
  st().setStartText(text);
  st().begin();
};

describe('Simplify ladder', () => {
  beforeEach(() => {
    useAlgebraStore.setState({ mode: 'hand', start: null, lines: [], previous: null });
  });

  it('Start on the same expression keeps the lines', () => {
    startWith("AB + AB'");
    st().pushLine({ expr: parseExpr('A'), cite: '11b' });
    st().begin();
    expect(st().lines).toHaveLength(2);
  });

  it('a new expression replaces the ladder, and Undo brings it back', () => {
    startWith("AB + AB'");
    st().pushLine({ expr: parseExpr('A'), cite: '11b' });
    startWith('A + AB');
    expect(st().lines).toHaveLength(1);
    st().undo();
    expect(st().lines).toHaveLength(2);
    expect(st().startText).toBe("AB + AB'");
    expect(st().previous).toBeNull();
  });

  it('switching to Worked and back leaves the hand ladder alone', () => {
    startWith("AB + AB'");
    st().pushLine({ expr: parseExpr('A'), cite: '11b' });
    st().setMode('worked');
    st().setMode('hand');
    expect(st().lines).toHaveLength(2);
  });
});
