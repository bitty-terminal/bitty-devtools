/**
 * Peer-credential authentication for IPC (phase 2, live runtime).
 *
 * This module reuses the accepted IPC auth contract from `bitty-ipc`
 * (Unix socket 0600 / 0700 directory, Windows named pipe ACL) without
 * introducing ambient credentials. Verification is headless and bounded,
 * requiring no unsafe. Real `SO_PEERCRED` / `GetNamedPipeClientProcessId`
 * extraction lives in the platform seam; this file only verifies
 * already-extracted credentials so tests run anywhere without a live socket.
 *
 * All checks are fail-closed: directory mode, socket mode, owner UID,
 * peer UID equality, and re-check before each privileged action.
 */

export const DIR_MODE = 0o700 as const;
export const SOCKET_MODE = 0o600 as const;
export const MAX_CHILD_TOKENS = 64 as const;
export const MAX_SCOPED_ID_BYTES = 64 as const;
export const CHILD_TOKEN_TTL_MS = 60_000 as const;
export const MAX_TOKEN_TTL_MS = 60_000 as const;

export type PeerCredentials = {
  uid: number;
  gid: number;
  pid: number;
};

export function peerCredentials(
  uid: number,
  gid: number,
  pid: number,
): PeerCredentials {
  if (!Number.isInteger(uid) || uid < 0)
    throw new Error("uid must be integer >=0");
  if (!Number.isInteger(gid) || gid < 0)
    throw new Error("gid must be integer >=0");
  if (!Number.isInteger(pid)) throw new Error("pid must be integer");
  return { uid, gid, pid };
}

export class AuthError extends Error {
  constructor(
    public readonly code:
      "Unauthenticated" | "ScopeDenied" | "LimitExceeded" | "InvalidRequest",
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export function verifyPeerUid(
  peer: PeerCredentials,
  expectedUid: number,
): void {
  if (peer.uid !== expectedUid) {
    throw new AuthError(
      "Unauthenticated",
      `peer uid ${peer.uid} does not match runtime uid ${expectedUid}`,
    );
  }
}

export function verifyUnixEndpoint(
  runtimeUid: number,
  peer: PeerCredentials,
  dirMode: number,
  dirOwnerUid: number,
  sockMode: number,
  sockOwnerUid: number,
): void {
  if (dirMode !== DIR_MODE) {
    throw new AuthError(
      "Unauthenticated",
      `directory mode ${dirMode.toString(8)} != ${DIR_MODE.toString(8)} (must be 0700)`,
    );
  }
  if (sockMode !== SOCKET_MODE) {
    throw new AuthError(
      "Unauthenticated",
      `socket mode ${sockMode.toString(8)} != ${SOCKET_MODE.toString(8)} (must be 0600)`,
    );
  }
  if (dirOwnerUid !== runtimeUid) {
    throw new AuthError(
      "Unauthenticated",
      `directory owner ${dirOwnerUid} != runtime ${runtimeUid}`,
    );
  }
  if (sockOwnerUid !== runtimeUid) {
    throw new AuthError(
      "Unauthenticated",
      `socket owner ${sockOwnerUid} != runtime ${runtimeUid}`,
    );
  }
  verifyPeerUid(peer, runtimeUid);
}

export function verifyWindowsPipe(
  peerSid: bigint | number,
  runtimeSid: bigint | number,
): void {
  if (peerSid !== runtimeSid) {
    throw new AuthError(
      "Unauthenticated",
      `pipe peer sid ${String(peerSid)} != runtime sid ${String(runtimeSid)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Endpoint discovery (advisory, never credential)
// ---------------------------------------------------------------------------

export type EndpointConfig = {
  runtimeUid: number;
  xdgRuntimeDir?: string;
  bittySocket?: string;
  instanceId?: string;
};

export function resolveSocketPath(config: EndpointConfig): string {
  // Precedence: BITTY_SOCKET env (advisory) > XDG_RUNTIME_DIR/bitty/<instance>.sock
  // Forged BITTY_SOCKET without peer credential still fails at verify step.
  if (config.bittySocket !== undefined && config.bittySocket.length > 0) {
    if (config.bittySocket.length > 512)
      throw new Error("BITTY_SOCKET path too long");
    if (config.bittySocket.includes("\0"))
      throw new Error("BITTY_SOCKET contains NUL");
    return config.bittySocket;
  }
  const base = config.xdgRuntimeDir ?? `/run/user/${config.runtimeUid}`;
  const instance = config.instanceId ?? "default";
  if (instance.length === 0 || instance.length > 64)
    throw new Error("instanceId must be 1..64");
  if (!/^[a-z0-9_-]+$/i.test(instance))
    throw new Error("instanceId must match ^[a-z0-9_-]+$");
  return `${base}/bitty/${instance}.sock`;
}

export function isBittyEnvDiscoverySafe(): string {
  return "BITTY_SOCKET and BITTY_INSTANCE_ID are advisory identifiers, never credentials. Every request still requires SO_PEERCRED / pipe-ACL and per-request scope evaluation.";
}

// ---------------------------------------------------------------------------
// Child scope token (short-lived, PTY fd, never env, 60s TTL, bounded 64)
// ---------------------------------------------------------------------------

export type ChildToken = {
  token: string;
  scope: string;
  scopedId: string;
  createdAtMs: number;
  ttlMs: number;
};

export function newChildToken(
  token: string,
  scope: string,
  scopedId: string,
  createdAtMs: number,
  ttlMs: number,
): ChildToken {
  if (token.length === 0 || token.length > 128)
    throw new Error("child token must be 1..128 bytes");
  if (scopedId.length > MAX_SCOPED_ID_BYTES)
    throw new Error(`scopedId > ${MAX_SCOPED_ID_BYTES}`);
  if (ttlMs === 0 || ttlMs > MAX_TOKEN_TTL_MS)
    throw new Error(`ttlMs must be 1..${MAX_TOKEN_TTL_MS}`);
  if (
    token
      .split("")
      .some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)
  ) {
    throw new Error("token must not contain control bytes");
  }
  if (
    scopedId
      .split("")
      .some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)
  ) {
    throw new Error("scopedId must not contain control bytes");
  }
  return { token, scope, scopedId, createdAtMs, ttlMs };
}

export function childTokenExpiresAt(t: ChildToken): number {
  return t.createdAtMs + t.ttlMs;
}

export function childTokenIsExpired(t: ChildToken, nowMs: number): boolean {
  return nowMs >= childTokenExpiresAt(t);
}

export function childTokenAuthorizes(
  t: ChildToken,
  scope: string,
  scopedId: string,
  nowMs: number,
): boolean {
  return (
    !childTokenIsExpired(t, nowMs) &&
    t.scope === scope &&
    t.scopedId === scopedId
  );
}

export class ChildTokenStore {
  private tokens = new Map<string, ChildToken>();

  get size(): number {
    return this.tokens.size;
  }

  insert(t: ChildToken): void {
    const isNew = !this.tokens.has(t.token);
    if (isNew && this.tokens.size >= MAX_CHILD_TOKENS) {
      throw new AuthError(
        "LimitExceeded",
        `child_tokens limit ${MAX_CHILD_TOKENS} exceeded`,
      );
    }
    this.tokens.set(t.token, t);
  }

  verify(
    tokenStr: string,
    scope: string,
    scopedId: string,
    nowMs: number,
  ): void {
    const tok = this.tokens.get(tokenStr);
    if (tok === undefined) {
      throw new AuthError(
        "Unauthenticated",
        `unknown child token '${tokenStr}'`,
      );
    }
    if (childTokenIsExpired(tok, nowMs)) {
      throw new AuthError(
        "Unauthenticated",
        `child token '${tokenStr}' expired`,
      );
    }
    if (tok.scope !== scope || tok.scopedId !== scopedId) {
      throw new AuthError(
        "ScopeDenied",
        `child token scope ${tok.scope} id ${tok.scopedId} mismatch`,
      );
    }
  }

  drainExpired(nowMs: number): string[] {
    const expired: string[] = [];
    for (const [k, v] of this.tokens) {
      if (childTokenIsExpired(v, nowMs)) expired.push(k);
    }
    for (const k of expired) this.tokens.delete(k);
    return expired;
  }

  revoke(tokenStr: string): boolean {
    return this.tokens.delete(tokenStr);
  }
}
