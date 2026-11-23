import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  MAX_DOC_BYTES,
  pickDocumentFiles as pickBrowser,
  pickSavePath,
  readDocFile,
} from './fs/browserFs';
import { pickDocumentFiles as pickDesktop } from './fs/desktopFs';

const open = vi.fn();
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: (o: unknown) => open(o) }));
vi.mock('@tauri-apps/api/path', () => ({
  basename: async (p: string) => p.split('/').pop(),
}));

beforeAll(async () => {
  await import('@tauri-apps/api/path');
});

afterEach(() => {
  vi.unstubAllGlobals();
  open.mockReset();
});

describe('pickDocumentFiles (browser, picker)', () => {
  it('returns every picked handle and asks for multiple', async () => {
    const handles = [{ name: 'a.lcirc' }, { name: 'b.lcirc' }];
    const showOpenFilePicker = vi.fn().mockResolvedValue(handles);
    vi.stubGlobal('window', { showOpenFilePicker });
    await expect(pickBrowser()).resolves.toEqual(handles);
    expect(showOpenFilePicker.mock.calls[0]![0].multiple).toBe(true);
    expect(showOpenFilePicker.mock.calls[0]![0].types).toHaveLength(3);
  });

  it('narrows the types to the accepted extensions', async () => {
    const showOpenFilePicker = vi.fn().mockResolvedValue([]);
    vi.stubGlobal('window', { showOpenFilePicker });
    await pickBrowser(undefined, ['.lcirc']);
    const { types } = showOpenFilePicker.mock.calls[0]![0];
    expect(types).toHaveLength(1);
    expect(types[0].accept['application/json']).toEqual(['.lcirc']);
  });

  it('passes no types on a touch-first device, whose picker would gray every document out', async () => {
    const showOpenFilePicker = vi.fn().mockResolvedValue([]);
    vi.stubGlobal('window', { showOpenFilePicker, matchMedia: () => ({ matches: true }) });
    await pickBrowser(undefined, ['.lcirc']);
    expect(showOpenFilePicker.mock.calls[0]![0]).not.toHaveProperty('types');
  });

  it('resolves to [] when dismissed', async () => {
    const showOpenFilePicker = vi.fn().mockRejectedValue(new DOMException('', 'AbortError'));
    vi.stubGlobal('window', { showOpenFilePicker });
    await expect(pickBrowser()).resolves.toEqual([]);
  });
});

describe('pickDocumentFiles (browser, input fallback)', () => {
  function stubInput(): { input: EventTarget & Record<string, unknown>; click: () => void } {
    const target = new EventTarget();
    const input = Object.assign(target, {
      type: '',
      multiple: false,
      accept: '',
      hidden: false,
      files: null as unknown,
      remove: vi.fn(),
    }) as unknown as EventTarget & Record<string, unknown>;
    const click = vi.fn();
    input.click = click;
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', { createElement: () => input, body: { append: vi.fn() } });
    return { input, click: click as () => void };
  }

  it('resolves both files from a multiple input', async () => {
    const { input } = stubInput();
    const files = [{ name: 'a' }, { name: 'b' }];
    const p = pickBrowser(undefined, ['.lcirc']);
    expect(input.multiple).toBe(true);
    expect(input.accept).toBe('.lcirc');
    input.files = files;
    input.dispatchEvent(new Event('change'));
    await expect(p).resolves.toEqual(files);
  });

  it('leaves accept empty on a touch device, whose picker would gray the files out', async () => {
    const { input } = stubInput();
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
    const p = pickBrowser(undefined, ['.lcirc']);
    expect(input.accept).toBe('');
    input.dispatchEvent(new Event('cancel'));
    await expect(p).resolves.toEqual([]);
  });

  it('resolves [] on cancel', async () => {
    const { input } = stubInput();
    const p = pickBrowser();
    input.dispatchEvent(new Event('cancel'));
    await expect(p).resolves.toEqual([]);
  });
});

describe('pickSavePath (browser)', () => {
  it('offers octet-stream on a touch-first device, so Android keeps the extension', async () => {
    const showSaveFilePicker = vi.fn().mockResolvedValue({ name: 'a.lcirb' });
    vi.stubGlobal('window', { showSaveFilePicker, matchMedia: () => ({ matches: true }) });
    await pickSavePath('a.lcirb');
    const { types } = showSaveFilePicker.mock.calls[0]![0];
    expect(types[0].accept).toEqual({ 'application/octet-stream': ['.lcirb'] });
  });

  it('offers the JSON types on desktop', async () => {
    const showSaveFilePicker = vi.fn().mockResolvedValue({ name: 'a.lcirb' });
    vi.stubGlobal('window', { showSaveFilePicker, matchMedia: () => ({ matches: false }) });
    await pickSavePath('a.lcirb');
    expect(showSaveFilePicker.mock.calls[0]![0].types[0].accept).toHaveProperty('application/json');
  });
});

describe('readDocFile', () => {
  it('refuses a file over the size cap without reading it', async () => {
    const text = vi.fn();
    const big = Object.assign(Object.create(File.prototype) as File, {});
    Object.defineProperties(big, {
      size: { value: MAX_DOC_BYTES + 1 },
      name: { value: 'clip.mp4' },
      text: { value: text },
    });
    await expect(readDocFile(big)).rejects.toThrow('too large to be a Logicuitry file');
    expect(text).not.toHaveBeenCalled();
  });

  it('reads a file under the cap', async () => {
    await expect(readDocFile(new File(['{}'], 'a.lcirb'))).resolves.toBe('{}');
  });
});

describe('pickDocumentFiles (desktop)', () => {
  it('normalizes null to []', async () => {
    open.mockResolvedValue(null);
    await expect(pickDesktop()).resolves.toEqual([]);
    expect(open.mock.calls[0]![0].multiple).toBe(true);
  });

  it('normalizes a single string to one handle', async () => {
    open.mockResolvedValue('/x/a.lcirc');
    await expect(pickDesktop()).resolves.toEqual([{ name: 'a.lcirc', path: '/x/a.lcirc' }]);
  });

  it('maps an array to handles and filters by accept', async () => {
    open.mockResolvedValue(['/x/a.lcirc', '/x/b.lcirc']);
    const files = await pickDesktop(undefined, ['.lcirc']);
    expect(files).toEqual([
      { name: 'a.lcirc', path: '/x/a.lcirc' },
      { name: 'b.lcirc', path: '/x/b.lcirc' },
    ]);
    expect(open.mock.calls[0]![0].filters[0].extensions).toEqual(['lcirc']);
  });
});
