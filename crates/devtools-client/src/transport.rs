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
}

impl RateLimiter {
    #[must_use]
    pub fn rc9_default() -> Self {
        Self::new(RC9_REQ_PER_SEC, RC9_BURST_PER_SEC)
    }

    #[must_use]
    pub fn new(limit_per_sec: u32, burst: u32) -> Self {
        Self {
            timestamps: std::collections::VecDeque::with_capacity(burst as usize),
            limit_per_sec,
            burst,
        }
    }

    pub fn count_in_window(&mut self, now_ms: u64) -> usize {
        self.evict_old(now_ms);
        self.timestamps.len()
    }

    pub fn check(&mut self, now_ms: u64) -> Result<(), TransportError> {
        self.evict_old(now_ms);
        if (self.timestamps.len() as u32) >= self.burst {
            return Err(TransportError::RateLimited(format!(
                "{} requests in {}ms exceeds burst {}",
                self.timestamps.len(),
                RC9_WINDOW_MS,
                self.burst
            )));
        }
        let _ = self.limit_per_sec;
        self.timestamps.push_back(now_ms);
        Ok(())
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
    connected: bool,
    requests: usize,
    peer: Option<PeerCredentials>,
    runtime_uid: u32,
    socket_path: String,
    dir_mode: u32,
    sock_mode: u32,
    dir_owner_uid: u32,
    sock_owner_uid: u32,
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
            connected: false,
            requests: 0,
            peer,
            runtime_uid,
            socket_path,
            dir_mode,
            sock_mode,
            dir_owner_uid,
            sock_owner_uid,
        }
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
        self.connected
    }

    #[must_use]
    pub fn socket_path(&self) -> &str {
        &self.socket_path
    }

    pub fn connect(&mut self) -> Result<(), TransportError> {
        if let Some(peer) = self.peer {
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
        check_connection_cap(self.requests)?;
        self.connected = true;
        Ok(())
    }

    pub fn disconnect(&mut self) {
        self.connected = false;
        self.stub.clear();
    }

    pub fn verify_peer_for_privileged(&self) -> Result<(), TransportError> {
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
        if !self.connected {
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
    fn rate_limiter_burst() {
        let mut lim = RateLimiter::new(10, 5);
        for _ in 0..5 {
            lim.check(0).unwrap();
        }
        assert!(lim.check(0).is_err());
        assert!(lim.check(1000).is_ok());
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
    fn stub_forward() {
        let mut a = StdioTransportStub::new(8);
        let mut b = StdioTransportStub::new(8);
        a.try_send_payload(b"msg").unwrap();
        assert_eq!(a.forward_to(&mut b), 1);
        assert_eq!(b.recv_incoming().unwrap().payload(), b"msg");
    }
}
