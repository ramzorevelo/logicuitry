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
import latchVsFlipFlop from './boards/latch-versus-flip-flop.lcirb';
import ls74PresetClear from './boards/preset-and-clear-on-a-74ls74.lcirb';
import enabledRegister from './boards/enabled-register-on-a-74ls157-and-two-74ls74s.lcirb';
import threeBitCounter from './boards/three-bit-counter-on-two-74ls74s.lcirb';
import ringOscillator from './boards/ring-oscillator-on-a-74ls00-and-a-74ls04.lcirb';
import switchDebouncer from './boards/switch-debouncer-on-a-74ls00.lcirb';
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
import clockModule from './boards/clock-module.lcirb';
import counterModule from './boards/counter-module.lcirb';
import busAndRegisters from './boards/bus-and-registers.lcirb';
import aluAndFlags from './boards/alu-and-flags.lcirb';
import registersAndAlu from './boards/registers-and-alu.lcirb';
import eightBitBusComputer from './boards/eight-bit-bus-computer.lcirb';
import interleavedMemory from './boards/four-bank-interleaved-memory.lcirb';
import cacheTagLookup from './boards/cache-tag-lookup.lcirb';
import majorityNandOnly from './boards/majority-vote-nand-only.lcirb';
import mintermsOn138 from './boards/minterms-on-a-74ls138.lcirb';
import counterFrom74ls from './boards/three-bit-counter-from-74ls-parts.lcirb';

export interface Example {
  id: string;
  name: string;
  /** One line, shown beside the name. Says what the circuit is, nothing else. */
  description: string;
  board: Board;
  /** Heading the menu files it under; one of EXAMPLE_GROUPS. */
  group: string;
  /** Chip definitions the board's instances refer to; loaded with it. */
  chips?: ChipDef[];
}

// Shipped files stay at the version they were written in, so a format bump
// never rewrites them; they come up to the current version here, as a file would.
const current = (doc: unknown): unknown => migrate(doc as Record<string, unknown>);

const ex = (board: unknown, description: string, chips?: unknown[]): Omit<Example, 'group'> => {
  const b = current(board) as Board;
  return {
    id: b.id,
    name: b.name,
    description,
    board: b,
    ...(chips ? { chips: chips.map((c) => current(c) as ChipDef) } : {}),
  };
};

const inGroup =
  (group: string) =>
  (board: unknown, description: string, chips?: unknown[]): Example => ({
    ...ex(board, description, chips),
    group,
  });

const GATES = 'Gates and logic';
/** Every board on one identity from Roth Unit 2 section 2.6, drawn as two
 *  circuits over shared inputs: the LEDs agree for every input combination,
 *  which is the proof the algebra claims. */
const ALGEBRA = 'Boolean algebra';
const ARITHMETIC = 'Arithmetic';
const BLOCKS = 'Multiplexers and decoders';
const DISPLAYS = 'Seven-segment displays';
const FLIP_FLOPS = 'Flip-flops and registers';
const BUS_COMPUTER = 'Bus computer';
const MEMORY = 'Memory and caches';
/** Starter boards carrying a challenge: the parts are on the board, the circuit is not. */
export const CHALLENGES = 'Challenges';

/** Every section heading, in the order the menu shows them. */
export const EXAMPLE_GROUPS: readonly string[] = [
  GATES,
  ALGEBRA,
  ARITHMETIC,
  BLOCKS,
  DISPLAYS,
  FLIP_FLOPS,
  BUS_COMPUTER,
  MEMORY,
  CHALLENGES,
];

const gates = inGroup(GATES);
const algebra = inGroup(ALGEBRA);
const arithmetic = inGroup(ARITHMETIC);
const block = inGroup(BLOCKS);
const display = inGroup(DISPLAYS);
const flipFlops = inGroup(FLIP_FLOPS);
const busComputer = inGroup(BUS_COMPUTER);
const memory = inGroup(MEMORY);
const challenge = inGroup(CHALLENGES);

/** One flat list, in the order the menu shows it. */
export const EXAMPLES: readonly Example[] = [
  gates(basicGates, 'Two switches into AND, OR, XOR, NAND, NOR, XNOR and NOT.'),
  gates(deMorganPair, 'A NAND beside an OR of two inverted inputs.'),
  gates(sumOfProducts, 'Three inputs, three product terms, one OR.'),
  gates(staticHazard, 'Two paths of unequal delay reconverge, so the output glitches.'),
  algebra(absorption, 'A + AB and A, which are the same circuit.'),
  algebra(elimination, "A(A' + B) reduced to AB."),
  algebra(consensus, "AB + A'C + BC beside the same sum without its consensus term."),
  algebra(distributiveLaw, 'A(B + C) beside AB + AC.'),
  algebra(complementCovering, "A + A' held at 1, and A(A + B) following A."),
  arithmetic(halfAdderBoard, 'An XOR gate for the sum and an AND gate for the carry.'),
  arithmetic(fullAdder, 'Two half-adder chips and an OR gate.', [halfAdder]),
  arithmetic(
    fullAdderOn153,
    'A dual 4-to-1 multiplexer with A and B on the selects and Cin on the data inputs.',
  ),
  arithmetic(rippleCarryAdder, 'Four full adders with each carry feeding the next stage.'),
  arithmetic(
    fourBitAdder283,
    'A 74LS283 wired pin by pin, with bits numbered from 0 and pins from 1.',
  ),
  arithmetic(
    eightBitAdder,
    'Two 4-bit adders with the low carry out feeding the high carry in, on datasheet timing.',
  ),
  arithmetic(
    adderSubtracter,
    'XOR gates invert B and SUB sets the carry in, so S is A + B or A - B, with an overflow flag.',
  ),
  arithmetic(
    fourOperationAlu,
    'Add, subtract, AND and OR on two 4-bit buses, chosen by F1 F0, with N, Z, C and V flags.',
  ),
  arithmetic(
    fullAdderDelay,
    'A full adder from five gates on datasheet timing, slowest from A to Cout.',
  ),
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
  flipFlops(srLatch, 'Two cross-coupled NOR gates holding a bit.'),
  flipFlops(
    switchDebouncer,
    'A bouncing SPDT switch into the NAND /S /R latch: flip it, and /S chatters while Q changes once.',
  ),
  flipFlops(dLatch, 'A level-sensitive latch built from NAND gates.'),
  flipFlops(dFlipFlop, 'An edge-triggered flip-flop driven by a clock.'),
  flipFlops(
    latchVsFlipFlop,
    'One D and one clock into a latch and a flip-flop. D changes mid-phase, so the two outputs part.',
  ),
  flipFlops(
    ls74PresetClear,
    'Active-low /PRE and /CLR set or clear the flip-flop at once, whatever the clock and D. It starts held clear.',
  ),
  flipFlops(
    divideByTwo,
    'A flip-flop with its inverted output fed back, halving the clock once /CLR is released.',
  ),
  flipFlops(
    enabledRegister,
    'A 2:1 multiplexer in front of each D: LOAD high loads D3-D0 on the clock edge, LOAD low holds.',
  ),
  flipFlops(
    shiftRegister,
    'Four stages that move the serial input one place along on every clock edge.',
  ),
  flipFlops(
    ringOscillator,
    'A NAND and two inverters in a loop, on datasheet timing. EN high starts it oscillating.',
  ),
  flipFlops(
    regToReg,
    'Two flip-flops with an inverter and an XOR between them, on datasheet timing.',
  ),
  flipFlops(
    threeBitCounter,
    'Next-state logic from an XOR package and an AND package in front of three flip-flops, counting 0 to 7 once /CLR is released.',
  ),
  flipFlops(
    mod10Counter,
    'A 74LS163 cleared at the clock edge after 9. Hold /RST low for one clock edge, then release it to count 0 to 9.',
  ),
  flipFlops(
    counterModule,
    'A 4-bit count on two 74LS74s that a 74LS283 steps up on UP or down on DN each 555 clock, with a 74LS157 loading 1001 on LOAD, CLEAR zeroing it and a 74LS47 driving the display.',
  ),
  busComputer(
    clockModule,
    'Three 555 timers: an astable clock, a monostable that debounces the STEP button and a bistable MODE select, with HLT holding CLK low.',
  ),
  busComputer(
    busAndRegisters,
    'Two 8-bit registers and a switch bank reach a pulled-down bus through 74LS245 transceivers.',
  ),
  busComputer(
    aluAndFlags,
    'Two 74LS283 adders and 74LS86 gates give A + B or A - B onto a bus, with carry and zero flags latched in a 74LS173.',
  ),
  busComputer(
    registersAndAlu,
    'Registers A and B feed an adder-subtracter on one 8-bit bus: load them from the switches, put A + B or A - B on the bus, and clock it back into A to add again.',
  ),
  busComputer(
    pcMarRam,
    'A program counter, a memory address register and a 16 x 8 RAM on one 8-bit bus, with a program in the RAM.',
  ),
  busComputer(
    eightBitBusComputer,
    'Registers A and B, a switch input, an adder-subtracter with flags, a program counter, a memory address register and a RAM on one 8-bit bus.',
  ),
  memory(
    interleavedMemory,
    'Eight 74LS189s in four banks of two, the 74LS139 enabling one bank from A5 A4. For low-order interleaving, swap the bus wires leaving the A5 A4 and A1 A0 switches. /DATA shows the complement of the stored word.',
  ),
  memory(
    cacheTagLookup,
    'Eight sets of a direct-mapped cache: a 74LS189 holds the valid bits and 3-bit tags, a 74LS04 undoes its inverted outputs, a 74LS85 compares the tag, and Hit is equal AND valid. A second 74LS189 holds the data, shown as its complement on /DATA. WRITE fills the set on a miss.',
  ),
  challenge(
    majorityNandOnly,
    'A, B and C into Y: build the majority from four NAND gates at most.',
  ),
  challenge(mintermsOn138, 'A, B and C into Y: minterms 0, 3, 4 and 5 from a 74LS138 and a NAND.'),
  challenge(
    counterFrom74ls,
    'CLK and /CLR into Q2 Q1 Q0: count 0 to 7 on two 74LS74s and at most two gate packages.',
  ),
];

/** An opened example keeps its board id, so a saved copy of an algebra board still matches. */
export const ALGEBRA_BOARD_IDS: ReadonlySet<string> = new Set(
  EXAMPLES.filter((e) => e.group === ALGEBRA).map((e) => e.id),
);
