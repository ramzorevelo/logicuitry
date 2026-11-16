import type { ChipDef, ChipLibrary, ComponentKind } from '../model/types';

/** Never listed and never flagged: they join, label, drive or show nets, they build no logic. */
export const WIRING_AIDS: ReadonlySet<ComponentKind> = new Set<ComponentKind>([
  'netlabel',
  'tunnel',
  'vcc',
  'gnd',
  'pullup',
  'pulldown',
  'split',
  'merge',
  'tapdrive',
  'tapread',
  'inport',
  'outport',
  'probe',
  'toggle',
  'button',
  'spdt',
  'led',
]);

/** Counted by "gates at most N", by bit width. */
export const GATE_KINDS: ReadonlySet<ComponentKind> = new Set<ComponentKind>([
  'and',
  'or',
  'nand',
  'nor',
  'xor',
  'xnor',
  'not',
  'buf',
]);

/** A def drawn as a physical package is one IC, named by its part number. */
export function isPackageDef(def: ChipDef): boolean {
  return def.appearance?.package !== undefined;
}

/**
 * The one membership test, shared by the live rows and the palette. `part` is
 * a primitive kind or a package's part number; an empty list allows anything.
 */
export function allowedOf(allowed: readonly string[], part: string): boolean {
  return allowed.length === 0 || allowed.includes(part) || WIRING_AIDS.has(part as ComponentKind);
}

/** A student-made chip is allowed when everything inside it is, recursively. */
export function chipDefAllowed(
  allowed: readonly string[],
  def: ChipDef,
  library: ChipLibrary,
  onPath: ReadonlySet<string> = new Set(),
): boolean {
  if (isPackageDef(def)) return allowedOf(allowed, def.id);
  if (allowed.length === 0) return true;
  if (onPath.has(def.id)) return false;
  const inner = new Set(onPath).add(def.id);
  return def.components.every((c) => {
    if (c.kind !== 'chip') return allowedOf(allowed, c.kind);
    const child = library.get(c.defId ?? '');
    return child !== undefined && chipDefAllowed(allowed, child, library, inner);
  });
}
