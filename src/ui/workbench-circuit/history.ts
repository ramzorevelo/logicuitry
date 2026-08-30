// Snapshot-diff undo model: every editor action diffs a working copy of the
// board slice it touched into one Command of before/after entity snapshots, and
// undo/redo replay those snapshots through a generic apply callback. No
// per-action inverse logic -- Component/Wire/Junction are flat id-keyed records,
// so a picked item is just {kind, id, before, after}.

import type { Circuit, Component, Junction, Wire, Group } from '../../core/model/types';

export type EntityKind = 'component' | 'wire' | 'junction' | 'group';

export type Entity = Component | Wire | Junction | Group;

export interface PickedItem {
  kind: EntityKind;
  id: string;
  before: Entity | null; // null = did not exist (an add)
  after: Entity | null; // null = no longer exists (a delete)
}

export interface Command {
  label: string;
  items: PickedItem[];
}

/** value === null deletes the entity by id; otherwise upserts it. */
export type ApplyFn = (kind: EntityKind, id: string, value: Entity | null) => void;

function indexById<T extends { id: string }>(list: readonly T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of list) map.set(item.id, item);
  return map;
}

function diffKind(
  kind: EntityKind,
  before: readonly Entity[],
  after: readonly Entity[],
): PickedItem[] {
  const beforeMap = indexById(before);
  const afterMap = indexById(after);
  const ids = new Set<string>([...beforeMap.keys(), ...afterMap.keys()]);
  const items: PickedItem[] = [];
  for (const id of ids) {
    const b = beforeMap.get(id) ?? null;
    const a = afterMap.get(id) ?? null;
    // Unchanged entities contribute nothing to the command.
    if (b && a && JSON.stringify(b) === JSON.stringify(a)) continue;
    items.push({ kind, id, before: b, after: a });
  }
  return items;
}

/** Diff two circuit snapshots into one command's picked-item list. */
export function diffCircuits(before: Circuit, after: Circuit, label: string): Command {
  return {
    label,
    items: [
      ...diffKind('component', before.components, after.components),
      ...diffKind('wire', before.wires, after.wires),
      ...diffKind('junction', before.junctions, after.junctions),
      ...diffKind('group', before.groups ?? [], after.groups ?? []),
    ],
  };
}

export class History {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];

  commit(cmd: Command): void {
    if (cmd.items.length === 0) return; // no-op actions push nothing
    this.undoStack.push(cmd);
    this.redoStack = [];
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(apply: ApplyFn): Command | null {
    const cmd = this.undoStack.pop();
    if (!cmd) return null;
    for (const item of [...cmd.items].reverse()) apply(item.kind, item.id, item.before);
    this.redoStack.push(cmd);
    return cmd;
  }

  redo(apply: ApplyFn): Command | null {
    const cmd = this.redoStack.pop();
    if (!cmd) return null;
    for (const item of cmd.items) apply(item.kind, item.id, item.after);
    this.undoStack.push(cmd);
    return cmd;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}

/** Upsert/delete one picked value into a mutable circuit; the store's apply. */
export function applyToCircuit(
  circuit: Circuit,
  kind: EntityKind,
  id: string,
  value: Entity | null,
): void {
  const key: keyof Circuit =
    kind === 'component'
      ? 'components'
      : kind === 'wire'
        ? 'wires'
        : kind === 'junction'
          ? 'junctions'
          : 'groups';
  // `groups` is optional -- absent on every board written before groups
  // existed -- so undoing back past the first group has to materialise it.
  if (key === 'groups' && !circuit.groups) circuit.groups = [];
  const list = circuit[key] as Entity[];
  const idx = list.findIndex((e) => e.id === id);
  if (value === null) {
    if (idx >= 0) list.splice(idx, 1);
  } else if (idx >= 0) {
    list[idx] = value;
  } else {
    list.push(value);
  }
}
