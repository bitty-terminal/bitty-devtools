#![forbid(unsafe_code)]
//! `bitty-devtools-client`: human-facing diagnostics client for local debugging.
//!
//! Phase 2 extends phase 1 with advanced tracing (filtering, retention/GC,
//! structured events, coalescing), control surfaces (audit log, generation
//! guards, pause/resume), and real IPC socket/pipe peer-creds integration
//! against the live Bitty runtime. This crate **reuses** the Panel Runtime
//! envelope and does not own the core debug protocol (devtools-rfc OQ-019,
//! performance budgets OQ-001). All operations are bounded, fail-closed,
//! and scope-checked. No TCP listener, no ambient credential.
//!
//! - Connection alone grants no authority; `debug.inspect` is default.
//! - Terminal output/traces are untrusted observation data.
//! - Per-consumer queues with `DropOldest` default, coalescing, counted drops.
//! - Payload at most 8 KiB, batch 32/8 KiB, chunk 256 KiB, frame 1 MiB / 256 KiB IPC.
//! - No `unsafe`, no PTY/GPU/window handles.

pub mod auth;
pub mod bounds;
pub mod compat;
pub mod control;
pub mod inspection;
pub mod protocol;
pub mod redaction;
pub mod tracing;
pub mod transport;

pub use compat::{MATRIX, MatrixEntry, REFERENCE_TERMS};
pub use protocol::{DebugScope, PROTOCOL_VERSION};

/// Re-export PanelRuntime constants for ergonomic `bounds::` parity.
pub const MAX_PANELS_PER_WORKSPACE: usize = bounds::MAX_PANELS_PER_WORKSPACE;
pub const MAX_PANELS_PER_WINDOW: usize = bounds::MAX_PANELS_PER_WINDOW;

/// Quick headless check that all bounds mirror the accepted Rust runtime.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounds_are_panel_runtime_parity() {
        assert_eq!(MAX_PANELS_PER_WORKSPACE, 32);
        assert_eq!(MAX_PANELS_PER_WINDOW, 64);
        assert_eq!(bounds::BUS_PER_SUBSCRIPTION, 64);
        assert_eq!(bounds::BUS_PER_PANEL_EVENTS, 1024);
        assert_eq!(bounds::BUS_GLOBAL_EVENTS, 8192);
        assert_eq!(bounds::MATRIX_LEN, 14);
    }

    #[test]
    fn matrix_ordered() {
        assert_eq!(MATRIX.first().unwrap().surface, "shell");
        assert_eq!(MATRIX.last().unwrap().surface, "DPI");
        assert_eq!(
            REFERENCE_TERMS,
            ["ghostty", "kitty", "wezterm", "alacritty"]
        );
    }

    #[test]
    fn protocol_version_supported() {
        assert_eq!(PROTOCOL_VERSION, "1.0");
        assert!(protocol::is_supported_version("1.0"));
        assert!(!protocol::is_supported_version("2.0"));
    }

    #[test]
    fn transport_and_auth_headless() {
        let peer = auth::PeerCredentials::new(1000, 1000, 42);
        assert!(auth::verify_peer_uid(peer, 1000).is_ok());
        assert!(auth::verify_peer_uid(peer, 1001).is_err());
        let mut t = transport::IpcTransport::with_defaults(
            1000,
            "/run/user/1000/bitty/default.sock".into(),
            Some(peer),
        );
        assert!(t.connect().is_ok());
        assert!(t.is_connected());
    }
}
