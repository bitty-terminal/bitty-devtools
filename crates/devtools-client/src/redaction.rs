#![forbid(unsafe_code)]
//! Typed redaction for previews and traces.

use std::borrow::Cow;

use crate::bounds::{PREVIEW_MAX_BYTES, truncate_to_bytes};

/// NORM-1 normalization class (normative; the single definition shared with
/// `src/redaction.ts`).
///
/// The class is every code point above U+007F that Unicode classifies as
/// `Default_Ignorable_Code_Point`, as general category `Cf`
/// (Other_Format), or as `White_Space`. Membership is decided by Unicode
/// character properties only; this table is generated from that definition,
/// never hand-curated, and both language test suites execute
/// `tests/fixtures/redaction-normalization-class.txt` to pin the exact set.
///
/// Rationale: every member renders as nothing at all (a format control or a
/// default-ignorable code point) or as blank (a non-ASCII space separator), so
/// a hostile producer can inject any of them to break a literal credential
/// pattern match without changing what the operator sees on screen. They are
/// therefore removed before secret matching. Membership is 4225 code points in
/// 29 ranges for Unicode 17.0.
///
/// C0, DEL, and C1 controls are deliberately not in the class: they are
/// escaped for rendering, not silently deleted, so an escape is never
/// swallowed. U+0085 is the one code point in both sets (Cc and White_Space);
/// `normalize_for_matching` removes it for matching and the renderer escapes
/// it, matching `sanitizeTerminalOutput` in `src/redaction.ts`.
const NORM_1_RANGES: &[(char, char)] = &[
    ('\u{85}', '\u{85}'),       // U+85
    ('\u{a0}', '\u{a0}'),       // U+A0
    ('\u{ad}', '\u{ad}'),       // U+AD
    ('\u{34f}', '\u{34f}'),     // U+34F
    ('\u{600}', '\u{605}'),     // U+600-U+605
    ('\u{61c}', '\u{61c}'),     // U+61C
    ('\u{6dd}', '\u{6dd}'),     // U+6DD
    ('\u{70f}', '\u{70f}'),     // U+70F
    ('\u{890}', '\u{891}'),     // U+890-U+891
    ('\u{8e2}', '\u{8e2}'),     // U+8E2
    ('\u{115f}', '\u{1160}'),   // U+115F-U+1160
    ('\u{1680}', '\u{1680}'),   // U+1680
    ('\u{17b4}', '\u{17b5}'),   // U+17B4-U+17B5
    ('\u{180b}', '\u{180f}'),   // U+180B-U+180F
    ('\u{2000}', '\u{200f}'),   // U+2000-U+200F
    ('\u{2028}', '\u{202f}'),   // U+2028-U+202F
    ('\u{205f}', '\u{206f}'),   // U+205F-U+206F
    ('\u{3000}', '\u{3000}'),   // U+3000
    ('\u{3164}', '\u{3164}'),   // U+3164
    ('\u{fe00}', '\u{fe0f}'),   // U+FE00-U+FE0F
    ('\u{feff}', '\u{feff}'),   // U+FEFF
    ('\u{ffa0}', '\u{ffa0}'),   // U+FFA0
    ('\u{fff0}', '\u{fffb}'),   // U+FFF0-U+FFFB
    ('\u{110bd}', '\u{110bd}'), // U+110BD
    ('\u{110cd}', '\u{110cd}'), // U+110CD
    ('\u{13430}', '\u{1343f}'), // U+13430-U+1343F
    ('\u{1bca0}', '\u{1bca3}'), // U+1BCA0-U+1BCA3
    ('\u{1d173}', '\u{1d17a}'), // U+1D173-U+1D17A
    ('\u{e0000}', '\u{e0fff}'), // U+E0000-U+E0FFF
];

fn is_unicode_format_separator(character: char) -> bool {
    NORM_1_RANGES
        .iter()
        .any(|(low, high)| character >= *low && character <= *high)
}

fn normalize_for_matching(value: &str) -> Cow<'_, str> {
    if !value
        .chars()
        .any(|character| character.is_control() || is_unicode_format_separator(character))
    {
        return Cow::Borrowed(value);
    }
    Cow::Owned(
        value
            .chars()
            .filter(|character| !character.is_control() && !is_unicode_format_separator(*character))
            .collect(),
    )
}

pub fn is_sensitive_field(name: &str) -> bool {
    let normalized = normalize_for_matching(name);
    let lower = normalized.to_ascii_lowercase();
    [
        "password",
        "secret",
        "token",
        "api_key",
        "api-key",
        "apikey",
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

/// Case-insensitive prefilter for `key[0]`: the scan must reach every ASCII
/// spelling of the first byte, otherwise the `eq_ignore_ascii_case` verification
/// below is unreachable for a capitalized, upper-case, or mixed-case key.
fn starts_key_candidate(bytes: &[u8], key_first: u8) -> Option<usize> {
    let lowered = key_first.to_ascii_lowercase();
    bytes
        .iter()
        .position(|byte| byte.to_ascii_lowercase() == lowered)
}

/// Scan for `key [=:] secret` assignment phrases and bearer token phrases.
fn contains_secret_phrase(value: &str) -> bool {
    const KEYS: [&str; 12] = [
        "password",
        "passwd",
        "secret",
        "api_key",
        "api-key",
        "apikey",
        "authorization",
        "auth",
        "token",
        "access_token",
        "cookie",
        "credential",
    ];
    let bytes = value.as_bytes();
    for key in KEYS {
        let key = key.as_bytes();
        let mut start = 0;
        while start + key.len() <= bytes.len() {
            let Some(rel) = starts_key_candidate(&bytes[start..], key[0]) else {
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
    contains_bearer_token(value) || contains_credential_name(value)
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

/// Match `bearer <token>` and normalized joined `bearer<token>` forms.
fn contains_bearer_token(value: &str) -> bool {
    const KEY: &str = "bearer";
    const MIN_JOINED_TOKEN: usize = 8;
    let vb = value.as_bytes();
    if KEY.len() >= vb.len() {
        return false;
    }
    for i in 0..=vb.len() - KEY.len() {
        if !vb[i..i + KEY.len()].eq_ignore_ascii_case(KEY.as_bytes()) {
            continue;
        }
        let Some(after) = value.get(i + KEY.len()..) else {
            continue;
        };
        let after_bytes = after.as_bytes();
        if matches!(after_bytes.first(), Some(b' ' | b'\t')) {
            if after_bytes
                .iter()
                .skip_while(|byte| matches!(**byte, b' ' | b'\t'))
                .any(|byte| !byte.is_ascii_whitespace())
            {
                return true;
            }
            continue;
        }
        if after_bytes
            .iter()
            .take_while(|byte| is_joined_bearer_char(**byte))
            .count()
            >= MIN_JOINED_TOKEN
        {
            return true;
        }
    }
    false
}

fn is_bearer_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~' | b'+' | b'/')
}

/// Token characters for the joined `bearer<token>` scan. This is the
/// `assignmentOrBearerPattern` character class in `src/redaction.ts`, which
/// also admits `=`; `=` is a base64 pad character, so a joined token shorter
/// than eight characters before its padding is still a token. Kept separate
/// from [`is_bearer_char`] because `is_bearer_char` also delimits JWT parts,
/// where admitting `=` would swallow the padding into a part and lose the
/// shape.
fn is_joined_bearer_char(b: u8) -> bool {
    is_bearer_char(b) || b == b'='
}

fn is_name_separator(b: u8) -> bool {
    matches!(b, b'-' | b'_')
}

fn is_name_run_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || is_name_separator(b)
}

/// True when `bytes[from..]` is optional space/tab then `:` or `=`. This is
/// the `(?!\s*[:=])` lookahead of the credential-name rule, and it is
/// deliberately weaker than [`is_assignment_after`]: the name rule only has to
/// know that a value delimiter follows, not that a value is present.
fn followed_by_assignment_delimiter(bytes: &[u8], from: usize) -> bool {
    let mut index = from;
    while matches!(bytes.get(index), Some(b' ' | b'\t')) {
        index += 1;
    }
    matches!(bytes.get(index), Some(b':' | b'='))
}

/// A bare credential-bearing configuration name (`GITHUB_TOKEN`, `API_KEY`,
/// `MY_SECRET_VALUE`) is itself sensitive even with no value beside it.
///
/// Mirrors `credentialNamePattern` in `src/redaction.ts`, and is deliberately
/// case-SENSITIVE on the credential name: only the SCREAMING_SNAKE spelling is
/// a finding, so "the password is required to log in" and "Tokens expire after
/// one hour" stay intact. The case-insensitive rule that *is* wanted lives in
/// [`contains_secret_phrase`], which requires an assignment delimiter.
///
/// The match is a segment-aligned credential name inside a maximal
/// `[A-Za-z0-9_-]` run, with the name ending a segment (or the run). The
/// negative lookahead is only consulted when the name ends the run, because any
/// earlier window end sits inside the run and is therefore followed by an
/// alphanumeric or a separator, which never satisfies `\s*[:=]`. A run whose
/// internal separator structure is irregular still reports here and not in
/// TypeScript, so this rule is a superset and never weaker.
fn contains_credential_name(value: &str) -> bool {
    const NAMES: [&[u8]; 5] = [b"SECRET", b"TOKEN", b"PASSWORD", b"CREDENTIAL", b"API_KEY"];
    let bytes = value.as_bytes();
    let mut run_start = 0;
    while run_start < bytes.len() {
        if !is_name_run_char(bytes[run_start]) {
            run_start += 1;
            continue;
        }
        let mut run_end = run_start;
        while run_end < bytes.len() && is_name_run_char(bytes[run_end]) {
            run_end += 1;
        }
        let run = &bytes[run_start..run_end];
        'names: for name in NAMES {
            if run.len() < name.len() {
                continue;
            }
            for at in 0..=run.len() - name.len() {
                if run[at..at + name.len()] != *name {
                    continue;
                }
                if at != 0 && !is_name_separator(run[at - 1]) {
                    continue;
                }
                let after = at + name.len();
                if after < run.len() {
                    if is_name_separator(run[after]) {
                        return true;
                    }
                    continue;
                }
                if !followed_by_assignment_delimiter(bytes, run_end) {
                    return true;
                }
                continue 'names;
            }
        }
        run_start = run_end;
    }
    false
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
            let Some(rel) = starts_key_candidate(&bytes[start..], prefix[0]) else {
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
    let normalized = normalize_for_matching(value);
    contains_secret(&normalized) || looks_like_high_entropy_secret(&normalized)
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

    const REDACTION_SEPARATOR_CORPUS: &str =
        include_str!("../../../tests/fixtures/redaction-separator-corpus.txt");
    const REDACTION_NORMALIZATION_CLASS: &str =
        include_str!("../../../tests/fixtures/redaction-normalization-class.txt");

    /// Every code point the NORM-1 class must contain, and the near-miss
    /// code points it must not contain. The fixture is shared with the
    /// TypeScript suite, so class membership cannot drift between languages
    /// without failing a gate on both sides.
    #[test]
    fn norm_1_normalization_class_matches_shared_pin() {
        let mut members = 0usize;
        let mut non_members = 0usize;
        for line in REDACTION_NORMALIZATION_CLASS.lines() {
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let mut columns = line.split('\t');
            let kind = columns.next().expect("class row kind");
            let code_point = columns.next().expect("class row code point");
            assert!(columns.next().is_none(), "unexpected class row column");
            let parsed = u32::from_str_radix(code_point, 16).expect("valid hex");
            let character = char::from_u32(parsed)
                .unwrap_or_else(|| panic!("class row {code_point} is not a scalar value"));
            let actual = is_unicode_format_separator(character);
            match kind {
                "member" => {
                    assert!(actual, "class row U+{code_point} must be normalized");
                    members += 1;
                }
                "nonmember" => {
                    assert!(!actual, "class row U+{code_point} must be preserved");
                    non_members += 1;
                }
                other => panic!("unknown class row kind {other}"),
            }
        }
        assert_eq!(members, 4225, "NORM-1 membership pin is complete");
        assert!(non_members >= 256, "NORM-1 boundary pin is present");
    }

    /// The class is a superset of every spelling either language used before,
    /// and the table and the pin agree on every code point in the fixture.
    #[test]
    fn norm_1_table_covers_all_class_members() {
        let mut counted = 0usize;
        for line in REDACTION_NORMALIZATION_CLASS.lines() {
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let mut columns = line.split('\t');
            if columns.next() != Some("member") {
                continue;
            }
            let code_point = columns.next().expect("class row code point");
            let parsed = u32::from_str_radix(code_point, 16).expect("valid hex");
            let Some(character) = char::from_u32(parsed) else {
                continue;
            };
            assert!(
                NORM_1_RANGES
                    .iter()
                    .any(|(low, high)| character >= *low && character <= *high),
                "U+{code_point} is pinned as a member but no table range covers it"
            );
            counted += 1;
        }
        assert_eq!(counted, 4225);
        assert_eq!(NORM_1_RANGES.len(), 29, "NORM-1 is 29 ranges");
    }

    fn decode_hex_corpus_value(hex: &str) -> Vec<u8> {
        assert_eq!(hex.len() % 2, 0, "invalid hex corpus value");
        hex.as_bytes()
            .chunks_exact(2)
            .map(|pair| {
                let text = std::str::from_utf8(pair).expect("corpus hex is ASCII");
                u8::from_str_radix(text, 16).expect("corpus hex is valid")
            })
            .collect()
    }

    #[test]
    fn px_0514_shared_differential_corpus() {
        let mut cases = 0;
        for line in REDACTION_SEPARATOR_CORPUS.lines() {
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let mut columns = line.split('\t');
            let id = columns.next().expect("corpus id");
            let hex = columns.next().expect("corpus hex");
            let expected = columns.next().expect("corpus expectation");
            assert!(columns.next().is_none(), "unexpected corpus column");
            let input = String::from_utf8(decode_hex_corpus_value(hex))
                .expect("corpus value is valid UTF-8");
            let actual = redact_value(input.clone(), "notes");
            let wanted = if expected == "true" {
                "[REDACTED]".to_string()
            } else {
                input
            };
            assert_eq!(actual, wanted, "corpus case {id}");
            cases += 1;
        }
        // Exact count, not a floor: a silently dropped fixture row must fail
        // here as loudly as a wrong expectation. The TypeScript suite asserts
        // the same total, so a fixture that only one language reads fails both.
        assert_eq!(cases, 2298, "shared corpus must be fully executed");
    }

    /// P1 regression: the candidate key-position prefilter must be ASCII
    /// case-insensitive, otherwise the `eq_ignore_ascii_case` verification is
    /// unreachable for any key whose first byte is not already lowercase.
    #[test]
    fn p1_key_position_prefilter_is_case_insensitive() {
        const MARKER: &str = "SYNTHETIC_OPAQUE_123456";
        const KEYS: [&str; 17] = [
            "password",
            "passwd",
            "secret",
            "api_key",
            "api-key",
            "apikey",
            "authorization",
            "proxy-authorization",
            "proxy_authorization",
            "auth",
            "token",
            "access_token",
            "access-token",
            "auth_token",
            "auth-token",
            "cookie",
            "credential",
        ];
        let spellings = |key: &str| -> Vec<String> {
            let mut forms = vec![key.to_string(), key.to_uppercase()];
            let mut mixed = String::new();
            for (index, character) in key.chars().enumerate() {
                if index % 2 == 0 {
                    mixed.extend(character.to_uppercase());
                } else {
                    mixed.push(character);
                }
            }
            forms.push(mixed);
            let mut title = String::new();
            let mut capitalize = true;
            for character in key.chars() {
                if character == '_' || character == '-' {
                    title.push(character);
                    capitalize = true;
                    continue;
                }
                if capitalize {
                    title.extend(character.to_uppercase());
                    capitalize = false;
                } else {
                    title.push(character);
                }
            }
            forms.push(title);
            forms
        };
        for key in KEYS {
            for spelling in spellings(key) {
                for separator in [": ", "= ", ":", "=", " : ", " = ", "\t= "] {
                    let input = format!("{spelling}{separator}{MARKER}");
                    assert_eq!(
                        redact_value(input.clone(), "notes"),
                        "[REDACTED]",
                        "assignment phrase must redact: {input:?}"
                    );
                }
            }
        }
    }

    /// The provider-token prefilter has the same defect class and the same
    /// fix: a lower-case spelling of a mixed-case prefix must still be found.
    #[test]
    fn p1_token_prefix_prefilter_is_case_insensitive() {
        for (spelling, marker) in [
            ("AIza", "aizasyndheticopaque123456"),
            ("aiza", "aizasyndheticopaque123456"),
            ("AKIA", "akiaIOSFODNN7EXAMPLE"),
            ("akia", "akiaIOSFODNN7EXAMPLE"),
        ] {
            let input = format!("{spelling}{marker}");
            assert_eq!(
                redact_value(input.clone(), "notes"),
                "[REDACTED]",
                "provider token must redact: {input:?}"
            );
        }
    }

    /// Sentence-style prose that merely mentions a key name must survive.
    #[test]
    fn p1_case_insensitive_prefilter_does_not_widen_prose() {
        for text in [
            "Passwords are required to log in",
            "The Authorization header is optional",
            "Tokens expire after one hour",
            "release 1.2.3",
            "thequickbrownfoxjumpsoverthelazydogagainx",
            "src/components/VeryLongComponentName/index.ts",
        ] {
            assert_eq!(redact_value(text.to_string(), "notes"), text);
        }
    }

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
