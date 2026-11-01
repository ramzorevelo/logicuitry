// Bundled example circuits. Imported at build time, never read from the
// library folder: they have to be there on a first launch with no folder
// granted, and iOS Safari has no File System Access API at all.
//
// An example is named for the circuit and nothing else.

import type { Board, ChipDef } from '../core/model/types';
import { migrate } from '../io/migrations';

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
import rippleCarryAdder from './boards/ripple-carry-adder.lcirb';
import halfAdderBoard from './boards/half-adder.lcirb';
import fullAdderOn153 from './boards/full-adder-on-a-74ls153.lcirb';
import fourBitAdder283 from './boards/four-bit-adder-on-a-74ls283.lcirb';
import eightBitAdder from './boards/eight-bit-adder.lcirb';
import adderSubtracter from './boards/adder-subtracter.lcirb';
import fourOperationAlu from './boards/four-operation-alu.lcirb';
import fullAdderDelay from './boards/full-adder-propagation-delay.lcirb';
import srLatch from './boards/sr-latch.lcirb';
import dLatch from './boards/d-latch.lcirb';
import dFlipFlop from './boards/d-flip-flop.lcirb';
import divideByTwo from './boards/divide-by-two.lcirb';
import mod10Counter from './boards/mod-10-counter.lcirb';
import shiftRegister from './boards/shift-register.lcirb';
import pcMarRam from './boards/program-counter-mar-and-ram.lcirb';
import regToReg from './boards/register-to-register-path.lcirb';
import mux2 from './boards/two-to-one-multiplexer.lcirb';
import muxTree from './boards/four-to-one-multiplexer-tree.lcirb';
import muxFunction8 from './boards/function-on-an-eight-to-one-multiplexer.lcirb';
import muxFolded4 from './boards/folded-variable-on-a-four-to-one-multiplexer.lcirb';
import ls151Function from './boards/four-variable-function-on-a-74ls151.lcirb';
import decoder24 from './boards/two-to-four-decoder.lcirb';
import ls138Logic from './boards/decoder-logic-on-a-74ls138.lcirb';
import ls139Cascade from './boards/three-to-eight-decoder-from-a-74ls139.lcirb';
import ls138Demux from './boards/demultiplexer-on-a-74ls138.lcirb';
import majorityMux8 from './boards/majority-on-an-eight-to-one-multiplexer.lcirb';
import majorityMux4 from './boards/majority-on-a-four-to-one-multiplexer.lcirb';
import majorityDecoder from './boards/majority-from-a-decoder.lcirb';
import segmentAZero from './boards/seven-segment-segment-a-unused-codes-0.lcirb';
import segmentADontCare from './boards/seven-segment-segment-a-unused-codes-dont-care.lcirb';
import ls47Display from './boards/seven-segment-display-on-a-74ls47.lcirb';
import ls48Display from './boards/seven-segment-display-on-a-74ls48.lcirb';
import busAndRegisters from './boards/bus-and-registers.lcirb';
import aluAndFlags from './boards/alu-and-flags.lcirb';
import eightBitBusComputer from './boards/eight-bit-bus-computer.lcirb';

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

// Shipped files stay at the version they were written in, so a format bump
// never rewrites them; they come up to the current version here, as a file would.
const current = (doc: unknown): unknown => migrate(doc as Record<string, unknown>);

const ex = (board: unknown, description: string, chips?: unknown[]): Example => {
  const b = current(board) as Board;
  return {
    id: b.id,
    name: b.name,
    description,
    board: b,
    ...(chips ? { chips: chips.map((c) => current(c) as ChipDef) } : {}),
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

const inGroup =
  (group: string) =>
  (board: unknown, description: string): Example => ({ ...ex(board, description), group });
const block = inGroup('Multiplexers and decoders');
const display = inGroup('Seven-segment displays');
const busComputer = inGroup('Bus computer');

/** One flat list, in the order the menu shows it. */
export const EXAMPLES: readonly Example[] = [
  ex(basicGates, 'Two switches into AND, OR, XOR, NAND, NOR, XNOR and NOT.'),
  ex(deMorganPair, 'A NAND beside an OR of two inverted inputs.'),
  ex(sumOfProducts, 'Three inputs, three product terms, one OR.'),
  ex(staticHazard, 'Two paths of unequal delay reconverge, so the output glitches.'),
  ex(halfAdderBoard, 'An XOR gate for the sum and an AND gate for the carry.'),
  ex(fullAdder, 'Two half-adder chips and an OR gate.', [halfAdder]),
  ex(
    fullAdderOn153,
    'A dual 4-to-1 multiplexer with A and B on the selects and Cin on the data inputs.',
  ),
  ex(rippleCarryAdder, 'Four full adders with each carry feeding the next stage.'),
  ex(fourBitAdder283, 'A 74LS283 wired pin by pin, with bits numbered from 0 and pins from 1.'),
  ex(
    eightBitAdder,
    'Two 4-bit adders with the low carry out feeding the high carry in, on datasheet timing.',
  ),
  ex(
    adderSubtracter,
    'XOR gates invert B and SUB sets the carry in, so S is A + B or A - B, with an overflow flag.',
  ),
  ex(
    fourOperationAlu,
    'Add, subtract, AND and OR on two 4-bit buses, chosen by F1 F0, with N, Z, C and V flags.',
  ),
  ex(fullAdderDelay, 'A full adder from five gates on datasheet timing, slowest from A to Cout.'),
  ex(srLatch, 'Two cross-coupled NOR gates holding a bit.'),
  ex(dLatch, 'A level-sensitive latch built from NAND gates.'),
  ex(dFlipFlop, 'An edge-triggered flip-flop driven by a clock.'),
  ex(
    divideByTwo,
    'A flip-flop with its inverted output fed back, halving the clock once /CLR is released.',
  ),
  ex(
    mod10Counter,
    'A 74LS163 cleared at the clock edge after 9. Hold /RST low for one clock edge, then release it to count 0 to 9.',
  ),
  ex(shiftRegister, 'Four stages that move the serial input one place along on every clock edge.'),
  ex(regToReg, 'Two flip-flops with an inverter and an XOR between them, on datasheet timing.'),
  law(absorption, 'A + AB and A, which are the same circuit.'),
  law(elimination, "A(A' + B) reduced to AB."),
  law(consensus, "AB + A'C + BC beside the same sum without its consensus term."),
  law(distributiveLaw, 'A(B + C) beside AB + AC.'),
  law(complementCovering, "A + A' held at 1, and A(A + B) following A."),
  block(mux2, "S' D0 + S D1 from an inverter, two AND gates and an OR gate."),
  block(mux4, 'Four data inputs, two select lines, one output.'),
  block(muxTree, 'Two 2:1 multiplexers on S0 feeding a third on S1.'),
  block(muxLookup, 'Fixed values on the data inputs turn a multiplexer into a truth table.'),
  block(muxFunction8, "Y = AB' + B'C' + A'BC read out of the constants 1001 1100 on D0 to D7."),
  block(
    muxFolded4,
    "Y = AB' + B'C' + A'BC with A and B on the selects and C', C, 1, 0 on the data inputs.",
  ),
  block(
    ls151Function,
    'Sixteen rows on eight data inputs, with D folded in and W giving the complement.',
  ),
  block(majorityMux8, 'Y = AB + BC + AC read out of the constants 0001 0111 on D0 to D7.'),
  block(
    majorityMux4,
    'Y = AB + BC + AC with A and B on the selects and 0, C, C, 1 on the data inputs.',
  ),
  block(decoder24, 'Two inverters and four AND gates, one per minterm.'),
  block(decoder38, 'Three address lines drive one of eight outputs high.'),
  block(ls139Cascade, 'Both halves of a 74LS139, with A2 choosing the half through an inverter.'),
  block(ls138Logic, 'The active-low minterms 0, 3, 4 and 5 collected by a four-input NAND gate.'),
  block(majorityDecoder, 'Y = AB + BC + AC as the OR of minterms 3, 5, 6 and 7.'),
  block(
    ls138Demux,
    'The data on /G2A reaches the addressed output, and the other seven stay high.',
  ),
  block(priorityEncoder, 'Four inputs coded to two bits, with a valid output.'),
  display(segmentAZero, "a = A'C + A'BD + AB'C' + B'C'D', dark on the codes 10 to 15."),
  display(segmentADontCare, "a = A + C + BD + B'D', lit on the codes 10 to 15."),
  display(ls47Display, 'Active-low outputs into a common-anode display.'),
  display(ls48Display, 'Active-high outputs into a common-cathode display.'),
  busComputer(
    busAndRegisters,
    'Two 8-bit registers and a switch bank reach a pulled-down bus through 74LS245 transceivers.',
  ),
  busComputer(
    aluAndFlags,
    'Two 74LS283 adders and 74LS86 gates give A + B or A - B onto a bus, with carry and zero flags latched in a 74LS173.',
  ),
  busComputer(
    pcMarRam,
    'A program counter, a memory address register and a 16 x 8 RAM on one 8-bit bus, with a program in the RAM.',
  ),
  busComputer(
    eightBitBusComputer,
    'Registers A and B, a switch input, an adder-subtracter with flags, a program counter, a memory address register and a RAM on one 8-bit bus.',
  ),
];
