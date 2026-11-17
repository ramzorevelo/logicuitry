// Export file names come from user-typed board titles, so they must survive
// Windows (reserved characters and device names) without losing readability.

const DOCUMENT_EXT = /\.(lcirb|lcirc|lcirl|json)$/i;
// Letters of any script stay; punctuation, Windows-reserved and control characters do not.
const UNSAFE_CHARS = /[^\p{L}\p{N}_.-]/gu;
const DASH_RUN = /-+/g;
const EDGE_DOT_OR_DASH = /^[-.]+|[-.]+$/g;
const TRAILING_DOT_OR_DASH = /[-.]+$/;
const DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const FALLBACK_BASE = 'board';
const MAX_BASE_CHARS = 80;

function safeBase(base: string | undefined): string {
  const stem = (base ?? '').trim().replace(DOCUMENT_EXT, '');
  const cleaned = stem
    .toLowerCase()
    .replace(UNSAFE_CHARS, '-')
    .replace(DASH_RUN, '-')
    .replace(EDGE_DOT_OR_DASH, '');
  // Code points, not UTF-16 units, so the cut never splits a surrogate pair.
  const capped = Array.from(cleaned)
    .slice(0, MAX_BASE_CHARS)
    .join('')
    .replace(TRAILING_DOT_OR_DASH, '');
  if (capped === '') return FALLBACK_BASE;
  // Windows treats "CON.anything" as the device too, so test the part before the first dot.
  const deviceCandidate = capped.split('.')[0] ?? '';
  return DEVICE_NAME.test(deviceCandidate) ? FALLBACK_BASE : capped;
}

/** `<base>-<suffix>.<ext>`; the suffix is trusted and appended as-is. */
export function exportFileName(base: string | undefined, suffix: string, ext: string): string {
  return `${safeBase(base)}-${suffix}.${ext}`;
}
