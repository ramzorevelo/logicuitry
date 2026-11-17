import { describe, expect, it } from 'vitest';
import { buildZip, crc32, type ZipEntry } from './zip';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface ReadEntry {
  name: string;
  data: Uint8Array;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
  flags: number;
}

/** Walks the central directory, then each local header, to check the writer end to end. */
function readZip(bytes: Uint8Array): { count: number; entries: ReadEntry[] } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  expect(view.getUint32(eocd, true)).toBe(0x06054b50);
  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  expect(cdOffset + cdSize).toBe(eocd);

  const entries: ReadEntry[] = [];
  let c = cdOffset;
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(c, true)).toBe(0x02014b50);
    const method = view.getUint16(c + 10, true);
    const flags = view.getUint16(c + 8, true);
    const crc = view.getUint32(c + 16, true);
    const compressedSize = view.getUint32(c + 20, true);
    const uncompressedSize = view.getUint32(c + 24, true);
    const nameLen = view.getUint16(c + 28, true);
    const extraLen = view.getUint16(c + 30, true);
    const commentLen = view.getUint16(c + 32, true);
    const localOffset = view.getUint32(c + 42, true);
    const name = decoder.decode(bytes.subarray(c + 46, c + 46 + nameLen));
    c += 46 + nameLen + extraLen + commentLen;

    expect(view.getUint32(localOffset, true)).toBe(0x04034b50);
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const data = bytes.slice(dataStart, dataStart + compressedSize);
    entries.push({ name, data, crc, compressedSize, uncompressedSize, method, flags });
  }
  expect(c).toBe(eocd);
  return { count: view.getUint16(eocd + 10, true), entries };
}

const text = (s: string): Uint8Array => encoder.encode(s);

describe('crc32', () => {
  it('matches the standard check values', () => {
    expect(crc32(text(''))).toBe(0);
    expect(crc32(text('123456789'))).toBe(0xcbf43926);
    expect(crc32(text('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339);
  });

  it('returns an unsigned 32-bit value', () => {
    const value = crc32(new Uint8Array([0xff, 0xfe, 0x80, 0x01]));
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(0xffffffff);
  });
});

describe('buildZip', () => {
  it('round-trips names, bytes, CRCs and sizes', () => {
    const entries: ZipEntry[] = [
      { name: 'half-adder-schematic.png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]) },
      { name: 'tabla-ñ.csv', data: text('a,b\n1,0\n') },
      { name: 'empty.txt', data: new Uint8Array(0) },
    ];
    const bytes = buildZip(entries);
    const { count, entries: read } = readZip(bytes);

    expect(count).toBe(entries.length);
    expect(read.map((e) => e.name)).toEqual(entries.map((e) => e.name));
    read.forEach((e, i) => {
      const source = entries[i]?.data ?? new Uint8Array(0);
      expect(Array.from(e.data)).toEqual(Array.from(source));
      expect(e.crc).toBe(crc32(source));
      expect(e.compressedSize).toBe(source.length);
      expect(e.uncompressedSize).toBe(source.length);
      expect(e.method).toBe(0);
      expect(e.flags & 0x0800).toBe(0x0800);
    });
  });

  it('is deterministic for the same input', () => {
    const entries: ZipEntry[] = [{ name: 'a.csv', data: text('x') }];
    expect(buildZip(entries)).toEqual(buildZip(entries));
  });

  it('writes the caller date into the DOS time and date words', () => {
    const bytes = buildZip([{ name: 'a', data: text('x') }], new Date(2026, 10, 17, 14, 30, 42));
    const view = new DataView(bytes.buffer);
    expect(view.getUint16(10, true)).toBe((14 << 11) | (30 << 5) | (42 >> 1));
    expect(view.getUint16(12, true)).toBe(((2026 - 1980) << 9) | (11 << 5) | 17);
  });

  it('throws on duplicate names', () => {
    expect(() =>
      buildZip([
        { name: 'a.csv', data: text('1') },
        { name: 'a.csv', data: text('2') },
      ]),
    ).toThrow(/duplicate/);
  });

  it('throws when a name exceeds 65535 bytes', () => {
    const name = 'n'.repeat(65536);
    expect(() => buildZip([{ name, data: text('x') }])).toThrow(RangeError);
  });

  it('produces a 22-byte archive for an empty entry list', () => {
    const bytes = buildZip([]);
    expect(bytes.length).toBe(22);
    expect(readZip(bytes).count).toBe(0);
    expect(new DataView(bytes.buffer).getUint32(0, true)).toBe(0x06054b50);
  });
});
