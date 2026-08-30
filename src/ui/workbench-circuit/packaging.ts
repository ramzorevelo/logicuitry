// Encapsulation pure logic: deriving a ChipDef's boundary pins from its
// internal In/Out components, detecting a chip-def reference cycle across the
// library, and detaching wires bound to a pin a def edit just removed. No
// DOM/canvas -- store-testable in Node.

import type {
  ChipDef,
  ChipLibrary,
  Circuit,
  Component,
  PinDef,
  PinDir,
  Point,
  Wire,
  WireEnd,
} from '../../core/model/types';
import { collapseJunctions } from './junctions';

/** Deep-enough clone for a Circuit's flat entity arrays -- packaging must not
 *  leave a def's `components`/`wires` aliasing the live board's, or an edit on
 *  one side would silently mutate the other before either side's next
 *  copy-on-write edit. */
export function cloneCircuit(c: Circuit): Circuit {
  return {
    components: c.components.map((x) => ({ ...x })),
    wires: c.wires.map((w) => ({ ...w, points: [...w.points] })),
    junctions: c.junctions.map((j) => ({ ...j })),
    ...(c.groups ? { groups: c.groups.map((g) => ({ ...g })) } : {}),
  };
}

export interface DerivedPins {
  pins: PinDef[];
  /** Names of pins present in `existing` but with no surviving boundComponent. */
  removed: string[];
  /** Kept pins whose name changed because their bound In/Out component was
   *  renamed (or rewired to a different-labeled component) since `existing`
   *  was derived. Empty when a would-be rename collides with another
   *  surviving pin's name -- the old name is kept instead (mirrors
   *  `renameWith`'s pre-edit validation idiom); the caller can detect that
   *  case by comparing a boundary component's own label against its final
   *  pin's name. */
  renamed: { from: string; to: string }[];
}

/** Boundary pins from a circuit's In/Out components. A pin already tracked
 *  (by its bound component id) has its name/width re-synced from that
 *  component -- an In/Out rename or width edit inside a def tab must
 *  propagate to the boundary pin, not leave it frozen at whatever it was
 *  named when first derived; new In/Out components are appended after the
 *  highest existing order on their side. */
export function derivePins(
  existing: readonly PinDef[],
  components: readonly Component[],
): DerivedPins {
  const byBound = new Map(existing.map((p) => [p.boundComponent, p]));
  const boundary = components.filter((c) => c.kind === 'inport' || c.kind === 'outport');
  const presentIds = new Set(boundary.map((c) => c.id));
  const removed = existing.filter((p) => !presentIds.has(p.boundComponent)).map((p) => p.name);
  const keptBase = existing.filter((p) => presentIds.has(p.boundComponent));

  const maxOrder = (dir: PinDir) =>
    keptBase.filter((p) => p.dir === dir).reduce((m, p) => Math.max(m, p.order), -1);
  let nextIn = maxOrder('in') + 1;
  let nextOut = maxOrder('out') + 1;

  const added: PinDef[] = [];
  for (const c of boundary) {
    if (byBound.has(c.id)) continue;
    const dir: PinDir = c.kind === 'inport' ? 'in' : 'out';
    const width = Number(c.params?.['width'] ?? 1);
    added.push({
      id: `pin-${c.id}`,
      name: c.label || c.id,
      dir,
      width,
      role: 'data',
      order: dir === 'in' ? nextIn++ : nextOut++,
      boundComponent: c.id,
    });
  }

  const renamed: { from: string; to: string }[] = [];
  const takenNames = new Set([...keptBase, ...added].map((p) => p.name));
  const kept = keptBase.map((p) => {
    const c = components.find((x) => x.id === p.boundComponent)!;
    const newWidth = Number(c.params?.['width'] ?? 1);
    const newName = c.label || c.id;
    if (newName === p.name) return newWidth === p.width ? p : { ...p, width: newWidth };
    if (takenNames.has(newName)) return newWidth === p.width ? p : { ...p, width: newWidth };
    takenNames.delete(p.name);
    takenNames.add(newName);
    renamed.push({ from: p.name, to: newName });
    return { ...p, name: newName, width: newWidth };
  });
  return { pins: [...kept, ...added], removed, renamed };
}

/** DFS over every def's chip-instance references; returns a message naming the
 *  offending chain, or null if the library is acyclic. Mirrors compile.ts's
 *  recursion check but runs at edit/save time, over the whole library. */
export function findCycle(lib: ChipLibrary): string | null {
  for (const def of lib.values()) {
    const err = visit(def, lib, []);
    if (err) return err;
  }
  return null;
}

function visit(def: ChipDef, lib: ChipLibrary, stack: readonly string[]): string | null {
  if (stack.includes(def.id)) return `recursive chip reference: ${[...stack, def.id].join(' -> ')}`;
  const nextStack = [...stack, def.id];
  for (const c of def.components) {
    if (c.kind !== 'chip' || !c.defId) continue;
    const child = lib.get(c.defId);
    if (!child) continue;
    const err = visit(child, lib, nextStack);
    if (err) return err;
  }
  return null;
}

function endComponent(end: WireEnd): string | undefined {
  return end.kind === 'pin' ? end.component : undefined;
}

/** Position for a detached free end: the nearest surviving bend on the wire's
 *  own polyline, or (no bends recorded) the instance's own position -- the
 *  store has no live glyph geometry to place it exactly at the old pin tip. */
function detachPos(w: Wire, end: 'a' | 'b', components: readonly Component[]): Point {
  if (w.points.length > 0) return end === 'a' ? w.points[0]! : w.points[w.points.length - 1]!;
  const other = end === 'a' ? w.a : w.b;
  const compId = endComponent(other);
  const comp = compId ? components.find((c) => c.id === compId) : undefined;
  return comp ? comp.pos : { x: 0, y: 0 };
}

/** Detach wire ends bound to a now-missing pin on any instance of `defId`
 *  within one circuit; returns the (possibly unchanged) circuit and the ids
 *  of instances that lost a connection (for the re-bind warning badge). */
export function detachRemovedPins(
  circuit: Circuit,
  defId: string,
  removedNames: readonly string[],
): { circuit: Circuit; staleIds: string[] } {
  if (removedNames.length === 0) return { circuit, staleIds: [] };
  const instanceIds = new Set(
    circuit.components.filter((c) => c.kind === 'chip' && c.defId === defId).map((c) => c.id),
  );
  if (instanceIds.size === 0) return { circuit, staleIds: [] };
  const removed = new Set(removedNames);
  const staleIds = new Set<string>();
  let changed = false;

  const wires = circuit.wires.map((w) => {
    let a = w.a;
    let b = w.b;
    let touched = false;
    if (a.kind === 'pin' && instanceIds.has(a.component) && removed.has(a.pin)) {
      staleIds.add(a.component);
      a = { kind: 'free', pos: detachPos(w, 'a', circuit.components) };
      touched = true;
    }
    if (b.kind === 'pin' && instanceIds.has(b.component) && removed.has(b.pin)) {
      staleIds.add(b.component);
      b = { kind: 'free', pos: detachPos(w, 'b', circuit.components) };
      touched = true;
    }
    if (touched) changed = true;
    return touched ? { ...w, a, b } : w;
  });

  return {
    circuit: changed ? { ...circuit, wires } : circuit,
    staleIds: [...staleIds],
  };
}

/** Rewrites wire ends bound to a renamed pin on any instance of `defId`
 *  within one circuit -- a sibling of `detachRemovedPins` for the rename
 *  case: the pin itself survives, only its name changed, so every WireEnd
 *  referencing it by the old name must follow rather than dangling. */
export function renamePinRefs(
  circuit: Circuit,
  defId: string,
  renamed: readonly { from: string; to: string }[],
): Circuit {
  if (renamed.length === 0) return circuit;
  const instanceIds = new Set(
    circuit.components.filter((c) => c.kind === 'chip' && c.defId === defId).map((c) => c.id),
  );
  if (instanceIds.size === 0) return circuit;
  const renameMap = new Map(renamed.map((r) => [r.from, r.to]));
  let changed = false;

  const wires = circuit.wires.map((w) => {
    let a = w.a;
    let b = w.b;
    let touched = false;
    if (a.kind === 'pin' && instanceIds.has(a.component) && renameMap.has(a.pin)) {
      a = { ...a, pin: renameMap.get(a.pin)! };
      touched = true;
    }
    if (b.kind === 'pin' && instanceIds.has(b.component) && renameMap.has(b.pin)) {
      b = { ...b, pin: renameMap.get(b.pin)! };
      touched = true;
    }
    if (touched) changed = true;
    return touched ? { ...w, a, b } : w;
  });

  return changed ? { ...circuit, wires } : circuit;
}

/** Board-only interactive components: testing aids, never real logic. Left
 *  inside a packaged def, a switch/LED still drives/reads its net as a real
 *  primitive -- if that net is also a label's boundary pin, the def ends up
 *  with a driver baked in, which collides with whatever the def gets wired
 *  to externally once placed (the "drive the same wire" packaging bug). */
const INTERACTIVE_KINDS = new Set(['toggle', 'button', 'led']);

/** Drops switches/LEDs and every wire touching them; a packaged def keeps
 *  only its In/Out label pins and the logic wired between them. */
export function stripInteractiveComponents(circuit: Circuit): Circuit {
  const dropped = new Set(
    circuit.components.filter((c) => INTERACTIVE_KINDS.has(c.kind)).map((c) => c.id),
  );
  if (dropped.size === 0) return circuit;
  const components = circuit.components.filter((c) => !dropped.has(c.id));
  // Copied, not aliased: the junction collapse below rewrites wire ends in
  // place and must never reach back into the caller's circuit.
  const wires = circuit.wires
    .filter((w) => {
      const aHit = w.a.kind === 'pin' && dropped.has(w.a.component);
      const bHit = w.b.kind === 'pin' && dropped.has(w.b.component);
      return !aHit && !bHit;
    })
    .map((w) => ({ ...w, points: [...w.points] }));
  const survivingJunctions = new Set<string>();
  for (const w of wires) {
    if (w.a.kind === 'junction') survivingJunctions.add(w.a.junction);
    if (w.b.kind === 'junction') survivingJunctions.add(w.b.junction);
  }
  const junctions = circuit.junctions.filter((j) => survivingJunctions.has(j.id));
  const stripped: Circuit = { components, wires, junctions };
  // A junction that only branched because a switch or LED hung off it is now
  // debris: orphaned, dangling, or a plain 2-way pass-through. `mergeCorners`
  // because a def needs junctions at real branches only.
  collapseJunctions(stripped, wireIdGen(circuit.wires), undefined, true);
  return stripped;
}

/** Wire ids for a merge, guaranteed clear of everything already in the source
 *  circuit -- a packaged def is written straight to disk, so a duplicate id
 *  here would survive the reload. */
function wireIdGen(existing: readonly Wire[]): () => string {
  const taken = new Set(existing.map((w) => w.id));
  let n = 1;
  return () => {
    let id = `mw${n++}`;
    while (taken.has(id)) id = `mw${n++}`;
    taken.add(id);
    return id;
  };
}

/** Only fully-contained pin-to-pin wires carry over (junction/free-end wires
 *  spanning the selection boundary are ambiguous to package and are dropped;
 *  packaging a whole circuit with no selection needs no filtering). */
export function extractSelection(circuit: Circuit, ids: ReadonlySet<string>): Circuit {
  const components = circuit.components.filter((c) => ids.has(c.id));
  const wires = circuit.wires.filter(
    (w) =>
      w.a.kind === 'pin' && w.b.kind === 'pin' && ids.has(w.a.component) && ids.has(w.b.component),
  );
  return { components, wires, junctions: [] };
}

/** Draft ChipDef for the package dialog: pins auto-derived from the source's
 *  In/Out components, no prior PinDef state to preserve. */
export function draftChipDef(id: string, name: string, source: Circuit): ChipDef {
  const stripped = stripInteractiveComponents(source);
  const { pins } = derivePins([], stripped.components);
  return {
    format: 'lcir.chip',
    formatVersion: 3,
    id,
    name,
    version: 1,
    components: stripped.components,
    wires: stripped.wires,
    junctions: stripped.junctions,
    pins,
  };
}

/** Unique, filename-safe slug for a new chip def id, given the library's
 *  existing ids. */
export function slugId(name: string, existingIds: ReadonlySet<string>): string {
  const base =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'chip';
  if (!existingIds.has(base)) return base;
  let n = 2;
  while (existingIds.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
