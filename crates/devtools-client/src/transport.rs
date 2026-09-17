#![forbid(unsafe_code)]
//! IPC transport for DevTools phase 2 (live runtime, bounded, headless).
//!
//! Mirrors `bitty-ipc` framing (256 KiB) and devtools-rfc logical 1 MiB,
//! RC-9 (100 req/s, burst 200, 16 connections), RC-10 (256 KiB chunk).
//! Headless stub with injectable peer, no OS handle, fail-closed.

use crate::auth::{PeerCredentials, verify_peer_uid, verify_unix_endpoint, verify_windows_pipe};
use crate::bounds::{CHUNK_BYTES, MAX_FRAME_BYTES as DEVTOOLS_MAX_FRAME};

pub const MAX_FRAME_BYTES: usize = 256 * 1024;
pub const MAX_BUFFERED_BYTES: usize = MAX_FRAME_BYTES + 8;
pub const RC9_REQ_PER_SEC: u32 = 100;
pub const RC9_BURST_PER_SEC: u32 = 200;
pub const RC9_WINDOW_MS: u64 = 1_000;
pub const RC9_MAX_CONNECTIONS: usize = 16;
pub const RC9_PAYLOAD_CAP_BYTES: usize = 1024 * 1024;
pub const RC10_CHUNK_CEILING: usize = 256 * 1024;
pub const DEFAULT_TRANSPORT_CAPACITY: usize = 64;
pub const MAX_TRANSPORT_CAPACITY: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportError {
    FrameTooLarge {
        actual: usize,
        limit: usize,
    },
    FrameTruncated {
        expected: usize,
        actual: usize,
    },
    PayloadTooLarge {
        field: String,
        limit: usize,
        actual: usize,
    },
    TransportFull {
        capacity: usize,
    },
    TransportClosed,
    RateLimited(String),
    ConnectionLimit(String),
    Unauthenticated(String),
    InvalidFrame(String),
}

impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::FrameTooLarge { actual, limit } => {
                write!(f, "frame too large {actual} > {limit}")
            }
            Self::FrameTruncated { expected, actual } => {
                write!(f, "frame truncated {actual} < {expected}")
            }
            Self::PayloadTooLarge {
                field,
                limit,
                actual,
            } => write!(f, "{field} {actual} > {limit}"),
            Self::TransportFull { capacity } => write!(f, "transport full {capacity}"),
            Self::TransportClosed => write!(f, "transport closed"),
            Self::RateLimited(s) => write!(f, "rate limited: {s}"),
            Self::ConnectionLimit(s) => write!(f, "connection limit: {s}"),
            Self::Unauthenticated(s) => write!(f, "unauthenticated: {s}"),
            Self::InvalidFrame(s) => write!(f, "invalid frame: {s}"),
        }
    }
}
impl std::error::Error for TransportError {}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Frame {
    payload: Vec<u8>,
}

impl Frame {
    pub fn new(payload: Vec<u8>) -> Result<Self, TransportError> {
        if payload.len() > MAX_FRAME_BYTES {
            return Err(TransportError::FrameTooLarge {
                actual: payload.len(),
                limit: MAX_FRAME_BYTES,
            });
        }
        Ok(Self { payload })
    }

    #[must_use]
    pub fn payload(&self) -> &[u8] {
        &self.payload
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.payload.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.payload.is_empty()
    }
}

pub fn encode_frame(payload: &[u8]) -> Result<Vec<u8>, TransportError> {
    if payload.len() > MAX_FRAME_BYTES {
        return Err(TransportError::FrameTooLarge {
            actual: payload.len(),
            limit: MAX_FRAME_BYTES,
        });
    }
    let mut out = Vec::with_capacity(4 + payload.len());
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    Ok(out)
}

pub fn decode_frame(buf: &[u8]) -> Result<(Frame, usize), TransportError> {
    if buf.len() < 4 {
        return Err(TransportError::FrameTruncated {
            expected: 4,
            actual: buf.len(),
        });
    }
    let len = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
    if len > MAX_FRAME_BYTES {
        return Err(TransportError::FrameTooLarge {
            actual: len,
            limit: MAX_FRAME_BYTES,
        });
    }
    let total = 4 + len;
    if buf.len() < total {
        return Err(TransportError::FrameTruncated {
            expected: total,
            actual: buf.len(),
        });
    }
    let payload = buf[4..total].to_vec();
    Ok((Frame { payload }, total))
}

#[derive(Debug, Default)]
pub struct Framer {
    buf: Vec<u8>,
}

impl Framer {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn buffered_len(&self) -> usize {
        self.buf.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    pub fn clear(&mut self) {
        self.buf.clear();
    }

    pub fn push_bytes(&mut self, bytes: &[u8]) -> Result<Vec<Frame>, TransportError> {
        if self.buf.len() + bytes.len() > MAX_BUFFERED_BYTES + MAX_FRAME_BYTES {
            self.buf.clear();
            return Err(TransportError::PayloadTooLarge {
                field: "framer.buffer".into(),
                limit: MAX_BUFFERED_BYTES + MAX_FRAME_BYTES,
                actual: bytes.len(),
            });
        }
        self.buf.extend_from_slice(bytes);
        let mut frames = Vec::new();
        let mut consumed = 0usize;
        loop {
            let remaining = &self.buf[consumed..];
            if remaining.is_empty() {
                break;
            }
            if remaining.len() < 4 {
                break;
            }
            let len = u32::from_be_bytes([remaining[0], remaining[1], remaining[2], remaining[3]])
                as usize;
            if len > MAX_FRAME_BYTES {
                self.buf.clear();
                return Err(TransportError::FrameTooLarge {
                    actual: len,
                    limit: MAX_FRAME_BYTES,
                });
            }
            let total = 4 + len;
            if remaining.len() < total {
                break;
            }
            let payload = remaining[4..total].to_vec();
            frames.push(Frame { payload });
            consumed += total;
        }
        if consumed > 0 {
            self.buf.drain(..consumed);
        }
        Ok(frames)
    }
}

#[derive(Debug, Clone)]
pub struct RateLimiter {
    timestamps: std::collections::VecDeque<u64>,
    limit_per_sec: u32,
    burst: u32,
    credit: u64,
    last_refill_ms: Option<u64>,
}

impl RateLimiter {
    #[must_use]
    pub fn rc9_default() -> Self {
        Self::new(RC9_REQ_PER_SEC, RC9_BURST_PER_SEC)
    }

    #[must_use]
    pub fn new(limit_per_sec: u32, burst: u32) -> Self {
        Self {
            timestamps: std::collections::VecDeque::new(),
            limit_per_sec,
            burst,
            credit: u64::from(burst) * RC9_WINDOW_MS,
            last_refill_ms: None,
        }
    }

    pub fn count_in_window(&mut self, now_ms: u64) -> usize {
        self.observe_time(now_ms);
        self.timestamps.len()
    }

    pub fn check(&mut self, now_ms: u64) -> Result<(), TransportError> {
        let now_ms = self.observe_time(now_ms);
        if (self.timestamps.len() as u32) >= self.burst {
            return Err(TransportError::RateLimited(format!(
                "{} requests in {}ms exceeds burst {}",
                self.timestamps.len(),
                RC9_WINDOW_MS,
                self.burst
            )));
        }
        if self.credit < RC9_WINDOW_MS {
            return Err(TransportError::RateLimited(format!(
                "sustained limit {} requests per {}ms exhausted",
                self.limit_per_sec, RC9_WINDOW_MS
            )));
        }
        self.credit -= RC9_WINDOW_MS;
        self.timestamps.push_back(now_ms);
        Ok(())
    }

    fn observe_time(&mut self, now_ms: u64) -> u64 {
        let now_ms = now_ms.max(self.last_refill_ms.unwrap_or(now_ms));
        let elapsed_ms = now_ms - self.last_refill_ms.unwrap_or(now_ms);
        self.credit = self
            .credit
            .saturating_add(elapsed_ms.saturating_mul(u64::from(self.limit_per_sec)))
            .min(u64::from(self.burst) * RC9_WINDOW_MS);
        self.last_refill_ms = Some(now_ms);
        self.evict_old(now_ms);
        now_ms
    }

    fn evict_old(&mut self, now_ms: u64) {
        while let Some(&front) = self.timestamps.front() {
            if now_ms.saturating_sub(front) >= RC9_WINDOW_MS {
                self.timestamps.pop_front();
            } else {
                break;
            }
        }
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.timestamps.is_empty()
    }
}

pub fn check_payload_cap(payload_len: usize) -> Result<(), TransportError> {
    if payload_len > RC9_PAYLOAD_CAP_BYTES {
        return Err(TransportError::PayloadTooLarge {
            field: "payload".into(),
            limit: RC9_PAYLOAD_CAP_BYTES,
            actual: payload_len,
        });
    }
    if payload_len > DEVTOOLS_MAX_FRAME {
        return Err(TransportError::PayloadTooLarge {
            field: "devtools frame".into(),
            limit: DEVTOOLS_MAX_FRAME,
            actual: payload_len,
        });
    }
    if payload_len > CHUNK_BYTES * 4 {
        // Logical 1 MiB must be chunked at 256 KiB, but single logical payload within 1 MiB is okay
    }
    Ok(())
}

pub fn check_connection_cap(active: usize) -> Result<(), TransportError> {
    if active >= RC9_MAX_CONNECTIONS {
        return Err(TransportError::ConnectionLimit(format!(
            "concurrent connections {} >= limit {} (shed newest)",
            active, RC9_MAX_CONNECTIONS
        )));
    }
    Ok(())
}

#[derive(Debug)]
pub struct StdioTransportStub {
    outgoing: std::collections::VecDeque<Frame>,
    incoming: std::collections::VecDeque<Frame>,
    capacity: usize,
    closed: bool,
    dropped_outgoing: u64,
}

impl StdioTransportStub {
    pub fn new(capacity: usize) -> Self {
        assert!(
            capacity > 0 && capacity <= MAX_TRANSPORT_CAPACITY,
            "capacity 1..{}",
            MAX_TRANSPORT_CAPACITY
        );
        Self {
            outgoing: std::collections::VecDeque::with_capacity(capacity),
            incoming: std::collections::VecDeque::with_capacity(capacity),
            capacity,
            closed: false,
            dropped_outgoing: 0,
        }
    }

    #[must_use]
    pub fn with_default_capacity() -> Self {
        Self::new(DEFAULT_TRANSPORT_CAPACITY)
    }

    #[must_use]
    pub fn capacity(&self) -> usize {
        self.capacity
    }

    #[must_use]
    pub fn outgoing_len(&self) -> usize {
        self.outgoing.len()
    }

    #[must_use]
    pub fn incoming_len(&self) -> usize {
        self.incoming.len()
    }

    #[must_use]
    pub fn is_closed(&self) -> bool {
        self.closed
    }

    #[must_use]
    pub fn dropped_outgoing(&self) -> u64 {
        self.dropped_outgoing
    }

    pub fn close(&mut self) {
        self.closed = true;
    }

    pub fn clear(&mut self) {
        self.outgoing.clear();
        self.incoming.clear();
        self.dropped_outgoing = 0;
    }

    pub fn try_send_frame(&mut self, frame: Frame) -> Result<(), TransportError> {
        if self.closed {
            return Err(TransportError::TransportClosed);
        }
        if self.outgoing.len() >= self.capacity {
            return Err(TransportError::TransportFull {
                capacity: self.capacity,
            });
        }
        self.outgoing.push_back(frame);
        Ok(())
    }

    pub fn try_send_payload(&mut self, payload: &[u8]) -> Result<(), TransportError> {
        if payload.len() > MAX_FRAME_BYTES {
            return Err(TransportError::FrameTooLarge {
                actual: payload.len(),
                limit: MAX_FRAME_BYTES,
            });
        }
        self.try_send_frame(Frame::new(payload.to_vec())?)
    }

    pub fn send_drop_oldest(&mut self, frame: Frame) {
        if self.closed {
            return;
        }
        if self.outgoing.len() >= self.capacity {
            self.outgoing.pop_front();
            self.dropped_outgoing = self.dropped_outgoing.wrapping_add(1);
        }
        self.outgoing.push_back(frame);
    }

    pub fn recv_outgoing(&mut self) -> Option<Frame> {
        self.outgoing.pop_front()
    }

    pub fn drain_outgoing(&mut self) -> Vec<Frame> {
        self.outgoing.drain(..).collect()
    }

    pub fn inject_incoming(&mut self, frame: Frame) -> Result<(), TransportError> {
        if self.closed {
            return Err(TransportError::TransportClosed);
        }
        if self.incoming.len() >= self.capacity {
            return Err(TransportError::TransportFull {
                capacity: self.capacity,
            });
        }
        self.incoming.push_back(frame);
        Ok(())
    }

    pub fn inject_incoming_payload(&mut self, payload: &[u8]) -> Result<(), TransportError> {
        self.inject_incoming(Frame::new(payload.to_vec())?)
    }

    pub fn recv_incoming(&mut self) -> Option<Frame> {
        self.incoming.pop_front()
    }

    pub fn drain_incoming(&mut self) -> Vec<Frame> {
        self.incoming.drain(..).collect()
    }

    pub fn drain_incoming_bounded(&mut self, limit: usize) -> Vec<Frame> {
        let take = limit.min(self.incoming.len());
        self.incoming.drain(..take).collect()
    }

    pub fn forward_to(&mut self, peer: &mut Self) -> usize {
        let mut moved = 0;
        while let Some(frame) = self.outgoing.front() {
            let _ = frame;
            if peer.is_closed() || peer.incoming_len() >= peer.capacity {
                break;
            }
            let f = self.outgoing.pop_front().unwrap();
            let _ = peer.inject_incoming(f);
            moved += 1;
        }
        moved
    }
}

impl Default for StdioTransportStub {
    fn default() -> Self {
        Self::with_default_capacity()
    }
}

pub struct IpcTransport {
    stub: StdioTransportStub,
    limiter: RateLimiter,
    active_connections: usize,
    requests: usize,
    peer: Option<PeerCredentials>,
    runtime_uid: u32,
    socket_path: String,
    dir_mode: u32,
    sock_mode: u32,
    dir_owner_uid: u32,
    sock_owner_uid: u32,
    /// Windows named-pipe peer identity (CTX-0043). When both SIDs are
    /// present the transport verifies the pipe peer instead of the Unix
    /// endpoint checks. Injected headlessly in tests; the live pipe path
    /// cannot execute on Linux (Windows-CI item).
    windows_peer_sid: Option<u64>,
    windows_runtime_sid: Option<u64>,
}

impl IpcTransport {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        runtime_uid: u32,
        socket_path: String,
        peer: Option<PeerCredentials>,
        dir_mode: u32,
        sock_mode: u32,
        dir_owner_uid: u32,
        sock_owner_uid: u32,
        capacity: usize,
    ) -> Self {
        Self {
            stub: StdioTransportStub::new(capacity),
            limiter: RateLimiter::rc9_default(),
            active_connections: 0,
            requests: 0,
            peer,
            runtime_uid,
            socket_path,
            dir_mode,
            sock_mode,
            dir_owner_uid,
            sock_owner_uid,
            windows_peer_sid: None,
            windows_runtime_sid: None,
        }
    }

    /// Windows named-pipe transport (CTX-0043): peer identity is a SID pair
    /// verified via [`verify_windows_pipe`] at connect and per privileged
    /// action, instead of the Unix endpoint checks.
    pub fn with_windows_pipe(
        runtime_uid: u32,
        socket_path: String,
        peer: Option<PeerCredentials>,
        peer_sid: u64,
        runtime_sid: u64,
        capacity: usize,
    ) -> Self {
        let mut transport = Self::new(
            runtime_uid,
            socket_path,
            peer,
            0o700,
            0o600,
            runtime_uid,
            runtime_uid,
            capacity,
        );
        transport.windows_peer_sid = Some(peer_sid);
        transport.windows_runtime_sid = Some(runtime_sid);
        transport
    }

    pub fn with_defaults(
        runtime_uid: u32,
        socket_path: String,
        peer: Option<PeerCredentials>,
    ) -> Self {
        Self::new(
            runtime_uid,
            socket_path,
            peer,
            0o700,
            0o600,
            runtime_uid,
            runtime_uid,
            DEFAULT_TRANSPORT_CAPACITY,
        )
    }

    #[must_use]
    pub fn is_connected(&self) -> bool {
        self.active_connections == 1
    }

    #[must_use]
    pub fn socket_path(&self) -> &str {
        &self.socket_path
    }

    pub fn connect(&mut self) -> Result<(), TransportError> {
        if self.stub.is_closed() {
            self.disconnect();
            return Err(TransportError::TransportClosed);
        }
        if let (Some(peer_sid), Some(runtime_sid)) =
            (self.windows_peer_sid, self.windows_runtime_sid)
        {
            // CTX-0043: named-pipe peers carry SIDs, not Unix modes/owners.
            self.verify_windows_pipe(peer_sid, runtime_sid)?;
        } else if let Some(peer) = self.peer {
            verify_unix_endpoint(
                self.runtime_uid,
                peer,
                self.dir_mode,
                self.dir_owner_uid,
                self.sock_mode,
                self.sock_owner_uid,
            )
            .map_err(|e| TransportError::Unauthenticated(e.to_string()))?;
        } else {
            if self.dir_mode != 0o700 {
                return Err(TransportError::Unauthenticated(format!(
                    "directory mode {:o} != 700",
                    self.dir_mode
                )));
            }
            if self.sock_mode != 0o600 {
                return Err(TransportError::Unauthenticated(format!(
                    "socket mode {:o} != 600",
                    self.sock_mode
                )));
            }
            if self.dir_owner_uid != self.runtime_uid {
                return Err(TransportError::Unauthenticated(format!(
                    "directory owner {} != runtime {}",
                    self.dir_owner_uid, self.runtime_uid
                )));
            }
            if self.sock_owner_uid != self.runtime_uid {
                return Err(TransportError::Unauthenticated(format!(
                    "socket owner {} != runtime {}",
                    self.sock_owner_uid, self.runtime_uid
                )));
            }
        }
        if !self.is_connected() {
            check_connection_cap(self.active_connections)?;
            self.active_connections += 1;
        }
        Ok(())
    }

    pub fn disconnect(&mut self) {
        self.active_connections = 0;
        self.stub.clear();
    }

    pub fn verify_peer_for_privileged(&self) -> Result<(), TransportError> {
        if let (Some(peer_sid), Some(runtime_sid)) =
            (self.windows_peer_sid, self.windows_runtime_sid)
        {
            // CTX-0043: every privileged action re-verifies the pipe peer SID.
            return self.verify_windows_pipe(peer_sid, runtime_sid);
        }
        if let Some(peer) = self.peer {
            verify_peer_uid(peer, self.runtime_uid)
                .map_err(|e| TransportError::Unauthenticated(e.to_string()))?;
            verify_unix_endpoint(
                self.runtime_uid,
                peer,
                self.dir_mode,
                self.dir_owner_uid,
                self.sock_mode,
                self.sock_owner_uid,
            )
            .map_err(|e| TransportError::Unauthenticated(e.to_string()))?;
        }
        Ok(())
    }

    pub fn verify_windows_pipe(
        &self,
        peer_sid: u64,
        runtime_sid: u64,
    ) -> Result<(), TransportError> {
        verify_windows_pipe(peer_sid, runtime_sid)
            .map_err(|e| TransportError::Unauthenticated(e.to_string()))
    }

    pub fn send_request(&mut self, json: &str, now_ms: u64) -> Result<(), TransportError> {
        if self.stub.is_closed() {
            self.disconnect();
            return Err(TransportError::TransportClosed);
        }
        if !self.is_connected() {
            return Err(TransportError::TransportClosed);
        }
        self.verify_peer_for_privileged()?;
        self.limiter.check(now_ms)?;
        let bytes = json.as_bytes();
        check_payload_cap(bytes.len())?;
        if bytes.len() <= MAX_FRAME_BYTES {
            self.stub.try_send_payload(bytes)?;
        } else {
            for chunk in bytes.chunks(MAX_FRAME_BYTES) {
                self.stub.try_send_payload(chunk)?;
            }
        }
        self.requests += 1;
        Ok(())
    }

    pub fn forward_to(&mut self, peer: &mut Self) -> usize {
        self.stub.forward_to(&mut peer.stub)
    }

    pub fn outgoing_len(&self) -> usize {
        self.stub.outgoing_len()
    }
    pub fn incoming_len(&self) -> usize {
        self.stub.incoming_len()
    }
    pub fn stub_mut(&mut self) -> &mut StdioTransportStub {
        &mut self.stub
    }
    pub fn limiter_mut(&mut self) -> &mut RateLimiter {
        &mut self.limiter
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::PeerCredentials;

    #[test]
    fn frame_roundtrip() {
        let p = b"hello";
        let wire = encode_frame(p).unwrap();
        let (f, c) = decode_frame(&wire).unwrap();
        assert_eq!(c, 4 + p.len());
        assert_eq!(f.payload(), p);
    }

    #[test]
    fn framer_incremental() {
        let mut fr = Framer::new();
        let w1 = encode_frame(b"a").unwrap();
        let w2 = encode_frame(b"bb").unwrap();
        let mut conc = w1.clone();
        conc.extend_from_slice(&w2);
        let first_half = &conc[..3];
        let second_half = &conc[3..];
        assert_eq!(fr.push_bytes(first_half).unwrap().len(), 0);
        let out = fr.push_bytes(second_half).unwrap();
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn rate_limiter_shared_timeline() {
        let mut lim = RateLimiter::new(2, 2);
        lim.check(0).unwrap();
        lim.check(0).unwrap();
        assert_eq!(lim.count_in_window(1000), 0);
        lim.check(500).unwrap();
        lim.check(500).unwrap();
        assert_eq!(lim.count_in_window(1500), 2);
        assert!(matches!(
            lim.check(1500),
            Err(TransportError::RateLimited(_))
        ));
        assert_eq!(lim.count_in_window(0), 2);
        assert_eq!(lim.count_in_window(2000), 0);
    }

    #[test]
    fn rate_limiter_count_before_check() {
        let mut lim = RateLimiter::new(2, 2);
        assert_eq!(lim.count_in_window(1000), 0);
        lim.check(0).unwrap();
        assert_eq!(lim.count_in_window(1000), 1);
        assert_eq!(lim.count_in_window(1999), 1);
        assert_eq!(lim.count_in_window(2000), 0);
    }

    #[test]
    fn rate_limiter_integer_boundaries() {
        for end in [(1_u64 << 53) - 1, u64::MAX] {
            let mut lim = RateLimiter::new(2, 4);
            for _ in 0..4 {
                lim.check(end - 1500).unwrap();
            }
            for _ in 0..2 {
                lim.check(end - 500).unwrap();
            }
            assert!(matches!(
                lim.check(end - 1),
                Err(TransportError::RateLimited(_))
            ));
            lim.check(end).unwrap();
            assert!(matches!(
                lim.check(end),
                Err(TransportError::RateLimited(_))
            ));
        }
        let mut lim = RateLimiter::new(u32::MAX, u32::MAX);
        assert!(lim.is_empty());
        assert_eq!(lim.timestamps.capacity(), 0);
        lim.check(0).unwrap();
        lim.check(u64::MAX).unwrap();
        assert_eq!(lim.count_in_window(u64::MAX), 1);
    }

    #[test]
    fn rate_limiter_rate_above_burst() {
        let mut lim = RateLimiter::new(u32::MAX, 1);
        lim.check(0).unwrap();
        assert!(matches!(
            lim.check(999),
            Err(TransportError::RateLimited(_))
        ));
        lim.check(1000).unwrap();
        lim.check((1_u64 << 53) - 1).unwrap();
        assert!(matches!(
            lim.check((1_u64 << 53) - 1),
            Err(TransportError::RateLimited(_))
        ));
    }

    #[test]
    fn rate_limiter_rc9_defaults() {
        let mut lim = RateLimiter::rc9_default();
        for _ in 0..RC9_BURST_PER_SEC {
            lim.check(0).unwrap();
        }
        assert!(matches!(lim.check(0), Err(TransportError::RateLimited(_))));
        for _ in 0..RC9_REQ_PER_SEC {
            lim.check(RC9_WINDOW_MS).unwrap();
        }
        assert!(matches!(
            lim.check(RC9_WINDOW_MS),
            Err(TransportError::RateLimited(_))
        ));
    }

    #[test]
    fn rate_limiter_sustained_refill() {
        let mut lim = RateLimiter::new(2, 4);
        for _ in 0..4 {
            lim.check(0).unwrap();
        }
        assert!(matches!(lim.check(0), Err(TransportError::RateLimited(_))));
        for second in 1..=10 {
            let now_ms = second * RC9_WINDOW_MS;
            for _ in 0..2 {
                lim.check(now_ms).unwrap();
            }
            assert!(matches!(
                lim.check(now_ms),
                Err(TransportError::RateLimited(_))
            ));
            assert_eq!(lim.count_in_window(now_ms), 2);
        }
    }

    #[test]
    fn rate_limiter_fractional_refill() {
        let mut lim = RateLimiter::new(3, 6);
        for _ in 0..6 {
            lim.check(0).unwrap();
        }
        for _ in 0..3 {
            lim.check(1000).unwrap();
        }
        for now_ms in [1100, 1200, 1300, 1333] {
            assert!(matches!(
                lim.check(now_ms),
                Err(TransportError::RateLimited(_))
            ));
        }
        assert_eq!(lim.count_in_window(1333), 3);
        assert!(lim.check(1334).is_ok());
        assert!(matches!(
            lim.check(1334),
            Err(TransportError::RateLimited(_))
        ));
    }

    #[test]
    fn rate_limiter_idle_credit_and_burst_ceiling() {
        let mut lim = RateLimiter::new(2, 4);
        lim.check(0).unwrap();
        for _ in 0..4 {
            lim.check(60_000).unwrap();
        }
        for now_ms in [60_000, 60_500] {
            assert!(matches!(
                lim.check(now_ms),
                Err(TransportError::RateLimited(_))
            ));
        }
        for _ in 0..2 {
            lim.check(61_000).unwrap();
        }
        assert!(matches!(
            lim.check(61_000),
            Err(TransportError::RateLimited(_))
        ));
    }

    #[test]
    fn rate_limiter_clock_regression() {
        let mut lim = RateLimiter::new(2, 4);
        for _ in 0..4 {
            lim.check(1000).unwrap();
        }
        for _ in 0..2 {
            lim.check(2000).unwrap();
        }
        for now_ms in [1500, 2000, 2499] {
            assert!(matches!(
                lim.check(now_ms),
                Err(TransportError::RateLimited(_))
            ));
        }
        assert!(lim.check(2500).is_ok());
    }

    #[test]
    fn rate_limiter_zero_limits() {
        let mut lim = RateLimiter::new(0, 1);
        lim.check(0).unwrap();
        assert!(matches!(
            lim.check(60_000),
            Err(TransportError::RateLimited(_))
        ));
        assert!(matches!(
            RateLimiter::new(2, 0).check(60_000),
            Err(TransportError::RateLimited(_))
        ));
    }

    #[test]
    fn transport_peer_ok() {
        let peer = PeerCredentials::new(1000, 1000, 1);
        let mut t = IpcTransport::with_defaults(
            1000,
            "/run/user/1000/bitty/default.sock".into(),
            Some(peer),
        );
        assert!(t.connect().is_ok());
        assert!(t.is_connected());
    }

    #[test]
    fn reconnect_admission_ignores_completed_request_history() {
        let mut t = IpcTransport::with_defaults(
            1000,
            "/unused/headless.sock".into(),
            Some(PeerCredentials::new(1000, 1000, 1)),
        );
        for cycle in 0..2 {
            t.connect().unwrap();
            for _ in 0..=RC9_MAX_CONNECTIONS {
                t.send_request("{}", 0).unwrap();
                assert!(t.stub_mut().recv_outgoing().is_some());
            }
            assert!(t.connect().is_ok());
            assert!(t.is_connected());
            t.stub_mut().inject_incoming_payload(b"{}").unwrap();
            t.disconnect();
            t.disconnect();
            assert!(!t.is_connected());
            assert_eq!(t.outgoing_len(), 0);
            assert_eq!(t.incoming_len(), 0);
            assert_eq!(t.requests, (cycle + 1) * (RC9_MAX_CONNECTIONS + 1));
            assert_eq!(t.limiter_mut().count_in_window(0), t.requests);
        }
        assert!(t.connect().is_ok());
        t.disconnect();
    }

    #[test]
    fn reconnect_preserves_rate_credit_and_releases_closed_ownership() {
        let mut t = IpcTransport::new(
            1000,
            "/unused/headless.sock".into(),
            Some(PeerCredentials::new(1000, 1000, 1)),
            0o700,
            0o600,
            1000,
            1000,
            1,
        );
        t.limiter = RateLimiter::new(0, 3);
        t.connect().unwrap();
        t.send_request("{}", 0).unwrap();
        assert!(matches!(
            t.send_request("{}", 0),
            Err(TransportError::TransportFull { .. })
        ));
        assert!(t.is_connected());
        t.disconnect();
        assert_eq!(t.outgoing_len(), 0);
        t.connect().unwrap();
        t.send_request("{}", 0).unwrap();
        assert_eq!(t.requests, 2);
        assert_eq!(t.limiter_mut().count_in_window(0), 3);
        t.disconnect();
        t.connect().unwrap();
        assert!(matches!(
            t.send_request("{}", 0),
            Err(TransportError::RateLimited(_))
        ));
        assert!(t.is_connected());
        t.stub_mut().close();
        assert!(matches!(
            t.send_request("{}", 0),
            Err(TransportError::TransportClosed)
        ));
        assert!(!t.is_connected());
        assert_eq!(t.outgoing_len(), 0);
        assert!(matches!(t.connect(), Err(TransportError::TransportClosed)));
        t.disconnect();
        assert!(matches!(t.connect(), Err(TransportError::TransportClosed)));
        assert!(!t.is_connected());
        assert_eq!(t.requests, 2);
        assert_eq!(t.limiter_mut().count_in_window(0), 3);
    }

    #[test]
    fn reconnect_failure_preserves_ownership_and_rechecks_peer() {
        let mut t = IpcTransport::with_defaults(
            1000,
            "/unused/headless.sock".into(),
            Some(PeerCredentials::new(1001, 1000, 1)),
        );
        assert!(matches!(
            t.connect(),
            Err(TransportError::Unauthenticated(_))
        ));
        assert!(!t.is_connected());
        t.disconnect();
        t.peer = Some(PeerCredentials::new(1000, 1000, 1));
        t.connect().unwrap();
        t.peer = Some(PeerCredentials::new(1001, 1000, 1));
        assert!(matches!(
            t.connect(),
            Err(TransportError::Unauthenticated(_))
        ));
        assert!(matches!(
            t.send_request("{}", 0),
            Err(TransportError::Unauthenticated(_))
        ));
        t.disconnect();
        t.peer = Some(PeerCredentials::new(1000, 1000, 1));
        assert!(t.connect().is_ok());
        t.disconnect();
    }

    #[test]
    fn transport_peer_mismatch_fails() {
        let peer = PeerCredentials::new(1001, 1000, 1);
        let mut t = IpcTransport::with_defaults(
            1000,
            "/run/user/1000/bitty/default.sock".into(),
            Some(peer),
        );
        assert!(t.connect().is_err());
    }

    #[test]
    fn windows_pipe_mismatch_fails_at_connect() {
        // CTX-0043: pipe verify must run at connect, not stay dead code.
        let peer = PeerCredentials::new(1000, 1000, 1);
        let mut t = IpcTransport::with_windows_pipe(
            1000,
            "\\\\.\\pipe\\bitty-default".into(),
            Some(peer),
            1001,
            1000,
            DEFAULT_TRANSPORT_CAPACITY,
        );
        let err = t.connect().expect_err("foreign SID must fail closed");
        assert!(err.to_string().contains("pipe peer sid"), "{err}");
        assert!(!t.is_connected());
    }

    #[test]
    fn windows_pipe_verified_at_connect_and_per_action() {
        // CTX-0043: matching SIDs pass connect and the per-action check.
        let peer = PeerCredentials::new(1000, 1000, 1);
        let mut t = IpcTransport::with_windows_pipe(
            1000,
            "\\\\.\\pipe\\bitty-default".into(),
            Some(peer),
            1000,
            1000,
            DEFAULT_TRANSPORT_CAPACITY,
        );
        assert!(t.connect().is_ok());
        assert!(t.verify_peer_for_privileged().is_ok());
        assert!(t.verify_windows_pipe(1001, 1000).is_err());
    }

    #[test]
    fn stub_forward() {
        let mut a = StdioTransportStub::new(8);
        let mut b = StdioTransportStub::new(8);
        a.try_send_payload(b"msg").unwrap();
        assert_eq!(a.forward_to(&mut b), 1);
        assert_eq!(b.recv_incoming().unwrap().payload(), b"msg");
    }
}
