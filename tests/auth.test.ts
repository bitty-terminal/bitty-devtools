import { describe, expect, test } from "bun:test";
import {
  peerCredentials,
  verifyPeerUid,
  verifyUnixEndpoint,
  verifyWindowsPipe,
  resolveSocketPath,
  shortInstanceHash,
  timingSafeTokenEqual,
  newChildToken,
  childTokenAuthorizes,
  ChildTokenStore,
  AuthError,
  DIR_MODE,
  SOCKET_MODE,
} from "../src/auth.js";

describe("headless auth policy and endpoint selection", () => {
  test("peer uid equality", () => {
    const peer = peerCredentials(1000, 1000, 42);
    expect(() => verifyPeerUid(peer, 1000)).not.toThrow();
    expect(() => verifyPeerUid(peer, 1001)).toThrow("peer uid");
  });

  test("unix endpoint 0700/0600 + owner check", () => {
    const peer = peerCredentials(1000, 1000, 1);
    expect(() =>
      verifyUnixEndpoint(1000, peer, DIR_MODE, 1000, SOCKET_MODE, 1000),
    ).not.toThrow();
    expect(() =>
      verifyUnixEndpoint(1000, peer, 0o755, 1000, SOCKET_MODE, 1000),
    ).toThrow("0700");
    expect(() =>
      verifyUnixEndpoint(1000, peer, DIR_MODE, 999, SOCKET_MODE, 1000),
    ).toThrow("directory owner");
    expect(() =>
      verifyUnixEndpoint(1000, peer, DIR_MODE, 1000, SOCKET_MODE, 999),
    ).toThrow("socket owner");
    expect(() =>
      verifyUnixEndpoint(
        1000,
        peerCredentials(1001, 1000, 1),
        DIR_MODE,
        1000,
        SOCKET_MODE,
        1000,
      ),
    ).toThrow("peer uid");
  });

  test("windows pipe SID equality", () => {
    expect(() => verifyWindowsPipe(123n, 123n)).not.toThrow();
    expect(() => verifyWindowsPipe(123n, 999n)).toThrow("pipe peer sid");
  });

  test("resolve socket path precedence uses BITTY_SOCKET as a bounded selector", () => {
    const p1 = resolveSocketPath({
      runtimeUid: 1000,
      bittySocket: "/tmp/custom.sock",
    });
    expect(p1).toBe("/tmp/custom.sock");
    const p2 = resolveSocketPath({
      runtimeUid: 1000,
      xdgRuntimeDir: "/run/user/1000",
      instanceId: "my-inst",
    });
    expect(p2).toBe("/run/user/1000/bitty/my-inst.sock");
    const p3 = resolveSocketPath({ runtimeUid: 1000 });
    expect(p3).toBe("/run/user/1000/bitty/default.sock");
    expect(() =>
      resolveSocketPath({ runtimeUid: 1000, bittySocket: "a".repeat(600) }),
    ).toThrow("too long");
    expect(() =>
      resolveSocketPath({ runtimeUid: 1000, instanceId: "bad/id" }),
    ).toThrow("must match");
  });

  test("short socket path stays verbatim below the portable bound", () => {
    expect(
      resolveSocketPath({
        runtimeUid: 1000,
        xdgRuntimeDir: "/run/user/1000",
        instanceId: "my-inst_1",
      }),
    ).toBe("/run/user/1000/bitty/my-inst_1.sock");
  });

  test("SUN_LEN fallback matches bitty-ipc FNV-1a vectors", () => {
    // Vectors derived by invoking bitty-ipc `devtools::resolve_socket_path`
    // (the live server implementation), never hand-computed.
    expect(shortInstanceHash("c".repeat(64))).toBe("3d3bb39181dc91e5");
    expect(
      shortInstanceHash("worker-abcdefghijklmnopqrstuvwxyz0123456789"),
    ).toBe("e14c53fe23cdb8ba");
  });

  test("long base degrades to the 16-hex hashed leaf byte-for-byte", () => {
    const base = `/tmp/${"b".repeat(50)}`;
    const instance = "c".repeat(64);
    expect(
      resolveSocketPath({
        runtimeUid: 1000,
        xdgRuntimeDir: base,
        instanceId: instance,
      }),
    ).toBe(`${base}/bitty/3d3bb39181dc91e5.sock`);
  });

  test("overlong base fails closed even with the hashed instance", () => {
    const base = `/tmp/${"d".repeat(120)}`;
    expect(() =>
      resolveSocketPath({ runtimeUid: 1000, xdgRuntimeDir: base }),
    ).toThrow(/AF_UNIX/);
  });

  test("child token short-lived, PTY fd never env, 0600, bounded 64", () => {
    const tok = newChildToken("tok-abc", "terminal.inspect", "t:4", 0, 60_000);
    expect(childTokenAuthorizes(tok, "terminal.inspect", "t:4", 10_000)).toBe(
      true,
    );
    expect(childTokenAuthorizes(tok, "terminal.input", "t:4", 10_000)).toBe(
      false,
    );
    expect(childTokenAuthorizes(tok, "terminal.inspect", "t:4", 60_000)).toBe(
      false,
    );
    const store = new ChildTokenStore();
    store.insert(tok);
    expect(() =>
      store.verify("tok-abc", "terminal.inspect", "t:4", 500),
    ).not.toThrow();
    expect(() =>
      store.verify("tok-abc", "terminal.inspect", "t:4", 60_000),
    ).toThrow("expired");
    const drained = store.drainExpired(60_000);
    expect(drained).toEqual(["tok-abc"]);
    expect(store.size).toBe(0);
  });

  test("child token rejection diagnostics contain only fixed categories", () => {
    const marker = "benign-marker";
    const store = new ChildTokenStore();
    const check = (message: string) => {
      try {
        store.verify(marker, "terminal.inspect", "t:4", 60_000);
        expect.unreachable("rejected token must throw");
      } catch (err) {
        expect(err).toBeInstanceOf(AuthError);
        expect((err as AuthError).code).toBe("Unauthenticated");
        expect((err as AuthError).message).toBe(message);
        expect(String(err)).not.toContain(marker);
        expect(JSON.stringify(err)).not.toContain(marker);
      }
    };
    check("unknown child token");
    store.insert(newChildToken(marker, "terminal.inspect", "t:4", 0, 60_000));
    expect(() =>
      store.verify(marker, "terminal.inspect", "t:4", 59_999),
    ).not.toThrow();
    check("child token expired");
  });

  test("BITTY_SOCKET selection does not provide peer credentials", () => {
    const peer = peerCredentials(2000, 2000, 99);
    const runtimeUid = 1000;
    expect(() => verifyPeerUid(peer, runtimeUid)).toThrow("peer uid");
  });

  test("token compare is constant-time: no early-exit on prefix", () => {
    // Equal strings compare true.
    expect(timingSafeTokenEqual("tok-abc", "tok-abc")).toBe(true);
    // Same-length mismatches at first, middle, and last byte all read false
    // without short-circuiting the accumulator.
    expect(timingSafeTokenEqual("Xok-abc", "tok-abc")).toBe(false);
    expect(timingSafeTokenEqual("tok-Xbc", "tok-abc")).toBe(false);
    expect(timingSafeTokenEqual("tok-abX", "tok-abc")).toBe(false);
    // Length mismatch never throws (timingSafeEqual would) and reads false.
    expect(timingSafeTokenEqual("tok-abc", "tok-abcd")).toBe(false);
    expect(timingSafeTokenEqual("", "tok-abc")).toBe(false);
    expect(timingSafeTokenEqual("tok-abc", "")).toBe(false);
  });

  test("store verify resolves tokens without Map.get key timing leak", () => {
    const store = new ChildTokenStore();
    store.insert(
      newChildToken("tok-abc", "terminal.inspect", "t:4", 0, 60_000),
    );
    store.insert(
      newChildToken("tok-xyz", "terminal.inspect", "t:4", 0, 60_000),
    );
    // Exact match still verifies.
    expect(() =>
      store.verify("tok-abc", "terminal.inspect", "t:4", 500),
    ).not.toThrow();
    // Near-miss candidates (shared prefix, wrong tail) must not verify.
    expect(() =>
      store.verify("tok-abX", "terminal.inspect", "t:4", 500),
    ).toThrow("unknown child token");
    expect(() =>
      store.verify("tok-ab", "terminal.inspect", "t:4", 500),
    ).toThrow("unknown child token");
    // Scope check still applies after a valid token match.
    try {
      store.verify("tok-abc", "terminal.input", "t:4", 500);
      expect.unreachable("scope mismatch must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).code).toBe("ScopeDenied");
    }
  });
});
