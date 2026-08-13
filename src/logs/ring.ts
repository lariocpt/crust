// Fixed-capacity ring of recent log items for the `logs` session. Push is
// O(1) and never allocates after construction; snapshot() returns
// oldest→newest. Counters are totals for the session, so `buffer` can
// report honestly how much history has scrolled past the window.
export class RingBuffer<T> {
  private buf: (T | undefined)[];
  private head = 0; // next write slot
  private count = 0;
  private pushedTotal = 0;
  private evictedTotal = 0;

  constructor(readonly capacity: number) {
    if (capacity < 1) throw new Error(`RingBuffer: capacity must be >= 1 — got ${capacity}`);
    this.buf = new Array(capacity);
  }

  push(item: T): void {
    if (this.count === this.capacity) this.evictedTotal++;
    else this.count++;
    this.buf[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    this.pushedTotal++;
  }

  /** Oldest → newest copy of the current window. */
  snapshot(): T[] {
    const out: T[] = new Array(this.count);
    const start = (this.head - this.count + this.capacity) % this.capacity;
    for (let i = 0; i < this.count; i++) {
      out[i] = this.buf[(start + i) % this.capacity] as T;
    }
    return out;
  }

  clear(): void {
    this.buf = new Array(this.capacity);
    this.head = 0;
    this.count = 0;
  }

  get size(): number {
    return this.count;
  }

  /** Total items ever pushed this session. */
  get pushed(): number {
    return this.pushedTotal;
  }

  /** Items overwritten because the window was full (excludes clear()). */
  get evicted(): number {
    return this.evictedTotal;
  }
}
