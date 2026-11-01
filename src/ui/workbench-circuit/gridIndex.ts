/** Uniform-grid buckets over world boxes, for the router's obstacle tests. A query visits a
 *  superset of the items whose box meets the query box, so an exact test run on what it visits
 *  answers as a scan of every item would, and routes stay identical. */
export class GridIndex<T> {
  private readonly cells = new Map<number, number[]>();
  private readonly items: T[] = [];
  private readonly seenAt: number[] = [];
  private query = 0;

  constructor(private readonly cellSize: number) {}

  get size(): number {
    return this.items.length;
  }

  /** Files `item` under every cell its closed box `x0..x1, y0..y1` touches. */
  insert(item: T, x0: number, y0: number, x1: number, y1: number): void {
    const id = this.items.length;
    this.items.push(item);
    this.seenAt.push(0);
    this.eachCell(x0, y0, x1, y1, (key) => {
      const bucket = this.cells.get(key);
      if (bucket) bucket.push(id);
      else this.cells.set(key, [id]);
    });
  }

  /** Visits each candidate for the closed box once, stopping at the first `visit` that returns
   *  true; returns whether one did. */
  some(x0: number, y0: number, x1: number, y1: number, visit: (item: T) => boolean): boolean {
    const stamp = ++this.query;
    let hit = false;
    this.eachCell(x0, y0, x1, y1, (key) => {
      const bucket = this.cells.get(key);
      if (!bucket) return false;
      for (const id of bucket) {
        if (this.seenAt[id] === stamp) continue;
        this.seenAt[id] = stamp;
        if (visit(this.items[id]!)) return (hit = true);
      }
      return false;
    });
    return hit;
  }

  private eachCell(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    fn: (key: number) => boolean | void,
  ): void {
    const s = this.cellSize;
    const cx1 = Math.floor(x1 / s);
    const cy1 = Math.floor(y1 / s);
    for (let cx = Math.floor(x0 / s); cx <= cx1; cx++)
      for (let cy = Math.floor(y0 / s); cy <= cy1; cy++)
        // Wrapped to 16 bits a side: two far cells sharing a key only widen the candidates.
        if (fn((cx & 0xffff) * 0x10000 + (cy & 0xffff))) return;
  }
}
