import { describe, expect, it } from 'vitest';
import { renderPreviewParams, PREVIEW_CANDIDATE_KEYS } from './paramPreview';
import { paramLiveness } from './paramLiveness';
import type { ParamValue } from '../../core/model/types';

const allVisible = () => true;
const fields =
  (map: Record<string, ParamValue>) =>
  (key: string): ParamValue | undefined =>
    map[key];

describe('renderPreviewParams', () => {
  it('previews a picked LED colour and shape', () => {
    const out = renderPreviewParams(
      [{ id: 'd1', kind: 'led' }],
      allVisible,
      fields({ color: 'blue', shape: 'round' }),
    );
    expect(out.get('d1')).toEqual({ color: 'blue', shape: 'round' });
  });

  // The whole point of previewing only these: a pin-shape change cannot be
  // taken back by dropping the overlay, so it has to wait for the commit.
  it('leaves every structural param to the commit', () => {
    const out = renderPreviewParams(
      [{ id: 'd1', kind: 'led' }],
      allVisible,
      fields({ color: 'green', width: 8 }),
    );
    expect(out.get('d1')).toEqual({ color: 'green' });
  });

  it('previews nothing when only structural fields are pending', () => {
    const out = renderPreviewParams([{ id: 'g1', kind: 'and' }], allVisible, fields({ inputs: 3 }));
    expect(out.size).toBe(0);
  });

  it('previews a mux select side', () => {
    const out = renderPreviewParams(
      [{ id: 'm1', kind: 'mux' }],
      allVisible,
      fields({ selSide: 'top' }),
    );
    expect(out.get('m1')).toEqual({ selSide: 'top' });
  });

  it('drops a value the target kind does not accept', () => {
    const out = renderPreviewParams(
      [{ id: 'd1', kind: 'led' }],
      allVisible,
      fields({ color: 'chartreuse' }),
    );
    expect(out.size).toBe(0);
  });

  // A batch spanning kinds writes each key only where it means something.
  it('previews a batch per component, skipping kinds a key does not fit', () => {
    const out = renderPreviewParams(
      [
        { id: 'd1', kind: 'led' },
        { id: 'd2', kind: 'led' },
        { id: 'm1', kind: 'mux' },
      ],
      allVisible,
      fields({ color: 'magenta' }),
    );
    expect(out.get('d1')).toEqual({ color: 'magenta' });
    expect(out.get('d2')).toEqual({ color: 'magenta' });
    expect(out.has('m1')).toBe(false);
  });

  it('honours a per-component visibility filter', () => {
    const out = renderPreviewParams(
      [
        { id: 'd1', kind: 'led' },
        { id: 'd2', kind: 'led' },
      ],
      (id) => id === 'd1',
      fields({ color: 'cyan' }),
    );
    expect(out.get('d1')).toEqual({ color: 'cyan' });
    expect(out.has('d2')).toBe(false);
  });

  it('previews no key that is not render-only, whatever the candidate list grows to', () => {
    for (const key of PREVIEW_CANDIDATE_KEYS) {
      const out = renderPreviewParams([{ id: 'x', kind: 'led' }], allVisible, fields({ [key]: 1 }));
      if (paramLiveness('led', key) !== 'render') expect(out.size, key).toBe(0);
    }
  });
});
