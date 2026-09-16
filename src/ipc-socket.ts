/**
 * Live Unix IPC socket seam for DevTools (CTX-0036, H-DEV-06).
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
 * - No TCP is involved; on non-Unix platforms `isLiveSocketSupported()`
 *   reports false and `connectLiveSocket()` refuses (Windows named-pipe
 *   dialing stays with CTX-0043 and is not duplicated here).
 */

import { DIR_MODE, SOCKET_MODE, resolveSocketPath } from "./auth.js";
import {
  MAX_FRAME_BYTES,
  TransportError,
  decodeFrame,
  encodeFrame,
} from "./transport.js";

export const LIVE_SOCKET_TIMEOUT_MS = 5_000 as const;

export type LiveSocketConfig = {
  /** Resolved socket path, or advisory discovery inputs. */
  socketPath?: string;
  runtimeUid: number;
  xdgRuntimeDir?: string;
  bittySocket?: string;
  instanceId?: string;
  /** Per-dial and per-response timeout. */
  timeoutMs?: number;
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
  isSymbolicLink(): boolean;
};

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

/** True on Unix runtimes where `Bun.connect({ unix })` can dial. */
export function isLiveSocketSupported(): boolean {
  if (resolveBun() === null) return false;
  const proc = globalThis as { process?: { platform?: string } };
  return proc.process?.platform !== "win32";
}

export type LiveSocketEndpoint = {
  socketPath: string;
  runtimeUid: number;
};

/**
 * Resolve the dial target: explicit path wins, otherwise the advisory
 * `BITTY_SOCKET` / `XDG_RUNTIME_DIR` / instance discovery from `auth.ts`.
 */
export function resolveLiveSocketEndpoint(
  config: LiveSocketConfig,
): LiveSocketEndpoint {
  const socketPath =
    config.socketPath ??
    resolveSocketPath({
      runtimeUid: config.runtimeUid,
      xdgRuntimeDir: config.xdgRuntimeDir,
      bittySocket: config.bittySocket,
      instanceId: config.instanceId,
    });
  return { socketPath, runtimeUid: config.runtimeUid };
}

function parentDirOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
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
): Promise<void> {
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
  if (
    typeof dirStat.isSymbolicLink === "function" &&
    dirStat.isSymbolicLink()
  ) {
    throw fail(`socket directory '${parent}' is a symlink (refusing to dial)`);
  }
  if (
    typeof sockStat.isSymbolicLink === "function" &&
    sockStat.isSymbolicLink()
  ) {
    throw fail(
      `socket '${endpoint.socketPath}' is a symlink (refusing to dial)`,
    );
  }
  if (typeof sockStat.isSocket === "function" && !sockStat.isSocket()) {
    throw fail(`'${endpoint.socketPath}' is not a socket`);
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
  /** True once the OS socket is open. */
  isOpen(): boolean;
  /**
   * Write one framed request and resolve with the next framed response
   * payload (raw bytes, still to be JSON-decoded by the caller). Bounded at
   * one 256 KiB frame each way, matching the `bitty-ipc` framing.
   */
  requestResponse(requestJson: Uint8Array, nowMs: number): Promise<Uint8Array>;
  close(): void;
};

/**
 * Dial the live socket. Attests the endpoint first (fail closed), then
 * opens one `AF_UNIX` connection. The caller owns the connection and must
 * `close()` it.
 */
export async function connectLiveSocket(
  config: LiveSocketConfig,
): Promise<LiveSocketConnection> {
  const bun = resolveBun();
  if (bun === null) {
    throw new TransportError("TransportClosed", "no Bun runtime for IPC dial");
  }
  const proc = globalThis as { process?: { platform?: string } };
  if (proc.process?.platform === "win32") {
    throw new TransportError(
      "TransportClosed",
      "live Unix socket dial is unsupported on win32 (named pipe only)",
    );
  }
  const endpoint = resolveLiveSocketEndpoint(config);
  await attestLiveSocketEndpoint(endpoint);
  const timeoutMs = config.timeoutMs ?? LIVE_SOCKET_TIMEOUT_MS;

  let handle: BunSocketHandle | null = null;
  let dialError: unknown = null;
  // Inbound bytes for the single round trip below. The handler is registered
  // up front at dial time: Bun dispatches to the handler captured at
  // `connect`, so swapping it later would silently drop the response.
  const inbound: Uint8Array[] = [];
  let responseSettled: ((value: Uint8Array) => void) | null = null;
  let responseFailed: ((error: unknown) => void) | null = null;
  const opened = new Promise<BunSocketHandle>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new TransportError(
          "TransportClosed",
          `dial '${endpoint.socketPath}' timed out after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
    bun
      .connect({
        unix: endpoint.socketPath,
        socket: {
          data(_socket, data) {
            try {
              inbound.push(new Uint8Array(data));
              const total = inbound.reduce((n, c) => n + c.length, 0);
              if (total < 4) return;
              const merged = new Uint8Array(total);
              let off = 0;
              for (const c of inbound) {
                merged.set(c, off);
                off += c.length;
              }
              const { frame, consumed } = decodeFrame(merged);
              void consumed;
              inbound.length = 0;
              responseSettled?.(frame.payload.slice());
            } catch (error) {
              inbound.length = 0;
              const failed = responseFailed;
              responseSettled = null;
              responseFailed = null;
              failed?.(error);
            }
          },
          error(_socket, error) {
            dialError = error;
            clearTimeout(timer);
            reject(
              new TransportError(
                "TransportClosed",
                `socket error on '${endpoint.socketPath}': ${error.message}`,
              ),
            );
          },
          open(socket) {
            clearTimeout(timer);
            resolve(socket);
          },
          close() {},
        },
      })
      .catch((error: unknown) => {
        clearTimeout(timer);
        dialError = error;
        reject(
          new TransportError(
            "TransportClosed",
            `dial '${endpoint.socketPath}' failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      });
  });
  try {
    handle = await opened;
  } catch (error) {
    if (dialError instanceof TransportError) throw dialError;
    throw error;
  }
  const socket = handle;
  let open = true;

  return {
    socketPath: endpoint.socketPath,
    isOpen: () => open,
    requestResponse: async (
      requestJson: Uint8Array,
      nowMs: number,
    ): Promise<Uint8Array> => {
      void nowMs;
      if (!open) {
        throw new TransportError("TransportClosed", "live socket is closed");
      }
      if (requestJson.length > MAX_FRAME_BYTES) {
        throw new TransportError(
          "FrameTooLarge",
          `request ${requestJson.length} > ${MAX_FRAME_BYTES}`,
        );
      }
      return new Promise<Uint8Array>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          responseSettled = null;
          responseFailed = null;
          reject(
            new TransportError(
              "TransportClosed",
              `no response from '${endpoint.socketPath}' within ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);
        responseSettled = (value: Uint8Array): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          responseSettled = null;
          responseFailed = null;
          resolve(value);
        };
        responseFailed = (error: unknown): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          responseSettled = null;
          responseFailed = null;
          reject(error);
        };
        try {
          socket.write(encodeFrame(requestJson));
          socket.flush();
        } catch (error) {
          const failed = responseFailed;
          responseSettled = null;
          responseFailed = null;
          clearTimeout(timer);
          settled = true;
          failed?.(
            error instanceof TransportError
              ? error
              : new TransportError(
                  "TransportClosed",
                  `write to '${endpoint.socketPath}' failed: ${error instanceof Error ? error.message : String(error)}`,
                ),
          );
        }
      });
    },
    close: () => {
      open = false;
      try {
        socket.end();
      } catch {
        try {
          socket.close();
        } catch {
          // Close is best-effort; a closed socket must not throw.
        }
      }
    },
  };
}
