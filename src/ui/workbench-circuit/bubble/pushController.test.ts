import { describe, expect, it } from 'vitest';
import type { Board, Component, Wire } from '../../../core/model/types';
import { withOutputBubble } from '../../../core/gates/bubbleModel';
import { commitPush, previewPush } from './pushController';

function board(components: Component[], wires: Wire[]): Board {
  return {
    format: 'lcir.board',
    formatVersion: 7,
    id: 'b',
    name: 'b',
    components,
    wires,
    junctions: [],
    probes: [],
    view: { x: 0, y: 0, zoom: 1 },
    timing: { mode: 'ideal', datasheet: 'typ' },
  };
}

const lib = new Map();

function nandBoard(): Board {
  const g1 = withOutputBubble({ id: 'g1', kind: 'and', pos: { x: 0, y: 0 } }, true);
  return board(
    [
      { id: 'in1', kind: 'inport', pos: { x: 0, y: 0 }, label: 'in1' },
      { id: 'in2', kind: 'inport', pos: { x: 0, y: 0 }, label: 'in2' },
      g1,
      { id: 'out', kind: 'outport', pos: { x: 0, y: 0 }, label: 'out' },
    ],
    [
      {
        id: 'w1',
        a: { kind: 'pin', component: 'in1', pin: 'y' },
        b: { kind: 'pin', component: 'g1', pin: 'a' },
        points: [],
      },
      {
        id: 'w2',
        a: { kind: 'pin', component: 'in2', pin: 'y' },
        b: { kind: 'pin', component: 'g1', pin: 'b' },
        points: [],
      },
      {
        id: 'w3',
        a: { kind: 'pin', component: 'g1', pin: 'y' },
        b: { kind: 'pin', component: 'out', pin: 'a' },
        points: [],
      },
    ],
  );
}

describe('previewPush / commitPush', () => {
  it('a legal outputBackward move previews and commits identically', () => {
    const b = nandBoard();
    const preview = previewPush(b, { kind: 'outputBackward', gateId: 'g1' }, lib);
    expect(preview.legal).toBe(true);
    const committed = commitPush(b, { kind: 'outputBackward', gateId: 'g1' }, lib);
    expect(committed).not.toBeNull();
    if (preview.legal) expect(committed).toEqual(preview.result);
  });

  it('an illegal inputsForward move (no bubbles at all) previews with no ghost, commit is null', () => {
    const b = nandBoard();
    const preview = previewPush(b, { kind: 'inputsForward', gateId: 'g1' }, lib);
    expect(preview.legal).toBe(false);
    expect(commitPush(b, { kind: 'inputsForward', gateId: 'g1' }, lib)).toBeNull();
  });

  it('one input bubble pushes forward, bubbling the sibling that had none', () => {
    // Was a failed drag while the rule asked for every input to be bubbled.
    // The transform bubbles the clean sibling instead, which is the whole of
    // De Morgan and leaves the truth table untouched -- so previewPush, which
    // verifies against core/boolean, calls it legal.
    const b = nandBoard();
    const pushed = commitPush(b, { kind: 'outputBackward', gateId: 'g1' }, lib)!;
    const partial = {
      ...pushed,
      components: pushed.components.map((c) =>
        c.id === 'g1' ? { ...c, params: { ...c.params, inputBubbles: 'a' } } : c,
      ),
    };
    const preview = previewPush(partial, { kind: 'inputsForward', gateId: 'g1' }, lib);
    expect(preview.legal).toBe(true);
    expect(commitPush(partial, { kind: 'inputsForward', gateId: 'g1' }, lib)).not.toBeNull();
  });
});
