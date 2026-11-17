// Minimal STORE-only ZIP writer. Exports are already compressed (PNG, CSV) or
// tiny, and skipping DEFLATE keeps the writer dependency-free and byte-stable.

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const LOCAL_HEADER_SIG = 0x04034b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const END_OF_CENTRAL_SIG = 0x06054b50;
const LOCAL_HEADER_LEN = 30;
const CENTRAL_HEADER_LEN = 46;
const END_OF_CENTRAL_LEN = 22;
const VERSION_NEEDED = 20;
// Bit 11: names are UTF-8.
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const MAX_ENTRIES = 0xffff;
const MAX_ARCHIVE_BYTES = 0xffffffff;
const MAX_NAME_BYTES = 0xffff;
const DOS_EPOCH_YEAR = 1980;
// Fixed default so the same entries always produce the same bytes.
const DEFAULT_DATE = new Date(1980, 0, 1, 0, 0, 0);

let crcTable: Uint32Array | undefined;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

export function crc32(data: Uint8Array): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = ((table[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** DOS time and date words; ZIP stores local time with 2-second resolution. */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getFullYear(), DOS_EPOCH_YEAR), DOS_EPOCH_YEAR + 127);
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((year - DOS_EPOCH_YEAR) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: day };
}

interface PreparedEntry {
  name: Uint8Array;
  data: Uint8Array;
  crc: number;
  offset: number;
}

export function buildZip(entries: readonly ZipEntry[], date: Date = DEFAULT_DATE): Uint8Array {
  if (entries.length > MAX_ENTRIES) {
    throw new RangeError(`zip: ${entries.length} entries exceeds ${MAX_ENTRIES}`);
  }
  const encoder = new TextEncoder();
  const seen = new Set<string>();
  const prepared: PreparedEntry[] = [];
  let offset = 0;
  for (const entry of entries) {
    if (seen.has(entry.name)) throw new Error(`zip: duplicate entry name "${entry.name}"`);
    seen.add(entry.name);
    const name = encoder.encode(entry.name);
    if (name.length > MAX_NAME_BYTES) {
      throw new RangeError(`zip: entry name longer than ${MAX_NAME_BYTES} bytes`);
    }
    prepared.push({ name, data: entry.data, crc: crc32(entry.data), offset });
    offset += LOCAL_HEADER_LEN + name.length + entry.data.length;
  }
  const centralStart = offset;
  let centralSize = 0;
  for (const p of prepared) centralSize += CENTRAL_HEADER_LEN + p.name.length;
  const total = centralStart + centralSize + END_OF_CENTRAL_LEN;
  if (total >= MAX_ARCHIVE_BYTES) {
    throw new RangeError('zip: archive too large for non-ZIP64 format');
  }

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  const { time, date: dosDate } = dosDateTime(date);

  for (const p of prepared) {
    let o = p.offset;
    view.setUint32(o, LOCAL_HEADER_SIG, true);
    view.setUint16(o + 4, VERSION_NEEDED, true);
    view.setUint16(o + 6, FLAG_UTF8, true);
    view.setUint16(o + 8, METHOD_STORE, true);
    view.setUint16(o + 10, time, true);
    view.setUint16(o + 12, dosDate, true);
    view.setUint32(o + 14, p.crc, true);
    view.setUint32(o + 18, p.data.length, true);
    view.setUint32(o + 22, p.data.length, true);
    view.setUint16(o + 26, p.name.length, true);
    view.setUint16(o + 28, 0, true);
    o += LOCAL_HEADER_LEN;
    out.set(p.name, o);
    out.set(p.data, o + p.name.length);
  }

  let c = centralStart;
  for (const p of prepared) {
    view.setUint32(c, CENTRAL_HEADER_SIG, true);
    view.setUint16(c + 4, VERSION_NEEDED, true);
    view.setUint16(c + 6, VERSION_NEEDED, true);
    view.setUint16(c + 8, FLAG_UTF8, true);
    view.setUint16(c + 10, METHOD_STORE, true);
    view.setUint16(c + 12, time, true);
    view.setUint16(c + 14, dosDate, true);
    view.setUint32(c + 16, p.crc, true);
    view.setUint32(c + 20, p.data.length, true);
    view.setUint32(c + 24, p.data.length, true);
    view.setUint16(c + 28, p.name.length, true);
    view.setUint16(c + 30, 0, true);
    view.setUint16(c + 32, 0, true);
    view.setUint16(c + 34, 0, true);
    view.setUint16(c + 36, 0, true);
    view.setUint32(c + 38, 0, true);
    view.setUint32(c + 42, p.offset, true);
    out.set(p.name, c + CENTRAL_HEADER_LEN);
    c += CENTRAL_HEADER_LEN + p.name.length;
  }

  view.setUint32(c, END_OF_CENTRAL_SIG, true);
  view.setUint16(c + 4, 0, true);
  view.setUint16(c + 6, 0, true);
  view.setUint16(c + 8, prepared.length, true);
  view.setUint16(c + 10, prepared.length, true);
  view.setUint32(c + 12, centralSize, true);
  view.setUint32(c + 16, centralStart, true);
  view.setUint16(c + 20, 0, true);
  return out;
}
