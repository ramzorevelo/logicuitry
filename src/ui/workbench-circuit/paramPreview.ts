// Live preview for the param overlay: what the board looks like while a field
// is open, before anything is written. Split out of CircuitWorkbench so the
// rule is testable without mounting the workbench.

import type { ParamValue } from '../../core/model/types';
import { clampParamValue } from './paramSpecs';
import { paramLiveness } from './paramLiveness';

/** Every param key the overlay can hold a pending value for. */
export const PREVIEW_CANDIDATE_KEYS = [
  'width',
  'inputs',
  'selectBits',
  'addressBits',
  'hasEnable',
  'selSide',
  'initial',
  'color',
  'shape',
  'value',
] as const;

export interface PreviewTarget {
  id: string;
  kind: string;
}

/** Pending values to draw with, per component id.
 *
 *  Only `render` params qualify: no compiled artefact reads them, so drawing
 *  one early cannot desync the sim and dropping the overlay is a complete
 *  revert. Previewing a structural param would mean running its pin diff and
 *  dropping wires, which Esc could not take back. */
export function renderPreviewParams(
  targets: readonly PreviewTarget[],
  keyVisible: (id: string, key: string) => boolean,
  rawValue: (key: string) => ParamValue | undefined,
): Map<string, Record<string, ParamValue>> {
  const out = new Map<string, Record<string, ParamValue>>();
  for (const { id, kind } of targets) {
    const params: Record<string, ParamValue> = {};
    for (const key of PREVIEW_CANDIDATE_KEYS) {
      if (!keyVisible(id, key)) continue;
      if (paramLiveness(kind, key) !== 'render') continue;
      const raw = rawValue(key);
      if (raw === undefined) continue;
      // Clamped against THIS component's own domain, so a batch spanning kinds
      // silently skips whatever a given kind will not accept.
      const v = clampParamValue(kind, key, raw);
      if (v !== null) params[key] = v;
    }
    if (Object.keys(params).length > 0) out.set(id, params);
  }
  return out;
}
