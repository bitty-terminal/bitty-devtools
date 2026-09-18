import { spyOn } from "bun:test";
import * as fs from "node:fs";
import { connectLiveSocket } from "../../src/ipc-socket.js";
import type { LiveSocketConnection } from "../../src/ipc-socket.js";

export const MEMORY_SOCKET_PATH = "/memory/bitty/fixture.sock";
export const MEMORY_TIMEOUT_MS = 100;
export const MEMORY_RUNTIME_UID = 1000;
export const MEMORY_DIR_MODE = 0o700;
export const MEMORY_SOCK_MODE = 0o600;
export const SCRATCH_TIMEOUT_MS = 1000;
export const SCRATCH_SOCKET_LEAF = "loopback.sock";
export const SCRATCH_TIMEOUT_CEILING_MS = 5000;

export type MemorySocket = {
  write(data: Uint8Array): number;
  flush(): void;
  end(): void;
  close(): void;
};

export type MemoryHandlers = {
  data(socket: MemorySocket, data: Uint8Array): void;
  open(socket: MemorySocket): void;
};

export type MemoryTransmission = {
  write?: () => void;
  flush?: (count: number) => void;
};

export type MemoryRun = (
  connection: LiveSocketConnection,
  receive: (bytes: Uint8Array) => void,
  writes: number[],
  flushes: number[],
) => Promise<void>;

export function localUid(): number {
  const proc = globalThis.process as unknown as {
    getuid?: () => number;
  };
  return typeof proc.getuid === "function" ? proc.getuid() : 1000;
}

export function scratchDir(prefix: string): string {
  const raw = process.env["XDG_RUNTIME_DIR"] ?? "/tmp";
  const base = raw.startsWith("/") ? raw : "/tmp";
  return `${base}/${prefix}-${process.pid}`;
}

export function assertScratchSocketPath(socketPath: string): void {
  if (socketPath.includes("\0")) {
    throw new Error("socket path contains NUL");
  }
  if (socketPath.startsWith("/") === false) {
    throw new Error(`scratch socket must be absolute: ${socketPath}`);
  }
  if (
    socketPath.includes("\\") ||
    /^[A-Za-z]:/.test(socketPath) ||
    socketPath.startsWith("\\\\")
  ) {
    throw new Error(`Windows socket syntax refused: ${socketPath}`);
  }
  if (socketPath.includes("/bitty-devtools-") === false) {
    throw new Error(`scratch socket must be run-owned: ${socketPath}`);
  }
}

export async function withMemoryConnection(
  run: MemoryRun,
  transmission: MemoryTransmission = {},
): Promise<void> {
  const runtime = Bun as unknown as {
    file(path: string): {
      stat(): Promise<{ mode: number; uid: number; isSocket(): boolean }>;
    };
    connect(options: { socket: MemoryHandlers }): Promise<MemorySocket>;
  };
  const stat = spyOn(fs, "lstatSync").mockReturnValue({
    isSymbolicLink: () => false,
  } as ReturnType<typeof fs.lstatSync>);
  let handlers: MemoryHandlers | undefined;
  const writes: number[] = [];
  const flushes: number[] = [];
  const socket: MemorySocket = {
    write: (data) => {
      writes.push(data.length);
      transmission.write?.();
      return data.length;
    },
    flush() {
      flushes.push(writes.length);
      transmission.flush?.(flushes.length);
    },
    end() {},
    close() {},
  };
  const file = spyOn(runtime, "file").mockImplementation((path) => ({
    stat: async () => ({
      mode: path.endsWith(".sock") ? MEMORY_SOCK_MODE : MEMORY_DIR_MODE,
      uid: MEMORY_RUNTIME_UID,
      isSocket: () => path.endsWith(".sock"),
    }),
  }));
  const connect = spyOn(runtime, "connect").mockImplementation(
    async (options) => {
      handlers = options.socket;
      handlers.open(socket);
      return socket;
    },
  );
  try {
    const connection = await connectLiveSocket({
      socketPath: MEMORY_SOCKET_PATH,
      runtimeUid: MEMORY_RUNTIME_UID,
      timeoutMs: MEMORY_TIMEOUT_MS,
    });
    try {
      await run(
        connection,
        (bytes) => handlers!.data(socket, bytes),
        writes,
        flushes,
      );
    } finally {
      connection.close();
    }
  } finally {
    connect.mockRestore();
    file.mockRestore();
    stat.mockRestore();
  }
}

export type ScratchLoopback = {
  dir: string;
  socketPath: string;
  runtimeUid: number;
  timeoutMs: number;
  stop: () => void;
};

export function createScratchLoopback(options: {
  prefix: string;
  responsePayload: Uint8Array;
  timeoutMs?: number;
}): ScratchLoopback {
  const timeoutMs = options.timeoutMs ?? SCRATCH_TIMEOUT_MS;
  if (
    Number.isInteger(timeoutMs) === false ||
    timeoutMs <= 0 ||
    timeoutMs > SCRATCH_TIMEOUT_CEILING_MS
  ) {
    throw new Error(`timeoutMs must be 1..5000, got ${timeoutMs}`);
  }
  if (
    options.prefix.length === 0 ||
    options.prefix.includes("\0") ||
    options.prefix.includes("/") ||
    options.prefix.includes("\\") ||
    options.prefix.includes("..")
  ) {
    throw new Error(`invalid scratch prefix: ${options.prefix}`);
  }
  const dir = scratchDir(options.prefix);
  const socketPath = `${dir}/${SCRATCH_SOCKET_LEAF}`;
  assertScratchSocketPath(socketPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o700);
  const runtimeUid = localUid();
  const wire = new Uint8Array(4 + options.responsePayload.length);
  new DataView(wire.buffer).setUint32(0, options.responsePayload.length, false);
  wire.set(options.responsePayload, 4);
  const server = (
    Bun as unknown as {
      listen(options: {
        unix: string;
        socket: {
          data(sock: { write(data: Uint8Array): void }, data: Uint8Array): void;
          error(): void;
        };
      }): { stop(closeActiveConnections?: boolean): void };
    }
  ).listen({
    unix: socketPath,
    socket: {
      data(sock) {
        sock.write(wire);
      },
      error() {},
    },
  });
  fs.chmodSync(socketPath, 0o600);
  return {
    dir,
    socketPath,
    runtimeUid,
    timeoutMs,
    stop: () => {
      try {
        server.stop(true);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
