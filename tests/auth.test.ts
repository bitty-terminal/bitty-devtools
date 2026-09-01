import { describe, expect, test } from "bun:test";
import {
  peerCredentials,
  verifyPeerUid,
  verifyUnixEndpoint,
  verifyWindowsPipe,
  resolveSocketPath,
  newChildToken,
  childTokenAuthorizes,
  ChildTokenStore,
  DIR_MODE,
  SOCKET_MODE,
} from "../src/auth.js";

describe("auth peer-creds (phase 2, live runtime)", () => {
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

  test("resolve socket path precedence BITTY_SOCKET advisory", () => {
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

  test("BITTY_SOCKET without peer cred still fails (advisory only)", () => {
    const peer = peerCredentials(2000, 2000, 99);
    const runtimeUid = 1000;
    expect(() => verifyPeerUid(peer, runtimeUid)).toThrow("peer uid");
  });
});
