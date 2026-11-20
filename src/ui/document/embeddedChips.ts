import type { Board, ChipDef } from '../../core/model/types';
import { pruneHiddenChecks } from '../../core/checks/checks';
import {
  chipsThatDiffer,
  chipsUsedBy,
  pinsDiffer,
  sameBehavior,
} from '../../core/model/embedChips';
import { isBuiltinChipDef } from '../../core/parts/packages';

/** Which copy wins when a board's chip differs from one already open. */
export type ChipCopyChoice = 'open' | 'board';

// Module state on purpose: "don't ask again" lasts until the page reloads, never longer,
// so a remembered "board's copies" cannot overwrite a newer chip weeks later.
let remembered: ChipCopyChoice | null = null;

export function rememberChipCopyChoice(choice: ChipCopyChoice | null): void {
  remembered = choice;
}

export function rememberedChipCopyChoice(): ChipCopyChoice | null {
  return remembered;
}

export function withoutChips(board: Board): Board {
  if (board.chips === undefined) return board;
  const copy = { ...board };
  delete copy.chips;
  return copy;
}

/** The board as written to a file: carrying the user chips it uses, or none. */
export function boardWithChips(
  board: Board,
  library: ReadonlyMap<string, ChipDef>,
  embed: boolean,
): Board {
  const bare = withoutChips(board);
  if (!embed) return bare;
  const chips = chipsUsedBy(board, library, board.chips);
  return chips.length > 0 ? { ...bare, chips } : bare;
}

/** The board as Save would write it, built without writing the pruned board
 *  back, so exporting or reporting never marks the board edited. */
export function boardAsSaved(
  board: Board,
  library: ReadonlyMap<string, ChipDef>,
  embed: boolean,
): Board {
  return boardWithChips(
    { ...board, hiddenChecks: pruneHiddenChecks(board, library) },
    library,
    embed,
  );
}

export interface EmbeddedPlan {
  /** Not loaded yet: load without asking. */
  load: ChipDef[];
  /** Loaded (or built in) with different content: the user picks a copy. */
  differ: ChipDef[];
  /** Differ, but the open copy has unsaved tab edits, which are never replaced. */
  kept: string[];
  /** Ids in `differ` whose loaded copy is a built-in. */
  builtin: string[];
  /** User chips in `differ` whose pins differ from the loaded copy, so the open copy would orphan wires. */
  pinMismatch: string[];
  /** Built-in ids in `differ` with different pins: keeping the built-in stays allowed, the board may dangle. */
  builtinPinMismatch: string[];
  /** Ids in `differ` that have a clean tab open; the board's copy would turn it dirty. */
  tabbed: string[];
}

export function planEmbedded(
  board: Board,
  library: ReadonlyMap<string, ChipDef>,
  dirtyTabIds: ReadonlySet<string>,
  openTabIds: ReadonlySet<string> = new Set(),
): EmbeddedPlan {
  const embedded = board.chips ?? [];
  const differIds = new Set(chipsThatDiffer(embedded, library));
  const plan: EmbeddedPlan = {
    load: [],
    differ: [],
    kept: [],
    builtin: [],
    pinMismatch: [],
    builtinPinMismatch: [],
    tabbed: [],
  };
  for (const def of embedded) {
    const loaded = library.get(def.id);
    if (!loaded) {
      plan.load.push(def);
      continue;
    }
    const builtin = isBuiltinChipDef(loaded);
    if (builtin ? sameBehavior(def, loaded) : !differIds.has(def.id)) continue;
    if (dirtyTabIds.has(def.id)) plan.kept.push(def.id);
    else {
      plan.differ.push(def);
      if (builtin) plan.builtin.push(def.id);
      if (pinsDiffer(def, loaded))
        (builtin ? plan.builtinPinMismatch : plan.pinMismatch).push(def.id);
      if (openTabIds.has(def.id)) plan.tabbed.push(def.id);
    }
  }
  return plan;
}
