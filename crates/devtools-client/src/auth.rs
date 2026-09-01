#![forbid(unsafe_code)]
//! Peer-credential authentication for IPC (phase 2, live runtime).
//!
//! Mirrors `bitty-ipc` auth contract: Unix socket 0700/0600, Windows named
//! pipe ACL, peer UID equality via `SO_PEERCRED` paradigm. Verification is
//! headless and bounded, requiring no `unsafe`. The platform seam that
//! extracts `PeerCredentials` via `getsockopt(SO_PEERCRED)` lives outside
//! this crate; here we only verify already-extracted triples.

pub const DIR_MODE: u32 = 0o700;
pub const SOCKET_MODE: u32 = 0o600;
pub const MAX_CHILD_TOKENS: usize = 64;
pub const MAX_SCOPED_ID_BYTES: usize = 64;
pub const CHILD_TOKEN_TTL_MS: u64 = 60_000;
pub const MAX_TOKEN_TTL_MS: u64 = 60_000;

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

pub fn resolve_socket_path(
    runtime_uid: u32,
    xdg_runtime_dir: Option<&str>,
    bitty_socket: Option<&str>,
    instance_id: Option<&str>,
) -> Result<String, AuthError> {
    if let Some(p) = bitty_socket {
        if !p.is_empty() {
            if p.len() > 512 {
                return Err(AuthError::InvalidRequest(
                    "BITTY_SOCKET too long".to_string(),
                ));
            }
            if p.contains('\0') {
                return Err(AuthError::InvalidRequest(
                    "BITTY_SOCKET contains NUL".to_string(),
                ));
            }
            return Ok(p.to_string());
        }
    }
    let base = xdg_runtime_dir
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("/run/user/{runtime_uid}"));
    let instance = instance_id.unwrap_or("default");
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
    Ok(format!("{base}/bitty/{instance}.sock"))
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
        !self.is_expired(now_ms) && self.scope == scope && self.scoped_id == scoped_id
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
        let tok = self.tokens.get(token_str).ok_or_else(|| {
            AuthError::Unauthenticated(format!("unknown child token '{token_str}'"))
        })?;
        if tok.is_expired(now_ms) {
            return Err(AuthError::Unauthenticated(format!(
                "child token '{token_str}' expired"
            )));
        }
        if tok.scope != scope || tok.scoped_id != scoped_id {
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
}
