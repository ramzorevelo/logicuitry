import { describe, expect, it } from 'vitest';
import * as bv from '../../value/busValue';
import { bcd7seg, SEGMENT_LETTERS } from './bcd7seg';
import type { EvalContext } from './types';
import { segmentLit, sevenSegCommon } from './display';

const H = bv.known(1, 1);
const L = bv.known(0, 1);
const X = bv.allX(1);
const Z = bv.allZ(1);

/** Segment outputs as the datasheet prints them: one H/L/Z per letter a..g. */
function outputs(
  activeLow: boolean,
  code: number | null,
  ctrl: { lt?: bv.BusValue; bi?: bv.BusValue; rbi?: bv.BusValue } = {},
): string {
  const addr = code === null ? [X, X, X, X] : [0, 1, 2, 3].map((i) => (code & (1 << i) ? H : L));
  const ctx: EvalContext = {
    params: { activeLow },
    state: undefined,
    inputs: [...addr, ctrl.lt ?? H, ctrl.bi ?? H, ctrl.rbi ?? H],
    prevInputs: [],
    time: 0,
  };
  return bcd7seg
    .evaluate(ctx)
    .outputs.map((o) => bv.toString(o!, 1))
    .join('');
}

/**
 * ON Semi SN74LS47/D rev 6 truth table, transcribed row by row. L on an output
 * is a lit segment, because the part is active-low.
 */
const LS47_ROWS: string[] = [
  'LLLLLLH', // 0
  'HLLHHHH', // 1
  'LLHLLHL', // 2
  'LLLLHHL', // 3
  'HLLHHLL', // 4
  'LHLLHLL', // 5
  'HHLLLLL', // 6
  'LLLHHHH', // 7
  'LLLLLLL', // 8
  'LLLHHLL', // 9
  'HHHLLHL', // 10
  'HHLLHHL', // 11
  'HLHHHLL', // 12
  'LHHLHLL', // 13
  'HHHLLLL', // 14
  'HHHHHHH', // 15
];

/** National DM74LS48 TL/F/10172; same displayed shapes, driven high instead. */
const LS48_ROWS = LS47_ROWS.map((row) => [...row].map((c) => (c === 'L' ? 'H' : 'L')).join(''));

describe('74LS47 (active-low, open collector)', () => {
  it('matches the datasheet truth table for all 16 codes', () => {
    LS47_ROWS.forEach((row, code) => {
      // An off segment is genuinely high-impedance on an open-collector part;
      // the display's own anode supply is what pulls it up.
      const expected = [...row].map((c) => (c === 'L' ? '0' : 'Z')).join('');
      expect(outputs(true, code), `code ${code}`).toBe(expected);
    });
  });

  it('never drives an off segment high', () => {
    for (let code = 0; code < 16; code++) expect(outputs(true, code)).not.toContain('1');
  });

  it('lamp test lights every segment', () => {
    expect(outputs(true, 5, { lt: L })).toBe('0'.repeat(7));
  });

  it('blanking input overrides the lamp test', () => {
    expect(outputs(true, 5, { lt: L, bi: L })).toBe('Z'.repeat(7));
  });

  it('ripple-blanking blanks a zero and leaves other digits alone', () => {
    expect(outputs(true, 0, { rbi: L })).toBe('Z'.repeat(7));
    expect(outputs(true, 1, { rbi: L })).toBe(outputs(true, 1));
  });

  it('treats an unwired active-low control as held high', () => {
    expect(outputs(true, 3, { lt: Z, bi: Z, rbi: Z })).toBe(outputs(true, 3));
  });

  it('reports X when a control or address line is unknown', () => {
    expect(outputs(true, 3, { bi: X })).toBe('X'.repeat(7));
    expect(outputs(true, null)).toBe('X'.repeat(7));
  });
});

describe('74LS48 (active-high, internal pull-ups)', () => {
  it('matches the datasheet truth table for all 16 codes', () => {
    LS48_ROWS.forEach((row, code) => {
      const expected = [...row].map((c) => (c === 'H' ? '1' : '0')).join('');
      expect(outputs(false, code), `code ${code}`).toBe(expected);
    });
  });

  it('never floats an output', () => {
    for (let code = 0; code < 16; code++) expect(outputs(false, code)).not.toContain('Z');
  });

  it('lamp test drives every segment high', () => {
    expect(outputs(false, 5, { lt: L })).toBe('1'.repeat(7));
  });

  it('blanks to all-low', () => {
    expect(outputs(false, 5, { bi: L })).toBe('0'.repeat(7));
  });
});

describe('the two parts together', () => {
  it('light the same segments, at opposite drive levels', () => {
    for (let code = 0; code < 16; code++) {
      const lit47 = [...outputs(true, code)].map((c) => c === '0');
      const lit48 = [...outputs(false, code)].map((c) => c === '1');
      expect(lit47, `code ${code}`).toEqual(lit48);
    }
  });

  it('exposes one output per segment letter, labelled by letter', () => {
    const outs = bcd7seg.pins({}).filter((p) => p.dir === 'out');
    expect(outs.map((p) => p.label)).toEqual([...SEGMENT_LETTERS]);
  });

  it('picks its datasheet part from activeLow', () => {
    const part = bcd7seg.defaultPart as (p: Record<string, unknown>) => string;
    expect(part({ activeLow: true })).toBe('74LS47');
    expect(part({})).toBe('74LS48');
  });
});

describe('pairing a decoder with a display', () => {
  const drive = (activeLow: boolean, code: number) => [...outputs(activeLow, code)];

  it("lights the right digit when the '47 drives a common-anode display", () => {
    expect(drive(true, 1).map((s) => segmentLit(s, 'anode'))).toEqual([
      false,
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
  });

  it("lights the right digit when the '48 drives a common-cathode display", () => {
    expect(drive(false, 1).map((s) => segmentLit(s, 'cathode'))).toEqual([
      false,
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
  });

  it("lights nothing when a '47 is wired to a common-cathode display", () => {
    for (let code = 0; code < 16; code++)
      expect(
        drive(true, code).some((s) => segmentLit(s, 'cathode')),
        `code ${code}`,
      ).toBe(false);
  });

  it("lights every dark segment when a '48 is wired to a common-anode display", () => {
    // Every '48 output is driven, so an anode display reads the inverse shape.
    const lit = drive(false, 1).map((s) => segmentLit(s, 'anode'));
    expect(lit).toEqual([true, false, false, true, true, true, true]);
  });

  it('defaults to cathode, so boards written before this keep their behaviour', () => {
    expect(sevenSegCommon({})).toBe('cathode');
    expect(sevenSegCommon({ common: 'anode' })).toBe('anode');
  });
});
