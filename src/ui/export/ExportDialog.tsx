import { useEffect, useMemo, useRef, useState } from 'react';
import { pruneHiddenChecks } from '../../core/checks/checks';
import { boardFileName } from '../../io/boardFile';
import { exportFileName } from '../../io/exportName';
import { saveBlob } from '../../io/fsAccess';
import { serializeDocument } from '../../io/library';
import { buildZip, type ZipEntry } from '../../io/zip';
import { useCompact } from '../compact';
import { chipDocument, chipFileName } from '../document/chipSave';
import { useModalKeys } from '../modalKeys';
import { useCircuitStore } from '../workbench-circuit/circuitStore';
import {
  copyCanvasImage,
  copyTable,
  imageClipboardSupported,
  printCanvas,
  useExportDialog,
} from './exportActions';
import {
  EXPORT_VIEWS,
  selectionSubset,
  VIEW_LABEL,
  VIEW_SLUG,
  type ExportPicture,
  type ExportView,
} from './exportPicture';
import {
  canvasToPng,
  panelSource,
  rasterize,
  readExportTheme,
  type Paper,
  type Raster,
} from './exportRender';
import { schematicPicture } from './schematicPicture';
import './export.css';

const PNG = { description: 'PNG image', mime: 'image/png', ext: 'png' };
const ZIP = { description: 'ZIP archive', mime: 'application/zip', ext: 'zip' };
const SCALES = [1, 2, 3] as const;

interface Options {
  paper: Paper;
  grid: boolean;
  signals: boolean;
  selectionOnly: boolean;
  scale: number;
}

/**
 * The open tab as its own file: the name the export is called after, and the
 * bytes a ZIP carries. Pruned the way Save prunes, but without writing the
 * pruned board back, so exporting never marks the board edited.
 */
function openDocument(): { base: string; fileName: string; text: () => string } {
  const st = useCircuitStore.getState();
  const tab = st.tabs.find((t) => t.id === st.activeTabId);
  const def = tab?.kind === 'def' ? st.chipLib.get(tab.defId) : undefined;
  if (def) {
    return {
      base: def.name || def.id,
      fileName: chipFileName(def),
      text: () => serializeDocument(chipDocument(def)),
    };
  }
  const board = st.board;
  return {
    base: board.name,
    fileName: boardFileName(board),
    text: () => serializeDocument({ ...board, hiddenChecks: pruneHiddenChecks(board, st.chipLib) }),
  };
}

function unavailableReason(view: ExportView, selectionOnly: boolean): string | null {
  const st = useCircuitStore.getState();
  if (view === 'schematic') {
    if (st.activeCircuit().components.length === 0) return 'The board is empty';
    if (selectionOnly && st.selection.size === 0) return 'Nothing is selected';
    return null;
  }
  const available = panelSource(view)?.available?.() ?? false;
  if (view === 'waveforms') return available ? null : 'Power the board to record a run';
  return available ? null : 'Open Analyze on an output';
}

function pictureOf(view: ExportView, opts: Options, paper: Paper): ExportPicture | null {
  const theme = readExportTheme(paper);
  if (view !== 'schematic') return panelSource(view)?.picture(theme) ?? null;
  const st = useCircuitStore.getState();
  const tab = st.tabs.find((t) => t.id === st.activeTabId);
  const prefix = tab?.kind === 'def' ? tab.prefix : 'main/';
  const whole = st.activeCircuit();
  const circuit = opts.selectionOnly ? selectionSubset(whole, st.selection) : whole;
  return schematicPicture(theme, circuit, st.chipLib, {
    grid: opts.grid,
    signals: opts.signals
      ? {
          pinSignal: (id, pin) => st.pinSignal(id, pin, prefix),
          pinRawValue: (id, pin) => st.pinRawValue(id, pin, prefix),
          heldOf: (id) => st.buttonHeld(id, prefix),
        }
      : undefined,
  });
}

export function ExportDialog() {
  const open = useExportDialog((s) => s.open);
  const close = useExportDialog((s) => s.close);
  useModalKeys(open ? close : null);
  if (!open) return null;
  return <ExportDialogBody onClose={close} />;
}

function ExportDialogBody({ onClose }: { onClose: () => void }) {
  const initialView = useExportDialog((s) => s.view);
  const printFirst = useExportDialog((s) => s.printFirst);
  const compact = useCompact();
  const hasSelection = useCircuitStore.getState().selection.size > 0;
  const [view, setView] = useState<ExportView>(initialView);
  const [opts, setOpts] = useState<Options>({
    paper: 'light',
    grid: false,
    signals: false,
    selectionOnly: false,
    scale: 2,
  });
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [fontsReady, setFontsReady] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(document.activeElement);

  useEffect(() => {
    let live = true;
    void document.fonts.ready.then(() => live && setFontsReady(true));
    const back = opener.current;
    return () => {
      live = false;
      if (back instanceof HTMLElement) back.focus();
    };
  }, []);

  const reasons = useMemo(
    () =>
      Object.fromEntries(EXPORT_VIEWS.map((v) => [v, unavailableReason(v, false)])) as Record<
        ExportView,
        string | null
      >,
    [],
  );
  const viewReason =
    view === 'schematic' ? unavailableReason(view, opts.selectionOnly) : reasons[view];

  // Taken from the board as it is now and kept: a running sim never repaints it.
  const raster: Raster | null = useMemo(() => {
    if (!fontsReady || viewReason) return null;
    const picture = pictureOf(view, opts, opts.paper);
    return picture ? rasterize(picture, opts.scale) : null;
  }, [fontsReady, view, opts, viewReason]);

  useEffect(() => {
    const box = previewRef.current;
    if (!box) return;
    if (raster) {
      raster.canvas.className = 'export-preview__image';
      box.replaceChildren(raster.canvas);
    } else box.replaceChildren();
  }, [raster]);

  const doc = useMemo(openDocument, []);
  const fileName = (v: ExportView, ext: string) => exportFileName(doc.base, VIEW_SLUG[v], ext);
  const say = (text: string, error = false) => setStatus({ text, error });
  const fail = (e: unknown) => say(e instanceof Error ? e.message : String(e), true);
  const set = (patch: Partial<Options>) => {
    setStatus(null);
    setOpts((o) => ({ ...o, ...patch }));
  };

  const copy = () => {
    if (!raster) return;
    copyCanvasImage(raster.canvas).then(
      () => say('Image copied. Paste it into your report.'),
      () => say('The clipboard refused the image. Use Save PNG instead.', true),
    );
  };

  const save = async () => {
    if (!raster) return;
    setBusy(true);
    try {
      const name = fileName(view, 'png');
      if (await saveBlob(await canvasToPng(raster.canvas), name, PNG)) say(`Saved ${name}`);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const print = () => {
    if (!raster) return;
    printCanvas(raster.canvas, fileName(view, 'png')).catch(fail);
  };

  const tableText = view === 'table' ? (panelSource('table')?.text?.() ?? null) : null;
  const copyAsTable = () => {
    if (!tableText) return;
    copyTable(tableText.html, tableText.tsv).then(
      () => say('Table copied. Paste it into Word or Docs.'),
      () => say('The clipboard refused the table.', true),
    );
  };

  const saveZip = async () => {
    setBusy(true);
    try {
      const encoder = new TextEncoder();
      const entries: ZipEntry[] = [];
      for (const v of EXPORT_VIEWS) {
        if (reasons[v]) continue;
        const picture = pictureOf(v, { ...opts, selectionOnly: false }, opts.paper);
        const r = picture ? rasterize(picture, opts.scale) : null;
        if (!r) continue;
        const png = await canvasToPng(r.canvas);
        entries.push({ name: fileName(v, 'png'), data: new Uint8Array(await png.arrayBuffer()) });
      }
      const csv = panelSource('table')?.text?.()?.csv;
      if (csv && !reasons.table)
        entries.push({ name: 'truth-table.csv', data: encoder.encode(csv) });
      entries.push({ name: doc.fileName, data: encoder.encode(doc.text()) });
      const zip = buildZip(entries, new Date());
      const name = exportFileName(doc.base, 'export', 'zip');
      if (await saveBlob(new Blob([zip], { type: ZIP.mime }), name, ZIP)) say(`Saved ${name}`);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const canCopy = imageClipboardSupported();
  const ready = raster !== null && !busy;

  return (
    <div
      className="package-overlay export-overlay"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="package-dialog export-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-title"
      >
        <div className="export-dialog__head">
          <h3 id="export-title">Export image</h3>
          <div className="export-seg" role="tablist" aria-label="What to export">
            {EXPORT_VIEWS.map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={v === view}
                disabled={reasons[v] !== null && v !== 'schematic'}
                title={reasons[v] ?? undefined}
                onClick={() => {
                  setStatus(null);
                  setView(v);
                }}
              >
                {VIEW_LABEL[v]}
              </button>
            ))}
          </div>
        </div>

        <div className="export-dialog__body package-scroll">
          <div className="export-preview">
            <div className="export-preview__sheet" ref={previewRef} />
            <div className="export-preview__meta">
              {viewReason ? (
                <span>{viewReason}</span>
              ) : raster ? (
                <>
                  <span>
                    {raster.canvas.width} x {raster.canvas.height} px
                  </span>
                  {raster.reduced && (
                    <span className="export-warn">
                      Resolution lowered to {raster.scale}x to fit
                    </span>
                  )}
                </>
              ) : null}
            </div>
          </div>

          <div className="export-opts">
            {view === 'schematic' && (
              <>
                <fieldset>
                  <legend>Area</legend>
                  <label>
                    <input
                      type="radio"
                      name="export-area"
                      checked={!opts.selectionOnly}
                      onChange={() => set({ selectionOnly: false })}
                    />
                    Whole board
                  </label>
                  <label className={hasSelection ? undefined : 'export-off'}>
                    <input
                      type="radio"
                      name="export-area"
                      checked={opts.selectionOnly}
                      disabled={!hasSelection}
                      onChange={() => set({ selectionOnly: true })}
                    />
                    Selection only
                  </label>
                </fieldset>
                <fieldset>
                  <legend>Show</legend>
                  <label>
                    <input
                      type="checkbox"
                      checked={opts.grid}
                      onChange={(e) => set({ grid: e.target.checked })}
                    />
                    Grid
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={opts.signals}
                      onChange={(e) => set({ signals: e.target.checked })}
                    />
                    Signal values
                  </label>
                </fieldset>
              </>
            )}
            {view === 'waveforms' && (
              <p className="export-note">
                The whole recorded run, with the signals, order and markers the Waveforms panel
                shows.
              </p>
            )}
            {view === 'kmap' && (
              <p className="export-note">The output, groups and reveal stage open in Analyze.</p>
            )}
            {view === 'table' && (
              <p className="export-note">
                The output and input order open in Analyze. Copy as table pastes rows and columns
                you can edit.
              </p>
            )}
            <fieldset>
              <legend>Colours</legend>
              <label>
                <input
                  type="radio"
                  name="export-paper"
                  checked={opts.paper === 'light'}
                  onChange={() => set({ paper: 'light' })}
                />
                Light paper
              </label>
              <label>
                <input
                  type="radio"
                  name="export-paper"
                  checked={opts.paper === 'current'}
                  onChange={() => set({ paper: 'current' })}
                />
                Current theme
              </label>
            </fieldset>
            <fieldset>
              <legend>Resolution</legend>
              <div className="export-seg" role="radiogroup" aria-label="Resolution">
                {SCALES.map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={opts.scale === k}
                    onClick={() => set({ scale: k })}
                  >
                    {k}x
                  </button>
                ))}
              </div>
            </fieldset>
          </div>
        </div>

        <div className="export-dialog__foot">
          <span
            className={status?.error ? 'export-status export-status--error' : 'export-status'}
            role="status"
          >
            {status?.text}
          </span>
          <button type="button" className="tool-btn" disabled={busy} onClick={() => void saveZip()}>
            Save all as ZIP...
          </button>
          {view === 'table' && (
            <button type="button" className="tool-btn" disabled={!tableText} onClick={copyAsTable}>
              Copy as table
            </button>
          )}
          {!compact && (
            <button
              type="button"
              className={printFirst ? 'tool-btn tool-btn--primary' : 'tool-btn'}
              disabled={!ready}
              onClick={print}
            >
              Print...
            </button>
          )}
          <button
            type="button"
            className="tool-btn"
            disabled={!ready || !canCopy}
            title={canCopy ? undefined : 'This browser cannot copy images'}
            onClick={copy}
          >
            Copy image
          </button>
          <button
            type="button"
            className={printFirst ? 'tool-btn' : 'tool-btn tool-btn--primary'}
            disabled={!ready}
            onClick={() => void save()}
          >
            Save PNG...
          </button>
          <button type="button" className="tool-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
