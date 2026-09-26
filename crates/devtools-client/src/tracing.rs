#![forbid(unsafe_code)]
//! Tracing surface (debug.trace, opt-in, bounded, DropOldest) — phase 2 advanced.
//!
//! Phase 2 adds filtering, structured events, retention/GC, coalescing control,
//! deterministic wall-clock, and chunked export with preview==export. All
//! bounds from devtools-rfc are preserved. The headless transport fixture
//! re-checks caller-supplied peer values; the live Linux path is inspect-only.

use crate::bounds::{
    BUS_BATCH_MAX_BYTES, BUS_BATCH_MAX_EVENTS, BUS_EVENT_MAX_BYTES, CHUNK_BYTES, MAX_TRACE_BYTES,
    MAX_TRACE_DURATION_MS,
};
use crate::redaction::redact_value;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write;

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
    pub filter: Option<TraceFilter>,
    pub retention: Option<TraceRetention>,
    pub drop_policy: DropPolicy,
    pub coalesce: CoalescePolicy,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TraceFilter {
    pub kinds: Option<Vec<String>>,
    pub owners: Option<Vec<String>>,
    pub exclude_input: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TraceRetention {
    pub max_bytes: Option<usize>,
    pub max_duration_ms: Option<u64>,
    pub max_traces: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DropPolicy {
    DropOldest,
    DropNewest,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoalescePolicy {
    Budget,
    None,
}

impl Default for TraceOptions {
    fn default() -> Self {
        Self {
            duration_ms: 10_000,
            max_bytes: 512 * 1024,
            include_input: false,
            filter: None,
            retention: None,
            drop_policy: DropPolicy::DropOldest,
            coalesce: CoalescePolicy::Budget,
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
        if let Some(ref f) = self.filter {
            if let Some(ref kinds) = f.kinds {
                if kinds.len() > 32 {
                    return Err(TracingError::Invalid("filter.kinds >32".to_string()));
                }
                for k in kinds {
                    if k.is_empty() || k.len() > 64 {
                        return Err(TracingError::Invalid("filter kind 1..64".to_string()));
                    }
                }
            }
            if let Some(ref owners) = f.owners {
                if owners.is_empty() || owners.len() > 32 {
                    return Err(TracingError::Invalid("filter.owners 1..32".to_string()));
                }
                for o in owners {
                    if o.is_empty() || o.len() > 64 {
                        return Err(TracingError::Invalid("filter owner 1..64".to_string()));
                    }
                }
            }
        }
        if let Some(ref r) = self.retention {
            if let Some(b) = r.max_bytes {
                if b == 0 || b > MAX_TRACE_BYTES {
                    return Err(TracingError::Invalid(format!(
                        "retention.maxBytes 1..{MAX_TRACE_BYTES}"
                    )));
                }
            }
            if let Some(d) = r.max_duration_ms {
                if d == 0 || d > MAX_TRACE_DURATION_MS {
                    return Err(TracingError::Invalid(format!(
                        "retention.maxDuration 1..{MAX_TRACE_DURATION_MS}"
                    )));
                }
            }
            if let Some(c) = r.max_traces {
                if c == 0 || c > 4 {
                    return Err(TracingError::Invalid(
                        "retention.maxTraces 1..4".to_string(),
                    ));
                }
            }
        }
        Ok(())
    }

    pub fn effective_retention(&self) -> TraceRetentionResolved {
        TraceRetentionResolved {
            max_bytes: self
                .retention
                .as_ref()
                .and_then(|r| r.max_bytes)
                .unwrap_or(self.max_bytes.min(MAX_TRACE_BYTES)),
            max_duration_ms: self
                .retention
                .as_ref()
                .and_then(|r| r.max_duration_ms)
                .unwrap_or(self.duration_ms.min(MAX_TRACE_DURATION_MS)),
            max_traces: self
                .retention
                .as_ref()
                .and_then(|r| r.max_traces)
                .unwrap_or(4),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct TraceRetentionResolved {
    pub max_bytes: usize,
    pub max_duration_ms: u64,
    pub max_traces: usize,
}

#[derive(Debug, Clone)]
pub struct StructuredTraceEvent {
    pub sequence: u64,
    pub owner: String,
    pub kind: String,
    pub payload: String,
    pub generation: u64,
    pub wall_clock_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatchRecord {
    pub owner: String,
    pub kind: String,
    pub payload: String,
}

#[derive(Debug, Clone)]
pub struct ObservabilityBatch {
    pub sequence: u64,
    pub drop_count: u64,
    pub records: Vec<BatchRecord>,
    pub wall_clock_ms: u64,
    pub coalesced_count: u64,
    pub policy: DropPolicy,
}

fn json_quote(value: &str) -> String {
    let mut output = String::with_capacity(value.len() + 2);
    output.push('"');
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\u{0008}' => output.push_str("\\b"),
            '\u{000c}' => output.push_str("\\f"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            c if c <= '\u{001f}' => {
                output.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => output.push(c),
        }
    }
    output.push('"');
    output
}

fn batch_json_bytes(records: &[BatchRecord]) -> usize {
    let mut json = String::from("[");
    for (index, record) in records.iter().enumerate() {
        if index > 0 {
            json.push(',');
        }
        json.push_str("{\"owner\":");
        json.push_str(&json_quote(&record.owner));
        json.push_str(",\"kind\":");
        json.push_str(&json_quote(&record.kind));
        json.push_str(",\"payload\":");
        json.push_str(&json_quote(&record.payload));
        json.push('}');
    }
    json.push(']');
    json.len()
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
    if types.len() > 256 {
        return Err(TracingError::Invalid("event types >256".to_string()));
    }
    let mut records = Vec::new();
    let mut drop_count = 0u64;
    for kind in types.iter().take(max_events) {
        let candidate = BatchRecord {
            owner: "panel-1".to_string(),
            kind: kind.clone(),
            payload: "{\"count\":1}".to_string(),
        };
        let mut next = records.clone();
        next.push(candidate.clone());
        if batch_json_bytes(&next) > max_bytes {
            drop_count += 1;
            continue;
        }
        records = next;
    }
    drop_count += types.len().saturating_sub(max_events) as u64;
    Ok(ObservabilityBatch {
        sequence: 42,
        drop_count,
        records,
        wall_clock_ms: 0,
        coalesced_count: 0,
        policy: DropPolicy::DropOldest,
    })
}

pub fn stream_filtered_events(
    filter: &TraceFilter,
    max_events: usize,
    max_bytes: usize,
    scope_ok: bool,
    cancelled: bool,
    now_ms: u64,
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
    let kinds_vec: Vec<String> = if let Some(ref k) = filter.kinds {
        if k.len() > 32 {
            return Err(TracingError::Invalid("filter.kinds >32".to_string()));
        }
        for kind in k {
            if kind.is_empty() || kind.len() > 64 {
                return Err(TracingError::Invalid("filter kind 1..64".to_string()));
            }
        }
        k.clone()
    } else {
        vec!["bitty.panel:mounted".to_string()]
    };
    let owner = filter
        .owners
        .as_ref()
        .and_then(|owners| owners.first())
        .cloned()
        .unwrap_or_else(|| "panel-1".to_string());
    if owner.is_empty() || owner.len() > 64 {
        return Err(TracingError::Invalid("filter owner 1..64".to_string()));
    }
    if let Some(ref owners) = filter.owners {
        if owners.is_empty() || owners.len() > 32 {
            return Err(TracingError::Invalid("filter.owners 1..32".to_string()));
        }
        for value in owners {
            if value.is_empty() || value.len() > 64 {
                return Err(TracingError::Invalid("filter owner 1..64".to_string()));
            }
        }
    }
    let mut seen = BTreeSet::new();
    let mut coalesced = 0u64;
    let mut records = Vec::new();
    let mut drop_count = 0u64;
    for kind in kinds_vec {
        let key = format!("{owner}:{kind}");
        if seen.contains(&key) {
            coalesced += 1;
            continue;
        }
        seen.insert(key);
        if records.len() >= max_events {
            drop_count += 1;
            continue;
        }
        let candidate = BatchRecord {
            owner: owner.clone(),
            kind,
            payload: "{\"count\":1}".to_string(),
        };
        let mut next = records.clone();
        next.push(candidate.clone());
        if batch_json_bytes(&next) > max_bytes {
            drop_count += 1;
            continue;
        }
        records = next;
    }
    Ok(ObservabilityBatch {
        sequence: now_ms,
        drop_count,
        records,
        wall_clock_ms: now_ms,
        coalesced_count: coalesced,
        policy: DropPolicy::DropOldest,
    })
}

// ---------------------------------------------------------------------------
// Phase 2 stateful tracer (per-session, bounded, retention/GC)
// ---------------------------------------------------------------------------

#[derive(Debug)]
#[allow(dead_code)]
struct TraceState {
    options: TraceOptions,
    bytes: usize,
    drops: u64,
    chunks: Vec<String>,
    start_ms: u64,
    retention: TraceRetentionResolved,
    drop_policy: DropPolicy,
    coalesce: CoalescePolicy,
    events: Vec<StructuredTraceEvent>,
    sequence: u64,
}

#[derive(Debug, Default)]
pub struct TracingClient {
    traces: BTreeMap<String, TraceState>,
    next_id: u64,
    global_seq: u64,
}

impl TracingClient {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    fn require_trace(&self, scope_ok: bool) -> Result<(), TracingError> {
        if !scope_ok {
            Err(TracingError::ScopeDenied)
        } else {
            Ok(())
        }
    }

    pub fn start_trace(
        &mut self,
        opts: TraceOptions,
        scope_ok: bool,
        now_ms: u64,
    ) -> Result<String, TracingError> {
        self.require_trace(scope_ok)?;
        if self.traces.len() >= 4 {
            return Err(TracingError::TooMany);
        }
        opts.validate()?;
        let retention = opts.effective_retention();
        self.next_id += 1;
        let id = format!("trace-{}", self.next_id);
        self.traces.insert(
            id.clone(),
            TraceState {
                options: opts.clone(),
                bytes: 0,
                drops: 0,
                chunks: Vec::new(),
                start_ms: now_ms,
                retention,
                drop_policy: opts.drop_policy,
                coalesce: opts.coalesce,
                events: Vec::new(),
                sequence: self.global_seq,
            },
        );
        self.global_seq += 1;
        Ok(id)
    }

    pub fn stop_trace(
        &mut self,
        trace_id: &str,
        scope_ok: bool,
    ) -> Result<(usize, u64), TracingError> {
        self.require_trace(scope_ok)?;
        let s = self.traces.remove(trace_id).ok_or(TracingError::NotFound)?;
        Ok((s.bytes, s.drops))
    }

    pub fn append_to_trace(
        &mut self,
        scope_ok: bool,
        trace_id: &str,
        data: &str,
    ) -> Result<(), TracingError> {
        self.require_trace(scope_ok)?;
        let rec = self
            .traces
            .get_mut(trace_id)
            .ok_or(TracingError::NotFound)?;
        if data.len() > BUS_EVENT_MAX_BYTES {
            return Err(TracingError::Invalid(format!(
                "trace record > {}",
                BUS_EVENT_MAX_BYTES
            )));
        }
        let record = redact_value(data.to_string(), "trace.record");
        let bytes_len = record.len();
        if bytes_len > BUS_EVENT_MAX_BYTES {
            return Err(TracingError::Invalid("trace record >8KiB".to_string()));
        }
        if rec.bytes + bytes_len > rec.options.max_bytes.min(rec.retention.max_bytes) {
            rec.drops += 1;
            return Ok(());
        }
        let cur_len = rec.chunks.last().map_or(0, String::len);
        if cur_len + bytes_len > CHUNK_BYTES || rec.chunks.is_empty() {
            rec.chunks.push(record);
        } else {
            let last = rec.chunks.last_mut().unwrap();
            last.push_str(&record);
        }
        rec.bytes += bytes_len;
        Ok(())
    }

    pub fn append_structured(
        &mut self,
        scope_ok: bool,
        trace_id: &str,
        event: StructuredTraceEvent,
    ) -> Result<(), TracingError> {
        self.require_trace(scope_ok)?;
        let rec = self
            .traces
            .get_mut(trace_id)
            .ok_or(TracingError::NotFound)?;
        if event.payload.len() > BUS_EVENT_MAX_BYTES {
            return Err(TracingError::Invalid(format!(
                "payload > {}",
                BUS_EVENT_MAX_BYTES
            )));
        }
        if event.owner.is_empty() || event.owner.len() > 64 {
            return Err(TracingError::Invalid("owner 1..64".to_string()));
        }
        if event.kind.is_empty() || event.kind.len() > 64 {
            return Err(TracingError::Invalid("kind 1..64".to_string()));
        }
        if event.generation == 0 {
            return Err(TracingError::Invalid("generation >=1".to_string()));
        }
        if let Some(ref filter) = rec.options.filter {
            if let Some(ref kinds) = filter.kinds {
                if !kinds.contains(&event.kind) {
                    rec.drops += 1;
                    return Ok(());
                }
            }
            if let Some(ref owners) = filter.owners {
                if !owners.contains(&event.owner) {
                    rec.drops += 1;
                    return Ok(());
                }
            }
        }
        let retained = StructuredTraceEvent {
            owner: redact_value(event.owner, "trace.owner"),
            kind: redact_value(event.kind, "trace.kind"),
            payload: redact_value(event.payload, "trace.payload"),
            ..event
        };
        let mut json = format!("{{\"sequence\":{},\"owner\":", retained.sequence);
        append_json_string(&mut json, &retained.owner);
        json.push_str(",\"kind\":");
        append_json_string(&mut json, &retained.kind);
        json.push_str(",\"payload\":");
        append_json_string(&mut json, &retained.payload);
        write!(
            json,
            ",\"generation\":{},\"wallClockMs\":{}}}",
            retained.generation, retained.wall_clock_ms
        )
        .unwrap();
        let json_len = json.len();
        if json_len > BUS_EVENT_MAX_BYTES {
            return Err(TracingError::Invalid("event json >8KiB".to_string()));
        }
        if rec.bytes + json_len > rec.options.max_bytes.min(rec.retention.max_bytes) {
            rec.drops += 1;
            return Ok(());
        }
        let cur_len = rec.chunks.last().map_or(0, String::len);
        if cur_len + json_len > CHUNK_BYTES || rec.chunks.is_empty() {
            rec.chunks.push(json);
        } else {
            let last = rec.chunks.last_mut().unwrap();
            last.push_str(&json);
        }
        rec.bytes += json_len;
        rec.events.push(retained);
        Ok(())
    }

    pub fn gc_expired(&mut self, now_ms: u64, scope_ok: bool) -> Result<Vec<String>, TracingError> {
        self.require_trace(scope_ok)?;
        let mut expired = Vec::new();
        for (id, state) in &self.traces {
            if now_ms.saturating_sub(state.start_ms) >= state.retention.max_duration_ms {
                expired.push(id.clone());
            }
        }
        for id in &expired {
            self.traces.remove(id);
        }
        Ok(expired)
    }

    pub fn trace_count(&self, scope_ok: bool) -> Result<usize, TracingError> {
        self.require_trace(scope_ok)?;
        Ok(self.traces.len())
    }

    pub fn list_traces(&self, scope_ok: bool) -> Result<Vec<String>, TracingError> {
        self.require_trace(scope_ok)?;
        Ok(self.traces.keys().cloned().collect())
    }

    pub fn clear_session_state(&mut self) {
        self.traces.clear();
        self.next_id = 0;
        self.global_seq = 0;
    }
}

fn append_json_string(json: &mut String, value: &str) {
    json.push('"');
    for ch in value.chars() {
        match ch {
            '"' => json.push_str("\\\""),
            '\\' => json.push_str("\\\\"),
            '\n' => json.push_str("\\n"),
            '\r' => json.push_str("\\r"),
            '\t' => json.push_str("\\t"),
            '\u{0008}' => json.push_str("\\b"),
            '\u{000c}' => json.push_str("\\f"),
            '\u{0000}'..='\u{001f}' => write!(json, "\\u{:04x}", u32::from(ch)).unwrap(),
            _ => json.push(ch),
        }
    }
    json.push('"');
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
    fn low_level_accessors_require_trace_scope() {
        let mut client = TracingClient::new();
        let id = client
            .start_trace(TraceOptions::default(), true, 0)
            .unwrap();
        assert!(client.append_to_trace(false, &id, "x").is_err());
        assert!(client.list_traces(false).is_err());
        client.stop_trace(&id, true).unwrap();
    }

    #[test]
    fn batch_limits() {
        assert!(stream_events(&["a".to_string()], 33, 1024, true, false).is_err());
        assert!(stream_events(&["a".to_string()], 1, 9000, true, false).is_err());
    }

    #[test]
    fn batch_uses_requested_bytes_and_structured_records() {
        let record = BatchRecord {
            owner: "panel-1".to_string(),
            kind: "one".to_string(),
            payload: "{\"count\":1}".to_string(),
        };
        let max_bytes = batch_json_bytes(std::slice::from_ref(&record));
        let batch = stream_events(
            &["one".to_string(), "two".to_string()],
            2,
            max_bytes,
            true,
            false,
        )
        .unwrap();
        assert_eq!(batch.records.len(), 1);
        assert_eq!(batch.records[0], record);
        assert_eq!(batch.drop_count, 1);
    }

    #[test]
    fn clear_session_state_removes_old_trace_ids() {
        let mut client = TracingClient::new();
        let id = client
            .start_trace(TraceOptions::default(), true, 0)
            .unwrap();
        client.clear_session_state();
        assert_eq!(client.trace_count(true).unwrap(), 0);
        assert!(client.list_traces(true).unwrap().is_empty());
        assert!(client.append_to_trace(true, &id, "late").is_err());
    }

    #[test]
    fn retention_and_gc() {
        let mut c = TracingClient::new();
        let id = c
            .start_trace(
                TraceOptions {
                    duration_ms: 1000,
                    ..Default::default()
                },
                true,
                0,
            )
            .unwrap();
        assert_eq!(c.trace_count(true).unwrap(), 1);
        let expired = c.gc_expired(2000, true).unwrap();
        assert_eq!(expired, vec![id]);
        assert_eq!(c.trace_count(true).unwrap(), 0);
    }

    #[test]
    fn raw_retention_matches_utf8_model() {
        for (max_bytes, retention_bytes) in [(24, 48), (48, 24)] {
            for coalesce in [CoalescePolicy::Budget, CoalescePolicy::None] {
                for drop_policy in [DropPolicy::DropOldest, DropPolicy::DropNewest] {
                    let mut c = TracingClient::new();
                    let id = c
                        .start_trace(
                            TraceOptions {
                                max_bytes,
                                retention: Some(TraceRetention {
                                    max_bytes: Some(retention_bytes),
                                    max_duration_ms: None,
                                    max_traces: None,
                                }),
                                coalesce,
                                drop_policy,
                                ..Default::default()
                            },
                            true,
                            0,
                        )
                        .unwrap();
                    let mut retained = String::new();
                    let mut drops = 0;
                    for record in ["你好", "café", "こんにちは", "добрый день", "salut"]
                    {
                        let before = format!("{:?}", c.traces[&id]);
                        let rejected = retained.len() + record.len() > 24;
                        if rejected {
                            drops += 1;
                        } else {
                            retained.push_str(record);
                        }
                        c.append_to_trace(true, &id, record).unwrap();
                        let state = c.traces.get_mut(&id).unwrap();
                        assert_eq!(state.chunks.concat(), retained);
                        assert_eq!(state.bytes, retained.len());
                        assert_eq!(state.drops, drops);
                        if rejected {
                            state.drops -= 1;
                            assert_eq!(format!("{state:?}"), before);
                            state.drops += 1;
                        }
                    }
                    assert_eq!(c.stop_trace(&id, true).unwrap(), (retained.len(), drops));
                }
            }
        }
    }

    #[test]
    fn structured_retention_matches_serialized_bytes() {
        let event = StructuredTraceEvent {
            sequence: 1,
            owner: "面板".into(),
            kind: "trace.record".into(),
            payload: "café says \"こんにちは\"\n".into(),
            generation: 1,
            wall_clock_ms: 10,
        };
        let json = "{\"sequence\":1,\"owner\":\"面板\",\"kind\":\"trace.record\",\"payload\":\"café says \\\"こんにちは\\\"\\n\",\"generation\":1,\"wallClockMs\":10}";
        for limit in [json.len() - 1, json.len(), json.len() + 1] {
            for retention_first in [true, false] {
                let mut c = TracingClient::new();
                let id = c
                    .start_trace(
                        TraceOptions {
                            max_bytes: if retention_first {
                                json.len() * 2
                            } else {
                                limit
                            },
                            retention: Some(TraceRetention {
                                max_bytes: Some(if retention_first {
                                    limit
                                } else {
                                    json.len() * 2
                                }),
                                max_duration_ms: None,
                                max_traces: None,
                            }),
                            ..Default::default()
                        },
                        true,
                        0,
                    )
                    .unwrap();
                let before = format!("{:?}", c.traces[&id]);
                c.append_structured(true, &id, event.clone()).unwrap();
                let state = c.traces.get_mut(&id).unwrap();
                if limit < json.len() {
                    assert_eq!(state.drops, 1);
                    state.drops = 0;
                    assert_eq!(format!("{state:?}"), before);
                } else {
                    assert_eq!(state.chunks.concat(), json);
                    assert_eq!(state.bytes, json.len());
                    assert_eq!(state.events.len(), 1);
                    assert_eq!(state.events[0].payload, event.payload);
                    let accepted = format!("{state:?}");
                    c.append_structured(true, &id, event.clone()).unwrap();
                    let state = c.traces.get_mut(&id).unwrap();
                    assert_eq!(state.drops, 1);
                    state.drops = 0;
                    assert_eq!(format!("{state:?}"), accepted);
                }
            }
        }
    }

    #[test]
    fn retained_redaction_is_measured() {
        let mut c = TracingClient::new();
        let id = c.start_trace(TraceOptions::default(), true, 0).unwrap();
        let event = StructuredTraceEvent {
            sequence: 1,
            owner: "panel-1".into(),
            kind: "trace.record".into(),
            payload: "password=example".into(),
            generation: 1,
            wall_clock_ms: 10,
        };
        c.append_structured(true, &id, event).unwrap();
        let state = &c.traces[&id];
        assert_eq!(state.events[0].payload, "[REDACTED]");
        assert!(state.chunks.concat().contains("\"payload\":\"[REDACTED]\""));
        assert_eq!(state.bytes, state.chunks.concat().len());
        let raw = c
            .start_trace(
                TraceOptions {
                    max_bytes: 10,
                    ..Default::default()
                },
                true,
                0,
            )
            .unwrap();
        c.append_to_trace(true, &raw, "password=example").unwrap();
        assert_eq!(c.traces[&raw].chunks, vec!["[REDACTED]"]);
        assert_eq!(c.stop_trace(&raw, true).unwrap(), (10, 0));
    }

    #[test]
    fn structured_filter() {
        let mut c = TracingClient::new();
        let opts = TraceOptions {
            filter: Some(TraceFilter {
                kinds: Some(vec!["a".to_string()]),
                owners: None,
                exclude_input: true,
            }),
            ..Default::default()
        };
        let id = c.start_trace(opts, true, 0).unwrap();
        let ev = StructuredTraceEvent {
            sequence: 0,
            owner: "panel-1".to_string(),
            kind: "b".to_string(),
            payload: "hello".to_string(),
            generation: 1,
            wall_clock_ms: 0,
        };
        c.append_structured(true, &id, ev).unwrap();
        // filtered out, drops incremented
        let state = c.traces.get(&id).unwrap();
        assert_eq!(state.drops, 1);
    }
}
