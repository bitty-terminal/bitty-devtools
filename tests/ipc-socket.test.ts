import { describe, expect, test } from "bun:test";
import { connectLiveSocket, isLiveSocketSupported } from "../src/ipc-socket.js";

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
        runtimeUid: 1000,
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
});
