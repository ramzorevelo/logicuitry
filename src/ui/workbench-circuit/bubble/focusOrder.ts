// Bubble-eligible terminal enumeration and Tab/Shift+Tab cycling order.
// Pure over the board model, no DOM.

import type { Board } from '../../../core/model/types';
import { gateInputPins, getInputBubbles, getOutputBubble } from '../../../core/gates/bubbleModel';
import { isStandaloneInverter } from '../../../core/gates/transform';

export type TerminalFocus =
  | { kind: 'terminal'; component: string; pin: string; side: 'input' | 'output' }
  | { kind: 'body'; component: string }
  | { kind: 'wire'; wireId: string };

const GATE_BASE_KINDS = new Set(['and', 'or', 'buf']);

/** Every terminal currently carrying a bubble, in board-declaration flow
 *  order (each gate's own output before its inputs). When `includeWires` is
 *  set (pair-insert tool active), every plain wire is appended after. */
export function focusOrder(board: Board, includeWires: boolean): TerminalFocus[] {
  const out: TerminalFocus[] = [];
  for (const c of board.components) {
    if (!GATE_BASE_KINDS.has(c.kind)) continue;
    // A gate widened to width>1 after already carrying a bubble (via the
    // param overlay) keeps the stored flag but refuses the push (M6.6) --
    // it must not become an unreachable Tab stop.
    if (Number(c.params?.['width'] ?? 1) > 1) continue;
    if (getOutputBubble(c))
      out.push({ kind: 'terminal', component: c.id, pin: 'y', side: 'output' });
    const bubbled = getInputBubbles(c);
    for (const pin of gateInputPins(c)) {
      if (bubbled.has(pin)) out.push({ kind: 'terminal', component: c.id, pin, side: 'input' });
    }
    // A standalone inverter's body is a second, bigger handle (absorb/merge).
    if (isStandaloneInverter(c)) out.push({ kind: 'body', component: c.id });
  }
  if (includeWires) for (const w of board.wires) out.push({ kind: 'wire', wireId: w.id });
  return out;
}

function focusKey(f: TerminalFocus): string {
  if (f.kind === 'wire') return `wire:${f.wireId}`;
  if (f.kind === 'body') return `body:${f.component}`;
  return `terminal:${f.component}:${f.pin}:${f.side}`;
}

/** Tab (dir=1) / Shift+Tab (dir=-1) from `current` (or the first/last entry
 *  when nothing is focused yet); wraps around; null when there is no
 *  eligible terminal at all. */
export function nextFocus(
  board: Board,
  current: TerminalFocus | null,
  dir: 1 | -1,
  includeWires: boolean,
): TerminalFocus | null {
  const order = focusOrder(board, includeWires);
  if (order.length === 0) return null;
  if (!current) return dir === 1 ? order[0]! : order[order.length - 1]!;
  const idx = order.findIndex((f) => focusKey(f) === focusKey(current));
  if (idx === -1) return dir === 1 ? order[0]! : order[order.length - 1]!;
  const next = (idx + dir + order.length) % order.length;
  return order[next]!;
}

export { focusKey };
