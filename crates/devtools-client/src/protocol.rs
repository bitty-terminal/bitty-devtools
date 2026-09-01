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
    let bytes = text.as_bytes();
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    let mut offset = 0usize;
    while offset < bytes.len() {
        let end = (offset + chunk_bytes).min(bytes.len());
        // Ensure char boundary
        let mut e = end;
        while e > offset && !text.is_char_boundary(e) {
            e -= 1;
        }
        if e == offset {
            break;
        }
        out.push(text[offset..e].to_owned());
        offset = e;
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
    ];
    let trace = [
        "bitty.debug/streamEvents",
        "bitty.debug/startTrace",
        "bitty.debug/stopTrace",
        "bitty.debug/fetchTraceChunk",
    ];
    let control = [
        "bitty.debug/suspendHandler",
        "bitty.debug/resumePlugin",
        "bitty.debug/disposeGeneration",
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
