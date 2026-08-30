// Bundled example circuits. Imported at build time, never read from the
// library folder: they have to be there on a first launch with no folder
// granted, and iOS Safari has no File System Access API at all.
//
// An example is named for the circuit and nothing else.

import type { Board, ChipDef } from '../core/model/types';

import halfAdder from './chips/half-adder.lcirc';

import basicGates from './boards/basic-gates.lcirb';
import deMorganPair from './boards/de-morgan-pair.lcirb';
import absorption from './boards/absorption.lcirb';
import elimination from './boards/elimination.lcirb';
import consensus from './boards/consensus.lcirb';
import distributiveLaw from './boards/distributive-law.lcirb';
import complementCovering from './boards/complement-and-covering.lcirb';
import sumOfProducts from './boards/three-variable-sum-of-products.lcirb';
import mux4 from './boards/four-to-one-multiplexer.lcirb';
import muxLookup from './boards/multiplexer-as-lookup-table.lcirb';
import decoder38 from './boards/three-to-eight-decoder.lcirb';
import priorityEncoder from './boards/priority-encoder.lcirb';
import staticHazard from './boards/static-hazard.lcirb';
import fullAdder from './boards/full-adder.lcirb';
import srLatch from './boards/sr-latch.lcirb';
import dLatch from './boards/d-latch.lcirb';
import dFlipFlop from './boards/d-flip-flop.lcirb';
import divideByTwo from './boards/divide-by-two.lcirb';
import regToReg from './boards/register-to-register-path.lcirb';

export interface Example {
  id: string;
  name: string;
  /** One line, shown beside the name. Says what the circuit is, nothing else. */
  description: string;
  board: Board;
  /** Heading the menu files it under. Absent means the ungrouped run at the
   *  top, which is how every example shipped before the algebra set. */
  group?: string;
  /** Chip definitions the board's instances refer to; loaded with it. */
  chips?: ChipDef[];
}

const ex = (board: unknown, description: string, chips?: unknown[]): Example => {
  const b = board as Board;
  return {
    id: b.id,
    name: b.name,
    description,
    board: b,
    ...(chips ? { chips: chips as ChipDef[] } : {}),
  };
};

/** Every board on one identity from Roth Unit 2 section 2.6, drawn as two
 *  circuits over shared inputs: the LEDs agree for every input combination,
 *  which is the proof the algebra claims. */
const ALGEBRA = 'Boolean algebra';
const law = (board: unknown, description: string): Example => ({
  ...ex(board, description),
  group: ALGEBRA,
});

/** One flat list, in the order the menu shows it. */
export const EXAMPLES: readonly Example[] = [
  ex(basicGates, 'Two switches into AND, OR, XOR, NAND, NOR, XNOR and NOT.'),
  ex(deMorganPair, 'A NAND beside an OR of two inverted inputs.'),
  ex(sumOfProducts, 'Three inputs, three product terms, one OR.'),
  ex(mux4, 'Four data inputs, two select lines, one output.'),
  ex(muxLookup, 'Fixed values on the data inputs turn a multiplexer into a truth table.'),
  ex(decoder38, 'Three address lines drive one of eight outputs high.'),
  ex(priorityEncoder, 'Four inputs coded to two bits, with a valid output.'),
  ex(staticHazard, 'Two paths of unequal delay reconverge, so the output glitches.'),
  ex(fullAdder, 'Two half-adder chips and an OR gate.', [halfAdder]),
  ex(srLatch, 'Two cross-coupled NOR gates holding a bit.'),
  ex(dLatch, 'A level-sensitive latch built from NAND gates.'),
  ex(dFlipFlop, 'An edge-triggered flip-flop driven by a clock.'),
  ex(
    divideByTwo,
    'A flip-flop with its inverted output fed back, halving the clock once /CLR is released.',
  ),
  ex(regToReg, 'Two flip-flops with an inverter and an XOR between them, on datasheet timing.'),
  law(absorption, 'A + AB and A, which are the same circuit.'),
  law(elimination, "A(A' + B) reduced to AB."),
  law(consensus, "AB + A'C + BC beside the same sum without its consensus term."),
  law(distributiveLaw, 'A(B + C) beside AB + AC.'),
  law(complementCovering, "A + A' held at 1, and A(A + B) following A."),
];
