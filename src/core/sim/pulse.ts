import * as bv from '../value/busValue';
import { OSC_EVENT_LIMIT, type SettleReport, type Simulator } from './kernel';

/**
 * One clock cycle on a paused sim: steps until `clockNet` has risen and then
 * fallen, then settles the logic. It stops at the fall, as the headless
 * runner's tick does, so inputs set next land mid-period. Steps rather than
 * runUntil because a paused sim parks its clocks; each step re-arms them.
 * Null when nothing can move or the net never rises.
 */
export function pulseClock(
  sim: Simulator,
  clockNet: number,
  limit = OSC_EVENT_LIMIT * 10,
): SettleReport | null {
  const level = () => bv.toString(sim.netValue(clockNet), 1);
  let previous = level();
  let rose = false;
  let processed = 0;
  while (processed <= limit) {
    const report = sim.stepToNextEvent();
    if (!report) return null;
    processed += report.changedNets.length + report.evaluated.length;
    const now = level();
    if (now === '1' && previous !== '1') rose = true;
    else if (rose && now === '0') {
      const settled = sim.settle();
      return { ...settled, eventsProcessed: processed + settled.eventsProcessed };
    }
    previous = now;
  }
  return null;
}
