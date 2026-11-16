import type { ChipDef } from '../../core/model/types';
import { isBuiltinChipDef } from '../../core/parts/packages';
import { useCircuitStore } from '../workbench-circuit/circuitStore';
import type { DocFile, LibraryDir } from '../../io/platform';
import { CHIP_EXT } from '../../io/docExtensions';
import { CURRENT_VERSION } from '../../io/migrations';
import { serializeDocument } from '../../io/library';
import {
  PermissionLapsedError,
  docFileWritable,
  exportDoc,
  filePickersSupported,
  pickSavePath,
  writeDoc,
  writeDocFile,
} from '../../io/fsAccess';

/** Where an open chip came from, so Save writes it back there. */
export type ChipSource =
  | { kind: 'file'; file: DocFile }
  | { kind: 'library'; dir: LibraryDir; name: string };

/** The file side of a chip save, injected so the routing is testable without a browser. */
export interface ChipSaveIo {
  pickersSupported: () => boolean;
  writable: (file: DocFile) => boolean;
  writeFile: (file: DocFile, text: string) => Promise<void>;
  writeLibrary: (dir: LibraryDir, name: string, doc: ChipDef) => Promise<void>;
  pickSavePath: (suggestedName: string) => Promise<DocFile | undefined>;
  download: (doc: ChipDef, filename: string) => void;
}

export type ChipSaveResult =
  | { kind: 'written'; source: ChipSource }
  | { kind: 'downloaded' }
  | { kind: 'cancelled' };

export type ChipSaveRoute = 'file' | 'library' | 'pick' | 'download';

/** The app's own file layer; `startIn` is where the save picker opens. */
export function appChipSaveIo(startIn?: LibraryDir): ChipSaveIo {
  return {
    pickersSupported: filePickersSupported,
    writable: docFileWritable,
    writeFile: writeDocFile,
    writeLibrary: (dir, name, doc) => writeDoc(dir, 'chips', name, doc),
    pickSavePath: (name) => pickSavePath(name, startIn),
    download: exportDoc,
  };
}

const sources = new Map<string, ChipSource>();

export const chipSourceOf = (defId: string): ChipSource | undefined => sources.get(defId);

export function rememberChipSource(defId: string, source: ChipSource): void {
  sources.set(defId, source);
}

/** The id names the file, so a student's starter keeps the name the course gave it. */
export const chipFileName = (def: ChipDef): string => `${def.id}${CHIP_EXT}`;

/** The chip as a document: same id, name, pins and version, at the current format. */
export function chipDocument(def: ChipDef): ChipDef {
  return { ...def, formatVersion: CURRENT_VERSION['lcir.chip'] as ChipDef['formatVersion'] };
}

/** An upload is a read-only snapshot, so it routes like a chip with no file at all. */
export function chipSaveRoute(
  source: ChipSource | undefined,
  io: Pick<ChipSaveIo, 'pickersSupported' | 'writable'>,
  saveAs: boolean,
): ChipSaveRoute {
  if (!saveAs && source?.kind === 'library') return 'library';
  if (!saveAs && source?.kind === 'file' && io.writable(source.file)) return 'file';
  return io.pickersSupported() ? 'pick' : 'download';
}

/**
 * Writes the chip to its own file, else asks where (or downloads `<id>.lcirc`
 * without a save picker). A lapsed permission falls back to the picker rather
 * than reporting a save that never happened. The id is never changed here.
 */
export async function saveChip(
  def: ChipDef,
  io: ChipSaveIo,
  opts: { saveAs?: boolean } = {},
): Promise<ChipSaveResult> {
  const doc = chipDocument(def);
  const source = chipSourceOf(def.id);
  const route = chipSaveRoute(source, io, opts.saveAs ?? false);
  try {
    if (route === 'file' && source?.kind === 'file') {
      await io.writeFile(source.file, serializeDocument(doc));
      return { kind: 'written', source };
    }
    if (route === 'library' && source?.kind === 'library') {
      await io.writeLibrary(source.dir, source.name, doc);
      return { kind: 'written', source };
    }
  } catch (e) {
    if (!(e instanceof PermissionLapsedError)) throw e;
    if (!io.pickersSupported()) {
      io.download(doc, chipFileName(def));
      return { kind: 'downloaded' };
    }
  }
  if (route === 'download') {
    io.download(doc, chipFileName(def));
    return { kind: 'downloaded' };
  }
  const file = await io.pickSavePath(chipFileName(def));
  if (!file) return { kind: 'cancelled' };
  await io.writeFile(file, serializeDocument(doc));
  const picked: ChipSource = { kind: 'file', file };
  rememberChipSource(def.id, picked);
  return { kind: 'written', source: picked };
}

/**
 * Saves an open chip from the store and marks the def that was written as clean (an edit that
 * lands during the write stays unsaved). True once it is on disk, written or downloaded.
 */
export async function saveOpenChip(
  defId: string,
  opts: { saveAs?: boolean; startIn?: LibraryDir | undefined } = {},
): Promise<boolean> {
  const store = useCircuitStore.getState();
  const def = store.chipLib.get(defId);
  if (!def || isBuiltinChipDef(def)) return false;
  try {
    const result = await saveChip(def, appChipSaveIo(opts.startIn), {
      saveAs: opts.saveAs ?? false,
    });
    if (result.kind === 'cancelled') return false;
    useCircuitStore.getState().markChipSaved(defId, def);
    return true;
  } catch (e) {
    useCircuitStore.setState({ error: `save: ${(e as Error).message}` });
    return false;
  }
}
