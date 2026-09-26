#![forbid(unsafe_code)]
//! Headless authentication and endpoint-policy helpers for DevTools.
//!
//! Mirrors `bitty-ipc` policy values: Unix socket 0700/0600, Windows named
//! pipe ACL, and peer UID equality. Verification is bounded and requires no
//! `unsafe`. This module does not extract `SO_PEERCRED` or
//! `GetNamedPipeClientProcessId` values and does not establish a live peer
//! identity; it verifies caller-supplied triples in the headless fixture.
//! The implemented live adapter separately attests endpoint ownership and
//! mode and remains inspect-only.

pub const DIR_MODE: u32 = 0o700;
pub const SOCKET_MODE: u32 = 0o600;
pub const MAX_CHILD_TOKENS: usize = 64;
pub const MAX_SCOPED_ID_BYTES: usize = 64;
pub const CHILD_TOKEN_TTL_MS: u64 = 60_000;
pub const MAX_TOKEN_TTL_MS: u64 = 60_000;

/// Portable `AF_UNIX` socket-path ceiling in payload bytes (excl. NUL).
///
/// Mirrors `bitty-ipc` `devtools::MAX_SOCKET_PATH_BYTES`: 100 payload bytes
/// fits Linux (108 incl. NUL) and macOS/BSD (104 incl. NUL) with margin.
pub const MAX_SOCKET_PATH_BYTES: usize = 100;
pub const SUN_LEN_LINUX: usize = 108;
pub const SUN_LEN_MACOS: usize = 104;
pub const SOCKET_LEAF_DIR: &str = "bitty";
pub const DEFAULT_INSTANCE_ID: &str = "default";

/// Constant-time token comparison over raw bytes.
///
/// Byte length is compared first (fail-closed `false`); the content loop
/// always accumulates the full XOR difference via `subtle::ConstantTimeEq`
/// so comparison time does not leak the shared-prefix length of a candidate.
#[must_use]
pub fn constant_time_token_eq(a: &str, b: &str) -> bool {
    use subtle::ConstantTimeEq;
    let ab = a.as_bytes();
    let bb = b.as_bytes();
    if ab.len() != bb.len() {
        return false;
    }
    ab.ct_eq(bb).unwrap_u8() == 1
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct PeerCredentials {
    pub uid: u32,
    pub gid: u32,
    pub pid: i32,
}

impl PeerCredentials {
    #[must_use]
    pub fn new(uid: u32, gid: u32, pid: i32) -> Self {
        Self { uid, gid, pid }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthError {
    Unauthenticated(String),
    ScopeDenied(String),
    LimitExceeded(String),
    InvalidRequest(String),
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unauthenticated(s) => write!(f, "unauthenticated: {s}"),
            Self::ScopeDenied(s) => write!(f, "scope denied: {s}"),
            Self::LimitExceeded(s) => write!(f, "limit exceeded: {s}"),
            Self::InvalidRequest(s) => write!(f, "invalid: {s}"),
        }
    }
}
impl std::error::Error for AuthError {}

pub fn verify_peer_uid(peer: PeerCredentials, expected_uid: u32) -> Result<(), AuthError> {
    if peer.uid == expected_uid {
        Ok(())
    } else {
        Err(AuthError::Unauthenticated(format!(
            "peer uid {} != runtime uid {}",
            peer.uid, expected_uid
        )))
    }
}

pub fn verify_unix_endpoint(
    runtime_uid: u32,
    peer: PeerCredentials,
    dir_mode: u32,
    dir_owner_uid: u32,
    sock_mode: u32,
    sock_owner_uid: u32,
) -> Result<(), AuthError> {
    if dir_mode != DIR_MODE {
        return Err(AuthError::Unauthenticated(format!(
            "directory mode {dir_mode:o} != {:o} (must be 0700)",
            DIR_MODE
        )));
    }
    if sock_mode != SOCKET_MODE {
        return Err(AuthError::Unauthenticated(format!(
            "socket mode {sock_mode:o} != {:o} (must be 0600)",
            SOCKET_MODE
        )));
    }
    if dir_owner_uid != runtime_uid {
        return Err(AuthError::Unauthenticated(format!(
            "directory owner {dir_owner_uid} != runtime {runtime_uid}"
        )));
    }
    if sock_owner_uid != runtime_uid {
        return Err(AuthError::Unauthenticated(format!(
            "socket owner {sock_owner_uid} != runtime {runtime_uid}"
        )));
    }
    verify_peer_uid(peer, runtime_uid)
}

pub fn verify_windows_pipe(peer_sid: u64, runtime_sid: u64) -> Result<(), AuthError> {
    if peer_sid == runtime_sid {
        Ok(())
    } else {
        Err(AuthError::Unauthenticated(format!(
            "pipe peer sid {peer_sid} != runtime sid {runtime_sid}"
        )))
    }
}

/// Deterministic 64-bit FNV-1a hash rendered as 16 lowercase hex chars.
///
/// Byte-for-byte parity with `bitty-ipc` `devtools::short_instance_hash`
/// (`OFFSET = 0xcbf29ce484222325`, `PRIME = 0x100000001b3`, wrapping u64).
/// Used to clamp a long instance id into a socket leaf that fits
/// [`MAX_SOCKET_PATH_BYTES`]; it is not a security hash.
#[must_use]
pub fn short_instance_hash(instance: &str) -> String {
    const OFFSET: u64 = 0xcbf29ce484222325;
    const PRIME: u64 = 0x100000001b3;
    let mut hash = OFFSET;
    for byte in instance.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(PRIME);
    }
    format!("{hash:016x}")
}

/// Resolve the Unix socket path with `bitty-ipc` precedence and a portable
/// `AF_UNIX` bound.
///
/// Precedence: non-empty `BITTY_SOCKET` (the explicit dial target) wins
/// verbatim; otherwise
/// `<base>/bitty/<instance>.sock` where `base` is `XDG_RUNTIME_DIR` or
/// `/run/user/<uid>`, and `instance` is `BITTY_INSTANCE_ID` or `default`.
///
/// When the direct form exceeds [`MAX_SOCKET_PATH_BYTES`] the instance id is
/// clamped to its 16-hex FNV-1a hash; when even that is too long the base
/// directory is too long and resolution fails closed.
pub fn resolve_socket_path(
    runtime_uid: u32,
    xdg_runtime_dir: Option<&str>,
    bitty_socket: Option<&str>,
    instance_id: Option<&str>,
) -> Result<String, AuthError> {
    if let Some(p) = bitty_socket {
        if !p.is_empty() {
            if p.contains('\0') {
                return Err(AuthError::InvalidRequest(
                    "BITTY_SOCKET contains NUL".to_string(),
                ));
            }
            if p.len() > MAX_SOCKET_PATH_BYTES {
                return Err(AuthError::InvalidRequest(format!(
                    "BITTY_SOCKET path too long for AF_UNIX ({} > {MAX_SOCKET_PATH_BYTES} payload bytes; portable SUN_LEN: Linux {SUN_LEN_LINUX} / macOS {SUN_LEN_MACOS} incl. NUL)",
                    p.len()
                )));
            }
            return Ok(p.to_string());
        }
    }
    let base = match xdg_runtime_dir {
        Some(dir) if !dir.is_empty() => dir.to_string(),
        _ => format!("/run/user/{runtime_uid}"),
    };
    let instance = instance_id.unwrap_or(DEFAULT_INSTANCE_ID);
    if instance.is_empty() || instance.len() > 64 {
        return Err(AuthError::InvalidRequest("instanceId 1..64".to_string()));
    }
    if !instance
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(AuthError::InvalidRequest(
            "instanceId must match ^[a-z0-9_-]+$".to_string(),
        ));
    }
    let direct = format!("{base}/{SOCKET_LEAF_DIR}/{instance}.sock");
    if direct.len() <= MAX_SOCKET_PATH_BYTES {
        return Ok(direct);
    }
    let hashed = format!(
        "{base}/{SOCKET_LEAF_DIR}/{}.sock",
        short_instance_hash(instance)
    );
    if hashed.len() <= MAX_SOCKET_PATH_BYTES {
        return Ok(hashed);
    }
    Err(AuthError::InvalidRequest(format!(
        "socket base dir too long for AF_UNIX ({} > {MAX_SOCKET_PATH_BYTES} payload bytes even with hashed instance; portable SUN_LEN: Linux {SUN_LEN_LINUX} / macOS {SUN_LEN_MACOS} incl. NUL; shorten XDG_RUNTIME_DIR or set BITTY_SOCKET)",
        hashed.len()
    )))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChildToken {
    pub token: String,
    pub scope: String,
    pub scoped_id: String,
    pub created_at_ms: u64,
    pub ttl_ms: u64,
}

impl ChildToken {
    pub fn new(
        token: String,
        scope: String,
        scoped_id: String,
        created_at_ms: u64,
        ttl_ms: u64,
    ) -> Result<Self, AuthError> {
        if token.is_empty() || token.len() > 128 {
            return Err(AuthError::InvalidRequest(format!(
                "child token 1..128, got {}",
                token.len()
            )));
        }
        if scoped_id.len() > MAX_SCOPED_ID_BYTES {
            return Err(AuthError::InvalidRequest(format!(
                "scopedId > {}",
                MAX_SCOPED_ID_BYTES
            )));
        }
        if ttl_ms == 0 || ttl_ms > MAX_TOKEN_TTL_MS {
            return Err(AuthError::InvalidRequest(format!(
                "ttlMs 1..{}",
                MAX_TOKEN_TTL_MS
            )));
        }
        if token.bytes().any(|b| b < 0x20 || b == 0x7F)
            || scoped_id.bytes().any(|b| b < 0x20 || b == 0x7F)
        {
            return Err(AuthError::InvalidRequest(
                "token/scoped_id must not contain control bytes".to_string(),
            ));
        }
        Ok(Self {
            token,
            scope,
            scoped_id,
            created_at_ms,
            ttl_ms,
        })
    }

    #[must_use]
    pub fn expires_at_ms(&self) -> u64 {
        self.created_at_ms.saturating_add(self.ttl_ms)
    }

    #[must_use]
    pub fn is_expired(&self, now_ms: u64) -> bool {
        now_ms >= self.expires_at_ms()
    }

    #[must_use]
    pub fn authorizes(&self, scope: &str, scoped_id: &str, now_ms: u64) -> bool {
        if self.is_expired(now_ms) {
            return false;
        }
        constant_time_token_eq(&self.scope, scope)
            && constant_time_token_eq(&self.scoped_id, scoped_id)
    }
}

#[derive(Debug, Default)]
pub struct ChildTokenStore {
    tokens: std::collections::BTreeMap<String, ChildToken>,
}

impl ChildTokenStore {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.tokens.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.tokens.is_empty()
    }

    pub fn insert(&mut self, tok: ChildToken) -> Result<(), AuthError> {
        let is_new = !self.tokens.contains_key(&tok.token);
        if is_new && self.tokens.len() >= MAX_CHILD_TOKENS {
            return Err(AuthError::LimitExceeded(format!(
                "child_tokens limit {MAX_CHILD_TOKENS} exceeded"
            )));
        }
        self.tokens.insert(tok.token.clone(), tok);
        Ok(())
    }

    pub fn verify(
        &self,
        token_str: &str,
        scope: &str,
        scoped_id: &str,
        now_ms: u64,
    ) -> Result<(), AuthError> {
        // Linear scan with a constant-time byte compare per candidate: a
        // direct map lookup would let hash-probe timing leak how much of the
        // candidate matches a stored key, so every stored token is compared
        // and exactly one match is accepted. Scope and expiry are checked
        // only after the token comparison to keep failure timing uniform.
        let mut matched: Option<&ChildToken> = None;
        let mut matches = 0usize;
        for candidate in self.tokens.values() {
            if constant_time_token_eq(&candidate.token, token_str) {
                matched = Some(candidate);
                matches += 1;
            }
        }
        let tok = match (matched, matches) {
            (Some(tok), 1) => tok,
            _ => {
                return Err(AuthError::Unauthenticated("unknown child token".into()));
            }
        };
        if tok.is_expired(now_ms) {
            return Err(AuthError::Unauthenticated("child token expired".into()));
        }
        if !constant_time_token_eq(&tok.scope, scope)
            || !constant_time_token_eq(&tok.scoped_id, scoped_id)
        {
            return Err(AuthError::ScopeDenied(format!(
                "child token scope {} id {} mismatch",
                tok.scope, tok.scoped_id
            )));
        }
        Ok(())
    }

    pub fn drain_expired(&mut self, now_ms: u64) -> Vec<String> {
        let expired: Vec<String> = self
            .tokens
            .iter()
            .filter_map(|(k, v)| {
                if v.is_expired(now_ms) {
                    Some(k.clone())
                } else {
                    None
                }
            })
            .collect();
        for k in &expired {
            self.tokens.remove(k);
        }
        expired
    }

    pub fn revoke(&mut self, token_str: &str) -> bool {
        self.tokens.remove(token_str).is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peer_uid_ok() {
        let peer = PeerCredentials::new(1000, 1000, 42);
        assert!(verify_peer_uid(peer, 1000).is_ok());
        assert!(verify_peer_uid(peer, 1001).is_err());
    }

    #[test]
    fn unix_endpoint_ok_and_fail() {
        let peer = PeerCredentials::new(1000, 1000, 1);
        assert!(verify_unix_endpoint(1000, peer, 0o700, 1000, 0o600, 1000).is_ok());
        assert!(verify_unix_endpoint(1000, peer, 0o755, 1000, 0o600, 1000).is_err());
        assert!(verify_unix_endpoint(1000, peer, 0o700, 999, 0o600, 1000).is_err());
    }

    #[test]
    fn socket_path_precedence() {
        let p = resolve_socket_path(1000, None, Some("/tmp/custom.sock"), None).unwrap();
        assert_eq!(p, "/tmp/custom.sock");
        let p2 = resolve_socket_path(1000, Some("/run/user/1000"), None, Some("my-inst")).unwrap();
        assert_eq!(p2, "/run/user/1000/bitty/my-inst.sock");
    }

    #[test]
    fn socket_path_short_unchanged() {
        let p = resolve_socket_path(1000, Some("/run/user/1000"), None, Some("my-inst_1")).unwrap();
        assert_eq!(p, "/run/user/1000/bitty/my-inst_1.sock");
        let d = resolve_socket_path(1000, None, None, None).unwrap();
        assert_eq!(d, "/run/user/1000/bitty/default.sock");
    }

    #[test]
    fn short_instance_hash_matches_bitty_ipc_vectors() {
        // Vectors derived by invoking bitty-ipc `devtools::resolve_socket_path`
        // (the live server implementation), never hand-computed.
        assert_eq!(short_instance_hash(&"c".repeat(64)), "3d3bb39181dc91e5");
        assert_eq!(
            short_instance_hash("worker-abcdefghijklmnopqrstuvwxyz0123456789"),
            "e14c53fe23cdb8ba"
        );
    }

    #[test]
    fn socket_path_long_base_degrades_to_hash() {
        let base = format!("/tmp/{}", "b".repeat(50));
        let instance = "c".repeat(64);
        let p = resolve_socket_path(1000, Some(&base), None, Some(&instance)).unwrap();
        assert_eq!(p, format!("{base}/bitty/3d3bb39181dc91e5.sock"));
        assert!(p.len() <= MAX_SOCKET_PATH_BYTES);
    }

    #[test]
    fn socket_path_overlong_base_fails_closed() {
        let base = format!("/tmp/{}", "d".repeat(120));
        let err = resolve_socket_path(1000, Some(&base), None, None).unwrap_err();
        assert!(format!("{err}").contains("AF_UNIX"));
    }

    #[test]
    fn child_token_lifecycle() {
        let tok = ChildToken::new(
            "tok-abc".into(),
            "terminal.inspect".into(),
            "t:4".into(),
            0,
            60_000,
        )
        .unwrap();
        assert!(!tok.is_expired(59_999));
        assert!(tok.is_expired(60_000));
        assert!(tok.authorizes("terminal.inspect", "t:4", 10_000));
        assert!(!tok.authorizes("terminal.input", "t:4", 10_000));
        let mut store = ChildTokenStore::new();
        store.insert(tok).unwrap();
        assert!(
            store
                .verify("tok-abc", "terminal.inspect", "t:4", 500)
                .is_ok()
        );
        assert!(
            store
                .verify("tok-abc", "terminal.inspect", "t:4", 60_000)
                .is_err()
        );
    }

    #[test]
    fn child_token_rejection_diagnostics_contain_only_fixed_categories() {
        let marker = "benign-marker";
        let mut store = ChildTokenStore::new();
        let check = |store: &ChildTokenStore, message: &str| {
            let err = store
                .verify(marker, "terminal.inspect", "t:4", 60_000)
                .unwrap_err();
            assert_eq!(err, AuthError::Unauthenticated(message.into()));
            assert!(!format!("{err}").contains(marker));
            assert!(!format!("{err:?}").contains(marker));
        };
        check(&store, "unknown child token");
        store
            .insert(
                ChildToken::new(
                    marker.into(),
                    "terminal.inspect".into(),
                    "t:4".into(),
                    0,
                    60_000,
                )
                .unwrap(),
            )
            .unwrap();
        assert!(
            store
                .verify(marker, "terminal.inspect", "t:4", 59_999)
                .is_ok()
        );
        check(&store, "child token expired");
    }

    #[test]
    fn token_compare_is_constant_time_no_early_exit() {
        // Equal inputs compare true.
        assert!(constant_time_token_eq("tok-abc", "tok-abc"));
        // Same-length mismatches at first, middle, and last byte all read
        // false through the full accumulator.
        assert!(!constant_time_token_eq("Xok-abc", "tok-abc"));
        assert!(!constant_time_token_eq("tok-Xbc", "tok-abc"));
        assert!(!constant_time_token_eq("tok-abX", "tok-abc"));
        // Length mismatch reads false without panicking.
        assert!(!constant_time_token_eq("tok-abc", "tok-abcd"));
        assert!(!constant_time_token_eq("", "tok-abc"));
        assert!(!constant_time_token_eq("tok-abc", ""));
    }

    #[test]
    fn store_verify_scans_without_map_key_timing_leak() {
        let mut store = ChildTokenStore::new();
        store
            .insert(
                ChildToken::new(
                    "tok-abc".into(),
                    "terminal.inspect".into(),
                    "t:4".into(),
                    0,
                    60_000,
                )
                .unwrap(),
            )
            .unwrap();
        store
            .insert(
                ChildToken::new(
                    "tok-xyz".into(),
                    "terminal.inspect".into(),
                    "t:4".into(),
                    0,
                    60_000,
                )
                .unwrap(),
            )
            .unwrap();
        // Exact match still verifies.
        assert!(
            store
                .verify("tok-abc", "terminal.inspect", "t:4", 500)
                .is_ok()
        );
        // Near-miss candidates (shared prefix, wrong tail) must not verify.
        assert!(
            store
                .verify("tok-abX", "terminal.inspect", "t:4", 500)
                .is_err()
        );
        assert!(
            store
                .verify("tok-ab", "terminal.inspect", "t:4", 500)
                .is_err()
        );
        // Scope check still applies after a valid token match.
        assert!(matches!(
            store.verify("tok-abc", "terminal.input", "t:4", 500),
            Err(AuthError::ScopeDenied(_))
        ));
    }
}
