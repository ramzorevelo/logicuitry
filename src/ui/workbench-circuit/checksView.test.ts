import { describe, expect, it } from 'vitest';
import { checksView, revealViewport } from './checksView';
import { board, chipComp, comp, wire } from '../../core/model/testFixtures';
import { builtinChipLibrary } from '../../core/parts/packages';
import type { Board } from '../../core/model/types';

const lib = builtinChipLibrary();
const view = (b: Board) => checksView({ circuit: b, top: b, lib });

describe('checksView', () => {
  it('reuses its rows across a pan, which changes the board but no part of the circuit', () => {
    const b = board({ components: [comp('g1', 'and')] });
    const first = view(b);
    const panned = view({ ...b, view: { x: 40, y: 40, zoom: 2 } });
    expect(panned.shown).toBe(first.shown);
  });

  it('regroups rows on a hide without recomputing the findings', () => {
    const b = board({ components: [comp('g1', 'and')] });
    const before = view(b);
    const after = view({ ...b, hiddenChecks: ['unwired:g1.a'] });
    expect(after.hidden.map((r) => r.title)).toEqual(['g1: pin a not wired']);
    expect(after.counts.warning).toBe(before.counts.warning);
    expect(after.shown.find((r) => r.kind === 'unwired')!.title).toBe('g1: pin b not wired');
  });

  it('puts a compile refusal first, as the only error', () => {
    const b = board({
      components: [chipComp('u1', '74LS08', 'U1'), chipComp('u2', '74LS08', 'U2')],
      wires: [wire('w', ['u1', '1Y'], ['u2', '1Y'])],
    });
    const v = view(b);
    expect(v.shown[0]!.kind).toBe('compile');
    expect(v.counts.error).toBe(1);
  });

  it('marks open pins, unpowered packages and floatable nets, never hidden ones', () => {
    const b = board({
      components: [
        chipComp('u1', '74LS32', 'U1'),
        comp('btn', 'button', { toGround: true }),
        comp('n', 'not'),
      ],
      wires: [wire('w1', ['btn', 'y'], ['n', 'a'])],
    });
    const m = view(b).markers;
    expect(m.badges).toEqual(new Set(['u1']));
    expect(m.dashedWires).toEqual(new Set(['w1']));
    expect(m.pins.some((p) => p.component === 'u1' && p.pin === '1A')).toBe(true);
    const hidden = view({ ...b, hiddenChecks: ['power:u1.VCC', 'power:u1.GND'] }).markers;
    expect(hidden.badges.size).toBe(0);
  });
});

describe('revealViewport', () => {
  const vp = { panX: 0, panY: 0, zoom: 2 };

  it('leaves a target already in view alone', () => {
    expect(revealViewport(vp, { x: 10, y: 10, w: 20, h: 20 }, 400, 300)).toBe(vp);
  });

  it('pans just far enough to bring a target in, keeping the zoom', () => {
    expect(revealViewport(vp, { x: 250, y: -40, w: 20, h: 20 }, 400, 300)).toEqual({
      panX: 70,
      panY: -40,
      zoom: 2,
    });
  });

  it('centres a target larger than the view', () => {
    expect(revealViewport(vp, { x: 0, y: 0, w: 400, h: 50 }, 400, 300)).toEqual({
      panX: 100,
      panY: 0,
      zoom: 2,
    });
  });
});
