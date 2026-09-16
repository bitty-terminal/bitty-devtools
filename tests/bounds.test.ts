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

  test("truncateToBytes exact-length input is a fast-path identity", () => {
    const s = "ab".concat("é"); // 4 bytes
    expect(new TextEncoder().encode(s).length).toBe(4);
    expect(truncateToBytes(s, 4)).toBe(s);
    expect(truncateToBytes("", 0)).toBe("");
  });

  test("truncateToBytes never splits emoji or CJK sequences", () => {
    const enc = new TextEncoder();
    // "a😀b": bytes 1 + 4 + 1; maxBytes 2..4 must stop after "a"
    expect(truncateToBytes("a😀b", 2)).toBe("a");
    expect(truncateToBytes("a😀b", 4)).toBe("a");
    expect(truncateToBytes("a😀b", 5)).toBe("a😀");
    // CJK (3 bytes each): 7-byte cap keeps 2 chars (6 bytes)
    const cjk = truncateToBytes("日本語テスト", 7);
    expect(enc.encode(cjk).length).toBeLessThanOrEqual(7);
    expect(cjk).toBe("日本");
    expect(truncateToBytes("日本語テスト", 9)).toBe("日本語");
    for (const out of [
      truncateToBytes("a😀b", 2),
      truncateToBytes("日本語テスト", 7),
    ]) {
      // No dangling surrogate halves in the output
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
      expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out)).toBe(false);
    }
  });

  test("truncateToBytes zero cap and lone surrogates stay bounded", () => {
    const enc = new TextEncoder();
    expect(truncateToBytes("hello", 0)).toBe("");
    // Lone surrogates encode to U+FFFD (3 bytes); output must stay in-budget
    const lone = truncateToBytes("x�", 2);
    expect(enc.encode(lone).length).toBeLessThanOrEqual(2);
    expect(lone).toBe("x");
  });
});
