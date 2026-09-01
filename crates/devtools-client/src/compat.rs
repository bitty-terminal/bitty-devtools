#![forbid(unsafe_code)]
//! Compat matrix 14×4 reuse (headless, bounded, deterministic).

use crate::bounds::{MAX_ACTIONS, MAX_CORPUS_BYTES};
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

pub fn generate_matrix_json() -> Result<String, String> {
    check_matrix_invariants()?;
    let mut out = String::new();
    out.push_str("{\n  \"version\": 1,\n  \"matrix_len\": 14,\n  \"entries\": [\n");
    for (idx, e) in MATRIX.iter().enumerate() {
        let pseudo = e.surface.repeat(8);
        let len = pseudo.len().min(MAX_CORPUS_BYTES);
        let actions = len.min(MAX_ACTIONS);
        // deterministic hash: FNV
        let mut h: u64 = 0xcbf29ce484222325;
        for b in pseudo.as_bytes().iter().take(len) {
            h ^= *b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
        out.push_str(&format!(
            "    {{\"surface\":\"{}\",\"hash\":\"{:016x}\",\"bytes\":{},\"actions\":{}}}",
            e.surface, h, len, actions
        ));
        if idx + 1 < MATRIX.len() {
            out.push_str(",\n");
        } else {
            out.push('\n');
        }
    }
    out.push_str("  ]\n}\n");
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
    fn json_bounded_deterministic() {
        let j = generate_matrix_json().unwrap();
        assert!(j.len() < 16 * 1024);
        let j2 = generate_matrix_json().unwrap();
        assert_eq!(j, j2);
        assert!(j.contains("\"surface\":\"shell\""));
        assert!(j.contains("\"surface\":\"DPI\""));
    }
}
