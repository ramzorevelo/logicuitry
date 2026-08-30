// Preview-then-commit controller shared by duplicate, smart-connect, wire-cut,
// and insert-on-wire. Pure state; the draw call paints `current` at reduced
// alpha with a dashed accent border.

export const GHOST_ALPHA = 0.45;

export interface GhostPreview<T> {
  proposal: T;
  // Per-sub-item accept/reject flags; empty = single all-or-nothing item.
  flags: Map<string, boolean>;
}

export class PreviewController<T> {
  current: GhostPreview<T> | null = null;

  begin(proposal: T, flags?: Map<string, boolean>): void {
    this.current = { proposal, flags: flags ?? new Map() };
  }

  update(proposal: T): void {
    if (this.current) this.current.proposal = proposal;
    else this.begin(proposal);
  }

  setFlag(id: string, on: boolean): void {
    this.current?.flags.set(id, on);
  }

  // Returns the committed proposal and clears state; null if nothing pending.
  commit(): T | null {
    const proposal = this.current?.proposal ?? null;
    this.current = null;
    return proposal;
  }

  cancel(): void {
    this.current = null;
  }

  get active(): boolean {
    return this.current !== null;
  }
}
