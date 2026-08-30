// Binary min-heap ordered by (time, seq): time drives simulation order and
// seq gives the deterministic tie-break required for identical replays.

export interface Timestamped {
  time: number;
  seq: number;
}

export class EventQueue<T extends Timestamped> {
  private heap: T[] = [];

  get size(): number {
    return this.heap.length;
  }

  peek(): T | undefined {
    return this.heap[0];
  }

  push(item: T): void {
    const h = this.heap;
    h.push(item);
    let i = h.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!before(h[i]!, h[parent]!)) break;
      [h[i], h[parent]] = [h[parent]!, h[i]!];
      i = parent;
    }
  }

  pop(): T | undefined {
    const h = this.heap;
    if (h.length === 0) return undefined;
    const top = h[0]!;
    const last = h.pop()!;
    if (h.length > 0) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let smallest = i;
        if (l < h.length && before(h[l]!, h[smallest]!)) smallest = l;
        if (r < h.length && before(h[r]!, h[smallest]!)) smallest = r;
        if (smallest === i) break;
        [h[i], h[smallest]] = [h[smallest]!, h[i]!];
        i = smallest;
      }
    }
    return top;
  }
}

function before(a: Timestamped, b: Timestamped): boolean {
  return a.time !== b.time ? a.time < b.time : a.seq < b.seq;
}
