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
    value
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
    fn preview_truncation() {
        let long = "a".repeat(9000);
        let (t, m) = redact_preview(long, "preview");
        assert!(t.len() <= PREVIEW_MAX_BYTES);
        assert!(m.truncated);
    }
}
