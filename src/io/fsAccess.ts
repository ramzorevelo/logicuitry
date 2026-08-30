// File layer entry point. Every consumer imports from here and never from a
// backend directly, so the second backend is one dispatcher rather than a
// branch at every call site.
//
// Which backend is chosen is a RUNTIME question (`isDesktop`), not a build
// flag: one bundle serves both targets.

import * as browser from './fs/browserFs';
import * as desktop from './fs/desktopFs';
import { isDesktop } from './platform';

export type { LibrarySubdir, LibraryRestore } from './fs/browserFs';
export { PermissionLapsedError } from './fs/browserFs';
export type { LibraryDir, DocFile } from './platform';

const fs = () => (isDesktop() ? desktop : browser);

export const fileSystemAccessSupported: typeof browser.fileSystemAccessSupported = () =>
  fs().fileSystemAccessSupported();
export const filePickersSupported: typeof browser.filePickersSupported = () =>
  fs().filePickersSupported();
export const pickDirectory: typeof browser.pickDirectory = (kind) => fs().pickDirectory(kind);
export const restoreDirectory: typeof browser.restoreDirectory = (kind) =>
  fs().restoreDirectory(kind);
export const loadChipLibrary: typeof browser.loadChipLibrary = (root) => fs().loadChipLibrary(root);
export const ensurePermission: typeof browser.ensurePermission = (handle, request) =>
  fs().ensurePermission(handle, request);
export const listFiles: typeof browser.listFiles = (root, sub) => fs().listFiles(root, sub);
export const readDoc: typeof browser.readDoc = (root, sub, name) => fs().readDoc(root, sub, name);
export const writeDoc: typeof browser.writeDoc = (root, sub, name, doc) =>
  fs().writeDoc(root, sub, name, doc);
export const importDocFromFile: typeof browser.importDocFromFile = (file) =>
  fs().importDocFromFile(file);
export const exportDoc: typeof browser.exportDoc = (doc, filename) => fs().exportDoc(doc, filename);

export const pickDocumentFile: typeof browser.pickDocumentFile = (startIn) =>
  fs().pickDocumentFile(startIn);
export const pickSavePath: typeof browser.pickSavePath = (name, startIn) =>
  fs().pickSavePath(name, startIn);
export const readDocFile: typeof browser.readDocFile = (file) => fs().readDocFile(file);
export const writeDocFile: typeof browser.writeDocFile = (file, text) =>
  fs().writeDocFile(file, text);
export const sameFile: typeof browser.sameFile = (a, b) => fs().sameFile(a, b);
