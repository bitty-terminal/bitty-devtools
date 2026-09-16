import { describe, expect, test } from "bun:test";
import { FifoQueue, QueueError, MAX_QUEUE_CAPACITY } from "../src/queue.js";

describe("FifoQueue (bounded O(1) FIFO, CTX-0042)", () => {
  test("capacity validated 1..256", () => {
    expect(() => new FifoQueue<number>(0)).toThrow("capacity");
    expect(() => new FifoQueue<number>(MAX_QUEUE_CAPACITY + 1)).toThrow(
      "capacity",
    );
    expect(new FifoQueue<number>(1).getCapacity()).toBe(1);
  });

  test("FIFO order, peek/len, dequeue O(1) without shift", () => {
    const q = new FifoQueue<string>(4);
    expect(q.isEmpty()).toBe(true);
    expect(q.dequeue()).toBeUndefined();
    q.enqueue("a");
    q.enqueue("b");
    expect(q.len()).toBe(2);
    expect(q.peek()).toBe("a");
    expect(q.dequeue()).toBe("a");
    expect(q.peek()).toBe("b");
    expect(q.len()).toBe(1);
  });

  test("overflow is fail-closed (QueueFull), drops stay countable at call site", () => {
    const q = new FifoQueue<number>(2);
    q.enqueue(1);
    q.enqueue(2);
    expect(() => q.enqueue(3)).toThrow(QueueError);
    expect(q.len()).toBe(2);
  });

  test("dropOldest removes head and reports", () => {
    const q = new FifoQueue<number>(2);
    expect(q.dropOldest()).toBe(false);
    q.enqueue(1);
    q.enqueue(2);
    expect(q.dropOldest()).toBe(true);
    expect(q.toArray()).toEqual([2]);
  });

  test("head-index compaction preserves order over many cycles", () => {
    const q = new FifoQueue<number>(8);
    let next = 0;
    for (let round = 0; round < 50; round++) {
      for (let i = 0; i < 5; i++) {
        if (q.len() >= 8) q.dropOldest();
        q.enqueue(next++);
      }
      const got = q.drainBounded(3);
      expect(got.length).toBe(3);
      for (let i = 1; i < got.length; i++) {
        expect(got[i]!).toBe(got[i - 1]! + 1);
      }
    }
    // Remaining entries still strictly increasing (FIFO preserved)
    const rest = q.drain();
    for (let i = 1; i < rest.length; i++) {
      expect(rest[i]!).toBe(rest[i - 1]! + 1);
    }
  });

  test("drain/drainBounded/clear semantics", () => {
    const q = new FifoQueue<number>(8);
    for (let i = 0; i < 5; i++) q.enqueue(i);
    expect(q.drainBounded(2)).toEqual([0, 1]);
    expect(q.len()).toBe(3);
    expect(q.drain()).toEqual([2, 3, 4]);
    expect(q.isEmpty()).toBe(true);
    q.enqueue(9);
    q.clear();
    expect(q.isEmpty()).toBe(true);
    expect(q.dequeue()).toBeUndefined();
  });
});
