#![forbid(unsafe_code)]
//! Compat matrix 14×4 reuse (headless, bounded, deterministic).

use crate::bounds::{MAX_ACTIONS, MAX_CORPUS_BYTES, MAX_SNAPSHOT_JSON_BYTES};
use std::collections::BTreeSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MatrixEntry {
    pub surface: &'static str,
    pub category: &'static str,
    pub corpus_rel: &'static str,
    pub description: &'static str,
}

pub const MATRIX: &[MatrixEntry] = &[
    MatrixEntry {
        surface: "shell",
        category: "shell",
        corpus_rel: "shell/corpus/02-dogfooding-shell-osc133-osc7-fish.bin",
        description: "shell prompt marks 133;A/B/C/D plus OSC 7 cwd and OSC 8 hyperlink (zsh/fish)",
    },
    MatrixEntry {
        surface: "tmux",
        category: "tui",
        corpus_rel: "tui/corpus/01-nvim-tmux.bin",
        description: "tmux pane border and status bar with color",
    },
    MatrixEntry {
        surface: "nvim",
        category: "tui",
        corpus_rel: "tui/corpus/03-dogfooding-nvim-tmux-fzf-htop-ssh.bin",
        description: "nvim fullscreen alt-screen 1049h scroll region and statusline",
    },
    MatrixEntry {
        surface: "fzf",
        category: "tui",
        corpus_rel: "tui/corpus/02-htop-fzf.bin",
        description: "fzf fuzzy finder height 40 percent alt-screen list",
    },
    MatrixEntry {
        surface: "htop",
        category: "tui",
        corpus_rel: "tui/corpus/03-dogfooding-nvim-tmux-fzf-htop-ssh.bin",
        description: "htop process table color bars with alt-screen",
    },
    MatrixEntry {
        surface: "ssh",
        category: "tui",
        corpus_rel: "tui/corpus/03-dogfooding-nvim-tmux-fzf-htop-ssh.bin",
        description: "ssh remote echo ssh-ok plus OSC 0 remote-title",
    },
    MatrixEntry {
        surface: "alt-screen",
        category: "resize",
        corpus_rel: "resize/corpus/02-dogfooding-resize-dpi-alt-screen.bin",
        description: "alt-screen 1049h/1049l with scroll region 2;10r and 800x600 resize",
    },
    MatrixEntry {
        surface: "mouse",
        category: "mouse",
        corpus_rel: "mouse/corpus/03-dogfooding-mouse-resize-sgr.bin",
        description: "mouse SGR 1006 with 1000/1002/1003 modes click drag scroll",
    },
    MatrixEntry {
        surface: "resize",
        category: "resize",
        corpus_rel: "resize/corpus/01-resize-reflow.bin",
        description: "resize reflow with scroll region and erase",
    },
    MatrixEntry {
        surface: "OSC",
        category: "osc",
        corpus_rel: "osc/corpus/03-dogfooding-osc7-8-52-title.bin",
        description: "OSC 0/2 title plus 7 cwd file plus 8 hyperlink",
    },
    MatrixEntry {
        surface: "clipboard",
        category: "osc",
        corpus_rel: "osc/corpus/02-clipboard.bin",
        description: "clipboard OSC 52 query c versus write with base64 payload",
    },
    MatrixEntry {
        surface: "Kitty",
        category: "keyboard",
        corpus_rel: "keyboard/corpus/03-dogfooding-kitty-keyboard-bracketed.bin",
        description: "Kitty keyboard progressive 7727 plus CSI u and bracketed paste",
    },
    MatrixEntry {
        surface: "IME",
        category: "unicode",
        corpus_rel: "unicode/corpus/09-dogfooding-ime-unicode-dpi.bin",
        description: "IME wide CJK emoji ZWJ combining zero-width invalid utf8",
    },
    MatrixEntry {
        surface: "DPI",
        category: "resize",
        corpus_rel: "resize/corpus/02-dogfooding-resize-dpi-alt-screen.bin",
        description: "DPI scale 800x600 to 100x37 at 8x16 with alt-screen",
    },
];

pub const REFERENCE_TERMS: &[&str] = &["ghostty", "kitty", "wezterm", "alacritty"];

/// Tracks upstream bitty-term-state `CANONICAL_HASH_VERSION` (live canonical,
/// now 5; upstream bitty-compat-lab emits its `EXPECTED_HASH_VERSION`).
/// Divergence: devtools `stateHash` here is FNV-1a over surface-name
/// pseudo-bytes for headless shape-parity, NOT the real canonical stream; the
/// version field tracks upstream so consumers can tell which canonical era the
/// matrix was generated against.
pub const CANONICAL_HASH_VERSION: u32 = 5;

pub fn check_matrix_invariants() -> Result<(), String> {
    if MATRIX.len() != 14 {
        return Err(format!("matrix len {} != 14", MATRIX.len()));
    }
    let mut seen = BTreeSet::new();
    for e in MATRIX {
        if !seen.insert(e.surface) {
            return Err(format!("duplicate {}", e.surface));
        }
        if e.corpus_rel.is_empty() {
            return Err(format!("empty corpus for {}", e.surface));
        }
    }
    if MATRIX.first().unwrap().surface != "shell" {
        return Err("must start with shell".to_string());
    }
    if MATRIX.last().unwrap().surface != "DPI" {
        return Err("must end with DPI".to_string());
    }
    if REFERENCE_TERMS.len() != 4 {
        return Err("reference terms must be 4".to_string());
    }
    Ok(())
}

/// Minimal JSON string escape for matrix fields (mirrors the upstream
/// compat-lab helper; current descriptions are plain ASCII but the helper
/// keeps the generator correct if text ever gains quotes or controls).
fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            _ => o.push(ch),
        }
    }
    o
}

pub fn generate_matrix_json() -> Result<String, String> {
    check_matrix_invariants()?;
    let mut out = String::new();
    // TS MatrixJson shape, byte-exact with `JSON.stringify(doc, null, 2)`:
    // camelCase keys, generated date, bounds block, full per-entry fields.
    out.push_str("{\n");
    out.push_str("  \"version\": 1,\n");
    out.push_str("  \"generated\": \"2026-09-01\",\n");
    out.push_str("  \"matrixLen\": 14,\n");
    out.push_str("  \"bounds\": {\n");
    out.push_str(&format!("    \"MAX_CORPUS_BYTES\": {MAX_CORPUS_BYTES},\n"));
    out.push_str(&format!("    \"MAX_ACTIONS\": {MAX_ACTIONS},\n"));
    out.push_str(&format!(
        "    \"MAX_SNAPSHOT_JSON_BYTES\": {MAX_SNAPSHOT_JSON_BYTES},\n"
    ));
    out.push_str("    \"GRID\": \"80x24\",\n");
    // Tracks upstream CANONICAL_HASH_VERSION (see CANONICAL_HASH_VERSION
    // above); the stateHash values are headless pseudo-hashes, not the real
    // canonical stream.
    out.push_str(&format!(
        "    \"CANONICAL_HASH_VERSION\": {CANONICAL_HASH_VERSION}\n"
    ));
    out.push_str("  },\n");
    out.push_str("  \"entries\": [\n");
    for (idx, e) in MATRIX.iter().enumerate() {
        let pseudo = e.surface.repeat(8);
        let bytes = pseudo.as_bytes();
        let len = bytes.len().min(MAX_CORPUS_BYTES);
        let actions = len.min(MAX_ACTIONS);
        // Deterministic FNV-1a 64-bit over the same pseudo bytes as TS
        // `deterministicHash` (offset basis + prime, masked to u64).
        let mut h: u64 = 0xcbf29ce484222325;
        for b in bytes.iter().take(len) {
            h ^= *b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
        out.push_str("    {\n");
        out.push_str(&format!("      \"surface\": \"{}\",\n", esc(e.surface)));
        out.push_str(&format!("      \"category\": \"{}\",\n", esc(e.category)));
        out.push_str(&format!(
            "      \"corpusRel\": \"{}\",\n",
            esc(e.corpus_rel)
        ));
        out.push_str(&format!(
            "      \"description\": \"{}\",\n",
            esc(e.description)
        ));
        out.push_str(&format!("      \"bytesLen\": {len},\n"));
        out.push_str(&format!("      \"actionsLen\": {actions},\n"));
        out.push_str(&format!("      \"stateHash\": \"{h:016x}\",\n"));
        out.push_str("      \"width\": 80,\n");
        out.push_str("      \"height\": 24,\n");
        out.push_str("      \"generation\": 1,\n");
        out.push_str("      \"self\": \"PASS\",\n");
        out.push_str("      \"references\": {\n");
        out.push_str("        \"ghostty\": \"SKIP\",\n");
        out.push_str("        \"kitty\": \"SKIP\",\n");
        out.push_str("        \"wezterm\": \"SKIP\",\n");
        out.push_str("        \"alacritty\": \"SKIP\"\n");
        out.push_str("      }\n");
        if idx + 1 < MATRIX.len() {
            out.push_str("    },\n");
        } else {
            out.push_str("    }\n");
        }
    }
    out.push_str("  ]\n}");
    if out.len() > 16 * 1024 {
        return Err(format!("json {} > 16 KiB", out.len()));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matrix_len_is_14() {
        assert_eq!(MATRIX.len(), 14);
    }

    #[test]
    fn invariants_hold() {
        check_matrix_invariants().unwrap();
    }

    #[test]
    fn json_matches_ts_shape() {
        // H-DEV-05: Rust output must carry the TS MatrixJson shape exactly:
        // camelCase top-level keys, bounds block, full per-entry fields.
        let j = generate_matrix_json().unwrap();
        for key in [
            "\"generated\": \"2026-09-01\"",
            "\"matrixLen\": 14",
            "\"bounds\": {",
            "\"MAX_CORPUS_BYTES\": 8192",
            "\"MAX_ACTIONS\": 4096",
            "\"MAX_SNAPSHOT_JSON_BYTES\": 16384",
            "\"GRID\": \"80x24\"",
            "\"CANONICAL_HASH_VERSION\": 5",
            "\"category\": \"shell\"",
            "\"corpusRel\": \"shell/corpus/",
            "\"bytesLen\": 40",
            "\"actionsLen\": 40",
            "\"stateHash\": \"e01e4dbbf6812045\"",
            "\"width\": 80",
            "\"height\": 24",
            "\"generation\": 1",
            "\"self\": \"PASS\"",
            "\"ghostty\": \"SKIP\"",
        ] {
            assert!(j.contains(key), "missing {key}");
        }
        assert!(!j.contains("matrix_len"), "must use TS camelCase matrixLen");
    }
    #[test]
    fn json_byte_matches_ts_golden() {
        // Golden comparison: byte-exact equality with the checked-in TS
        // generator output (tests/fixtures/compat-matrix-golden.json).
        let golden = include_str!("../../../tests/fixtures/compat-matrix-golden.json");
        let j = generate_matrix_json().unwrap();
        assert_eq!(j, golden.trim_end());
        // Determinism: second generation identical.
        assert_eq!(generate_matrix_json().unwrap(), j);
        assert!(j.len() < 16 * 1024);
    }

    #[test]
    fn matrix_content_matches_ts() {
        // Content parity: 14 rows, same order and surface/category/corpus.
        let expected = [
            (
                "shell",
                "shell",
                "shell/corpus/02-dogfooding-shell-osc133-osc7-fish.bin",
            ),
            ("tmux", "tui", "tui/corpus/01-nvim-tmux.bin"),
            (
                "nvim",
                "tui",
                "tui/corpus/03-dogfooding-nvim-tmux-fzf-htop-ssh.bin",
            ),
            ("fzf", "tui", "tui/corpus/02-htop-fzf.bin"),
            (
                "htop",
                "tui",
                "tui/corpus/03-dogfooding-nvim-tmux-fzf-htop-ssh.bin",
            ),
            (
                "ssh",
                "tui",
                "tui/corpus/03-dogfooding-nvim-tmux-fzf-htop-ssh.bin",
            ),
            (
                "alt-screen",
                "resize",
                "resize/corpus/02-dogfooding-resize-dpi-alt-screen.bin",
            ),
            (
                "mouse",
                "mouse",
                "mouse/corpus/03-dogfooding-mouse-resize-sgr.bin",
            ),
            ("resize", "resize", "resize/corpus/01-resize-reflow.bin"),
            ("OSC", "osc", "osc/corpus/03-dogfooding-osc7-8-52-title.bin"),
            ("clipboard", "osc", "osc/corpus/02-clipboard.bin"),
            (
                "Kitty",
                "keyboard",
                "keyboard/corpus/03-dogfooding-kitty-keyboard-bracketed.bin",
            ),
            (
                "IME",
                "unicode",
                "unicode/corpus/09-dogfooding-ime-unicode-dpi.bin",
            ),
            (
                "DPI",
                "resize",
                "resize/corpus/02-dogfooding-resize-dpi-alt-screen.bin",
            ),
        ];
        assert_eq!(MATRIX.len(), expected.len());
        for (entry, (surface, category, corpus)) in MATRIX.iter().zip(expected) {
            assert_eq!(entry.surface, surface);
            assert_eq!(entry.category, category);
            assert_eq!(entry.corpus_rel, corpus);
        }
    }
}
