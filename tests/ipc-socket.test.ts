import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  MAX_FRAME_BYTES,
  TransportError,
  encodeFrame,
} from "../src/transport.js";
import {
  attestLiveSocketEndpoint,
  connectLiveSocket,
  isLiveSocketSupported,
  LIVE_SOCKET_MAX_PENDING_FRAMES,
} from "../src/ipc-socket.js";

type MemorySocket = {
  write(data: Uint8Array): number;
  flush(): void;
  end(): void;
  close(): void;
};

type MemoryHandlers = {
  data(socket: MemorySocket, data: Uint8Array): void;
  open(socket: MemorySocket): void;
};

async function withMemoryConnection(
  run: (
    connection: Awaited<ReturnType<typeof connectLiveSocket>>,
    receive: (bytes: Uint8Array) => void,
    writes: number[],
    flushes: number[],
  ) => Promise<void>,
  transmission: {
    write?: () => void;
    flush?: (count: number) => void;
  } = {},
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
      mode: path.endsWith(".sock") ? 0o600 : 0o700,
      uid: 1000,
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
      socketPath: "/memory/bitty/fixture.sock",
      runtimeUid: 1000,
      timeoutMs: 100,
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

const firstPayload = new TextEncoder().encode('{"id":1,"result":"ready"}');
const secondPayload = new TextEncoder().encode('{"id":2,"result":"done"}');
const firstFrame = encodeFrame(firstPayload);
const secondFrame = encodeFrame(secondPayload);
const pairedFrames = new Uint8Array(firstFrame.length + secondFrame.length);
pairedFrames.set(firstFrame);
pairedFrames.set(secondFrame, firstFrame.length);

describe("in-memory physical stream frames (#97)", () => {
  for (let boundary = 1; boundary < firstFrame.length; boundary++) {
    test(`waits for a frame split at byte ${boundary}`, async () => {
      await withMemoryConnection(async (connection, receive) => {
        const response = connection.requestResponse(firstPayload, 0);
        const result = response.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        let settled = false;
        void result.then(() => {
          settled = true;
        });
        receive(firstFrame.subarray(0, boundary));
        await Promise.resolve();
        await Promise.resolve();
        expect(settled).toBe(false);
        receive(firstFrame.subarray(boundary));
        expect(await result).toEqual({ value: firstPayload });
      });
    });
  }

  for (
    let boundary = firstFrame.length;
    boundary <= pairedFrames.length;
    boundary++
  ) {
    test(`retains ordered suffix at byte ${boundary}`, async () => {
      await withMemoryConnection(async (connection, receive) => {
        const first = connection.requestResponse(firstPayload, 0);
        receive(pairedFrames.subarray(0, boundary));
        expect(await first).toEqual(firstPayload);
        const second = connection.requestResponse(secondPayload, 1);
        receive(pairedFrames.subarray(boundary));
        expect(await second).toEqual(secondPayload);
      });
    });
  }

  test("accepts bytewise delivery and an empty physical frame", async () => {
    await withMemoryConnection(async (connection, receive) => {
      const first = connection.requestResponse(firstPayload, 0);
      for (const byte of firstFrame) receive(Uint8Array.of(byte));
      expect(await first).toEqual(firstPayload);
      const empty = connection.requestResponse(secondPayload, 1);
      receive(encodeFrame(new Uint8Array(0)));
      expect(await empty).toEqual(new Uint8Array(0));
    });
  });

  test("accepts two coalesced maximum-sized physical frames", async () => {
    await withMemoryConnection(async (connection, receive) => {
      const payload = new Uint8Array(MAX_FRAME_BYTES).fill(32);
      const frame = encodeFrame(payload);
      const bytes = new Uint8Array(frame.length * 2);
      bytes.set(frame);
      bytes.set(frame, frame.length);
      const first = connection.requestResponse(firstPayload, 0);
      receive(bytes);
      expect(await first).toEqual(payload);
      expect(await connection.requestResponse(secondPayload, 1)).toEqual(
        payload,
      );
    });
  });

  test("writes a request before serving an already-retained frame", async () => {
    await withMemoryConnection(async (connection, receive, writes, flushes) => {
      const idle = connection.requestResponse(firstPayload, 0);
      receive(pairedFrames);
      expect(await idle).toEqual(firstPayload);
      expect(await connection.requestResponse(secondPayload, 1)).toEqual(
        secondPayload,
      );
      expect(writes).toEqual([firstFrame.length, secondFrame.length]);
      expect(flushes).toEqual([1, 2]);
    });
  });

  test("caps pending frames at the declared bound and then fails explicitly", async () => {
    await withMemoryConnection(async (connection, receive, writes) => {
      for (let i = 0; i < LIVE_SOCKET_MAX_PENDING_FRAMES; i++) {
        receive(secondFrame);
      }
      expect(await connection.requestResponse(secondPayload, 0)).toEqual(
        secondPayload,
      );
      receive(secondFrame);
      receive(secondFrame);
      await expect(
        connection.requestResponse(secondPayload, 1),
      ).rejects.toMatchObject({
        code: "TransportFull",
      });
      expect(writes).toEqual([secondFrame.length]);
    });
  });

  test("admits exactly the cap from one coalesced physical delivery", async () => {
    await withMemoryConnection(async (connection, receive) => {
      const chunk = new Uint8Array(
        secondFrame.length * LIVE_SOCKET_MAX_PENDING_FRAMES,
      );
      for (let i = 0; i < LIVE_SOCKET_MAX_PENDING_FRAMES; i++) {
        chunk.set(secondFrame, i * secondFrame.length);
      }
      receive(chunk);
      for (let i = 0; i < LIVE_SOCKET_MAX_PENDING_FRAMES; i++) {
        expect(await connection.requestResponse(secondPayload, 1)).toEqual(
          secondPayload,
        );
      }
    });
  });

  test("settles an active waiter promptly when the cap overflows", async () => {
    await withMemoryConnection(async (connection, receive, writes) => {
      const waiter = connection.requestResponse(firstPayload, 0);
      const result = waiter.catch((error: unknown) => error);
      const chunk = new Uint8Array(
        secondFrame.length * (LIVE_SOCKET_MAX_PENDING_FRAMES + 1),
      );
      for (let i = 0; i <= LIVE_SOCKET_MAX_PENDING_FRAMES; i++) {
        chunk.set(secondFrame, i * secondFrame.length);
      }
      receive(chunk);
      const error = await result;
      expect(error).toBeInstanceOf(TransportError);
      expect(error).toMatchObject({ code: "TransportFull" });
      await expect(connection.requestResponse(secondPayload, 1)).rejects.toBe(
        error,
      );
      expect(writes).toEqual([firstFrame.length]);
    });
  });

  for (const boundary of [2, 6]) {
    test(`retains a suffix of ${boundary} bytes at capacity`, async () => {
      await withMemoryConnection(async (connection, receive, writes) => {
        const bytes = new Uint8Array(
          secondFrame.length * LIVE_SOCKET_MAX_PENDING_FRAMES + boundary,
        );
        for (let i = 0; i < LIVE_SOCKET_MAX_PENDING_FRAMES; i++) {
          bytes.set(secondFrame, i * secondFrame.length);
        }
        bytes.set(firstFrame.subarray(0, boundary), bytes.length - boundary);
        receive(bytes);
        expect(await connection.requestResponse(secondPayload, 0)).toEqual(
          secondPayload,
        );
        receive(firstFrame.subarray(boundary));
        for (let i = 1; i < LIVE_SOCKET_MAX_PENDING_FRAMES; i++) {
          expect(await connection.requestResponse(secondPayload, i)).toEqual(
            secondPayload,
          );
        }
        expect(await connection.requestResponse(firstPayload, 64)).toEqual(
          firstPayload,
        );
        expect(writes.length).toBe(LIVE_SOCKET_MAX_PENDING_FRAMES + 1);
      });
    });
  }

  test("flushes only once when a second flush would throw", async () => {
    await withMemoryConnection(
      async (connection, receive, writes, flushes) => {
        const response = connection.requestResponse(firstPayload, 0);
        expect(flushes).toEqual([1]);
        receive(firstFrame);
        expect(await response).toEqual(firstPayload);
        expect(writes).toEqual([firstFrame.length]);
        expect(flushes).toEqual([1]);
      },
      {
        flush: (count) => {
          if (count === 2) throw new Error("unexpected second flush");
        },
      },
    );
  });

  for (const operation of ["write", "flush"] as const) {
    for (const retained of [false, true]) {
      test(`rejects a ${operation} failure promptly with retained=${retained}`, async () => {
        const failure = new Error(`fixture ${operation} failure`);
        await withMemoryConnection(
          async (connection, receive, writes, flushes) => {
            if (retained) receive(firstFrame);
            let rejected: unknown;
            const response = connection
              .requestResponse(firstPayload, 0)
              .catch((error: unknown) => {
                rejected = error;
              });
            await Promise.resolve();
            await Promise.resolve();
            expect(rejected).toBe(failure);
            await response;
            expect(writes).toEqual([firstFrame.length]);
            expect(flushes).toEqual(operation === "write" ? [] : [1]);
          },
          {
            [operation]: () => {
              throw failure;
            },
          },
        );
      });
    }
  }
});

/** Process UID for attestation: the real local UID, never a constant. */
function localUid(): number {
  const proc = globalThis.process as unknown as {
    getuid?: () => number;
  };
  return typeof proc.getuid === "function" ? proc.getuid() : 1000;
}

/**
 * TDD failing-first proof for CTX-0036 (H-DEV-06): the Unix IPC socket
 * seam must dial a live OS socket and complete a framed request/response
 * round trip, not just flip a connected flag.
 */
describe("live Unix IPC socket (CTX-0036)", () => {
  test("connect -> request -> response round trip over a loopback socket", async () => {
    if (!isLiveSocketSupported()) return;
    const proc = globalThis.process as unknown as {
      getBuiltinModule(id: string): {
        mkdirSync(p: string, o: unknown): void;
        chmodSync(p: string, m: number): void;
        rmSync(p: string, o: unknown): void;
      };
    };
    const fs = proc.getBuiltinModule("node:fs");
    const dir = `${process.env["XDG_RUNTIME_DIR"] ?? "/tmp"}/bitty-devtools-ctx0036-${process.pid}`;
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o700);
    const socketPath = `${dir}/loopback.sock`;
    const payload = new TextEncoder().encode(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        result: { plugins: [] },
        version: "1.0",
      }),
    );
    const wire = new Uint8Array(4 + payload.length);
    new DataView(wire.buffer).setUint32(0, payload.length, false);
    wire.set(payload, 4);

    const server = Bun.listen({
      unix: socketPath,
      socket: {
        data(sock, _data) {
          sock.write(wire);
        },
        error() {},
      },
    });
    fs.chmodSync(socketPath, 0o600);
    try {
      const conn = await connectLiveSocket({
        socketPath,
        runtimeUid: localUid(),
      });
      try {
        const request = new TextEncoder().encode(
          JSON.stringify({
            id: 7,
            method: "bitty.debug/listPlugins",
            params: {},
            version: "1.0",
          }),
        );
        const response = await conn.requestResponse(request, 1000);
        const decoded = JSON.parse(new TextDecoder().decode(response)) as {
          jsonrpc: string;
          id: number;
        };
        expect(decoded.jsonrpc).toBe("2.0");
        expect(decoded.id).toBe(7);
      } finally {
        conn.close();
      }
    } finally {
      server.stop(true);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("symlink at the socket path refuses to attest", async () => {
    if (!isLiveSocketSupported()) return;
    const proc = globalThis.process as unknown as {
      getBuiltinModule(id: string): {
        mkdirSync(p: string, o: unknown): void;
        chmodSync(p: string, m: number): void;
        rmSync(p: string, o: unknown): void;
        symlinkSync(t: string, p: string): void;
      };
    };
    const fs = proc.getBuiltinModule("node:fs");
    const dir = `${process.env["XDG_RUNTIME_DIR"] ?? "/tmp"}/bitty-devtools-ctx0036-link-${process.pid}`;
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o700);
    const target = `${dir}/real.sock`;
    const link = `${dir}/loopback.sock`;
    const server = Bun.listen({
      unix: target,
      socket: {
        data() {},
        error() {},
      },
    });
    fs.chmodSync(target, 0o600);
    fs.symlinkSync(target, link);
    try {
      let caught: unknown = null;
      try {
        await attestLiveSocketEndpoint({
          socketPath: link,
          runtimeUid: localUid(),
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).not.toBeNull();
      expect(String(caught)).toContain("symlink");
    } finally {
      server.stop(true);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
