#![forbid(unsafe_code)]
//! Tracing surface (debug.trace, opt-in, bounded, DropOldest).

use crate::bounds::{
    BUS_BATCH_MAX_BYTES, BUS_BATCH_MAX_EVENTS, BUS_EVENT_MAX_BYTES, MAX_TRACE_BYTES,
    MAX_TRACE_DURATION_MS,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TracingError {
    ScopeDenied,
    Invalid(String),
    TooMany,
    NotFound,
    Cancelled,
}

impl std::fmt::Display for TracingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ScopeDenied => write!(f, "debug.trace required"),
            Self::Invalid(m) => write!(f, "invalid: {m}"),
            Self::TooMany => write!(f, "too many traces"),
            Self::NotFound => write!(f, "trace not found"),
            Self::Cancelled => write!(f, "cancelled"),
        }
    }
}
impl std::error::Error for TracingError {}

#[derive(Debug, Clone)]
pub struct TraceOptions {
    pub duration_ms: u64,
    pub max_bytes: usize,
    pub include_input: bool,
}

impl Default for TraceOptions {
    fn default() -> Self {
        Self {
            duration_ms: 10_000,
            max_bytes: 512 * 1024,
            include_input: false,
        }
    }
}

impl TraceOptions {
    pub fn validate(&self) -> Result<(), TracingError> {
        if self.duration_ms == 0 || self.duration_ms > MAX_TRACE_DURATION_MS {
            return Err(TracingError::Invalid(format!(
                "durationMs 1..{}",
                MAX_TRACE_DURATION_MS
            )));
        }
        if self.max_bytes == 0 || self.max_bytes > MAX_TRACE_BYTES {
            return Err(TracingError::Invalid(format!(
                "maxBytes 1..{}",
                MAX_TRACE_BYTES
            )));
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct ObservabilityBatch {
    pub sequence: u64,
    pub drop_count: u64,
    pub records: Vec<(String, String)>,
    pub wall_clock_ms: u64,
}

pub fn stream_events(
    types: &[String],
    max_events: usize,
    max_bytes: usize,
    scope_ok: bool,
    cancelled: bool,
) -> Result<ObservabilityBatch, TracingError> {
    if !scope_ok {
        return Err(TracingError::ScopeDenied);
    }
    if cancelled {
        return Err(TracingError::Cancelled);
    }
    if max_events == 0 || max_events > BUS_BATCH_MAX_EVENTS {
        return Err(TracingError::Invalid("maxEvents 1..32".to_string()));
    }
    if max_bytes == 0 || max_bytes > BUS_BATCH_MAX_BYTES {
        return Err(TracingError::Invalid("maxBytes 1..8192".to_string()));
    }
    for t in types {
        if t.len() > 64 {
            return Err(TracingError::Invalid("eventType 1..64".to_string()));
        }
        if t.is_empty() {
            return Err(TracingError::Invalid("event type empty".to_string()));
        }
    }
    let records = types
        .iter()
        .take(max_events)
        .map(|t| (t.clone(), "{\"count\":1}".to_string()))
        .collect::<Vec<_>>();
    let bytes = format!("{records:?}").len();
    if bytes > BUS_EVENT_MAX_BYTES * 4 {
        return Err(TracingError::Invalid("batch too large".to_string()));
    }
    Ok(ObservabilityBatch {
        sequence: 42,
        drop_count: 0,
        records,
        wall_clock_ms: 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_required() {
        assert!(stream_events(&["a".to_string()], 1, 1024, false, false).is_err());
        assert!(stream_events(&["a".to_string()], 1, 1024, true, false).is_ok());
    }

    #[test]
    fn bounds_enforced() {
        let opts = TraceOptions {
            duration_ms: 10 * 60 * 1000,
            ..Default::default()
        };
        assert!(opts.validate().is_err());
        let opts2 = TraceOptions {
            max_bytes: 10 * 1024 * 1024,
            ..Default::default()
        };
        assert!(opts2.validate().is_err());
    }

    #[test]
    fn batch_limits() {
        assert!(stream_events(&["a".to_string()], 33, 1024, true, false).is_err());
        assert!(stream_events(&["a".to_string()], 1, 9000, true, false).is_err());
    }
}
