// Progress through the first-circuit tutorial, read off the board and the live
// pin values alone. Re-derived on every change and never latched, so a delete
// or an undo takes a tick back the same way a placement gave it.

import type { Board, Component } from '../model/types';
import type { BusValue } from '../value/busValue';
import { connectedPins } from '../gates/netGraph';
import { getInputBubbles, getOutputBubble } from '../gates/bubbleModel';

export const FIRST_CIRCUIT_STEPS = ['switches', 'gate', 'led', 'wires', 'power', 'lit'] as const;
export type FirstCircuitStep = (typeof FIRST_CIRCUIT_STEPS)[number];

/** What the detector needs from a running board: a pin's value is undefined while unpowered. */
export interface FirstCircuitSim {
  powered: boolean;
  pinValue(component: string, pin: string): BusValue | undefined;
}

export interface FirstCircuitProgress {
  done: Record<FirstCircuitStep, boolean>;
  /** The first unmet step in order, null once the LED is lit. */
  current: FirstCircuitStep | null;
  /** Powered while a building step is still unmet: editing is locked until power goes off. */
  mustPowerOff: boolean;
}

const OUTPUT_PIN = 'y';
const LED_PIN = 'a';

function isOneBit(c: Component): boolean {
  return Number(c.params?.['width'] ?? 1) === 1;
}

function isSwitch(c: Component): boolean {
  return c.kind === 'toggle' && isOneBit(c);
}

/** A plain two-input AND: a third input would float to X and the LED could never light. */
function isPlainAnd(c: Component): boolean {
  return (
    c.kind === 'and' &&
    isOneBit(c) &&
    Number(c.params?.['inputs'] ?? 2) === 2 &&
    !getOutputBubble(c) &&
    getInputBubbles(c).size === 0
  );
}

/** One plain LED: an LED array is the same kind, and an active-low one is dark at 1. */
function isLed(c: Component): boolean {
  return c.kind === 'led' && isOneBit(c) && c.params?.['activeLow'] !== true;
}

const pinKey = (component: string, pin: string) => `${component}\u0000${pin}`;

interface Wiring {
  switches: [string, string];
  led: string;
}

/**
 * Two switches each alone on their own AND input, the AND output on an LED.
 * Nets, not wire ends, so junctions, bends and net labels all count; a switch
 * shorted to another switch or to the output does not.
 */
function findWiring(board: Board): Wiring | null {
  const netOf = (component: string, pin: string): Set<string> => {
    const net = new Set([pinKey(component, pin)]);
    for (const p of connectedPins(board, { component, pin })) net.add(pinKey(p.component, p.pin));
    return net;
  };
  const switches = board.components.filter(isSwitch);
  const leds = board.components.filter(isLed);

  for (const gate of board.components.filter(isPlainAnd)) {
    const out = netOf(gate.id, OUTPUT_PIN);
    const led = leds.find((l) => out.has(pinKey(l.id, LED_PIN)));
    if (!led || switches.some((s) => out.has(pinKey(s.id, OUTPUT_PIN)))) continue;

    const feeding: string[] = [];
    for (const s of switches) {
      const net = netOf(s.id, OUTPUT_PIN);
      const shorted = switches.some((o) => o.id !== s.id && net.has(pinKey(o.id, OUTPUT_PIN)));
      const gateInputs = connectedPins(board, { component: s.id, pin: OUTPUT_PIN }).filter(
        (p) => p.component === gate.id && p.pin !== OUTPUT_PIN,
      );
      if (!shorted && gateInputs.length === 1) feeding.push(s.id);
    }
    if (feeding.length >= 2) return { switches: [feeding[0]!, feeding[1]!], led: led.id };
  }
  return null;
}

function isHigh(v: BusValue | undefined): boolean {
  return v !== undefined && (v.v & 1) === 1 && (v.x & 1) === 0 && (v.z & 1) === 0;
}

export function firstCircuitProgress(board: Board, sim: FirstCircuitSim): FirstCircuitProgress {
  const wiring = findWiring(board);
  const built = {
    switches: board.components.filter(isSwitch).length >= 2,
    gate: board.components.some(isPlainAnd),
    led: board.components.some(isLed),
    wires: wiring !== null,
  };
  const powered = sim.powered && wiring !== null;
  const lit =
    wiring !== null &&
    sim.powered &&
    wiring.switches.every((s) => isHigh(sim.pinValue(s, OUTPUT_PIN))) &&
    isHigh(sim.pinValue(wiring.led, LED_PIN));
  const done: Record<FirstCircuitStep, boolean> = { ...built, power: powered, lit };
  const current = FIRST_CIRCUIT_STEPS.find((step) => !done[step]) ?? null;
  const buildingUnmet = !(built.switches && built.gate && built.led && built.wires);
  return { done, current, mustPowerOff: sim.powered && buildingUnmet };
}
