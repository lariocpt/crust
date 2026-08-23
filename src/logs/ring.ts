// Shared by cli.ts (the --buffer flag) and session.ts (the `buffer N` resize
// command) — they live here because session importing cli would be a cycle.
export const DEFAULT_CAPACITY = 10_000;
export const MAX_CAPACITY = 1_000_000;

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
  private cap: number;

  constructor(capacity: number) {
    if (capacity < 1) throw new Error(`RingBuffer: capacity must be >= 1 — got ${capacity}`);
    this.cap = capacity;
    this.buf = new Array(capacity);
  }

  get capacity(): number {
    return this.cap;
  }

  push(item: T): void {
    if (this.count === this.cap) this.evictedTotal++;
    else this.count++;
    this.buf[this.head] = item;
    this.head = (this.head + 1) % this.cap;
    this.pushedTotal++;
  }

  /** Oldest → newest copy of the current window. */
  snapshot(): T[] {
    const out: T[] = new Array(this.count);
    const start = (this.head - this.count + this.cap) % this.cap;
    for (let i = 0; i < this.count; i++) {
      out[i] = this.buf[(start + i) % this.cap] as T;
    }
    return out;
  }

  /** Oldest ≤n items — a cheap peek where snapshot() would copy the window. */
  sample(n: number): T[] {
    const take = Math.min(Math.max(n, 0), this.count);
    const out: T[] = new Array(take);
    const start = (this.head - this.count + this.cap) % this.cap;
    for (let i = 0; i < take; i++) {
      out[i] = this.buf[(start + i) % this.cap] as T;
    }
    return out;
  }

  /**
   * Live resize, keeping the NEWEST min(size, n) items — so a too-small
   * window can be widened without restarting the session and throwing away
   * the held source's history. Anything discarded on a shrink counts as
   * evicted; pushed is untouched (the items were pushed once).
   */
  resize(n: number): { kept: number; discarded: number } {
    if (n < 1) throw new Error(`RingBuffer: capacity must be >= 1 — got ${n}`);
    const snap = this.snapshot();
    const kept = Math.min(snap.length, n);
    const discarded = snap.length - kept;
    this.evictedTotal += discarded;
    const keptItems = snap.slice(snap.length - kept);
    this.cap = n;
    this.buf = new Array(n);
    for (let i = 0; i < keptItems.length; i++) this.buf[i] = keptItems[i];
    this.count = kept;
    this.head = kept % n;
    return { kept, discarded };
  }

  clear(): void {
    this.buf = new Array(this.cap);
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
