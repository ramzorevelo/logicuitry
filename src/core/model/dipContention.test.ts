import { describe, expect, it } from 'vitest';
import { compile } from './compile';
import { builtinChipLibrary } from '../parts/packages';
import { board, chipComp, comp, wire } from './testFixtures';

const lib = builtinChipLibrary();

/** Two instances of `part` with `pinA` of the first tied to `pinB` of the second. */
const tied = (part: string, pinA: string, pinB = pinA) =>
  board({
    components: [chipComp('u1', part, 'U1'), chipComp('u2', part, 'U2')],
    wires: [wire('w1', ['u1', pinA], ['u2', pinB])],
  });

describe('DIP output contention', () => {
  it('refuses two totem-pole DIP outputs on one net, named by package pin', () => {
    expect(() => compile(tied('74LS08', '1Y'), lib)).toThrow(
      /pins main\/U1\.1Y and main\/U2\.1Y drive the same wire/,
    );
  });

  it('refuses a DIP output tied to a plain gate output', () => {
    const b = board({
      components: [chipComp('u1', '74LS04', 'U1'), comp('g1', 'not')],
      wires: [wire('w1', ['u1', '2Y'], ['g1', 'y'])],
    });
    expect(() => compile(b, lib)).toThrow(/drive the same wire/);
  });

  it('still lets three-state, bidirectional and open-collector DIP pins share a net', () => {
    expect(() => compile(tied('74LS374', '1Q'), lib)).not.toThrow();
    expect(() => compile(tied('74LS245', 'A1'), lib)).not.toThrow();
    expect(() => compile(tied('74LS47', 'a'), lib)).not.toThrow();
    expect(() => compile(tied('74LS173', '1Q'), lib)).not.toThrow();
  });

  it('lets one totem-pole DIP output drive a three-state bus pin', () => {
    const b = board({
      components: [chipComp('u1', '74LS08', 'U1'), chipComp('u2', '74LS245', 'U2')],
      wires: [wire('w1', ['u1', '1Y'], ['u2', 'A1'])],
    });
    expect(() => compile(b, lib)).not.toThrow();
  });
});
