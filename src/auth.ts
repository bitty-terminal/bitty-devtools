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

/**
 * Portable `AF_UNIX` socket-path ceiling in payload bytes (excl. NUL).
 *
 * `sockaddr_un.sun_path` is 108 bytes incl. NUL on Linux and 104 incl. NUL on
 * macOS/BSD; 100 payload bytes fits every target with margin. Mirrors
 * `bitty-ipc` `devtools::MAX_SOCKET_PATH_BYTES` and replaces the former
 * 512-byte advisory check, which is wrong for `bind`/`connect`.
 */
export const MAX_SOCKET_PATH_BYTES = 100 as const;

export const SUN_LEN_LINUX = 108 as const;
export const SUN_LEN_MACOS = 104 as const;
export const SOCKET_LEAF_DIR = "bitty" as const;
export const DEFAULT_INSTANCE_ID = "default" as const;

const UTF8 = new TextEncoder();

function utf8ByteLength(value: string): number {
  return UTF8.encode(value).length;
}

/**
 * Constant-time token comparison over UTF-8 bytes.
 *
 * Uses Node `crypto.timingSafeEqual` via `process.getBuiltinModule` (Bun
 * runtime) so comparison time does not leak the shared-prefix length of a
 * candidate token. Length mismatch reads false (never throws) to keep
 * callers fail-closed without a length oracle via exceptions; the byte loop
 * itself always runs to completion.
 */
type TimingSafeEqual = (a: Uint8Array, b: Uint8Array) => boolean;

function nodeTimingSafeEqual(): TimingSafeEqual {
  const proc = globalThis as unknown as {
    process?: { getBuiltinModule?: (id: string) => unknown };
  };
  const getBuiltin = proc.process?.getBuiltinModule;
  if (typeof getBuiltin === "function") {
    const mod = getBuiltin.call(proc.process, "node:crypto") as {
      timingSafeEqual?: unknown;
    };
    if (typeof mod.timingSafeEqual === "function") {
      return mod.timingSafeEqual as TimingSafeEqual;
    }
  }
  throw new Error("node:crypto timingSafeEqual unavailable");
}
export function timingSafeTokenEqual(a: string, b: string): boolean {
  const ab = UTF8.encode(a);
  const bb = UTF8.encode(b);
  if (ab.length !== bb.length) return false;
  return nodeTimingSafeEqual()(ab, bb);
}

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

/**
 * Deterministic 64-bit FNV-1a hash rendered as 16 lowercase hex chars.
 *
 * Byte-for-byte parity with `bitty-ipc` `devtools::short_instance_hash`
 * (`OFFSET = 0xcbf29ce484222325`, `PRIME = 0x100000001b3`, wrapping u64).
 * Used to clamp a long instance id into a socket leaf that fits
 * `MAX_SOCKET_PATH_BYTES`; it is not a security hash.
 */
export function shortInstanceHash(instance: string): string {
  const OFFSET = 0xcbf29ce484222325n;
  const PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let hash = OFFSET;
  for (const byte of UTF8.encode(instance)) {
    hash = ((hash ^ BigInt(byte)) * PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * Resolve the Unix socket path with `bitty-ipc` precedence and a portable
 * `AF_UNIX` bound.
 *
 * Precedence: non-empty `BITTY_SOCKET` (advisory) wins verbatim; otherwise
 * `<base>/bitty/<instance>.sock` where `base` is `XDG_RUNTIME_DIR` or
 * `/run/user/<uid>`, and `instance` is `BITTY_INSTANCE_ID` or `default`.
 *
 * When the direct form exceeds {@link MAX_SOCKET_PATH_BYTES} the instance id
 * is clamped to its 16-hex FNV-1a hash; when even that is too long the base
 * directory is too long and resolution fails closed. Lengths are UTF-8 byte
 * counts so the thresholds match the Rust server exactly.
 */
export function resolveSocketPath(config: EndpointConfig): string {
  if (config.bittySocket !== undefined && config.bittySocket.length > 0) {
    if (config.bittySocket.includes("\0"))
      throw new Error("BITTY_SOCKET contains NUL");
    if (utf8ByteLength(config.bittySocket) > MAX_SOCKET_PATH_BYTES)
      throw new Error(
        `BITTY_SOCKET path too long for AF_UNIX (${utf8ByteLength(config.bittySocket)} > ${MAX_SOCKET_PATH_BYTES} payload bytes; portable SUN_LEN: Linux ${SUN_LEN_LINUX} / macOS ${SUN_LEN_MACOS} incl. NUL)`,
      );
    return config.bittySocket;
  }
  const base =
    config.xdgRuntimeDir !== undefined && config.xdgRuntimeDir.length > 0
      ? config.xdgRuntimeDir
      : `/run/user/${config.runtimeUid}`;
  const instance = config.instanceId ?? DEFAULT_INSTANCE_ID;
  if (instance.length === 0 || instance.length > 64)
    throw new Error("instanceId must be 1..64");
  if (!/^[a-z0-9_-]+$/i.test(instance))
    throw new Error("instanceId must match ^[a-z0-9_-]+$");
  const direct = `${base}/${SOCKET_LEAF_DIR}/${instance}.sock`;
  if (utf8ByteLength(direct) <= MAX_SOCKET_PATH_BYTES) return direct;
  const hashed = `${base}/${SOCKET_LEAF_DIR}/${shortInstanceHash(instance)}.sock`;
  if (utf8ByteLength(hashed) <= MAX_SOCKET_PATH_BYTES) return hashed;
  throw new Error(
    `socket base dir too long for AF_UNIX (${utf8ByteLength(hashed)} > ${MAX_SOCKET_PATH_BYTES} payload bytes even with hashed instance; portable SUN_LEN: Linux ${SUN_LEN_LINUX} / macOS ${SUN_LEN_MACOS} incl. NUL; shorten XDG_RUNTIME_DIR or set BITTY_SOCKET)`,
  );
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
  if (childTokenIsExpired(t, nowMs)) return false;
  return (
    timingSafeTokenEqual(t.scope, scope) &&
    timingSafeTokenEqual(t.scopedId, scopedId)
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
    // Linear scan with a constant-time byte compare per candidate: a direct
    // `Map.get(tokenStr)` would let hash-probe timing leak how much of the
    // candidate matches a stored key, so every stored token is compared and
    // exactly one match is accepted. Scope and expiry are checked only after
    // the token comparison to keep failure timing uniform.
    let matched: ChildToken | undefined = undefined;
    let matches = 0;
    for (const candidate of this.tokens.values()) {
      if (timingSafeTokenEqual(candidate.token, tokenStr)) {
        matched = candidate;
        matches += 1;
      }
    }
    const tok = matches === 1 ? matched : undefined;
    if (tok === undefined) {
      throw new AuthError("Unauthenticated", "unknown child token");
    }
    if (childTokenIsExpired(tok, nowMs)) {
      throw new AuthError("Unauthenticated", "child token expired");
    }
    if (
      !timingSafeTokenEqual(tok.scope, scope) ||
      !timingSafeTokenEqual(tok.scopedId, scopedId)
    ) {
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
