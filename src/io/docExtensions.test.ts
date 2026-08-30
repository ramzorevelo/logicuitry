import { describe, expect, it } from 'vitest';
import { BOARD_EXT, CHIP_EXT, isDocumentName } from './docExtensions';

describe('document extensions', () => {
  it('accepts boards and chips', () => {
    expect(isDocumentName(`adder${BOARD_EXT}`)).toBe(true);
    expect(isDocumentName(`half-adder${CHIP_EXT}`)).toBe(true);
  });

  it('still reads the pre-extension names, so older saves keep opening', () => {
    expect(isDocumentName('adder.board.json')).toBe(true);
    expect(isDocumentName('half-adder.chip.json')).toBe(true);
  });

  // The whole point of the change: a chips folder that also holds notes,
  // settings or any other JSON must not have them offered as chips, and the
  // desktop app must not become the handler for every .json on the machine.
  it('ignores a plain .json file', () => {
    expect(isDocumentName('package.json')).toBe(false);
    expect(isDocumentName('notes.json')).toBe(false);
  });

  it('is case-insensitive, since Windows is', () => {
    expect(isDocumentName('ADDER.LCIRB')).toBe(true);
    expect(isDocumentName('Half-Adder.Lcirc')).toBe(true);
  });

  it('does not match a name that merely contains the extension', () => {
    expect(isDocumentName('adder.lcirb.txt')).toBe(false);
    expect(isDocumentName('lcirb')).toBe(false);
  });
});
