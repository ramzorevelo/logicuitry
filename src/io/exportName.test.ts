import { describe, expect, it } from 'vitest';
import { exportFileName } from './exportName';

describe('exportFileName', () => {
  it('joins a slugged base, the suffix and the extension', () => {
    expect(exportFileName('half adder.lcirb', 'schematic', 'png')).toBe('half-adder-schematic.png');
  });

  it('strips known document extensions case-insensitively, and only those', () => {
    expect(exportFileName('x.LCIRB', 'export', 'csv')).toBe('x-export.csv');
    expect(exportFileName('lesson.lcirl', 'export', 'csv')).toBe('lesson-export.csv');
    expect(exportFileName('chip.lcirc', 'export', 'csv')).toBe('chip-export.csv');
    expect(exportFileName('data.json', 'export', 'csv')).toBe('data-export.csv');
    expect(exportFileName('v1.2', 'export', 'csv')).toBe('v1.2-export.csv');
  });

  it('replaces Windows-reserved characters and control characters with dashes', () => {
    expect(exportFileName('a<b>c:d"e/f\\g|h?i*j', 'kmap', 'png')).toBe(
      'a-b-c-d-e-f-g-h-i-j-kmap.png',
    );
    expect(exportFileName('a\u0001b\u007fc', 'kmap', 'png')).toBe('a-b-c-kmap.png');
  });

  it('collapses whitespace and dash runs to a single dash', () => {
    expect(exportFileName('half   --  adder', 'schematic', 'png')).toBe('half-adder-schematic.png');
    expect(exportFileName('a\tb\nc', 'schematic', 'png')).toBe('a-b-c-schematic.png');
  });

  it('uses board for untitled documents', () => {
    expect(exportFileName(undefined, 'schematic', 'png')).toBe('board-schematic.png');
    expect(exportFileName('', 'schematic', 'png')).toBe('board-schematic.png');
    expect(exportFileName('   ', 'schematic', 'png')).toBe('board-schematic.png');
    expect(exportFileName('...', 'schematic', 'png')).toBe('board-schematic.png');
  });

  it('uses board for Windows device names, in any case and with an extension', () => {
    expect(exportFileName('CON', 'waveforms', 'png')).toBe('board-waveforms.png');
    expect(exportFileName('nul', 'waveforms', 'png')).toBe('board-waveforms.png');
    expect(exportFileName('Lpt1.lcirc', 'waveforms', 'png')).toBe('board-waveforms.png');
    expect(exportFileName('aux.notes', 'waveforms', 'png')).toBe('board-waveforms.png');
    expect(exportFileName('COM9', 'waveforms', 'png')).toBe('board-waveforms.png');
  });

  it('keeps names that only look like device names', () => {
    expect(exportFileName('com10', 'waveforms', 'png')).toBe('com10-waveforms.png');
    expect(exportFileName('console', 'waveforms', 'png')).toBe('console-waveforms.png');
  });

  it('trims leading and trailing dots and dashes', () => {
    expect(exportFileName('notes...', 'export', 'csv')).toBe('notes-export.csv');
    expect(exportFileName('...notes', 'export', 'csv')).toBe('notes-export.csv');
    expect(exportFileName('-notes-', 'export', 'csv')).toBe('notes-export.csv');
  });

  it('caps the base at 80 characters and re-trims the cut', () => {
    const long = `${'a'.repeat(79)} b${'c'.repeat(20)}`;
    const name = exportFileName(long, 'schematic', 'png');
    expect(name).toBe(`${'a'.repeat(79)}-schematic.png`);

    const exact = exportFileName('a'.repeat(200), 'schematic', 'png');
    expect(exact).toBe(`${'a'.repeat(80)}-schematic.png`);
  });

  it('keeps unicode letters', () => {
    expect(exportFileName('Crème brûlée.lcirb', 'schematic', 'png')).toBe(
      'crème-brûlée-schematic.png',
    );
  });
});

describe('exportFileName punctuation', () => {
  it('drops punctuation the way a saved board name does', () => {
    expect(exportFileName('Half adder, edited', 'schematic', 'png')).toBe(
      'half-adder-edited-schematic.png',
    );
  });
});
