// What a Logicuitry document is called on disk. Boards and chips carry their
// own extensions so a folder listing, a file picker and the OS can each tell
// them apart without opening them, and so associating the desktop app with its
// documents never means claiming every .json on the machine.
//
// The extension is a hint, never the authority: parseDocumentFile still
// decides a file's kind from the `format` token inside it, so a renamed board
// is rejected rather than mis-loaded.

export const BOARD_EXT = '.lcirb';
export const CHIP_EXT = '.lcirc';

/** Names written before documents had their own extensions. Read, never
 *  written; drop once nothing in the wild still uses them. */
const LEGACY_EXTS = ['.board.json', '.chip.json'] as const;

export function isDocumentName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.endsWith(BOARD_EXT) ||
    lower.endsWith(CHIP_EXT) ||
    LEGACY_EXTS.some((e) => lower.endsWith(e))
  );
}
