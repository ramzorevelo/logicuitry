import { describe, expect, it } from 'vitest';
import { isPanelKeyTarget, isSelectTarget, keyBelongsElsewhere, type KeyTarget } from './panelKeys';

/** A stand-in element that sits inside the given ancestors' class names. */
const el = (tagName: string, inside: string[] = []): KeyTarget => ({
  tagName,
  closest: (selector) =>
    selector
      .split(',')
      .map((s) => s.trim().replace(/^\./, ''))
      .some((cls) => inside.includes(cls))
      ? {}
      : null,
});

describe('isPanelKeyTarget', () => {
  it('claims the drawer keys anywhere inside the reference drawer', () => {
    expect(isPanelKeyTarget(el('BUTTON', ['ref-drawer']), 'Delete')).toBe(true);
    expect(isPanelKeyTarget(el('DIV', ['ref-drawer']), 'Delete')).toBe(true);
    expect(isPanelKeyTarget(el('DIV', ['ref-drawer']), 'ArrowLeft')).toBe(true);
    expect(isPanelKeyTarget(el('DIV', ['ref-drawer']), 'x')).toBe(true);
  });

  it('lets board keys through while the drawer has focus', () => {
    for (const key of [' ', '.', '1', 'z', 'Home', 'b']) {
      expect(isPanelKeyTarget(el('DIV', ['ref-drawer']), key)).toBe(false);
      expect(isPanelKeyTarget(el('BUTTON', ['wave-panel']), key)).toBe(false);
    }
  });

  it('claims every key on a select wherever it is', () => {
    expect(isPanelKeyTarget(el('SELECT'), 't')).toBe(true);
    expect(isPanelKeyTarget(el('SELECT'), ' ')).toBe(true);
  });

  it('claims a drawer key on a button in a side panel but not one in the toolbar', () => {
    expect(isPanelKeyTarget(el('BUTTON', ['wave-panel']), 'Delete')).toBe(true);
    expect(isPanelKeyTarget(el('BUTTON', ['circuit-inspector']), 'Enter')).toBe(true);
    expect(isPanelKeyTarget(el('BUTTON', ['circuit-toolbar']), 'Delete')).toBe(false);
  });

  it('leaves the canvas and the window itself to the board', () => {
    expect(isPanelKeyTarget(el('CANVAS', ['circuit-canvas-wrap']), 'Delete')).toBe(false);
    expect(isPanelKeyTarget({}, 'Delete')).toBe(false);
    expect(isPanelKeyTarget(null, 'Delete')).toBe(false);
  });
});

describe('keyBelongsElsewhere', () => {
  it('skips an event a control already handled', () => {
    expect(keyBelongsElsewhere({ defaultPrevented: true, target: null, key: ' ' })).toBe(true);
    expect(keyBelongsElsewhere({ defaultPrevented: false, target: null, key: ' ' })).toBe(false);
  });
});

describe('isSelectTarget', () => {
  it('is true only for a select', () => {
    expect(isSelectTarget(el('SELECT') as EventTarget)).toBe(true);
    expect(isSelectTarget(el('BUTTON', ['ref-drawer']) as EventTarget)).toBe(false);
    expect(isSelectTarget(null)).toBe(false);
  });
});
