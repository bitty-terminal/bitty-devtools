import { describe, expect, test } from "bun:test";
import {
  MATRIX,
  REFERENCE_TERMS,
  generateMatrixJson,
  parseMatrixJsonBounded,
} from "../src/compat-matrix.js";

describe("compat-matrix 14x4", () => {
  test("matrix is 14 rows ordered", () => {
    expect(MATRIX.length).toBe(14);
    expect(MATRIX[0].surface).toBe("shell");
    expect(MATRIX[MATRIX.length - 1].surface).toBe("DPI");
  });

  test("reference terms are 4", () => {
    expect(REFERENCE_TERMS).toEqual([
      "ghostty",
      "kitty",
      "wezterm",
      "alacritty",
    ]);
  });

  test("surfaces unique", () => {
    const seen = new Set(MATRIX.map((e) => e.surface));
    expect(seen.size).toBe(14);
  });

  test("generate json bounded <16 KiB deterministic", () => {
    const j = generateMatrixJson();
    expect(new TextEncoder().encode(j).length < 16 * 1024).toBe(true);
    const j2 = generateMatrixJson();
    expect(j).toBe(j2);
    expect(j.includes('"surface": "shell"')).toBe(true);
    expect(j.includes('"surface": "DPI"')).toBe(true);
  });

  test("parse bounded rejects oversize", () => {
    const j = generateMatrixJson();
    expect(parseMatrixJsonBounded(j).version).toBe(1);
    expect(() => parseMatrixJsonBounded("a".repeat(20 * 1024))).toThrow(
      "16 KiB",
    );
  });
});
