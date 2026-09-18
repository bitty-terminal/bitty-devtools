import { describe, expect, spyOn, test } from "bun:test";
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
import {
  assertScratchSocketPath,
  createScratchLoopback,
  localUid,
  scratchDir,
  withMemoryConnection,
} from "./helpers/fake-live-socket.js";

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

describe("live Unix IPC socket (CTX-0036)", () => {
  test("connect -> request -> response round trip over a loopback socket", async () => {
    if (!isLiveSocketSupported()) return;
    const payload = new TextEncoder().encode(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        result: { plugins: [] },
        version: "1.0",
      }),
    );
    const loopback = createScratchLoopback({
      prefix: "bitty-devtools-ctx0036",
      responsePayload: payload,
      timeoutMs: 1000,
    });
    try {
      const conn = await connectLiveSocket({
        socketPath: loopback.socketPath,
        runtimeUid: loopback.runtimeUid,
        timeoutMs: loopback.timeoutMs,
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
      loopback.stop();
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
    const nodeFs = proc.getBuiltinModule("node:fs");
    const dir = scratchDir("bitty-devtools-ctx0036-link");
    const target = `${dir}/real.sock`;
    const link = `${dir}/loopback.sock`;
    assertScratchSocketPath(link);
    nodeFs.mkdirSync(dir, { recursive: true });
    nodeFs.chmodSync(dir, 0o700);
    const server = Bun.listen({
      unix: target,
      socket: {
        data() {},
        error() {},
      },
    });
    nodeFs.chmodSync(target, 0o600);
    nodeFs.symlinkSync(target, link);
    const runtime = Bun as unknown as {
      connect(options: unknown): Promise<unknown>;
    };
    const connectSpy = spyOn(runtime, "connect");
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
      expect(connectSpy.mock.calls.length).toBe(0);
      let dialCaught: unknown = null;
      try {
        await connectLiveSocket({
          socketPath: link,
          runtimeUid: localUid(),
          timeoutMs: 1000,
        });
      } catch (error) {
        dialCaught = error;
      }
      expect(dialCaught).not.toBeNull();
      expect(String(dialCaught)).toContain("symlink");
      expect(connectSpy.mock.calls.length).toBe(0);
    } finally {
      connectSpy.mockRestore();
      server.stop(true);
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
