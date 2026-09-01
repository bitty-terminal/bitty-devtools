import { describe, expect, test } from "bun:test";
import {
  BOUNDS,
  assertBounded,
  assertStringBounded,
  truncateToBytes,
} from "../src/bounds.js";

describe("bounds", () => {
  test("constants mirror Panel Runtime and compat matrix", () => {
    expect(BOUNDS.MAX_PANELS_PER_WORKSPACE).toBe(32);
    expect(BOUNDS.MAX_PANELS_PER_WINDOW).toBe(64);
    expect(BOUNDS.BUS_PER_SUBSCRIPTION).toBe(64);
    expect(BOUNDS.BUS_PER_PANEL_EVENTS).toBe(1024);
    expect(BOUNDS.BUS_GLOBAL_EVENTS).toBe(8192);
    expect(BOUNDS.BUS_EVENT_MAX_BYTES).toBe(8192);
    expect(BOUNDS.MATRIX_LEN).toBe(14);
    expect(BOUNDS.MAX_CORPUS_BYTES).toBe(8192);
    expect(BOUNDS.MAX_FRAME_BYTES).toBe(1 * 1024 * 1024);
    expect(BOUNDS.CHUNK_BYTES).toBe(256 * 1024);
  });

  test("assertBounded fails closed", () => {
    expect(() => assertBounded("test", 100, 10)).toThrow("exceeded");
    expect(() => assertBounded("test", -1, 10)).toThrow("exceeded");
    expect(() => assertStringBounded("test", "a".repeat(9000), 8192)).toThrow(
      "exceeded",
    );
  });

  test("truncateToBytes respects char boundary", () => {
    const s = "a".repeat(9000);
    const t = truncateToBytes(s, 8192);
    expect(new TextEncoder().encode(t).length <= 8192).toBe(true);
  });
});
