import { describe, expect, test } from "bun:test";
import {
  Frame,
  Framer,
  RateLimiter,
  StdioTransportStub,
  IpcTransport,
  encodeFrame,
  decodeFrame,
  checkPayloadCap,
  checkConnectionCap,
  MAX_FRAME_BYTES,
  RC9_PAYLOAD_CAP_BYTES,
  RC9_MAX_CONNECTIONS,
} from "../src/transport.js";
import { peerCredentials } from "../src/auth.js";

describe("transport framing (phase 2, live runtime, bounded 256 KiB IPC / 1 MiB devtools)", () => {
  test("frame roundtrip small", () => {
    const p = new TextEncoder().encode("hello");
    const wire = encodeFrame(p);
    const { frame, consumed } = decodeFrame(wire);
    expect(consumed).toBe(4 + p.length);
    expect(frame.payload).toEqual(p);
  });

  test("frame rejects oversize 256 KiB", () => {
    const big = new Uint8Array(MAX_FRAME_BYTES + 1);
    expect(() => new Frame(big)).toThrow("payload");
    expect(() => encodeFrame(big)).toThrow("payload");
  });

  test("framer incremental headless", () => {
    const fr = new Framer();
    const w1 = encodeFrame(new TextEncoder().encode("a"));
    const w2 = encodeFrame(new TextEncoder().encode("bb"));
    const conc = new Uint8Array(w1.length + w2.length);
    conc.set(w1, 0);
    conc.set(w2, w1.length);
    const firstHalf = conc.slice(0, 3);
    const secondHalf = conc.slice(3);
    expect(fr.pushBytes(firstHalf).length).toBe(0);
    const out = fr.pushBytes(secondHalf);
    expect(out.length).toBe(2);
    expect(new TextDecoder().decode(out[0]!.payload)).toBe("a");
    expect(new TextDecoder().decode(out[1]!.payload)).toBe("bb");
  });

  test("rate limiter RC-9 100/s burst 200, window 1s", () => {
    const lim = new RateLimiter(10, 5);
    for (let i = 0; i < 5; i++) lim.check(0);
    expect(() => lim.check(0)).toThrow("rate limited");
    expect(() => lim.check(1000)).not.toThrow();
  });

  test("payload and connection caps RC-9/RC-10", () => {
    expect(() => checkPayloadCap(0)).not.toThrow();
    expect(() => checkPayloadCap(RC9_PAYLOAD_CAP_BYTES)).not.toThrow();
    expect(() => checkPayloadCap(RC9_PAYLOAD_CAP_BYTES + 1)).toThrow("exceeds");
    expect(() => checkConnectionCap(RC9_MAX_CONNECTIONS - 1)).not.toThrow();
    expect(() => checkConnectionCap(RC9_MAX_CONNECTIONS)).toThrow(
      "concurrent connections",
    );
  });

  test("stdio stub bounded 64, fail-closed at capacity, drop-oldest countable", () => {
    const a = new StdioTransportStub(2);
    a.trySendPayload(new TextEncoder().encode("a"));
    a.trySendPayload(new TextEncoder().encode("b"));
    expect(() => a.trySendPayload(new TextEncoder().encode("c"))).toThrow(
      "capacity",
    );
    a.sendDropOldest(new Frame(new TextEncoder().encode("c")));
    expect(a.droppedCount()).toBe(1);
    const out = a.drainOutgoing();
    expect(out.length).toBe(2);
    expect(new TextDecoder().decode(out[0]!.payload)).toBe("b");
  });

  test("ipc transport peer creds verified at connect and per privileged action", () => {
    const peer = peerCredentials(1000, 1000, 1);
    const t = new IpcTransport({
      runtimeUid: 1000,
      socketPath: "/run/user/1000/bitty/default.sock",
      peer,
    });
    expect(() => t.connect()).not.toThrow();
    expect(t.isConnected()).toBe(true);
    const req = { id: 1, method: "bitty.debug/listPlugins", version: "1.0" };
    expect(() => t.sendRequest(req, 0)).not.toThrow();
    expect(t.getRateLimiter().countInWindow(0)).toBe(1);
  });

  test("ipc transport rejects foreign user peer", () => {
    const peer = peerCredentials(1001, 1000, 1);
    const t = new IpcTransport({
      runtimeUid: 1000,
      socketPath: "/run/user/1000/bitty/default.sock",
      peer,
    });
    expect(() => t.connect()).toThrow("peer uid");
  });

  test("ipc transport chunking at 256 KiB for 1 MiB logical frame", () => {
    const peer = peerCredentials(1000, 1000, 1);
    const t = new IpcTransport({
      runtimeUid: 1000,
      socketPath: "/run/user/1000/bitty/default.sock",
      peer,
    });
    t.connect();
    const largePayload = "a".repeat(600 * 1024);
    const req = {
      id: 1,
      method: "bitty.debug/listPlugins",
      params: { x: largePayload },
      version: "1.0",
    };
    const frames = t.encodeRequest(req);
    // 600 KiB json will be >256 KiB, so chunked
    expect(frames.length >= 2).toBe(true);
    for (const f of frames) expect(f.length <= 4 + MAX_FRAME_BYTES).toBe(true);
  });

  test("headless forwarding between stubs simulates pipe without OS handle", () => {
    const peer = peerCredentials(1000, 1000, 1);
    const a = new IpcTransport({
      runtimeUid: 1000,
      socketPath: "/tmp/a.sock",
      peer,
    });
    const b = new IpcTransport({
      runtimeUid: 1000,
      socketPath: "/tmp/b.sock",
      peer,
    });
    a.connect();
    b.connect();
    a.sendRequest(
      { id: 1, method: "bitty.debug/listPlugins", version: "1.0" },
      0,
    );
    const moved = a.forwardTo(b);
    expect(moved).toBe(1);
    expect(b.incomingLen()).toBe(1);
  });
});
