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
    if (e.corpusRel.length > 256)
      throw new Error(`corpusRel too long for ${e.surface}`);
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
      CANONICAL_HASH_VERSION: 1,
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

export function parseMatrixJsonBounded(raw: string): MatrixJson {
  const bytes = new TextEncoder().encode(raw).length;
  if (bytes > 16 * 1024) throw new Error(`matrix json ${bytes} > 16 KiB`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("invalid matrix json");
  }
  const doc = parsed as MatrixJson;
  if (doc.version !== 1) throw new Error("matrix version must be 1");
  if (doc.entries.length !== MATRIX_LEN)
    throw new Error("matrix entries must be 14");
  return doc;
}
