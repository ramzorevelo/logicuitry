/** Least-recently-used map: a get refreshes an entry, a set past the cap drops the oldest. */
export class LruCache<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(private readonly capacity: number) {}

  get(key: K): V | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.capacity) break;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

/** A thumbnail differs by board, theme and backing-store size, nothing else:
 *  it is always drawn unpowered with nothing selected. */
export function thumbnailKey(
  boardId: string,
  themeRev: string,
  width: number,
  height: number,
): string {
  return `${boardId}|${themeRev}|${width}x${height}`;
}
