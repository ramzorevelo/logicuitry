import { create } from 'zustand';
import type { ExportView } from './exportPicture';
import { canvasToPng } from './exportRender';

interface ExportDialogState {
  open: boolean;
  view: ExportView;
  /** Print opens the dialog with Print as the main action. */
  printFirst: boolean;
  show: (view: ExportView, opts?: { print?: boolean }) => void;
  close: () => void;
}

export const useExportDialog = create<ExportDialogState>((set) => ({
  open: false,
  view: 'schematic',
  printFirst: false,
  show: (view, opts) => set({ open: true, view, printFirst: opts?.print ?? false }),
  close: () => set({ open: false }),
}));

export function imageClipboardSupported(): boolean {
  return typeof ClipboardItem !== 'undefined' && !!navigator.clipboard?.write;
}

/** Hands the clipboard a promise, so the write starts inside the click and keeps its gesture. */
export function copyCanvasImage(canvas: HTMLCanvasElement): Promise<void> {
  return navigator.clipboard.write([new ClipboardItem({ 'image/png': canvasToPng(canvas) })]);
}

/** HTML for Word and Docs, tab-separated text for everything else. */
export async function copyTable(html: string, tsv: string): Promise<void> {
  if (imageClipboardSupported()) {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([tsv], { type: 'text/plain' }),
      }),
    ]);
    return;
  }
  await navigator.clipboard.writeText(tsv);
}

/**
 * Prints the image alone from a hidden frame, so the app's own layout and
 * theme never reach the page and a cancelled dialog leaves nothing behind.
 */
export function printCanvas(canvas: HTMLCanvasElement, title: string): Promise<void> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error('the image is too large to print'));
      const url = URL.createObjectURL(blob);
      const frame = document.createElement('iframe');
      frame.setAttribute('aria-hidden', 'true');
      frame.style.cssText = 'position:fixed;width:0;height:0;border:0;left:-9999px';
      const landscape = canvas.width > canvas.height;
      const cleanup = () => {
        frame.remove();
        URL.revokeObjectURL(url);
      };
      frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><title></title><style>
@page { size: ${landscape ? 'landscape' : 'portrait'}; margin: 12mm }
html, body { margin: 0 }
img { display: block; max-width: 100%; max-height: 100vh; margin: 0 auto; object-fit: contain }
</style></head><body><img alt=""></body></html>`;
      frame.onload = () => {
        const doc = frame.contentDocument;
        const win = frame.contentWindow;
        const img = doc?.querySelector('img');
        if (!doc || !win || !img) {
          cleanup();
          return reject(new Error('printing is not available here'));
        }
        doc.title = title;
        img.src = url;
        img
          .decode()
          .then(() => {
            win.addEventListener('afterprint', cleanup, { once: true });
            win.focus();
            win.print();
            resolve();
          })
          .catch((e: unknown) => {
            cleanup();
            reject(e instanceof Error ? e : new Error('the image could not be printed'));
          });
      };
      document.body.appendChild(frame);
    }, 'image/png');
  });
}
