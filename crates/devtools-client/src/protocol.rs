#![forbid(unsafe_code)]
//! Versioned debug protocol consumption (no ownership).
//! Reuses devtools-rfc v1 `1.0` JSONL framing, 1 MiB inbound, 256 KiB chunk.

use crate::bounds::{CHUNK_BYTES, MAX_FRAME_BYTES};

pub const PROTOCOL_VERSION: &str = "1.0";
pub const SUPPORTED_VERSIONS: &[&str] = &[PROTOCOL_VERSION];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DebugScope {
    Inspect,
    Trace,
    Control,
}

impl DebugScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Inspect => "debug.inspect",
            Self::Trace => "debug.trace",
            Self::Control => "debug.control",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "debug.inspect" => Some(Self::Inspect),
            "debug.trace" => Some(Self::Trace),
            "debug.control" => Some(Self::Control),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ErrorCategory {
    Usage,
    Capability,
    Scope,
    Budget,
    Generation,
    Transport,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtocolError {
    pub category: ErrorCategory,
    pub code: String,
    pub message: String,
}

pub fn is_supported_version(v: &str) -> bool {
    SUPPORTED_VERSIONS.contains(&v)
}

pub fn negotiate_version(client: &str) -> Result<String, ProtocolError> {
    if is_supported_version(client) {
        Ok(PROTOCOL_VERSION.to_owned())
    } else {
        Err(ProtocolError {
            category: ErrorCategory::Usage,
            code: "UnsupportedVersion".to_string(),
            message: format!("unsupported version {client} expected {PROTOCOL_VERSION}"),
        })
    }
}

pub fn validate_frame_bytes(raw: &str) -> Result<(), String> {
    if raw.trim().is_empty() {
        return Err("frame must not be empty".to_string());
    }
    if raw.len() > MAX_FRAME_BYTES {
        return Err(format!("frame {} > {}", raw.len(), MAX_FRAME_BYTES));
    }
    Ok(())
}

pub fn chunk_text(text: &str, chunk_bytes: usize) -> Result<Vec<String>, String> {
    if chunk_bytes == 0 || chunk_bytes > CHUNK_BYTES {
        return Err(format!("chunkBytes must be in (0, {CHUNK_BYTES}]"));
    }
    if text.is_empty() {
        return Ok(Vec::new());
    }
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut offset = 0usize;
    while offset < bytes.len() {
        let mut end = (offset + chunk_bytes).min(bytes.len());
        while end > offset && !text.is_char_boundary(end) {
            end -= 1;
        }
        if end == offset {
            return Err("chunkBytes cannot fit the next Unicode scalar".to_string());
        }
        out.push(text[offset..end].to_owned());
        offset = end;
    }
    Ok(out)
}

pub fn is_valid_method_for_scope(method: &str, scope: DebugScope) -> bool {
    let inspect = [
        "bitty.debug/listPlugins",
        "bitty.debug/getPlugin",
        "bitty.debug/listSubscriptions",
        "bitty.debug/getBudgets",
        "bitty.debug/getQueueSnapshot",
        "bitty.debug/getSnapshot",
        "bitty.debug/listHandles",
        // CTX-0159 live read-only introspection (server-registered, inspect scope).
        "bitty.debug/getGridText",
        "bitty.debug/getInputRing",
        "bitty.debug/getModifiers",
        "bitty.debug/getFocus",
    ];
    let trace = [
        "bitty.debug/streamEvents",
        "bitty.debug/startTrace",
        "bitty.debug/stopTrace",
        "bitty.debug/fetchTraceChunk",
        // CTX-0038 automation frame reads (trace scope + terminal.inspect).
        "bitty.debug/captureFrame",
        "bitty.debug/frameHash",
    ];
    let control = [
        "bitty.debug/suspendHandler",
        "bitty.debug/resumePlugin",
        "bitty.debug/disposeGeneration",
        // CTX-0038 automation input synthesis (control scope + terminal.input).
        "bitty.debug/synthesizeInput",
    ];
    if inspect.contains(&method) {
        return true;
    }
    if trace.contains(&method) {
        return scope == DebugScope::Trace || scope == DebugScope::Control;
    }
    if control.contains(&method) {
        return scope == DebugScope::Control;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_negotiation() {
        assert_eq!(negotiate_version("1.0").unwrap(), "1.0");
        assert!(negotiate_version("2.0").is_err());
    }

    #[test]
    fn scope_matrix() {
        assert!(is_valid_method_for_scope(
            "bitty.debug/listPlugins",
            DebugScope::Inspect
        ));
        assert!(!is_valid_method_for_scope(
            "bitty.debug/startTrace",
            DebugScope::Inspect
        ));
        assert!(is_valid_method_for_scope(
            "bitty.debug/startTrace",
            DebugScope::Trace
        ));
        assert!(!is_valid_method_for_scope(
            "bitty.debug/suspendHandler",
            DebugScope::Trace
        ));
        assert!(is_valid_method_for_scope(
            "bitty.debug/suspendHandler",
            DebugScope::Control
        ));
    }

    #[test]
    fn scope_matrix_includes_automation() {
        // CTX-0038: automation drivers were omitted from the scope matrix.
        // synthesizeInput is control-only; captureFrame and frameHash are
        // trace-level reads held also by control.
        assert!(!is_valid_method_for_scope(
            "bitty.debug/synthesizeInput",
            DebugScope::Inspect
        ));
        assert!(!is_valid_method_for_scope(
            "bitty.debug/synthesizeInput",
            DebugScope::Trace
        ));
        assert!(is_valid_method_for_scope(
            "bitty.debug/synthesizeInput",
            DebugScope::Control
        ));
        for method in ["bitty.debug/captureFrame", "bitty.debug/frameHash"] {
            assert!(!is_valid_method_for_scope(method, DebugScope::Inspect));
            assert!(is_valid_method_for_scope(method, DebugScope::Trace));
            assert!(is_valid_method_for_scope(method, DebugScope::Control));
        }
    }

    #[test]
    fn scope_matrix_includes_ctx0159() {
        // CTX-0159 live read-only introspection (server-registered, inspect
        // scope). Mirrors TS `isValidMethodForScope`: the inspect set is the
        // base for every scope, so these read-only methods hold for all
        // scopes exactly like the other inspect methods above.
        for method in [
            "bitty.debug/getGridText",
            "bitty.debug/getInputRing",
            "bitty.debug/getModifiers",
            "bitty.debug/getFocus",
        ] {
            assert!(is_valid_method_for_scope(method, DebugScope::Inspect));
            assert!(is_valid_method_for_scope(method, DebugScope::Trace));
            assert!(is_valid_method_for_scope(method, DebugScope::Control));
        }
    }

    #[test]
    fn chunk_preserves_multilingual_text_within_byte_limits() {
        for text in [
            "",
            "Hello world",
            "café Ελληνικά",
            "日本語 हिन्दी العربية",
            "e\u{0301} and \u{1d11e} music",
            "\u{feff}Hello\u{feff}世界",
        ] {
            let minimum = text.chars().map(char::len_utf8).max().unwrap_or(1);
            for limit in minimum..=16 {
                let chunks = chunk_text(text, limit).unwrap();
                assert_eq!(chunks.concat(), text);
                for chunk in &chunks {
                    assert!(!chunk.is_empty());
                    assert!(chunk.len() <= limit);
                }
            }
        }
    }

    #[test]
    fn chunk_packs_whole_scalars_at_exact_byte_boundaries() {
        assert_eq!(
            chunk_text("abé日本\u{1d11e}z", 4).unwrap(),
            ["abé", "日", "本", "\u{1d11e}", "z"]
        );
    }

    #[test]
    fn chunk_rejects_limits_that_cannot_fit_the_next_scalar() {
        for scalar in ["é", "日", "\u{1d11e}"] {
            for limit in 1..scalar.len() {
                for prefix in ["", "hello "] {
                    assert_eq!(
                        chunk_text(&format!("{prefix}{scalar} fin"), limit),
                        Err("chunkBytes cannot fit the next Unicode scalar".to_string())
                    );
                }
            }
        }
    }

    #[test]
    fn chunk_requires_a_byte_limit_in_range() {
        for limit in [0, CHUNK_BYTES + 1, usize::MAX] {
            for text in ["", "hello"] {
                assert_eq!(
                    chunk_text(text, limit),
                    Err(format!("chunkBytes must be in (0, {CHUNK_BYTES}]"))
                );
            }
        }
    }

    #[test]
    fn chunk_bounded() {
        let s = "a".repeat(600 * 1024);
        let chunks = chunk_text(&s, CHUNK_BYTES).unwrap();
        assert_eq!(chunks.len(), 3);
        for c in &chunks {
            assert!(c.len() <= CHUNK_BYTES);
        }
        assert_eq!(chunks.concat(), s);
    }
}
