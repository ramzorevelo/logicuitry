import type { Board, ChipDef } from '../../core/model/types';
import { chipsThatDiffer, chipsUsedBy } from '../../core/model/embedChips';
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

export interface EmbeddedPlan {
  /** Not loaded yet, or only a built-in under that id: load without asking. */
  load: ChipDef[];
  /** Loaded with different content: the user picks a copy. */
  differ: ChipDef[];
  /** Differ, but the open copy has unsaved tab edits, which are never replaced. */
  kept: string[];
}

export function planEmbedded(
  board: Board,
  library: ReadonlyMap<string, ChipDef>,
  dirtyTabIds: ReadonlySet<string>,
): EmbeddedPlan {
  const embedded = board.chips ?? [];
  const differIds = new Set(chipsThatDiffer(embedded, library));
  const plan: EmbeddedPlan = { load: [], differ: [], kept: [] };
  for (const def of embedded) {
    const loaded = library.get(def.id);
    if (!loaded || isBuiltinChipDef(loaded)) plan.load.push(def);
    else if (!differIds.has(def.id)) continue;
    else if (dirtyTabIds.has(def.id)) plan.kept.push(def.id);
    else plan.differ.push(def);
  }
  return plan;
}
