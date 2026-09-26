/**
 * Linux-only live Unix IPC socket seam for DevTools (CTX-0036, H-DEV-06).
 *
 * `IpcTransport` in `transport.ts` is a headless stub: `connect()` verifies
 * caller-supplied mode values and flips a flag without ever dialing the OS
 * socket, so every `request()` fails closed with `TransportClosed`. This
 * module is the minimal live path that actually dials the socket `bitty`
 * serves (`bitty-app/src/ipc_serve.rs`) at the resolved path
 * (`<base>/bitty/<instance>.sock`, see `auth.ts`): it stats the endpoint
 * (directory `0700`, socket `0600`, same owner as the runtime UID), dials
 * with `Bun.connect` over `AF_UNIX`, and does one framed request/response
 * round trip using the shared `u32 BE` + payload framing.
 *
 * Security properties (mirror the `bitty-ipc` contract, fail closed):
 * - The endpoint directory must exist, must not be a symlink, must be mode
 *   `0700`, and must be owned by the runtime UID; the socket itself must be
 *   mode `0600` and owned by the runtime UID. Anything else refuses to dial.
 * - Responses are untrusted observation data: bounded at 256 KiB, framed
 *   exactly once, and returned as raw bytes for the caller to decode.
 * - No TCP is involved. Linux endpoint attestation is the only implemented
 *   live adapter;
 *   `isLiveSocketSupported()` reports false and `connectLiveSocket()` refuses
 *   on Windows and macOS rather than implying an unverified live adapter.
 */

import {
  DIR_MODE,
  MAX_SOCKET_PATH_BYTES,
  SOCKET_MODE,
  resolveSocketPath,
} from "./auth.js";
import {
  Framer,
  MAX_FRAME_BYTES,
  TransportError,
  encodeFrame,
} from "./transport.js";

export const LIVE_SOCKET_TIMEOUT_MS = 5_000 as const;
export const LIVE_SOCKET_MAX_TIMEOUT_MS = 60_000 as const;

export const LIVE_SOCKET_MAX_PENDING_FRAMES = 64 as const;

export const LIVE_SOCKET_SUPPORTED_PLATFORM = "linux" as const;

type LiveSocketPlatform = typeof LIVE_SOCKET_SUPPORTED_PLATFORM | "unsupported";

export type LiveSocketIdentity = {
  kind: "endpoint-attested";
  runtimeUid: number;
  peer: null;
  authenticated: false;
};

export type SymlinkProbe = (path: string) => {
  isSymbolicLink(): boolean;
};

export type LiveSocketConfig = {
  /** Resolved socket path, or environment-selected endpoint inputs. */
  socketPath?: string;
  runtimeUid: number;
  xdgRuntimeDir?: string;
  bittySocket?: string;
  instanceId?: string;
  /** Per-dial and per-response timeout. */
  timeoutMs?: number;
  lstatSync?: SymlinkProbe;
};

type BunSocketHandle = {
  write(data: Uint8Array): number;
  flush(): void;
  end(): void;
  close(): void;
};

type BunRuntime = {
  connect(options: {
    unix: string;
    socket: {
      data(socket: BunSocketHandle, data: Uint8Array): void;
      error(socket: BunSocketHandle, error: Error): void;
      open(socket: BunSocketHandle): void;
      close(socket: BunSocketHandle): void;
    };
  }): Promise<BunSocketHandle>;
  file(path: string): { stat(): Promise<UnixStat | null> };
};

type UnixStat = {
  mode: number;
  uid: number;
  isSocket(): boolean;
};

function isSymlinkNoFollow(path: string, probe?: SymlinkProbe): boolean | null {
  if (probe !== undefined) {
    try {
      return probe(path).isSymbolicLink();
    } catch {
      return null;
    }
  }
  const proc = globalThis as unknown as {
    process?: { getBuiltinModule?: (id: string) => unknown };
  };
  const getBuiltin = proc.process?.getBuiltinModule;
  if (typeof getBuiltin !== "function") return null;
  try {
    const fs = getBuiltin.call(proc.process, "node:fs") as {
      lstatSync?: (p: string) => { isSymbolicLink?: () => boolean };
    };
    const stat = fs.lstatSync?.(path);
    if (typeof stat?.isSymbolicLink !== "function") return null;
    return stat.isSymbolicLink();
  } catch {
    return null;
  }
}

function resolveBun(): BunRuntime | null {
  const bun = (globalThis as { Bun?: unknown }).Bun as BunRuntime | undefined;
  if (
    bun === undefined ||
    typeof bun.connect !== "function" ||
    typeof bun.file !== "function"
  ) {
    return null;
  }
  return bun;
}

export function liveSocketPlatform(): LiveSocketPlatform {
  const proc = globalThis as { process?: { platform?: string } };
  return proc.process?.platform === LIVE_SOCKET_SUPPORTED_PLATFORM
    ? LIVE_SOCKET_SUPPORTED_PLATFORM
    : "unsupported";
}

export function isLiveSocketSupported(): boolean {
  return (
    resolveBun() !== null &&
    liveSocketPlatform() === LIVE_SOCKET_SUPPORTED_PLATFORM
  );
}

function unsupportedPlatformError(): TransportError {
  const proc = globalThis as { process?: { platform?: string } };
  const platform = proc.process?.platform ?? "unknown";
  return new TransportError(
    "TransportClosed",
    `live Unix socket transport is unsupported on ${platform}; Linux endpoint attestation is the only implemented live adapter`,
  );
}

export type LiveSocketEndpoint = {
  socketPath: string;
  runtimeUid: number;
};

function assertBoundedSocketPath(socketPath: string): void {
  if (
    socketPath.length === 0 ||
    !socketPath.startsWith("/") ||
    socketPath.includes("\0") ||
    socketPath.includes("\\") ||
    socketPath
      .split("/")
      .slice(1)
      .some((part) => part.length === 0 || part === "." || part === "..") ||
    new TextEncoder().encode(socketPath).length > MAX_SOCKET_PATH_BYTES
  ) {
    throw new TransportError(
      "Unauthenticated",
      "live socket path must be an absolute bounded AF_UNIX path",
    );
  }
}

/**
 * Resolve the dial target: explicit path wins, otherwise
 * `BITTY_SOCKET` / `XDG_RUNTIME_DIR` / instance selection from `auth.ts`.
 */
export function resolveLiveSocketEndpoint(
  config: LiveSocketConfig,
): LiveSocketEndpoint {
  if (!Number.isSafeInteger(config.runtimeUid) || config.runtimeUid < 0) {
    throw new TransportError(
      "Unauthenticated",
      "runtimeUid must be a nonnegative safe integer",
    );
  }
  const socketPath =
    config.socketPath ??
    resolveSocketPath({
      runtimeUid: config.runtimeUid,
      xdgRuntimeDir: config.xdgRuntimeDir,
      bittySocket: config.bittySocket,
      instanceId: config.instanceId,
    });
  assertBoundedSocketPath(socketPath);
  return { socketPath, runtimeUid: config.runtimeUid };
}

function parentDirOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

function pathAncestors(path: string): string[] {
  const parts = path.split("/").filter((part) => part.length > 0);
  const ancestors: string[] = [];
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    ancestors.push(current);
  }
  return ancestors;
}

function leafOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(index + 1);
}

/**
 * Attest the endpoint before dialing: the parent directory must be `0700`
 * and runtime-owned, the socket must exist, be a real socket (not a symlink),
 * be mode `0600`, and be runtime-owned. Mirrors the server-side attestation
 * in `bitty-ipc` `devtools::prepare_socket_dir` / `attest_bound_socket`.
 */
export async function attestLiveSocketEndpoint(
  endpoint: LiveSocketEndpoint,
  lstatSync?: SymlinkProbe,
): Promise<void> {
  if (liveSocketPlatform() !== LIVE_SOCKET_SUPPORTED_PLATFORM) {
    throw unsupportedPlatformError();
  }
  assertBoundedSocketPath(endpoint.socketPath);
  const bun = resolveBun();
  if (bun === null) {
    throw new TransportError("TransportClosed", "no Bun runtime for IPC dial");
  }
  const fail = (message: string): TransportError =>
    new TransportError("Unauthenticated", message);
  if (endpoint.socketPath.includes("\0")) {
    throw fail("socket path contains NUL");
  }
  const parent = parentDirOf(endpoint.socketPath);
  let dirStat: UnixStat | null = null;
  let sockStat: UnixStat | null = null;
  try {
    dirStat = await bun.file(parent).stat();
  } catch {
    dirStat = null;
  }
  try {
    sockStat = await bun.file(endpoint.socketPath).stat();
  } catch {
    sockStat = null;
  }
  if (dirStat === null) {
    throw fail(`socket directory '${parent}' does not exist`);
  }
  if (sockStat === null) {
    throw fail(`socket '${endpoint.socketPath}' does not exist`);
  }
  for (const component of pathAncestors(parent)) {
    const componentSymlink = isSymlinkNoFollow(component, lstatSync);
    if (componentSymlink === null) {
      throw fail("endpoint symlink state could not be verified");
    }
    if (componentSymlink) {
      throw fail(
        `socket path component '${component}' is a symlink (refusing to dial)`,
      );
    }
  }
  const socketSymlink = isSymlinkNoFollow(endpoint.socketPath, lstatSync);
  if (socketSymlink === null) {
    throw fail("endpoint symlink state could not be verified");
  }
  if (socketSymlink) {
    throw fail(
      `socket '${endpoint.socketPath}' is a symlink (refusing to dial)`,
    );
  }
  if (typeof sockStat.isSocket !== "function" || !sockStat.isSocket()) {
    throw fail(
      `'${endpoint.socketPath}' is not a socket or its type is unverifiable`,
    );
  }
  if ((dirStat.mode & 0o777) !== DIR_MODE) {
    throw fail(
      `socket directory '${parent}' mode ${(dirStat.mode & 0o777).toString(8)} != ${DIR_MODE.toString(8)} (must be 0700)`,
    );
  }
  if ((sockStat.mode & 0o777) !== SOCKET_MODE) {
    throw fail(
      `socket '${leafOf(endpoint.socketPath)}' mode ${(sockStat.mode & 0o777).toString(8)} != ${SOCKET_MODE.toString(8)} (must be 0600)`,
    );
  }
  if (dirStat.uid !== endpoint.runtimeUid) {
    throw fail(
      `socket directory '${parent}' owner uid ${dirStat.uid} != runtime uid ${endpoint.runtimeUid}`,
    );
  }
  if (sockStat.uid !== endpoint.runtimeUid) {
    throw fail(
      `socket '${leafOf(endpoint.socketPath)}' owner uid ${sockStat.uid} != runtime uid ${endpoint.runtimeUid}`,
    );
  }
}

export type LiveSocketConnection = {
  /** The attested path this connection dialed. */
  socketPath: string;
  /** Identity is explicit: endpoint attestation is not peer authentication. */
  identity: LiveSocketIdentity;
  /** True once the OS socket is open. */
  isOpen(): boolean;
  /**
   * Write one framed request and resolve with the response carrying the same
   * request id. The optional id is used when the payload cannot be inspected.
   */
  requestResponse(
    requestJson: Uint8Array,
    nowMs: number,
    requestId?: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
  close(): void;
};

/**
 * Dial the live socket. Attests the endpoint first (fail closed), then
 * opens one `AF_UNIX` connection. The caller owns the connection and must
 * `close()` it.
 */
function requestIdFromPayload(payload: Uint8Array): number {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      payload,
    );
  } catch {
    throw new TransportError("InvalidFrame", "request payload is not UTF-8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TransportError("InvalidFrame", "request payload is not JSON");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    typeof (parsed as { id?: unknown }).id !== "number" ||
    !Number.isSafeInteger((parsed as { id: number }).id) ||
    (parsed as { id: number }).id < 0
  ) {
    throw new TransportError("InvalidFrame", "request payload has no safe id");
  }
  return (parsed as { id: number }).id;
}

function responseIdFromPayload(payload: Uint8Array): number | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      payload,
    );
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    typeof (parsed as { id?: unknown }).id !== "number" ||
    !Number.isSafeInteger((parsed as { id: number }).id) ||
    (parsed as { id: number }).id < 0
  ) {
    return null;
  }
  return (parsed as { id: number }).id;
}

function closeSocket(socket: BunSocketHandle): void {
  try {
    socket.end();
  } catch {
    try {
      socket.close();
    } catch {
      return;
    }
  }
}

export async function connectLiveSocket(
  config: LiveSocketConfig,
): Promise<LiveSocketConnection> {
  if (liveSocketPlatform() !== LIVE_SOCKET_SUPPORTED_PLATFORM) {
    throw unsupportedPlatformError();
  }
  const bun = resolveBun();
  if (bun === null) {
    throw new TransportError("TransportClosed", "no Bun runtime for IPC dial");
  }
  const endpoint = resolveLiveSocketEndpoint(config);
  await attestLiveSocketEndpoint(endpoint, config.lstatSync);
  const timeoutMs = config.timeoutMs ?? LIVE_SOCKET_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > LIVE_SOCKET_MAX_TIMEOUT_MS
  ) {
    throw new TransportError(
      "TransportClosed",
      `timeoutMs must be in 1..${LIVE_SOCKET_MAX_TIMEOUT_MS}`,
    );
  }

  let socket: BunSocketHandle | null = null;
  let dialTimer: ReturnType<typeof setTimeout> | null = null;
  let dialSettled = false;
  let resolveDial!: (handle: BunSocketHandle) => void;
  let rejectDial!: (error: unknown) => void;
  const opened = new Promise<BunSocketHandle>((resolve, reject) => {
    resolveDial = resolve;
    rejectDial = reject;
  });
  const failDial = (error: TransportError): void => {
    if (dialSettled) return;
    dialSettled = true;
    if (dialTimer !== null) clearTimeout(dialTimer);
    if (socket !== null) closeSocket(socket);
    rejectDial(error);
  };
  dialTimer = setTimeout(() => {
    failDial(
      new TransportError(
        "TransportClosed",
        `dial '${endpoint.socketPath}' timed out after ${timeoutMs}ms`,
      ),
    );
  }, timeoutMs);

  const inbound = new Framer();
  const pending = new Map<
    number,
    {
      resolve: (value: Uint8Array) => void;
      reject: (error: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
      detach: () => void;
    }
  >();
  const pendingOrder: number[] = [];
  const retained: Array<{ id: number | null; payload: Uint8Array }> = [];
  let open = false;
  let terminalError: TransportError | null = null;
  let nextFallbackId = 0;
  const removePending = (id: number): void => {
    pending.delete(id);
    const index = pendingOrder.indexOf(id);
    if (index >= 0) pendingOrder.splice(index, 1);
  };
  const failConnection = (error: TransportError, remember = false): void => {
    if (remember) terminalError = error;
    if (!open && pending.size === 0 && retained.length === 0) return;
    open = false;
    inbound.clear();
    const waiters = [...pending.values()];
    pending.clear();
    pendingOrder.length = 0;
    retained.length = 0;
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.detach();
      waiter.reject(error);
    }
    if (socket !== null) closeSocket(socket);
  };
  const onData = (_socket: BunSocketHandle, data: Uint8Array): void => {
    if (!open) return;
    try {
      for (const frame of inbound.pushBytes(new Uint8Array(data))) {
        const id = responseIdFromPayload(frame.payload);
        let waiter = id === null ? undefined : pending.get(id);
        if (waiter === undefined && id === null && pendingOrder.length > 0) {
          const oldest = pendingOrder[0];
          waiter = oldest === undefined ? undefined : pending.get(oldest);
        }
        if (waiter !== undefined) {
          const key = id ?? pendingOrder[0];
          if (key !== undefined) removePending(key);
          waiter.resolve(frame.payload.slice());
          continue;
        }
        if (retained.length >= LIVE_SOCKET_MAX_PENDING_FRAMES) {
          throw new TransportError(
            "TransportFull",
            `pending frames exceed ${LIVE_SOCKET_MAX_PENDING_FRAMES}`,
          );
        }
        retained.push({ id, payload: frame.payload.slice() });
      }
    } catch (error) {
      failConnection(
        error instanceof TransportError
          ? error
          : new TransportError("InvalidFrame", "invalid response frame"),
        true,
      );
    }
  };
  const onError = (_socket: BunSocketHandle, error: Error): void => {
    if (!open) {
      failDial(
        new TransportError(
          "TransportClosed",
          `socket error on '${endpoint.socketPath}': ${error.message}`,
        ),
      );
      return;
    }
    failConnection(
      new TransportError(
        "TransportClosed",
        `socket error on '${endpoint.socketPath}': ${error.message}`,
      ),
    );
  };
  const onClose = (): void => {
    if (!open) {
      failDial(
        new TransportError(
          "TransportClosed",
          `socket '${endpoint.socketPath}' closed before open`,
        ),
      );
      return;
    }
    failConnection(
      new TransportError(
        "TransportClosed",
        `socket '${endpoint.socketPath}' closed`,
      ),
    );
  };
  const onOpen = (handle: BunSocketHandle): void => {
    socket = handle;
    if (dialSettled) {
      closeSocket(handle);
      return;
    }
    dialSettled = true;
    if (dialTimer !== null) clearTimeout(dialTimer);
    resolveDial(handle);
  };

  try {
    const connecting = bun.connect({
      unix: endpoint.socketPath,
      socket: {
        data: onData,
        error: onError,
        open: onOpen,
        close: onClose,
      },
    });
    void connecting.catch((error: unknown) => {
      failDial(
        new TransportError(
          "TransportClosed",
          `dial '${endpoint.socketPath}' failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    });
  } catch (error) {
    failDial(
      new TransportError(
        "TransportClosed",
        `dial '${endpoint.socketPath}' failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }

  const openedSocket = await opened;
  socket = openedSocket;
  open = true;
  const identity: LiveSocketIdentity = {
    kind: "endpoint-attested",
    runtimeUid: endpoint.runtimeUid,
    peer: null,
    authenticated: false,
  };

  return {
    socketPath: endpoint.socketPath,
    identity,
    isOpen: () => open,
    requestResponse: (
      requestJson: Uint8Array,
      nowMs: number,
      requestId?: number,
      signal?: AbortSignal,
    ) => {
      let id: number;
      try {
        void nowMs;
        if (terminalError !== null) throw terminalError;
        if (!open || socket === null) {
          throw new TransportError("TransportClosed", "live socket is closed");
        }
        if (requestJson.length > MAX_FRAME_BYTES) {
          throw new TransportError(
            "FrameTooLarge",
            `request ${requestJson.length} > ${MAX_FRAME_BYTES}`,
          );
        }
        if (requestId !== undefined) {
          id = requestId;
        } else {
          try {
            id = requestIdFromPayload(requestJson);
          } catch {
            if (nextFallbackId >= Number.MAX_SAFE_INTEGER) {
              throw new TransportError(
                "TransportFull",
                "fallback request id space exhausted",
              );
            }
            id = nextFallbackId++;
          }
        }
        if (!Number.isSafeInteger(id) || id < 0) {
          throw new TransportError(
            "InvalidFrame",
            "request id must be a safe integer",
          );
        }
        if (pending.has(id)) {
          throw new TransportError("TransportFull", `request ${id} is pending`);
        }
        if (signal?.aborted) {
          throw new TransportError("TransportClosed", "request cancelled");
        }
        if (pending.size >= LIVE_SOCKET_MAX_PENDING_FRAMES) {
          throw new TransportError(
            "TransportFull",
            `pending requests exceed ${LIVE_SOCKET_MAX_PENDING_FRAMES}`,
          );
        }
      } catch (error) {
        return Promise.reject(error);
      }
      return new Promise<Uint8Array>((resolve, reject) => {
        let settled = false;
        const cleanup = (): void => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          removePending(id);
        };
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          const error = new TransportError(
            "TransportClosed",
            `no response for request ${id} within ${timeoutMs}ms`,
          );
          failConnection(error, true);
          reject(error);
        }, timeoutMs);
        const onAbort = (): void => {
          if (settled) return;
          settled = true;
          cleanup();
          const error = new TransportError(
            "TransportClosed",
            `request ${id} cancelled`,
          );
          failConnection(error, true);
          reject(error);
        };
        pending.set(id, {
          resolve: (value) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(value);
          },
          reject: (error) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
          },
          timer,
          detach: () => signal?.removeEventListener("abort", onAbort),
        });
        pendingOrder.push(id);
        signal?.addEventListener("abort", onAbort, { once: true });
        const retainedIndex = retained.findIndex(
          (frame) => frame.id === id || frame.id === null,
        );
        const queued =
          retainedIndex >= 0 ? retained.splice(retainedIndex, 1)[0] : undefined;
        try {
          const wire = encodeFrame(requestJson);
          const written = socket?.write(wire);
          if (written !== wire.length) {
            throw new TransportError(
              "TransportClosed",
              "socket write was partial",
            );
          }
          socket?.flush();
          if (queued !== undefined) {
            const waiter = pending.get(id);
            waiter?.resolve(queued.payload);
          }
        } catch (error) {
          const connectionError =
            error instanceof TransportError
              ? error
              : new TransportError("TransportClosed", "socket write failed");
          const waiter = pending.get(id);
          waiter?.reject(error);
          failConnection(connectionError, true);
        }
      });
    },
    close: () => {
      failConnection(
        new TransportError("TransportClosed", "live socket closed"),
      );
    },
  };
}
