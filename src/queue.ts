/**
 * Bounded O(1) FIFO queue (CTX-0042, issue #68).
 *
 * Replaces `Array.shift()` front-removal (O(K) memmove per dequeue) with an
 * index-based ring buffer: enqueue appends at the tail, dequeue advances a
 * head index, so both are amortized O(1) regardless of queue length. The live
 * window is kept compact by slicing off the consumed prefix once the head
 * index passes the live length (bounded extra copy, amortized O(1)).
 *
 * Time: enqueue O(1) amortized, dequeue O(1) amortized, peek/len O(1),
 * drain O(n). Space: O(K) for K live entries.
 *
 * Bounds: capacity 1..MAX_QUEUE_CAPACITY; the queue never grows past
 * capacity (callers drop or reject first — this container is fail-closed and
 * throws on overflow so drops stay countable at the call site).
 */

export const MAX_QUEUE_CAPACITY = 256 as const;

export class QueueError extends Error {
  constructor(
    public readonly code: "QueueFull" | "QueueEmpty",
    message: string,
  ) {
    super(message);
    this.name = "QueueError";
  }
}

/** Bounded FIFO with amortized O(1) enqueue and dequeue. */
export class FifoQueue<T> {
  private buf: T[] = [];
  private head = 0;

  constructor(private readonly capacity: number) {
    if (
      !Number.isInteger(capacity) ||
      capacity < 1 ||
      capacity > MAX_QUEUE_CAPACITY
    ) {
      throw new QueueError(
        "QueueFull",
        `queue capacity must be 1..${MAX_QUEUE_CAPACITY}`,
      );
    }
  }

  getCapacity(): number {
    return this.capacity;
  }

  len(): number {
    return this.buf.length - this.head;
  }

  isEmpty(): boolean {
    return this.len() === 0;
  }

  peek(): T | undefined {
    return this.buf[this.head];
  }

  /** Amortized O(1). Throws QueueFull at capacity (callers drop/reject first). */
  enqueue(item: T): void {
    if (this.len() >= this.capacity) {
      throw new QueueError("QueueFull", `capacity ${this.capacity}`);
    }
    this.buf.push(item);
  }

  /** Amortized O(1): advances the head index instead of memmove. */
  dequeue(): T | undefined {
    if (this.head >= this.buf.length) return undefined;
    const item = this.buf[this.head];
    this.head += 1;
    if (this.head * 2 >= this.buf.length) {
      this.buf = this.buf.slice(this.head);
      this.head = 0;
    }
    return item;
  }

  /**
   * Drop the oldest entry without returning it (amortized O(1)).
   * Returns true when an entry was dropped.
   */
  dropOldest(): boolean {
    return this.dequeue() !== undefined;
  }

  /** O(n): snapshot of live entries in FIFO order. */
  toArray(): T[] {
    return this.buf.slice(this.head);
  }

  /** O(n): remove and return all live entries in FIFO order. */
  drain(): T[] {
    const out = this.buf.slice(this.head);
    this.buf = [];
    this.head = 0;
    return out;
  }

  /** O(n): remove and return up to `limit` live entries in FIFO order. */
  drainBounded(limit: number): T[] {
    const take = Math.min(Math.max(limit, 0), this.len());
    const out = this.buf.slice(this.head, this.head + take);
    this.head += take;
    if (this.head >= this.buf.length) {
      this.buf = [];
      this.head = 0;
    } else if (this.head * 2 >= this.buf.length) {
      this.buf = this.buf.slice(this.head);
      this.head = 0;
    }
    return out;
  }

  clear(): void {
    this.buf = [];
    this.head = 0;
  }
}
