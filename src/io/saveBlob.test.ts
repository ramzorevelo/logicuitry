import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveBlob } from './fs/browserFs';

const kind = { description: 'PNG image', mime: 'image/png', ext: 'png' };
const blob = new Blob(['x']);

afterEach(() => vi.unstubAllGlobals());

describe('saveBlob (browser)', () => {
  it('downloads through an anchor when there is no save picker', async () => {
    const a = { href: '', download: '', click: vi.fn() };
    const revoke = vi.fn();
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', { createElement: () => a });
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:x', revokeObjectURL: revoke });
    await expect(saveBlob(blob, 'a.png', kind)).resolves.toBe(true);
    expect(a.download).toBe('a.png');
    expect(a.click).toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith('blob:x');
  });

  it('returns false when the picker is dismissed', async () => {
    const showSaveFilePicker = vi.fn().mockRejectedValue(new DOMException('', 'AbortError'));
    vi.stubGlobal('window', { showSaveFilePicker });
    await expect(saveBlob(blob, 'a.png', kind)).resolves.toBe(false);
  });

  it('writes the blob to the picked file', async () => {
    const write = vi.fn();
    const close = vi.fn();
    const showSaveFilePicker = vi.fn().mockResolvedValue({
      createWritable: async () => ({ write, close }),
    });
    vi.stubGlobal('window', { showSaveFilePicker });
    await expect(saveBlob(blob, 'a.png', kind)).resolves.toBe(true);
    expect(write).toHaveBeenCalledWith(blob);
    expect(close).toHaveBeenCalled();
  });

  it('rethrows other picker errors', async () => {
    vi.stubGlobal('window', { showSaveFilePicker: vi.fn().mockRejectedValue(new Error('boom')) });
    await expect(saveBlob(blob, 'a.png', kind)).rejects.toThrow('boom');
  });
});
