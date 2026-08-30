import { describe, expect, it } from 'vitest';
import type { Vec2 } from '../../render/scene';
import type { Wire } from '../../core/model/types';
import { alignSplicePos, findSpliceWire, splicePins } from './spliceOnWire';

const p = (x: number, y: number): Vec2 => ({ x, y });
// findSpliceWire is given each wire's display polyline through a callback,
// so the wire's own a/b ends never matter to it -- dummy free ends suffice.
const wire = (id: string, points: Vec2[] = []): Wire => ({
  id,
  a: { kind: 'free', pos: p(0, 0) },
  b: { kind: 'free', pos: p(0, 0) },
  points,
});

describe('splicePins', () => {
  it('qualifies a 1-in/1-out primitive with its pin names', () => {
    expect(splicePins('not', {})).toEqual({ inName: 'a', outName: 'y' });
    expect(splicePins('buf', {})).toEqual({ inName: 'a', outName: 'y' });
  });

  it('rejects a single-pin observer (probe) -- not 1-in/1-out', () => {
    expect(splicePins('probe', {})).toBeUndefined();
  });

  it('rejects a multi-input gate', () => {
    expect(splicePins('and', {})).toBeUndefined();
  });

  it('rejects an unknown kind', () => {
    expect(splicePins('nope', {})).toBeUndefined();
  });
});

describe('findSpliceWire', () => {
  it("finds the wire when the body overlaps a leg even though the cursor sits in the L's empty corner", () => {
    // L-wire: 0,0 -> 100,0 -> 100,100. Cursor at (50,20), well off the line
    // (past any click hit radius), but the pending component's body
    // straddles the horizontal leg at x in [40,60].
    const w = wire('w1', []);
    const displayPts = [p(0, 0), p(100, 0), p(100, 100)];
    const cursor = p(50, 20);
    const bodyBounds = { x: 40, y: -5, w: 20, h: 10 }; // overlaps the y=0 leg
    const hit = findSpliceWire(cursor, bodyBounds, [w], () => displayPts);
    expect(hit).toBeDefined();
    expect(hit!.wireId).toBe('w1');
    expect(hit!.seg).toBe(0);
    expect(hit!.segA).toEqual(p(0, 0));
    expect(hit!.segB).toEqual(p(100, 0));
  });

  it('returns undefined when the body is clear of every wire', () => {
    const w = wire('w1', []);
    const displayPts = [p(0, 0), p(100, 0)];
    const bodyBounds = { x: 200, y: 200, w: 10, h: 10 };
    expect(findSpliceWire(p(205, 205), bodyBounds, [w], () => displayPts)).toBeUndefined();
  });

  it('picks whichever of two overlapping wires is nearest the cursor', () => {
    const near = wire('near', []);
    const far = wire('far', []);
    const nearPts = [p(0, 8), p(100, 8)];
    const farPts = [p(0, 2), p(100, 2)];
    const bodyBounds = { x: 40, y: 0, w: 20, h: 10 }; // overlaps both legs
    const cursor = p(50, 7); // closer to the y=8 leg
    const hit = findSpliceWire(cursor, bodyBounds, [near, far], (w) =>
      w.id === 'near' ? nearPts : farPts,
    );
    expect(hit!.wireId).toBe('near');
  });

  it('chooses the segment nearest refPoint (the ghost body CENTER), not wherever the raw cursor happened to be (M4.5)', () => {
    // L-wire as in the empty-corner case above, but this time the caller's
    // raw pointer position is far from both the body and the wire -- only
    // `refPoint` (the ghost's body center, which is what the user actually
    // saw and is what the caller must now pass) determines the outcome.
    const w = wire('w1', []);
    const displayPts = [p(0, 0), p(100, 0), p(100, 100)];
    const rawCursor = p(500, 500); // nowhere near the wire or the body
    const refPoint = p(50, 2); // the ghost body's actual center, near the y=0 leg
    const bodyBounds = { x: 40, y: -5, w: 20, h: 10 };
    const hit = findSpliceWire(refPoint, bodyBounds, [w], () => displayPts);
    expect(hit).toBeDefined();
    expect(hit!.seg).toBe(0);
    expect(hit!.segA).toEqual(p(0, 0));
    expect(hit!.segB).toEqual(p(100, 0));
    // Sanity: had the raw cursor been used instead, nothing would qualify
    // (rawCursor doesn't even land near the body-qualified leg) -- proves
    // refPoint, not cursor, drives both qualification-adjacent geometry and
    // the segment choice.
    expect(rawCursor).not.toEqual(refPoint);
  });

  it('returns the cursor-nearest segment even when only a different leg of that wire overlaps the body', () => {
    // Live-verified repro (starter board w3): L-wire (248,112) -> (320,112)
    // -> (320,144); NOT at cursor (284,128), body bounds (pin stubs reach
    // x=320) touch only the vertical leg -- the horizontal leg sits just
    // above the bounds' top edge. Overlap qualifies the wire; the returned
    // segment must still be the cursor-nearest one (horizontal, d=16 vs 36),
    // or the projected drop lands on top of the LED's pin.
    const w = wire('w3', []);
    const displayPts = [p(248, 112), p(320, 112), p(320, 144)];
    const cursor = p(284, 128);
    const bodyBounds = { x: 264, y: 116, w: 56, h: 24 }; // touches x=320 leg only
    const hit = findSpliceWire(cursor, bodyBounds, [w], () => displayPts);
    expect(hit).toBeDefined();
    expect(hit!.seg).toBe(0);
    expect(hit!.segA).toEqual(p(248, 112));
    expect(hit!.segB).toEqual(p(320, 112));
  });
});

describe('alignSplicePos (Item 2, Bug A)', () => {
  it('locks the perpendicular axis exactly onto an off-grid horizontal wire line', () => {
    // Wire runs at y=101 (off the 8-grid); a NOT's pins are both at y=4 in its
    // own local geometry (pos-relative). pos.y must land at 101-4=97 exactly,
    // not snapped to a grid multiple.
    const pos = alignSplicePos(p(150, 101), p(100, 101), p(200, 101), p(0, 4), p(16, 4), 8);
    expect(pos.y).toBe(97);
    // Along-axis (x) centers the pin pair on the drop point, then snaps: pin
    // midpoint offset is 8, drop x is 150 -> raw pos.x = 142, snaps to 144.
    expect(pos.x).toBe(144);
  });

  it('locks the perpendicular axis exactly onto a vertical wire line', () => {
    const pos = alignSplicePos(p(103, 150), p(103, 100), p(103, 200), p(4, 0), p(4, 16), 8);
    expect(pos.x).toBe(99);
    // pin midpoint offset 8, drop y 150 -> raw pos.y = 142, snaps to 144.
    expect(pos.y).toBe(144);
  });

  it('falls back to a plain grid snap when the component is oriented across the wire', () => {
    // Horizontal segment but the candidate's pins sit at different y (rotated
    // 90 relative to the wire) -- no single wire-line coordinate to lock to.
    const pos = alignSplicePos(p(101, 99), p(50, 100), p(150, 100), p(4, 0), p(4, 16), 8);
    expect(pos).toEqual({ x: 104, y: 96 });
  });
});
