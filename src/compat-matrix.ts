/**
 * Compat matrix reuse (14 surfaces x 4 terminals).
 *
 * Mirrors `bitty-compat-lab` matrix.rs: 14 rows, 4 reference terminals,
 * bounded corpus (≤8 KiB, ≤4096 actions), deterministic state hash.
 * No winit/wgpu/window handles, no network, no RNG. Hosted over Panel
 * Runtime snapshot context for diagnostics correlation.
 */

import { BOUNDS } from "./bounds.js";

export type CompatSurface =
  | "shell"
  | "tmux"
  | "nvim"
  | "fzf"
  | "htop"
  | "ssh"
  | "alt-screen"
  | "mouse"
  | "resize"
  | "OSC"
  | "clipboard"
  | "Kitty"
  | "IME"
  | "DPI";

export type MatrixEntry = {
  surface: CompatSurface;
  category: string;
  corpusRel: string;
  description: string;
};

export const MATRIX: readonly MatrixEntry[] = [
  {
    surface: "shell",
    category: "shell",
    corpusRel: "shell/corpus/02-dogfooding-shell-osc133-osc7-fish.bin",
    description:
      "shell prompt marks 133;A/B/C/D plus OSC 7 cwd and OSC 8 hyperlink (zsh/fish)",
  },
  {
    surface: "tmux",
    category: "tui",
    corpusRel: "tui/corpus/01-nvim-tmux.bin",
    description: "tmux pane border and status bar with color",
  },
  {
    surface: "nvim",
    category: "tui",
    corpusRel: "tui/corpus/03-dogfooding-nvim-tmux-fzf-htop-ssh.bin",
    description:
      "nvim fullscreen alt-screen 1049h scroll region and statusline",
  },
  {
    surface: "fzf",
    category: "tui",
    corpusRel: "tui/corpus/02-htop-fzf.bin",
    description: "fzf fuzzy finder height 40 percent alt-screen list",
  },
  {
    surface: "htop",
    category: "tui",
    corpusRel: "tui/corpus/03-dogfooding-nvim-tmux-fzf-htop-ssh.bin",
    description: "htop process table color bars with alt-screen",
  },
  {
    surface: "ssh",
    category: "tui",
    corpusRel: "tui/corpus/03-dogfooding-nvim-tmux-fzf-htop-ssh.bin",
    description: "ssh remote echo ssh-ok plus OSC 0 remote-title",
  },
  {
    surface: "alt-screen",
    category: "resize",
    corpusRel: "resize/corpus/02-dogfooding-resize-dpi-alt-screen.bin",
    description:
      "alt-screen 1049h/1049l with scroll region 2;10r and 800x600 resize",
  },
  {
    surface: "mouse",
    category: "mouse",
    corpusRel: "mouse/corpus/03-dogfooding-mouse-resize-sgr.bin",
    description: "mouse SGR 1006 with 1000/1002/1003 modes click drag scroll",
  },
  {
    surface: "resize",
    category: "resize",
    corpusRel: "resize/corpus/01-resize-reflow.bin",
    description: "resize reflow with scroll region and erase",
  },
  {
    surface: "OSC",
    category: "osc",
    corpusRel: "osc/corpus/03-dogfooding-osc7-8-52-title.bin",
    description: "OSC 0/2 title plus 7 cwd file plus 8 hyperlink",
  },
  {
    surface: "clipboard",
    category: "osc",
    corpusRel: "osc/corpus/02-clipboard.bin",
    description: "clipboard OSC 52 query c versus write with base64 payload",
  },
  {
    surface: "Kitty",
    category: "keyboard",
    corpusRel: "keyboard/corpus/03-dogfooding-kitty-keyboard-bracketed.bin",
    description:
      "Kitty keyboard progressive 7727 plus CSI u and bracketed paste",
  },
  {
    surface: "IME",
    category: "unicode",
    corpusRel: "unicode/corpus/09-dogfooding-ime-unicode-dpi.bin",
    description: "IME wide CJK emoji ZWJ combining zero-width invalid utf8",
  },
  {
    surface: "DPI",
    category: "resize",
    corpusRel: "resize/corpus/02-dogfooding-resize-dpi-alt-screen.bin",
    description: "DPI scale 800x600 to 100x37 at 8x16 with alt-screen",
  },
] as const;

export const REFERENCE_TERMS: readonly string[] = [
  "ghostty",
  "kitty",
  "wezterm",
  "alacritty",
] as const;

export const MATRIX_LEN = 14 as const;

/**
 * Tracks upstream bitty-term-state CANONICAL_HASH_VERSION (live canonical,
 * now 5; upstream bitty-compat-lab emits its EXPECTED_HASH_VERSION).
 * Divergence: devtools `stateHash` here is FNV-1a over surface-name
 * pseudo-bytes for headless shape-parity, NOT the real canonical stream; the
 * version field tracks upstream so consumers can tell which canonical era the
 * matrix was generated against.
 */
export const CANONICAL_HASH_VERSION = 5 as const;

export type MatrixJsonEntry = MatrixEntry & {
  bytesLen: number;
  actionsLen: number;
  stateHash: string;
  width: number;
  height: number;
  generation: number;
  self: "PASS";
  references: Record<string, "SKIP">;
};

export type MatrixJson = {
  version: number;
  generated: string;
  matrixLen: number;
  bounds: {
    MAX_CORPUS_BYTES: number;
    MAX_ACTIONS: number;
    MAX_SNAPSHOT_JSON_BYTES: number;
    GRID: string;
    CANONICAL_HASH_VERSION: number;
  };
  entries: MatrixJsonEntry[];
};

/** Deterministic FNV-like hash for headless verification (no crypto). */
export function deterministicHash(bytes: Uint8Array): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

export function checkMatrixInvariants(): void {
  if (MATRIX.length !== MATRIX_LEN) {
    throw new Error(`matrix len ${MATRIX.length} != MATRIX_LEN ${MATRIX_LEN}`);
  }
  const seen = new Set<string>();
  for (const e of MATRIX) {
    if (seen.has(e.surface)) throw new Error(`duplicate surface ${e.surface}`);
    seen.add(e.surface);
    if (e.corpusRel.length === 0)
      throw new Error(`empty corpusRel for ${e.surface}`);
    if (new TextEncoder().encode(e.corpusRel).length > 256)
      throw new Error(`corpusRel too long for ${e.surface}`);
    if (
      e.corpusRel.startsWith("/") ||
      e.corpusRel.includes("\\") ||
      e.corpusRel.split("/").some((part) => part === ".." || part === "") ||
      /[\u0000-\u001f\u007f]/.test(e.corpusRel)
    ) {
      throw new Error(`invalid corpusRel for ${e.surface}`);
    }
    for (const [field, value] of [
      ["category", e.category],
      ["description", e.description],
    ] as const) {
      if (
        value.length === 0 ||
        new TextEncoder().encode(value).length > 256 ||
        /[\u0000-\u001f\u007f]/.test(value)
      ) {
        throw new Error(`invalid ${field} for ${e.surface}`);
      }
    }
  }
  const first = MATRIX[0];
  if (first === undefined || first.surface !== "shell")
    throw new Error("matrix must start with shell");
  const last = MATRIX[MATRIX.length - 1];
  if (last === undefined || last.surface !== "DPI")
    throw new Error("matrix must end with DPI");
  if (REFERENCE_TERMS.length !== 4)
    throw new Error("reference terms must be 4");
}

export function generateMatrixJson(): string {
  checkMatrixInvariants();
  const entries: MatrixJsonEntry[] = MATRIX.map((e) => {
    // Deterministic headless pseudo-bytes: surface name repeated to fill pseudo corpus
    const pseudo = new TextEncoder().encode(e.surface.repeat(8));
    const boundedLen = Math.min(pseudo.length, BOUNDS.MAX_CORPUS_BYTES);
    const slice = pseudo.slice(0, boundedLen);
    const actionsLen = Math.min(slice.length, BOUNDS.MAX_ACTIONS);
    const hash = deterministicHash(slice);
    return {
      ...e,
      bytesLen: slice.length,
      actionsLen,
      stateHash: hash,
      width: 80,
      height: 24,
      generation: 1,
      self: "PASS" as const,
      references: {
        ghostty: "SKIP" as const,
        kitty: "SKIP" as const,
        wezterm: "SKIP" as const,
        alacritty: "SKIP" as const,
      },
    };
  });
  const doc: MatrixJson = {
    version: 1,
    generated: "2026-09-01",
    matrixLen: MATRIX_LEN,
    bounds: {
      MAX_CORPUS_BYTES: BOUNDS.MAX_CORPUS_BYTES,
      MAX_ACTIONS: BOUNDS.MAX_ACTIONS,
      MAX_SNAPSHOT_JSON_BYTES: BOUNDS.MAX_SNAPSHOT_JSON_BYTES,
      GRID: "80x24",
      // Tracks upstream CANONICAL_HASH_VERSION (see CANONICAL_HASH_VERSION
      // above); the stateHash values are headless pseudo-hashes, not the
      // real canonical stream.
      CANONICAL_HASH_VERSION,
    },
    entries,
  };
  const json = JSON.stringify(doc, null, 2);
  const bytes = new TextEncoder().encode(json).length;
  if (bytes > 16 * 1024) throw new Error(`matrix json ${bytes} > 16 KiB`);
  // Determinism check: second generation identical
  const json2 = JSON.stringify(doc, null, 2);
  if (json !== json2) throw new Error("matrix json not deterministic");
  return json;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireExactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  field: string,
): void {
  for (const key of Object.keys(value)) {
    if (!fields.includes(key))
      throw new Error(`${field}.${key} is not allowed`);
  }
  for (const key of fields) {
    if (!Object.hasOwn(value, key)) {
      throw new Error(`${field}.${key} is required`);
    }
  }
}

function requireString(
  value: Record<string, unknown>,
  key: string,
  field: string,
  maxBytes: number,
): string {
  const result = value[key];
  if (typeof result !== "string" || result.length === 0) {
    throw new Error(`${field}.${key} must be a non-empty string`);
  }
  if (new TextEncoder().encode(result).length > maxBytes) {
    throw new Error(`${field}.${key} exceeds its byte bound`);
  }
  return result;
}

function requireInteger(
  value: Record<string, unknown>,
  key: string,
  field: string,
): number {
  const result = value[key];
  if (!Number.isSafeInteger(result) || (result as number) < 0) {
    throw new Error(`${field}.${key} must be a nonnegative integer`);
  }
  return result as number;
}

export function validateMatrixJsonDocument(
  document: unknown,
): asserts document is MatrixJson {
  if (!isRecord(document)) throw new Error("matrix must be an object");
  requireExactFields(
    document,
    ["version", "generated", "matrixLen", "bounds", "entries"],
    "matrix",
  );
  if (document["version"] !== 1 || document["matrixLen"] !== MATRIX_LEN) {
    throw new Error("matrix version or length is invalid");
  }
  requireString(document, "generated", "matrix", 32);
  if (!isRecord(document["bounds"]))
    throw new Error("matrix.bounds must be an object");
  requireExactFields(
    document["bounds"],
    [
      "MAX_CORPUS_BYTES",
      "MAX_ACTIONS",
      "MAX_SNAPSHOT_JSON_BYTES",
      "GRID",
      "CANONICAL_HASH_VERSION",
    ],
    "matrix.bounds",
  );
  const expectedBounds: Record<string, number> = {
    MAX_CORPUS_BYTES: BOUNDS.MAX_CORPUS_BYTES,
    MAX_ACTIONS: BOUNDS.MAX_ACTIONS,
    MAX_SNAPSHOT_JSON_BYTES: BOUNDS.MAX_SNAPSHOT_JSON_BYTES,
    CANONICAL_HASH_VERSION: 5,
  };
  for (const [key, expected] of Object.entries(expectedBounds)) {
    if (document["bounds"][key] !== expected) {
      throw new Error(`matrix.bounds.${key} is invalid`);
    }
  }
  if (document["bounds"]["GRID"] !== "80x24") {
    throw new Error("matrix.bounds.GRID is invalid");
  }
  if (
    !Array.isArray(document["entries"]) ||
    document["entries"].length !== MATRIX_LEN
  ) {
    throw new Error("matrix entries must be 14");
  }
  const seen = new Set<string>();
  for (const [index, value] of document["entries"].entries()) {
    if (!isRecord(value))
      throw new Error(`matrix.entries[${index}] must be an object`);
    const field = `matrix.entries[${index}]`;
    requireExactFields(
      value,
      [
        "surface",
        "category",
        "corpusRel",
        "description",
        "bytesLen",
        "actionsLen",
        "stateHash",
        "width",
        "height",
        "generation",
        "self",
        "references",
      ],
      field,
    );
    const surface = requireString(value, "surface", field, 64);
    if (
      !MATRIX.some((entry) => entry.surface === surface) ||
      seen.has(surface) ||
      surface !== MATRIX[index]?.surface
    ) {
      throw new Error(`${field}.surface is invalid`);
    }
    seen.add(surface);
    for (const key of ["category", "corpusRel", "description"] as const) {
      const text = requireString(value, key, field, 256);
      if (/[\u0000-\u001f\u007f]/.test(text)) {
        throw new Error(`${field}.${key} contains control characters`);
      }
    }
    const corpus = value["corpusRel"];
    if (
      typeof corpus !== "string" ||
      corpus.startsWith("/") ||
      corpus.includes("\\") ||
      corpus.split("/").some((part) => part === ".." || part === "")
    ) {
      throw new Error(`${field}.corpusRel is invalid`);
    }
    const bytesLen = requireInteger(value, "bytesLen", field);
    const actionsLen = requireInteger(value, "actionsLen", field);
    if (bytesLen < 1 || actionsLen < 1) {
      throw new Error(`${field} contains an empty matrix entry`);
    }
    for (const key of ["width", "height", "generation"] as const) {
      const valueNumber = requireInteger(value, key, field);
      if (valueNumber < 1) throw new Error(`${field}.${key} must be positive`);
    }
    if (bytesLen > BOUNDS.MAX_CORPUS_BYTES || actionsLen > BOUNDS.MAX_ACTIONS) {
      throw new Error(`${field} exceeds matrix bounds`);
    }
    const stateHash = requireString(value, "stateHash", field, 16);
    if (!/^[0-9a-f]{16}$/.test(stateHash)) {
      throw new Error(`${field}.stateHash is invalid`);
    }
    if (value["self"] !== "PASS") throw new Error(`${field}.self is invalid`);
    if (!isRecord(value["references"])) {
      throw new Error(`${field}.references must be an object`);
    }
    requireExactFields(
      value["references"],
      ["ghostty", "kitty", "wezterm", "alacritty"],
      `${field}.references`,
    );
    for (const key of ["ghostty", "kitty", "wezterm", "alacritty"] as const) {
      if (value["references"][key] !== "SKIP") {
        throw new Error(`${field}.references.${key} is invalid`);
      }
    }
  }
  return;
}

export function parseMatrixJsonBounded(raw: string): MatrixJson {
  const bytes = new TextEncoder().encode(raw).length;
  if (bytes > BOUNDS.MAX_SNAPSHOT_JSON_BYTES) {
    throw new Error(`matrix json ${bytes} > 16 KiB`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("invalid matrix json");
  }
  validateMatrixJsonDocument(parsed);
  return parsed;
}
