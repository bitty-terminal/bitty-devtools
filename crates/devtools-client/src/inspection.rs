#![forbid(unsafe_code)]
//! Inspection surface (debug.inspect, read-only).

use crate::bounds::{
    BUS_GLOBAL_BYTES, BUS_GLOBAL_EVENTS, BUS_PER_PANEL_BYTES, BUS_PER_PANEL_EVENTS,
    BUS_PER_SUBSCRIPTION,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InspectionError {
    ScopeDenied,
    InvalidId(String),
}

impl std::fmt::Display for InspectionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ScopeDenied => write!(f, "debug.inspect required"),
            Self::InvalidId(m) => write!(f, "invalid id: {m}"),
        }
    }
}
impl std::error::Error for InspectionError {}

#[derive(Debug, Clone)]
pub struct SubscriptionInfo {
    pub event_type: String,
    pub queue_depth: usize,
    pub queued_bytes: usize,
    pub drop_count: u64,
    pub policy: String,
}

#[derive(Debug, Clone)]
pub struct QueueSnapshot {
    pub per_subscription_limit: usize,
    pub per_subscription_current: usize,
    pub per_plugin_events: usize,
    pub per_plugin_bytes: usize,
    pub per_plugin_limit_events: usize,
    pub per_plugin_limit_bytes: usize,
    pub global_events: usize,
    pub global_bytes: usize,
    pub global_limit_events: usize,
    pub global_limit_bytes: usize,
}

pub fn list_subscriptions(
    plugin_id: &str,
    scope_ok: bool,
) -> Result<Vec<SubscriptionInfo>, InspectionError> {
    if !scope_ok {
        return Err(InspectionError::ScopeDenied);
    }
    if plugin_id.is_empty() || plugin_id.len() > 128 {
        return Err(InspectionError::InvalidId("pluginId 1..128".to_string()));
    }
    Ok(vec![
        SubscriptionInfo {
            event_type: "bitty.panel:mounted".to_string(),
            queue_depth: 0,
            queued_bytes: 0,
            drop_count: 0,
            policy: "DropOldest".to_string(),
        },
        SubscriptionInfo {
            event_type: "xuepoo.git:branch-changed".to_string(),
            queue_depth: 2,
            queued_bytes: 256,
            drop_count: 1,
            policy: "DropOldest".to_string(),
        },
    ])
}

pub fn queue_snapshot(plugin_id: &str, scope_ok: bool) -> Result<QueueSnapshot, InspectionError> {
    if !scope_ok {
        return Err(InspectionError::ScopeDenied);
    }
    if plugin_id.len() > 128 {
        return Err(InspectionError::InvalidId("pluginId too long".to_string()));
    }
    Ok(QueueSnapshot {
        per_subscription_limit: BUS_PER_SUBSCRIPTION,
        per_subscription_current: 2,
        per_plugin_events: 12,
        per_plugin_bytes: 4096,
        per_plugin_limit_events: BUS_PER_PANEL_EVENTS,
        per_plugin_limit_bytes: BUS_PER_PANEL_BYTES,
        global_events: 120,
        global_bytes: 64 * 1024,
        global_limit_events: BUS_GLOBAL_EVENTS,
        global_limit_bytes: BUS_GLOBAL_BYTES,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requires_inspect() {
        assert!(list_subscriptions("x", false).is_err());
        assert!(list_subscriptions("panel-1", true).is_ok());
    }

    #[test]
    fn queue_snapshot_bounded() {
        let s = queue_snapshot("panel-1", true).unwrap();
        assert_eq!(s.per_subscription_limit, 64);
        assert_eq!(s.global_limit_events, 8192);
    }
}
