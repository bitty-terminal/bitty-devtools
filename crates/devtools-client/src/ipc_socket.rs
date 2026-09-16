//! Live Unix IPC socket seam for DevTools (CTX-0036, H-DEV-06).
//!
//! `transport::IpcTransport` is a headless stub: `connect()` verifies
//! caller-supplied mode values and flips a flag without ever dialing the OS
//! socket, so every `request()` fails closed with `TransportClosed`. This
//! module is the minimal live path that actually dials the socket `bitty`
//! serves (`bitty-app/src/ipc_serve.rs`) at the resolved path
//! (`<base>/bitty/<instance>.sock`, see `auth::resolve_socket_path`): it
//! stats the endpoint (directory `0700`, socket `0600`, same owner as the
//! runtime UID), dials with blocking `std::os::unix::net::UnixStream`, and
//! does one framed request/response round trip using the shared `u32 BE` +
//! payload framing.
//!
//! Security properties (mirror the `bitty-ipc` contract, fail closed):
//! - The endpoint directory must exist, must not be a symlink, must be mode
//!   `0700`, and must be owned by the runtime UID; the socket itself must be
//!   mode `0600` and owned by the runtime UID. Anything else refuses to dial.
//! - Responses are untrusted observation data: bounded at 256 KiB, framed
//!   exactly once, and returned as raw bytes for the caller to decode.
//! - Unix only. The Windows named-pipe dial stays with CTX-0043 and is not
//!   duplicated here; on non-Unix targets every entry point fails closed.
//! - No `unsafe`: only blocking std I/O with read/write timeouts.

use crate::auth::{AuthError, DIR_MODE, SOCKET_MODE, resolve_socket_path};
use crate::transport::{MAX_FRAME_BYTES, TransportError, decode_frame, encode_frame};

/// Per-dial and per-response timeout (matches the TS seam).
pub const LIVE_SOCKET_TIMEOUT_SECS: u64 = 5;

/// Resolved dial target: the attested path plus the owning runtime UID.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveSocketEndpoint {
    /// Attested socket path to dial.
    pub socket_path: String,
    /// Owning runtime UID (endpoint owner + dialing peer).
    pub runtime_uid: u32,
}

/// Dial configuration: explicit path wins, otherwise advisory discovery.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LiveSocketConfig {
    /// Explicit socket path (skips discovery).
    pub socket_path: Option<String>,
    /// Owning runtime UID.
    pub runtime_uid: u32,
    /// `XDG_RUNTIME_DIR` override for discovery.
    pub xdg_runtime_dir: Option<String>,
    /// `BITTY_SOCKET` advisory override for discovery.
    pub bitty_socket: Option<String>,
    /// Instance id for discovery (`default` when absent).
    pub instance_id: Option<String>,
}

/// Resolve the dial target: explicit path wins, otherwise the advisory
/// `BITTY_SOCKET` / `XDG_RUNTIME_DIR` / instance discovery from `auth`.
pub fn resolve_live_socket_endpoint(
    config: &LiveSocketConfig,
) -> Result<LiveSocketEndpoint, TransportError> {
    let socket_path = match &config.socket_path {
        Some(p) if !p.is_empty() => p.clone(),
        _ => resolve_socket_path(
            config.runtime_uid,
            config.xdg_runtime_dir.as_deref(),
            config.bitty_socket.as_deref(),
            config.instance_id.as_deref(),
        )
        .map_err(|e| TransportError::Unauthenticated(e.to_string()))?,
    };
    Ok(LiveSocketEndpoint {
        socket_path,
        runtime_uid: config.runtime_uid,
    })
}

fn parent_dir_of(path: &str) -> &str {
    match path.rfind('/') {
        Some(0) | None => "/",
        Some(i) => &path[..i],
    }
}

fn leaf_of(path: &str) -> &str {
    match path.rfind('/') {
        Some(i) => &path[i + 1..],
        None => path,
    }
}

/// Attest the endpoint before dialing (Unix only).
///
/// The parent directory must be `0700` and runtime-owned, the socket must
/// exist, be a real socket (not a symlink), be mode `0600`, and be
/// runtime-owned. Mirrors the server-side attestation in `bitty-ipc`
/// `devtools::prepare_socket_dir` / `attest_bound_socket`.
#[cfg(unix)]
pub fn attest_live_socket_endpoint(endpoint: &LiveSocketEndpoint) -> Result<(), TransportError> {
    use std::os::unix::fs::FileTypeExt;

    let fail = |message: String| TransportError::Unauthenticated(message);
    if endpoint.socket_path.contains('\0') {
        return Err(fail("socket path contains NUL".to_string()));
    }
    let parent = parent_dir_of(&endpoint.socket_path);
    let dir_meta = std::fs::symlink_metadata(parent)
        .map_err(|_| fail(format!("socket directory '{parent}' does not exist")))?;
    let sock_meta = std::fs::symlink_metadata(&endpoint.socket_path)
        .map_err(|_| fail(format!("socket '{}' does not exist", endpoint.socket_path)))?;
    if dir_meta.file_type().is_symlink() {
        return Err(fail(format!(
            "socket directory '{parent}' is a symlink (refusing to dial)"
        )));
    }
    if sock_meta.file_type().is_symlink() {
        return Err(fail(format!(
            "socket '{}' is a symlink (refusing to dial)",
            endpoint.socket_path
        )));
    }
    if !sock_meta.file_type().is_socket() {
        return Err(fail(format!("'{}' is not a socket", endpoint.socket_path)));
    }
    use std::os::unix::fs::MetadataExt;
    if dir_meta.mode() & 0o777 != DIR_MODE {
        return Err(fail(format!(
            "socket directory '{parent}' mode {:o} != {:o} (must be 0700)",
            dir_meta.mode() & 0o777,
            DIR_MODE
        )));
    }
    if sock_meta.mode() & 0o777 != SOCKET_MODE {
        return Err(fail(format!(
            "socket '{}' mode {:o} != {:o} (must be 0600)",
            leaf_of(&endpoint.socket_path),
            sock_meta.mode() & 0o777,
            SOCKET_MODE
        )));
    }
    if dir_meta.uid() != endpoint.runtime_uid {
        return Err(fail(format!(
            "socket directory '{parent}' owner uid {} != runtime uid {}",
            dir_meta.uid(),
            endpoint.runtime_uid
        )));
    }
    if sock_meta.uid() != endpoint.runtime_uid {
        return Err(fail(format!(
            "socket '{}' owner uid {} != runtime uid {}",
            leaf_of(&endpoint.socket_path),
            sock_meta.uid(),
            endpoint.runtime_uid
        )));
    }
    Ok(())
}

/// Non-Unix stub: there is no `AF_UNIX` dial here (named pipe stays with
/// CTX-0043), so attestation always fails closed.
#[cfg(not(unix))]
pub fn attest_live_socket_endpoint(endpoint: &LiveSocketEndpoint) -> Result<(), TransportError> {
    Err(TransportError::Unauthenticated(format!(
        "live Unix socket dial is unsupported on this platform (refusing '{}')",
        endpoint.socket_path
    )))
}

/// One live `AF_UNIX` connection (Unix only): owns the stream, frames one
/// request/response round trip, and closes on drop.
#[cfg(unix)]
#[derive(Debug)]
pub struct LiveSocketConnection {
    stream: std::os::unix::net::UnixStream,
    socket_path: String,
}

#[cfg(unix)]
impl LiveSocketConnection {
    /// The attested path this connection dialed.
    #[must_use]
    pub fn socket_path(&self) -> &str {
        &self.socket_path
    }

    /// Write one framed request and read the next framed response payload
    /// (raw bytes, still to be JSON-decoded by the caller). Bounded at one
    /// 256 KiB frame each way, matching the `bitty-ipc` framing. Times out
    /// instead of blocking forever.
    pub fn request_response(
        &mut self,
        request_json: &[u8],
        _now_ms: u64,
    ) -> Result<Vec<u8>, TransportError> {
        use std::io::{Read, Write};
        use std::time::Duration;

        if request_json.len() > MAX_FRAME_BYTES {
            return Err(TransportError::FrameTooLarge {
                actual: request_json.len(),
                limit: MAX_FRAME_BYTES,
            });
        }
        self.stream
            .set_read_timeout(Some(Duration::from_secs(LIVE_SOCKET_TIMEOUT_SECS)))
            .map_err(|_| TransportError::TransportClosed)?;
        self.stream
            .set_write_timeout(Some(Duration::from_secs(LIVE_SOCKET_TIMEOUT_SECS)))
            .map_err(|_| TransportError::TransportClosed)?;
        let wire = encode_frame(request_json)?;
        self.stream
            .write_all(&wire)
            .map_err(|_| TransportError::TransportClosed)?;
        self.stream
            .flush()
            .map_err(|_| TransportError::TransportClosed)?;
        let mut header = [0u8; 4];
        self.stream
            .read_exact(&mut header)
            .map_err(|_| TransportError::TransportClosed)?;
        let len = u32::from_be_bytes(header) as usize;
        if len > MAX_FRAME_BYTES {
            return Err(TransportError::FrameTooLarge {
                actual: len,
                limit: MAX_FRAME_BYTES,
            });
        }
        let mut payload = vec![0u8; len];
        self.stream
            .read_exact(&mut payload)
            .map_err(|_| TransportError::TransportClosed)?;
        // Re-validate through the shared decoder so overlong/truncated
        // input fails with the same vocabulary as the headless path.
        let mut raw = header.to_vec();
        raw.extend_from_slice(&payload);
        let (frame, _consumed) = decode_frame(&raw)?;
        Ok(frame.payload().to_vec())
    }
}

/// Dial the live socket (Unix only). Attests the endpoint first (fail
/// closed), then opens one blocking `AF_UNIX` connection with timeouts.
/// The caller owns the connection.
#[cfg(unix)]
pub fn connect_live_socket(
    config: &LiveSocketConfig,
) -> Result<LiveSocketConnection, TransportError> {
    use std::time::Duration;

    let endpoint = resolve_live_socket_endpoint(config)?;
    attest_live_socket_endpoint(&endpoint)?;
    let stream = std::os::unix::net::UnixStream::connect(&endpoint.socket_path)
        .map_err(|_| TransportError::TransportClosed)?;
    stream
        .set_read_timeout(Some(Duration::from_secs(LIVE_SOCKET_TIMEOUT_SECS)))
        .map_err(|_| TransportError::TransportClosed)?;
    stream
        .set_write_timeout(Some(Duration::from_secs(LIVE_SOCKET_TIMEOUT_SECS)))
        .map_err(|_| TransportError::TransportClosed)?;
    Ok(LiveSocketConnection {
        stream,
        socket_path: endpoint.socket_path,
    })
}

/// Non-Unix stub: no `AF_UNIX` dial here, fail closed.
#[cfg(not(unix))]
pub fn connect_live_socket(_config: &LiveSocketConfig) -> Result<(), TransportError> {
    Err(TransportError::TransportClosed)
}

impl From<AuthError> for TransportError {
    fn from(value: AuthError) -> Self {
        Self::Unauthenticated(value.to_string())
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::os::unix::net::UnixListener;

    fn test_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "bitty-devtools-ctx0036-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        dir
    }

    fn framed(payload: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(4 + payload.len());
        out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        out.extend_from_slice(payload);
        out
    }

    #[test]
    fn live_round_trip_over_loopback_socket() {
        let dir = test_dir("round-trip");
        let path = dir.join("loopback.sock");
        let listener = UnixListener::bind(&path).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let uid = current_uid(&dir);
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut header = [0u8; 4];
            stream.read_exact(&mut header).unwrap();
            let len = u32::from_be_bytes(header) as usize;
            let mut body = vec![0u8; len];
            stream.read_exact(&mut body).unwrap();
            assert!(
                String::from_utf8(body)
                    .unwrap()
                    .contains("bitty.debug/listPlugins")
            );
            let response = br#"{"jsonrpc":"2.0","id":7,"result":{"plugins":[]},"version":"1.0"}"#;
            stream.write_all(&framed(response)).unwrap();
            stream.flush().unwrap();
        });
        let endpoint = LiveSocketEndpoint {
            socket_path: path.to_string_lossy().into_owned(),
            runtime_uid: uid,
        };
        attest_live_socket_endpoint(&endpoint).unwrap();
        let config = LiveSocketConfig {
            socket_path: Some(endpoint.socket_path.clone()),
            runtime_uid: uid,
            ..LiveSocketConfig::default()
        };
        let mut conn = connect_live_socket(&config).unwrap();
        assert_eq!(conn.socket_path(), endpoint.socket_path);
        let request = br#"{"id":7,"method":"bitty.debug/listPlugins","params":{},"version":"1.0"}"#;
        let raw = conn.request_response(request, 0).unwrap();
        let decoded: serde_like::JsonResponse = serde_like::parse(&raw);
        assert_eq!(decoded.id, 7);
        server.join().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn wrong_mode_fails_closed_before_dial() {
        let dir = test_dir("wrong-mode");
        let path = dir.join("loopback.sock");
        // A fresh bind inherits umask-derived modes (0755 here), not the
        // required 0600: attestation must refuse before any dial.
        let _listener = UnixListener::bind(&path).unwrap();
        let uid = current_uid(&dir);
        let endpoint = LiveSocketEndpoint {
            socket_path: path.to_string_lossy().into_owned(),
            runtime_uid: uid,
        };
        let err = attest_live_socket_endpoint(&endpoint).unwrap_err();
        assert!(
            matches!(err, TransportError::Unauthenticated(_)),
            "expected Unauthenticated, got {err}"
        );
        drop(_listener);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Current UID for test attestation: owner of the test directory
    /// itself (no libc dep, no unsafe, no temp-dir probe races).
    /// Production compares the stat UID against the caller-supplied
    /// runtime UID; tests just need the real local UID.
    fn current_uid(dir: &std::path::Path) -> u32 {
        use std::os::unix::fs::MetadataExt;
        std::fs::metadata(dir).unwrap().uid()
    }

    /// Minimal JSON id extraction without a serde dep.
    mod serde_like {
        pub struct JsonResponse {
            pub id: i64,
        }

        pub fn parse(raw: &[u8]) -> JsonResponse {
            let text = String::from_utf8(raw.to_vec()).unwrap();
            let marker = "\"id\":";
            let start = text.find(marker).unwrap() + marker.len();
            let rest = text[start..].trim_start();
            let end = rest
                .find(|c: char| !c.is_ascii_digit() && c != '-')
                .unwrap_or(rest.len());
            JsonResponse {
                id: rest[..end].parse().unwrap(),
            }
        }
    }
}
