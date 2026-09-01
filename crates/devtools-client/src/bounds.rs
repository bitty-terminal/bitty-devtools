#![forbid(unsafe_code)]
//! Bounded constants mirroring Panel Runtime and compat matrix.
//! No new budget family; all thresholds are validated before mutation.

pub const MAX_PANELS_PER_WORKSPACE: usize = 32;
pub const MAX_PANELS_PER_WINDOW: usize = 64;
pub const DEFAULT_MAX_PANELS_PER_WORKSPACE: usize = 16;
pub const DEFAULT_MAX_PANELS_PER_WINDOW: usize = 32;
pub const MAX_TOPICS_TOTAL: usize = 256;
pub const MAX_SUBSCRIPTIONS_PER_PANEL: usize = 32;
pub const MAX_COMMANDS_PER_PANEL_TYPE: usize = 32;

pub const BUS_PER_SUBSCRIPTION: usize = 64;
pub const BUS_PER_PANEL_EVENTS: usize = 1024;
pub const BUS_PER_PANEL_BYTES: usize = 256 * 1024;
pub const BUS_GLOBAL_EVENTS: usize = 8192;
pub const BUS_GLOBAL_BYTES: usize = 2 * 1024 * 1024;
pub const BUS_EVENT_MAX_BYTES: usize = 8 * 1024;
pub const BUS_BATCH_MAX_EVENTS: usize = 32;
pub const BUS_BATCH_MAX_BYTES: usize = 8 * 1024;

pub const MAX_OVERLAYS_PER_WINDOW: usize = 4;
pub const MAX_OVERLAY_TEXT_LEN: usize = 128;
pub const MAX_OVERLAY_TOOLTIP_LEN: usize = 256;

pub const MAX_COLS: u16 = 1024;
pub const MAX_ROWS: u16 = 1024;
pub const RESIZE_DEBOUNCE_CAP: usize = 64;
pub const GENERATION_RESERVE: u64 = 1024;

pub const MATRIX_LEN: usize = 14;
pub const MAX_CORPUS_BYTES: usize = 8 * 1024;
pub const MAX_ACTIONS: usize = 4096;
pub const MAX_SNAPSHOT_JSON_BYTES: usize = 16 * 1024;

pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
pub const CHUNK_BYTES: usize = 256 * 1024;
pub const MAX_TRACE_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_TRACE_DURATION_MS: u64 = 5 * 60 * 1000;

pub const PREVIEW_MAX_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundError {
    pub bound: &'static str,
    pub observed: usize,
    pub limit: usize,
}

impl std::fmt::Display for BoundError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} exceeded: {} > {}",
            self.bound, self.observed, self.limit
        )
    }
}
impl std::error::Error for BoundError {}

pub fn assert_bounded(
    bound: &'static str,
    observed: usize,
    limit: usize,
) -> Result<(), BoundError> {
    if observed > limit {
        return Err(BoundError {
            bound,
            observed,
            limit,
        });
    }
    Ok(())
}

pub fn truncate_to_bytes(s: &str, max_bytes: usize) -> String {
    let bytes = s.as_bytes();
    if bytes.len() <= max_bytes {
        return s.to_owned();
    }
    // Truncate at char boundary
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assert_bounded_fail_closed() {
        assert!(assert_bounded("test", 100, 10).is_err());
        assert!(assert_bounded("test", 10, 10).is_ok());
    }

    #[test]
    fn truncate_bytes_char_boundary() {
        let s = "a".repeat(9000);
        let t = truncate_to_bytes(&s, 8192);
        assert!(t.len() <= 8192);
    }
}
