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
    expect(MATRIX[0]!.surface).toBe("shell");
    expect(MATRIX[MATRIX.length - 1]!.surface).toBe("DPI");
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

  test("matrix content order parity (surface/category/corpus)", () => {
    // H-DEV-05(c): content must stay identical across impls; this pins the
    // 14-row order and fields the Rust matrix_content_matches_ts test mirrors.
    const expected: Array<[string, string, string]> = [
      [
        "shell",
        "shell",
        "shell/corpus/02-dogfooding-shell-osc133-osc7-fish.bin",
      ],
      ["tmux", "tui", "tui/corpus/01-nvim-tmux.bin"],
      ["nvim", "tui", "tui/corpus/03-dogfooding-nvim-tmux-fzf-htop-ssh.bin"],
      ["fzf", "tui", "tui/corpus/02-htop-fzf.bin"],
      ["htop", "tui", "tui/corpus/03-dogfooding-nvim-tmux-fzf-htop-ssh.bin"],
      ["ssh", "tui", "tui/corpus/03-dogfooding-nvim-tmux-fzf-htop-ssh.bin"],
      [
        "alt-screen",
        "resize",
        "resize/corpus/02-dogfooding-resize-dpi-alt-screen.bin",
      ],
      ["mouse", "mouse", "mouse/corpus/03-dogfooding-mouse-resize-sgr.bin"],
      ["resize", "resize", "resize/corpus/01-resize-reflow.bin"],
      ["OSC", "osc", "osc/corpus/03-dogfooding-osc7-8-52-title.bin"],
      ["clipboard", "osc", "osc/corpus/02-clipboard.bin"],
      [
        "Kitty",
        "keyboard",
        "keyboard/corpus/03-dogfooding-kitty-keyboard-bracketed.bin",
      ],
      ["IME", "unicode", "unicode/corpus/09-dogfooding-ime-unicode-dpi.bin"],
      [
        "DPI",
        "resize",
        "resize/corpus/02-dogfooding-resize-dpi-alt-screen.bin",
      ],
    ];
    expect(MATRIX.length).toBe(expected.length);
    for (let i = 0; i < expected.length; i++) {
      const row = MATRIX[i];
      const want = expected[i];
      expect(row?.surface as string | undefined).toBe(want?.[0]);
      expect(row?.category).toBe(want?.[1]);
      expect(row?.corpusRel).toBe(want?.[2]);
    }
  });

  test("generate json byte-matches golden fixture", async () => {
    // Golden file is generator output plus one trailing newline (see
    // tests/fixtures/compat-matrix-golden.json header note). Regenerate by
    // writing generateMatrixJson() + "\n" to that path.
    const golden = await Bun.file(
      `${import.meta.dir}/fixtures/compat-matrix-golden.json`,
    ).text();
    expect(`${generateMatrixJson()}\n`).toBe(golden);
  });

  test("parse bounded rejects unsafe entry values and ordering", () => {
    const document = JSON.parse(generateMatrixJson()) as {
      entries: Array<Record<string, unknown>>;
    };
    const mutations: Array<Record<string, unknown>> = [
      { corpusRel: "../escape.bin" },
      { corpusRel: "/absolute.bin" },
      { generation: 0 },
      { width: 0 },
      { stateHash: "not-a-hash" },
    ];
    for (const mutation of mutations) {
      const candidate = structuredClone(document) as typeof document;
      Object.assign(candidate.entries[0]!, mutation);
      expect(() => parseMatrixJsonBounded(JSON.stringify(candidate))).toThrow();
    }
    const reordered = structuredClone(document) as typeof document;
    const first = reordered.entries[0]!;
    reordered.entries[0] = reordered.entries[1]!;
    reordered.entries[1] = first;
    expect(() => parseMatrixJsonBounded(JSON.stringify(reordered))).toThrow();
  });

  test("parse bounded rejects oversize and closed-schema violations", () => {
    const j = generateMatrixJson();
    expect(parseMatrixJsonBounded(j).version).toBe(1);
    expect(() => parseMatrixJsonBounded("a".repeat(20 * 1024))).toThrow(
      "16 KiB",
    );
    const document = JSON.parse(j) as Record<string, unknown>;
    expect(() =>
      parseMatrixJsonBounded(JSON.stringify({ ...document, extra: true })),
    ).toThrow("not allowed");
    const entries = document["entries"] as Array<Record<string, unknown>>;
    entries[0]!["extra"] = true;
    expect(() => parseMatrixJsonBounded(JSON.stringify(document))).toThrow(
      "not allowed",
    );
  });
});
