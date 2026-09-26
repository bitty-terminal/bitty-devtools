import { describe, expect, test, spyOn } from "bun:test";
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
  RC9_REQ_PER_SEC,
  RC9_BURST_PER_SEC,
  RC9_WINDOW_MS,
} from "../src/transport.js";
import { peerCredentials } from "../src/auth.js";

describe("transport framing (headless fixture, bounded 256 KiB IPC / 1 MiB devtools)", () => {
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

  test("rate limiter defaults retain RC-9 sustained and burst values", () => {
    const lim = RateLimiter.rc9Default();
    for (let i = 0; i < RC9_BURST_PER_SEC; i++) lim.check(0);
    expect(() => lim.check(0)).toThrow("rate limited");
    for (let i = 0; i < RC9_REQ_PER_SEC; i++) lim.check(RC9_WINDOW_MS);
    expect(() => lim.check(RC9_WINDOW_MS)).toThrow("rate limited");
  });

  test("rate limiter refills at the sustained rate after the initial burst", () => {
    const lim = new RateLimiter(2, 4);
    for (let i = 0; i < 4; i++) lim.check(0);
    expect(() => lim.check(0)).toThrow("rate limited");
    for (let second = 1; second <= 10; second++) {
      const nowMs = second * 1000;
      for (let i = 0; i < 2; i++) lim.check(nowMs);
      expect(() => lim.check(nowMs)).toThrow("rate limited");
      expect(lim.countInWindow(nowMs)).toBe(2);
    }
  });

  test("rate limiter preserves fractional refill across rejections", () => {
    const fractional = new RateLimiter(3, 6);
    for (let i = 0; i < 6; i++) fractional.check(0);
    for (let i = 0; i < 3; i++) fractional.check(1000);
    for (const nowMs of [1100, 1200, 1300, 1333]) {
      expect(() => fractional.check(nowMs)).toThrow("rate limited");
    }
    expect(fractional.countInWindow(1333)).toBe(3);
    expect(() => fractional.check(1334)).not.toThrow();
    expect(() => fractional.check(1334)).toThrow("rate limited");
  });

  test("rate limiter caps idle credit and retains the rolling burst ceiling", () => {
    const lim = new RateLimiter(2, 4);
    lim.check(0);
    for (let i = 0; i < 4; i++) lim.check(60_000);
    expect(() => lim.check(60_000)).toThrow("rate limited");
    expect(() => lim.check(60_500)).toThrow("rate limited");
    for (let i = 0; i < 2; i++) lim.check(61_000);
    expect(() => lim.check(61_000)).toThrow("rate limited");
  });

  test("rate limiter does not refill twice after a clock regression", () => {
    const lim = new RateLimiter(2, 4);
    for (let i = 0; i < 4; i++) lim.check(1000);
    for (let i = 0; i < 2; i++) lim.check(2000);
    expect(() => lim.check(1500)).toThrow("rate limited");
    expect(() => lim.check(2000)).toThrow("rate limited");
    expect(() => lim.check(2499)).toThrow("rate limited");
    expect(() => lim.check(2500)).not.toThrow();
  });

  test("rate limiter zero rate never refills and zero burst never admits", () => {
    const lim = new RateLimiter(0, 1);
    lim.check(0);
    expect(() => lim.check(60_000)).toThrow("rate limited");
    expect(() => new RateLimiter(2, 0).check(60_000)).toThrow("rate limited");
  });

  test("rate limiter shares count and check time observations", () => {
    const lim = new RateLimiter(2, 2);
    lim.check(0);
    lim.check(0);
    expect(lim.countInWindow(1000)).toBe(0);
    lim.check(500);
    lim.check(500);
    expect(lim.countInWindow(1500)).toBe(2);
    expect(() => lim.check(1500)).toThrow("rate limited");
    expect(lim.countInWindow(0)).toBe(2);
    expect(lim.countInWindow(2000)).toBe(0);
  });

  test("rate limiter counting before admission establishes the clock", () => {
    const lim = new RateLimiter(2, 2);
    expect(lim.countInWindow(1000)).toBe(0);
    lim.check(0);
    expect(lim.countInWindow(1000)).toBe(1);
    expect(lim.countInWindow(1999)).toBe(1);
    expect(lim.countInWindow(2000)).toBe(0);
  });

  test("rate limiter rejects unsupported numeric configuration", () => {
    for (const value of [-1, 0.5, NaN, Infinity, -Infinity, 2 ** 32]) {
      expect(() => new RateLimiter(value, 2)).toThrow(RangeError);
      expect(() => new RateLimiter(2, value)).toThrow(RangeError);
    }
    expect(() => new RateLimiter(2 ** 32 - 1, 2 ** 32 - 1)).not.toThrow();
  });

  test("rate limiter rejects invalid time without changing state", () => {
    const lim = new RateLimiter(2, 2);
    lim.check(0);
    for (const nowMs of [-1, 0.5, NaN, Infinity, -Infinity, 2 ** 53]) {
      expect(() => lim.check(nowMs)).toThrow(RangeError);
      expect(() => lim.countInWindow(nowMs)).toThrow(RangeError);
      expect(lim.countInWindow(0)).toBe(1);
    }
    lim.check(0);
    expect(() => lim.check(0)).toThrow("rate limited");
  });

  test("rate limiter preserves millisecond precision at the safe integer boundary", () => {
    const lim = new RateLimiter(2, 4);
    const end = Number.MAX_SAFE_INTEGER;
    for (let i = 0; i < 4; i++) lim.check(end - 1500);
    for (let i = 0; i < 2; i++) lim.check(end - 500);
    expect(() => lim.check(end - 1)).toThrow("rate limited");
    lim.check(end);
    expect(() => lim.check(end)).toThrow("rate limited");
  });

  test("rate limiter caps wide elapsed refill and rate above burst", () => {
    const lim = new RateLimiter(2 ** 32 - 1, 1);
    lim.check(0);
    expect(() => lim.check(999)).toThrow("rate limited");
    lim.check(1000);
    lim.check(Number.MAX_SAFE_INTEGER);
    expect(() => lim.check(Number.MAX_SAFE_INTEGER)).toThrow("rate limited");
  });

  test("rate limiter bulk eviction stays correct and bounded", () => {
    const lim = new RateLimiter(200, 200);
    for (let i = 0; i < 200; i++) lim.check(0);
    expect(lim.countInWindow(0)).toBe(200);
    // Window advance evicts all 200 at once (was O(K) per shift()).
    expect(lim.countInWindow(1000)).toBe(0);
    expect(lim.isEmpty()).toBe(true);
    // Limiter still accepts after full eviction (head compaction correct).
    expect(() => lim.check(1000)).not.toThrow();
    expect(lim.countInWindow(1000)).toBe(1);
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

  test("headless transport verifies supplied peer values at connect and per privileged action", () => {
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

  test("reconnect admission is independent of completed request history", () => {
    const t = new IpcTransport({
      runtimeUid: 1000,
      socketPath: "/unused/headless.sock",
      peer: peerCredentials(1000, 1000, 1),
    });
    for (let cycle = 0; cycle < 2; cycle++) {
      t.connect();
      for (let id = 0; id <= RC9_MAX_CONNECTIONS; id++) {
        t.injectResponsePayload(
          new TextEncoder().encode(
            JSON.stringify({ jsonrpc: "2.0", id, result: {}, version: "1.0" }),
          ),
        );
        expect(
          t.request(
            { id, method: "bitty.debug/listPlugins", version: "1.0" },
            0,
          ).id,
        ).toBe(id);
        expect(t.getStub().recvOutgoing()).toBeDefined();
      }
      expect(() => t.connect()).not.toThrow();
      expect(t.isConnected()).toBe(true);
      t.injectResponsePayload(new TextEncoder().encode("{}"));
      t.disconnect();
      t.disconnect();
      expect(t.isConnected()).toBe(false);
      expect(t.outgoingLen()).toBe(0);
      expect(t.incomingLen()).toBe(0);
      expect(t.getRateLimiter().countInWindow(0)).toBe(
        (cycle + 1) * (RC9_MAX_CONNECTIONS + 1),
      );
    }
    expect(() => t.connect()).not.toThrow();
    t.disconnect();
  });

  test("reconnect preserves rate credit and releases terminally closed ownership", () => {
    const t = new IpcTransport({
      runtimeUid: 1000,
      socketPath: "/unused/headless.sock",
      peer: peerCredentials(1000, 1000, 1),
      capacity: 1,
    });
    const req = { id: 1, method: "bitty.debug/listPlugins", version: "1.0" };
    t.connect();
    t.sendRequest(req, 0);
    expect(() => t.sendRequest(req, 0)).toThrow("capacity");
    expect(t.isConnected()).toBe(true);
    t.disconnect();
    expect(t.outgoingLen()).toBe(0);
    t.connect();
    t.sendRequest(req, 0);
    expect(t.getRateLimiter().countInWindow(0)).toBe(3);
    t.getStub().close();
    expect(() => t.sendRequest(req, 0)).toThrow("closed");
    expect(t.isConnected()).toBe(false);
    expect(t.outgoingLen()).toBe(0);
    expect(() => t.connect()).toThrow("closed");
    t.disconnect();
    expect(() => t.connect()).toThrow("closed");
    expect(t.isConnected()).toBe(false);
    expect(t.getRateLimiter().countInWindow(0)).toBe(3);
  });

  test("reconnect failure leaves no ownership and rechecks peer identity", () => {
    const peer = peerCredentials(1000, 1000, 1);
    const t = new IpcTransport({
      runtimeUid: 1000,
      socketPath: "/unused/headless.sock",
      peer,
    });
    peer.uid = 1001;
    expect(() => t.connect()).toThrow("peer uid");
    expect(t.isConnected()).toBe(false);
    t.disconnect();
    peer.uid = 1000;
    t.connect();
    peer.uid = 1001;
    expect(() => t.connect()).toThrow("peer uid");
    expect(() =>
      t.sendRequest(
        { id: 1, method: "bitty.debug/listPlugins", version: "1.0" },
        0,
      ),
    ).toThrow("peer uid");
    t.disconnect();
    peer.uid = 1000;
    expect(() => t.connect()).not.toThrow();
    t.disconnect();
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

  test("ipc transport rejects malformed UTF-8 before response parsing", () => {
    const t = new IpcTransport({
      runtimeUid: 1000,
      socketPath: "/unused/headless.sock",
      peer: peerCredentials(1000, 1000, 1),
    });
    t.connect();
    t.injectResponsePayload(new Uint8Array([0xff]));
    expect(() =>
      t.request(
        { id: 1, method: "bitty.debug/listPlugins", version: "1.0" },
        0,
      ),
    ).toThrow("not valid UTF-8");
    t.disconnect();
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

  test("request sends and decodes the injected response envelope", () => {
    const peer = peerCredentials(1000, 1000, 1);
    const t = new IpcTransport({
      runtimeUid: 1000,
      socketPath: "/run/user/1000/bitty/default.sock",
      peer,
    });
    t.connect();
    t.injectResponsePayload(
      new TextEncoder().encode(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 9,
          result: { ok: true },
          version: "1.0",
        }),
      ),
    );
    const res = t.request(
      { id: 9, method: "bitty.debug/listPlugins", version: "1.0" },
      0,
    );
    expect(res.result).toEqual({ ok: true });
    expect(t.outgoingLen()).toBe(1);
  });

  test("windows pipe identity is verified at connect (CTX-0043)", () => {
    const peer = peerCredentials(1000, 1000, 1);
    const t = new IpcTransport({
      runtimeUid: 1000,
      socketPath: "\\\\.\\pipe\\bitty-default",
      peer,
      windowsPeerSid: 1001,
      windowsRuntimeSid: 1000,
    });
    expect(() => t.connect()).toThrow("pipe peer sid");
    expect(t.isConnected()).toBe(false);
  });

  test("windows pipe verify is called on connect and per action (CTX-0043)", async () => {
    const auth = await import("../src/auth.js");
    const peer = peerCredentials(1000, 1000, 1);
    const spy = spyOn(auth, "verifyWindowsPipe");
    try {
      const t = new IpcTransport({
        runtimeUid: 1000,
        socketPath: "\\\\.\\pipe\\bitty-default",
        peer,
        windowsPeerSid: 1000,
        windowsRuntimeSid: 1000,
      });
      t.connect();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(1000, 1000);
      t.sendRequest(
        { id: 1, method: "bitty.debug/listPlugins", version: "1.0" },
        0,
      );
      expect(spy.mock.calls.length >= 2).toBe(true);
      expect(spy.mock.calls[spy.mock.calls.length - 1]).toEqual([1000, 1000]);
    } finally {
      spy.mockRestore();
    }
  });

  test("request fails closed when the response id does not match", () => {
    const peer = peerCredentials(1000, 1000, 1);
    const t = new IpcTransport({
      runtimeUid: 1000,
      socketPath: "/run/user/1000/bitty/default.sock",
      peer,
    });
    t.connect();
    t.injectResponsePayload(
      new TextEncoder().encode(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 8,
          result: {},
          version: "1.0",
        }),
      ),
    );
    expect(() =>
      t.request(
        { id: 9, method: "bitty.debug/listPlugins", version: "1.0" },
        0,
      ),
    ).toThrow("response id");
  });
});
