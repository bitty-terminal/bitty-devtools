#![forbid(unsafe_code)]
//! Typed redaction for previews and traces.

use crate::bounds::{PREVIEW_MAX_BYTES, truncate_to_bytes};

pub fn is_sensitive_field(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [
        "password",
        "secret",
        "token",
        "api_key",
        "api-key",
        "authorization",
        "cookie",
    ]
    .iter()
    .any(|p| lower.contains(p))
}

pub fn redact_value(value: String, field: &str) -> String {
    if is_sensitive_field(field) {
        return "[REDACTED]".to_string();
    }
    // Value-side scan: embedded credential shapes and high-entropy tokens
    // redact regardless of the field name.
    if looks_secret(&value) {
        return "[REDACTED]".to_string();
    }
    value
}

/// Minimum token-candidate length for the entropy gate.
const ENTROPY_MIN_LENGTH: usize = 32;
/// Shannon entropy threshold (bits per char) for the entropy gate.
const ENTROPY_THRESHOLD_BITS: f64 = 4.5;

/// Case-insensitive substring search without allocating a lowered copy.
fn contains_lower(haystack: &str, needle: &str) -> bool {
    if needle.len() > haystack.len() {
        return false;
    }
    haystack
        .as_bytes()
        .windows(needle.len())
        .any(|w| w.eq_ignore_ascii_case(needle.as_bytes()))
}

/// True when `value` contains `needle`, comparing ASCII case-insensitively.
fn contains_phrase(value: &str, needle: &str) -> bool {
    contains_lower(value, needle)
}

/// Scan for `key [=:] secret` assignment phrases (password, secret,
/// api-key, auth/access token) and `bearer <token>` phrases, in any case.
fn contains_secret_phrase(value: &str) -> bool {
    const KEYS: [&str; 6] = [
        "password", "passwd", "secret", "api_key", "api-key", "apikey",
    ];
    let bytes = value.as_bytes();
    for key in KEYS {
        let key = key.as_bytes();
        let mut start = 0;
        while start + key.len() <= bytes.len() {
            let Some(rel) = bytes[start..].iter().position(|b| *b == key[0]) else {
                break;
            };
            let i = start + rel;
            if bytes
                .get(i..i + key.len())
                .is_some_and(|candidate| candidate.eq_ignore_ascii_case(key))
                && is_assignment_after(&bytes[i + key.len()..])
            {
                return true;
            }
            start = i + 1;
        }
    }
    for key in ["auth_token", "auth-token", "access_token", "access-token"] {
        if contains_key_assignment(value, key) {
            return true;
        }
    }
    contains_bearer_token(value)
}

/// Check whether `rest` (text after a matched key) is an assignment: optional
/// `-`/`_` separators, optional whitespace, then `:` or `=`, optional
/// whitespace, then a non-space secret. Returns false when the key is part of
/// a longer word (e.g. "passwords are").
fn is_assignment_after(rest: &[u8]) -> bool {
    let mut bytes = rest.iter().copied().peekable();
    if matches!(bytes.peek(), Some(b'-') | Some(b'_')) {
        bytes.next();
    }
    while matches!(bytes.peek(), Some(b' ') | Some(b'\t')) {
        bytes.next();
    }
    if !matches!(bytes.next(), Some(b':') | Some(b'=')) {
        return false;
    }
    while matches!(bytes.peek(), Some(b' ') | Some(b'\t')) {
        bytes.next();
    }
    matches!(bytes.peek(), Some(b) if !b.is_ascii_whitespace())
}

/// Case-insensitive key search where `_` and `-` match either separator.
fn contains_key_assignment(value: &str, key: &str) -> bool {
    let vb = value.as_bytes();
    let kb = key.as_bytes();
    if kb.len() > vb.len() {
        return false;
    }
    'outer: for i in 0..=vb.len() - kb.len() {
        for (o, k) in vb[i..].iter().zip(kb.iter()) {
            let norm_o = if *o == b'-' {
                b'_'
            } else {
                o.to_ascii_lowercase()
            };
            let norm_k = if *k == b'-' {
                b'_'
            } else {
                k.to_ascii_lowercase()
            };
            if norm_o != norm_k {
                continue 'outer;
            }
        }
        if is_assignment_after(&vb[i + kb.len()..]) {
            return true;
        }
    }
    false
}

/// Match `bearer <token>` (any case) where the token is a non-space run.
fn contains_bearer_token(value: &str) -> bool {
    const KEY: &str = "bearer";
    let vb = value.as_bytes();
    if KEY.len() + 2 > vb.len() {
        return false;
    }
    for i in 0..=vb.len() - KEY.len() {
        if !vb[i..i + KEY.len()].eq_ignore_ascii_case(KEY.as_bytes()) {
            continue;
        }
        let Some(after) = value.get(i + KEY.len()..) else {
            continue;
        };
        let mut chars = after.chars();
        match chars.next() {
            Some(' ') | Some('\t') => {}
            _ => continue,
        }
        if chars.any(|c| !c.is_whitespace()) {
            return true;
        }
    }
    false
}

fn is_bearer_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~' | b'+' | b'/')
}

fn is_token_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'+' | b'/' | b'=' | b'.' | b'~')
}

/// Provider-issued credential shapes recognizable regardless of field name.
fn contains_secret_token(value: &str) -> bool {
    // Prefixed tokens: sk-proj-/sk-live-/sk-test-, sk-ant-, xox[bpas]-, ghX_,
    // github_pat_, gsk_, AIza, AKIA(hex16).
    const PREFIXES: [&str; 12] = [
        "sk-proj-",
        "sk-live-",
        "sk-test-",
        "sk-ant-",
        "xoxb-",
        "xoxp-",
        "xoxa-",
        "xoxs-",
        "github_pat_",
        "gsk_",
        "AIza",
        "AKIA",
    ];
    let bytes = value.as_bytes();
    for prefix in PREFIXES {
        let prefix = prefix.as_bytes();
        let mut start = 0;
        while start + prefix.len() <= bytes.len() {
            let Some(rel) = bytes[start..].iter().position(|b| *b == prefix[0]) else {
                break;
            };
            let i = start + rel;
            if bytes
                .get(i..i + prefix.len())
                .is_some_and(|candidate| candidate.eq_ignore_ascii_case(prefix))
            {
                let tail = &bytes[i + prefix.len()..];
                let run_len = tail.iter().take_while(|b| is_token_char(**b)).count();
                let need = if prefix.eq_ignore_ascii_case(b"AKIA") {
                    16
                } else {
                    8
                };
                if run_len >= need {
                    if prefix.eq_ignore_ascii_case(b"AKIA") {
                        if tail[..16]
                            .iter()
                            .all(|b| b.is_ascii_digit() || b.is_ascii_uppercase())
                        {
                            return true;
                        }
                    } else {
                        return true;
                    }
                }
                start = i + prefix.len();
            } else {
                start = i + 1;
            }
        }
    }
    // ghX_ single-char family (ghp_, gho_, ghu_, ghs_, ghr_).
    let mut start = 0;
    while start + 4 <= bytes.len() {
        let window = &bytes[start..];
        let Some(rel) = window
            .iter()
            .position(|b| *b == b'g')
            .or_else(|| window.iter().position(|b| *b == b'G'))
        else {
            break;
        };
        let i = start + rel;
        if bytes.get(i..i + 4).is_some_and(|candidate| {
            candidate[..2].eq_ignore_ascii_case(b"gh")
                && matches!(
                    candidate[2],
                    b'p' | b'o' | b'u' | b's' | b'r' | b'P' | b'O' | b'U' | b'S' | b'R'
                )
                && candidate[3] == b'_'
        }) {
            let tail = &bytes[i + 4..];
            if tail.iter().take_while(|b| is_token_char(**b)).count() >= 8 {
                return true;
            }
            start = i + 4;
        } else {
            start = i + 1;
        }
    }
    // PEM private-key block marker.
    if contains_lower(value, "-----BEGIN ") && contains_phrase(value, "PRIVATE KEY-----") {
        return true;
    }
    // JWT shape: three separator-free runs joined by dots.
    if is_jwt_shape(value) {
        return true;
    }
    // Bare hex digests (SHA-1/SHA-256 lengths) bounded by non-hex.
    if contains_hex_digest(value) {
        return true;
    }
    false
}

fn is_jwt_part(bytes: &[u8]) -> bool {
    // Each dot-joined part must be at least 8 chars: a real JWT
    // header/payload/signature is far longer, and without the floor version
    // strings like "1.2.3" false-positive.
    bytes.len() >= 8
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

fn is_jwt_shape(value: &str) -> bool {
    for (di1, _) in value.match_indices('.') {
        let head = &value.as_bytes()[..di1];
        let head_start = head
            .iter()
            .rposition(|b| !is_bearer_char(*b))
            .map(|p| p + 1)
            .unwrap_or(0);
        let first = &head[head_start..];
        if !is_jwt_part(first) {
            continue;
        }
        let rest = &value.as_bytes()[di1 + 1..];
        let Some(di2_rel) = rest.iter().position(|b| *b == b'.') else {
            continue;
        };
        let second = &rest[..di2_rel];
        let tail = &rest[di2_rel + 1..];
        let tail_end = tail
            .iter()
            .position(|b| !is_bearer_char(*b))
            .unwrap_or(tail.len());
        let third = &tail[..tail_end];
        if is_jwt_part(second) && is_jwt_part(third) {
            return true;
        }
    }
    false
}

fn is_hex_boundary(b: Option<u8>) -> bool {
    !matches!(b, Some(x) if x.is_ascii_hexdigit())
}

fn contains_hex_digest(value: &str) -> bool {
    const LENGTHS: [usize; 2] = [64, 40];
    let bytes = value.as_bytes();
    for len in LENGTHS {
        if len > bytes.len() {
            continue;
        }
        for i in 0..=bytes.len() - len {
            if !is_hex_boundary(if i == 0 { None } else { Some(bytes[i - 1]) }) {
                continue;
            }
            if !bytes[i..i + len].iter().all(|b| b.is_ascii_hexdigit()) {
                continue;
            }
            if !is_hex_boundary(bytes.get(i + len).copied()) {
                continue;
            }
            return true;
        }
    }
    false
}

/// Shannon entropy in bits per character over the value's alphabet.
fn shannon_entropy(value: &str) -> f64 {
    let total = value.chars().count() as f64;
    if total == 0.0 {
        return 0.0;
    }
    // Count per byte; secrets are ASCII so chars and bytes agree here.
    let mut counts = [0u32; 256];
    for b in value.bytes() {
        counts[b as usize] += 1;
    }
    let mut entropy = 0.0;
    for count in counts.iter().filter(|c| **c > 0) {
        let p = f64::from(*count) / total;
        entropy -= p * p.log2();
    }
    entropy
}

/// High-entropy token gate for values with no recognizable shape: a long
/// separator-free run mixing at least two of lowercase/uppercase/digits, with
/// entropy at or above the threshold. Ordinary prose, slugs, UUIDs,
/// timestamps, single-class runs, and paths stay below it.
fn looks_like_high_entropy_secret(value: &str) -> bool {
    if value.chars().count() < ENTROPY_MIN_LENGTH {
        return false;
    }
    if !value
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'_' | b'=' | b'.' | b'~' | b'-'))
    {
        return false;
    }
    let mut lower = 0;
    let mut upper = 0;
    let mut digits = 0;
    for b in value.bytes() {
        if b.is_ascii_lowercase() {
            lower += 1;
        } else if b.is_ascii_uppercase() {
            upper += 1;
        } else if b.is_ascii_digit() {
            digits += 1;
        }
    }
    if [lower, upper, digits].iter().filter(|n| **n >= 2).count() < 2 {
        return false;
    }
    shannon_entropy(value) >= ENTROPY_THRESHOLD_BITS
}

fn contains_secret(value: &str) -> bool {
    contains_secret_token(value) || contains_secret_phrase(value)
}

/// Value-side secret scan: embedded credential shapes and high-entropy
/// tokens, regardless of field name.
pub fn looks_secret(value: &str) -> bool {
    contains_secret(value) || looks_like_high_entropy_secret(value)
}

pub struct RedactionMarker {
    pub redacted: bool,
    pub truncated: bool,
    pub original_bytes: usize,
}

pub fn redact_preview(text: String, field: &str) -> (String, RedactionMarker) {
    let original_bytes = text.len();
    let mut out = redact_value(text, field);
    let _redacted = out != "[REDACTED]" && is_sensitive_field(field);
    // Actually check if redacted
    let was_redacted = out == "[REDACTED]";
    if out.len() > PREVIEW_MAX_BYTES {
        out = truncate_to_bytes(&out, PREVIEW_MAX_BYTES);
        return (
            out,
            RedactionMarker {
                redacted: was_redacted,
                truncated: true,
                original_bytes,
            },
        );
    }
    (
        out.clone(),
        RedactionMarker {
            redacted: was_redacted,
            truncated: false,
            original_bytes,
        },
    )
}

pub fn preview_equals_export(preview: &str, export: &str) -> bool {
    preview == export
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sensitive_detection() {
        assert!(is_sensitive_field("password"));
        assert!(is_sensitive_field("api_key"));
        assert!(!is_sensitive_field("preview"));
    }

    #[test]
    fn redaction() {
        assert_eq!(
            redact_value("hunter2".to_string(), "password"),
            "[REDACTED]"
        );
        assert_eq!(redact_value("hello".to_string(), "preview"), "hello");
    }

    #[test]
    fn h_dev_01_value_under_innocent_field_redacted() {
        assert_eq!(
            redact_value("my password = hunter2-secret".to_string(), "notes"),
            "[REDACTED]"
        );
        assert_eq!(
            redact_value("Authorization: Bearer abcdef123456".to_string(), "message"),
            "[REDACTED]"
        );
        assert_eq!(
            redact_value("AKIAIOSFODNN7EXAMPLE".to_string(), "notes"),
            "[REDACTED]"
        );
        assert_eq!(
            redact_value(
                "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx".to_string(),
                "notes"
            ),
            "[REDACTED]"
        );
        assert_eq!(
            redact_value(
                "sk-proj-abcdefghijklmnopqrstuvwx1234567890ABCD".to_string(),
                "notes"
            ),
            "[REDACTED]"
        );
    }

    #[test]
    fn h_dev_01_entropy_heuristic_redacts_tokens() {
        assert_eq!(
            redact_value(
                "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ"
                    .to_string(),
                "preview"
            ),
            "[REDACTED]"
        );
        assert_eq!(
            redact_value(
                "K7qZ2mX9pL4vN8wQ3rT6yU1iO5aS0dF8gH2jK4".to_string(),
                "notes"
            ),
            "[REDACTED]"
        );
        assert_eq!(
            redact_value(
                "da39a3ee5e6b4b0d3255bfef95601890afd80709".to_string(),
                "notes"
            ),
            "[REDACTED]"
        );
    }

    #[test]
    fn heuristic_avoids_false_positives() {
        assert_eq!(
            redact_value(
                "the quick brown fox jumps over the lazy dog".to_string(),
                "notes"
            ),
            "the quick brown fox jumps over the lazy dog"
        );
        assert_eq!(redact_value("a".repeat(48), "notes"), "a".repeat(48));
        assert_eq!(
            redact_value("123e4567-e89b-12d3-a456-426614174000".to_string(), "notes"),
            "123e4567-e89b-12d3-a456-426614174000"
        );
        assert_eq!(
            redact_value("the password is required to log in".to_string(), "notes"),
            "the password is required to log in"
        );
        assert_eq!(
            redact_value(
                "thequickbrownfoxjumpsoverthelazydogagainx".to_string(),
                "notes"
            ),
            "thequickbrownfoxjumpsoverthelazydogagainx"
        );
        assert_eq!(
            redact_value(
                "src/components/VeryLongComponentName/index.ts".to_string(),
                "notes"
            ),
            "src/components/VeryLongComponentName/index.ts"
        );
        // Dotted triples are version strings, not JWTs (review blocker).
        for plain in ["1.2.3", "v1.2.3", "a.b.c", "10.0.1"] {
            assert_eq!(redact_value(plain.to_string(), "notes"), plain);
        }
    }

    #[test]
    fn multilingual_prose_is_preserved() {
        let words = [
            "hello",
            "café",
            "grüße",
            "世界",
            "こんにちは",
            "안녕하세요",
            "مرحبا",
            "नमस्ते",
            "γειά",
            "привет",
            "e\u{301}",
            "𝄞",
            "garden",
            "summer",
            "paper",
        ];
        let separators = [" ", "\t", "\n", "、", " — ", "\u{2003}"];
        for seed in 0..256 {
            let mut text = String::new();
            for index in 0..=seed % 16 {
                text.push_str(words[(seed + index * 7) % words.len()]);
                text.push_str(separators[(seed + index) % separators.len()]);
            }
            assert!(!contains_secret_phrase(&text));
            assert!(!contains_secret_token(&text));
            assert!(!contains_bearer_token(&text));
            assert!(!contains_key_assignment(&text, "access_token"));
            assert!(!is_jwt_shape(&text));
            assert!(!contains_hex_digest(&text));
            assert!(!looks_like_high_entropy_secret(&text));
            assert!(!looks_secret(&text));
            assert_eq!(redact_value(text.clone(), "notes"), text);
            let (preview, marker) = redact_preview(text.clone(), "notes");
            assert_eq!(preview, text);
            assert!(!marker.redacted);
            assert!(!marker.truncated);
            assert_eq!(marker.original_bytes, text.len());
            assert_eq!(redact_value(text, "password"), "[REDACTED]");
        }
    }

    #[test]
    fn multilingual_context_preserves_recognition() {
        let contexts = ["café", "世界", "مرحبا", "नमस्ते", "e\u{301}", "𝄞"];
        let samples = [
            ("password = example", true),
            ("passwd: example", true),
            ("secret_: example", true),
            ("api_key = example", true),
            ("api-key = example", true),
            ("apikey = example", true),
            ("AUTH-TOKEN = example", true),
            ("access_token: example", true),
            ("Bearer example", true),
            ("bearer", false),
            ("passwords are required", false),
            ("release 1.2.3", false),
            ("sk-test-xxxxxxxx", true),
            ("sk-test-xxxxxxx", false),
            ("ghp_xxxxxxxx", true),
            ("ghp_xxxxxxx", false),
            ("AKIAIOSFODNN7EXAMPLE", true),
            ("xxxxxxxx.yyyyyyyy.zzzzzzzz", true),
            ("da39a3ee5e6b4b0d3255bfef95601890afd80709", true),
            ("-----BEGIN PRIVATE KEY-----", true),
        ];
        for before in contexts {
            for after in contexts {
                for (sample, expected) in samples {
                    let text = format!("{before}【{sample}】{after}");
                    assert_eq!(looks_secret(&text), expected);
                    let (preview, marker) = redact_preview(text.clone(), "notes");
                    assert_eq!(preview, if expected { "[REDACTED]" } else { &text });
                    assert_eq!(marker.redacted, expected);
                    assert!(!marker.truncated);
                    assert_eq!(marker.original_bytes, text.len());
                }
            }
        }
    }

    #[test]
    fn multilingual_preview_matches_character_budget_model() {
        for unit in ["a", "é", "界", "𝄞", "e\u{301}", "مرحبا 世界 "] {
            for extra in 0..=4 {
                let text = unit.repeat(PREVIEW_MAX_BYTES / unit.len() + extra);
                let mut budget = PREVIEW_MAX_BYTES;
                let expected: String = text
                    .chars()
                    .take_while(|ch| {
                        if ch.len_utf8() > budget {
                            false
                        } else {
                            budget -= ch.len_utf8();
                            true
                        }
                    })
                    .collect();
                let (preview, marker) = redact_preview(text.clone(), "notes");
                assert_eq!(preview, expected);
                assert!(!marker.redacted);
                assert_eq!(marker.truncated, text.len() > PREVIEW_MAX_BYTES);
                assert_eq!(marker.original_bytes, text.len());
                assert!(preview.len() <= PREVIEW_MAX_BYTES);
            }
        }
    }

    #[test]
    fn preview_truncation() {
        let long = "a".repeat(9000);
        let (t, m) = redact_preview(long, "preview");
        assert!(t.len() <= PREVIEW_MAX_BYTES);
        assert!(m.truncated);
    }
}
