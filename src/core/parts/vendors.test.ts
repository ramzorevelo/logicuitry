import { describe, expect, it } from 'vitest';
import { compile } from '../model/compile';
import { board, comp, wire } from '../model/testFixtures';
import { datasheetDelay } from '../sim/delay';
import { Simulator } from '../sim/kernel';
import {
  column,
  contaminationNs,
  estimatedContaminationNs,
  getPart,
  minPublished,
  propagationNs,
  typPublished,
  vendorHasRow,
} from './partsDb';

describe('Fairchild rows', () => {
  it('reads the CL = 15 pF min and max off each gate sheet', () => {
    expect(getPart('74LS00', 'fairchild')!.tplh).toEqual({ min: 3, max: 10 });
    expect(getPart('74LS04', 'fairchild')!.tphl).toEqual({ min: 3, max: 10 });
    expect(getPart('74LS08', 'fairchild')!.tplh).toEqual({ min: 4, max: 13 });
    expect(getPart('74LS08', 'fairchild')!.tphl).toEqual({ min: 3, max: 11 });
    expect(getPart('74LS32', 'fairchild')!.tplh).toEqual({ min: 3, max: 11 });
    expect(getPart('74LS02', 'fairchild')!.tplh).toEqual({ max: 13 });
  });

  it("takes the 74LS86's other-input-LOW row on max, the reverse of TI's sheet", () => {
    expect(propagationNs('74LS86', 'lh', 'max', 'fairchild')).toBe(18);
    expect(propagationNs('74LS86', 'hl', 'max', 'fairchild')).toBe(17);
    expect(getPart('74LS86', 'fairchild')!.condition_worst).toBe('other input LOW');
    expect(getPart('74LS86', 'ti')!.condition_worst).toBe('other input HIGH');
  });

  it('falls back to the TI row for a part Fairchild has no sheet for', () => {
    expect(getPart('74LS283', 'fairchild')).toBe(getPart('74LS283', 'ti'));
    expect(vendorHasRow('74LS283', 'fairchild')).toBe(false);
    expect(vendorHasRow('74LS08', 'fairchild')).toBe(true);
    expect(vendorHasRow('74LS283', 'ti')).toBe(true);
  });

  it('leaves the TI rows untouched', () => {
    expect(propagationNs('74LS08', 'hl', 'max')).toBe(20);
    expect(propagationNs('74LS08', 'hl', 'max', 'ti')).toBe(20);
  });

  it('prints no typ, so typ reads max and says so', () => {
    expect(propagationNs('74LS32', 'lh', 'typ', 'fairchild')).toBe(11);
    expect(typPublished('74LS32', 'fairchild')).toBe(false);
    expect(typPublished('74LS32', 'ti')).toBe(true);
  });
});

describe('the min column', () => {
  it('reads a printed min, else the contamination estimate', () => {
    expect(column({ min: 3, max: 10 }, 'min')).toBe(3);
    expect(column({ typ: 10, max: 15 }, 'min')).toBe(estimatedContaminationNs(10));
    expect(column({ max: 13 }, 'min')).toBe(estimatedContaminationNs(13));
  });

  it('makes a printed min the t_cd, and marks only those parts as not estimated', () => {
    expect(contaminationNs('74LS08', 'hl', 'fairchild')).toBe(3);
    expect(contaminationNs('74LS08', 'hl', 'ti')).toBe(estimatedContaminationNs(10));
    expect(minPublished('74LS08', 'fairchild')).toBe(true);
    expect(minPublished('74LS86', 'fairchild')).toBe(false);
    expect(minPublished('74LS08', 'ti')).toBe(false);
  });

  it('derives the NAND latch from two Fairchild gates, min and max', () => {
    const latch = getPart('74LS00-SR', 'fairchild')!;
    expect(latch.tplh).toEqual({ min: 3, max: 10 });
    expect(latch.tphl).toEqual({ min: 6, max: 20 });
  });
});

/** NAND enable plus two inverters: a three-stage ring that starts from a known state. */
function ringBoard() {
  return board({
    components: [
      comp('en', 'toggle', undefined, 'EN'),
      comp('g1', 'nand'),
      comp('n1', 'not'),
      comp('n2', 'not'),
    ],
    wires: [
      wire('w1', ['en', 'y'], ['g1', 'a']),
      wire('w2', ['g1', 'y'], ['n1', 'a']),
      wire('w3', ['n1', 'y'], ['n2', 'a']),
      wire('w4', ['n2', 'y'], ['g1', 'b']),
    ],
  });
}

describe('a ring oscillator on Fairchild timing', () => {
  // SPEC: the chapter's 18 to 60 ns is six stage delays at the '00/'04's 3 ns min and 10 ns max.
  it.each([
    ['min', 18_000],
    ['max', 60_000],
  ] as const)('runs a %s period of %i ps', (col, period) => {
    const compiled = compile(ringBoard(), new Map());
    const sim = new Simulator(compiled, datasheetDelay(col, 'fairchild'));
    sim.powerOn();
    sim.setToggle('main/EN', false);
    sim.settle();
    sim.setToggle('main/EN', true);
    sim.runUntil(sim.time + 10 * period);
    const net = compiled.primitives[compiled.pathToPrimitive.get('main/n2')!]!.outputs[0]!;
    const rises = sim
      .traceRecords()
      .filter((r) => r.net === net && r.value.v === 1)
      .map((r) => r.time);
    const gaps = rises
      .slice(-4)
      .map((t, i, a) => (i ? t - a[i - 1]! : 0))
      .slice(1);
    expect(gaps).toEqual([period, period, period]);
  });
});
