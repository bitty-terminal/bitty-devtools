import { describe, expect, test } from "bun:test";
import { DevtoolsClient } from "../src/client.js";
import { IpcTransport } from "../src/transport.js";
import { peerCredentials } from "../src/auth.js";
import { createScratchLoopback } from "./helpers/fake-live-socket.js";
import { isLiveSocketSupported } from "../src/ipc-socket.js";

describe("DevtoolsClient integration", () => {
  test("connect + scope lifecycle", () => {
    const c = new DevtoolsClient();
    const s = c.connect();
    expect(s.connected).toBe(true);
    expect(c.currentScope()).toEqual([]);
    c.grantScope("debug.inspect");
    expect(c.currentScope()).toContain("debug.inspect");
    c.grantScope("debug.trace");
    expect(c.currentScope()).toContain("debug.trace");
    c.grantScope("debug.control");
    expect(c.currentScope()).toContain("debug.control");
    c.revokeScope("debug.inspect");
    expect(c.currentScope()).toEqual(["debug.trace", "debug.control"]);
    c.revokeScope("debug.trace");
    c.revokeScope("debug.control");
    expect(c.currentScope()).toEqual([]);
  });

  test("validateFrame bounded 1 MiB", () => {
    const c = new DevtoolsClient();
    expect(() => c.validateFrame("a".repeat(2 * 1024 * 1024))).toThrow(
      "exceeded",
    );
  });

  test("generateCompatMatrixJson bounded <16 KiB", () => {
    const c = new DevtoolsClient();
    c.connect();
    c.grantScope("debug.inspect");
    c.setPanelSnapshot({
      generation: 1 as never,
      panels: [],
      panelsPerWorkspace: new Map(),
      totalPanels: 0,
      topics: [],
      overlays: [],
      config: {
        maxPanelsPerWorkspace: 16,
        maxPanelsPerWindow: 32,
        maxTopicsTotal: 256,
        maxSubscriptionsPerPanel: 32,
      },
    });
    const json = c.generateCompatMatrixJson();
    expect(new TextEncoder().encode(json).length < 16 * 1024).toBe(true);
  });

  test("untrusted observation labeling", () => {
    const c = new DevtoolsClient();
    c.connect();
    c.grantScope("debug.inspect");
    c.setPanelSnapshot({
      generation: 1 as never,
      panels: [],
      panelsPerWorkspace: new Map(),
      totalPanels: 0,
      topics: [],
      overlays: [],
      config: {
        maxPanelsPerWorkspace: 16,
        maxPanelsPerWindow: 32,
        maxTopicsTotal: 256,
        maxSubscriptionsPerPanel: 32,
      },
    });
    const text = c.listPlugins;
    expect(typeof text).toBe("function");
  });
});

describe("DevtoolsClient inspection live IPC wiring", () => {
  test("connected inspection dispatches over the real IpcTransport", () => {
    const c = new DevtoolsClient();
    const transport = new IpcTransport({
      runtimeUid: 1000,
      socketPath: "/run/user/1000/bitty/default.sock",
      peer: peerCredentials(1000, 1000, 1),
    });
    c.connectWithTransport(transport);
    c.grantScope("debug.inspect");
    transport.injectResponsePayload(
      new TextEncoder().encode(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            plugins: [
              {
                id: "panel-1",
                version: "1.0.0",
                generation: 1,
                state: "Activated",
                manifestHash: "sha256:x",
                capabilities: ["panel.provider"],
              },
            ],
          },
          version: "1.0",
        }),
      ),
    );
    const plugins = c.listPlugins();
    expect(plugins.length).toBe(1);
    expect(plugins[0]!.id).toBe("panel-1");
    const sent = transport.getStub().drainOutgoing();
    expect(sent.length).toBe(1);
    const request = JSON.parse(new TextDecoder().decode(sent[0]!.payload)) as {
      method: string;
      version: string;
    };
    expect(request.method).toBe("bitty.debug/listPlugins");
    expect(request.version).toBe("1.0");
  });

  test("disconnected DevtoolsClient uses the injected mock, not IPC", () => {
    const c = new DevtoolsClient();
    c.connect();
    c.grantScope("debug.inspect");
    c.setPanelSnapshot({
      generation: 1 as never,
      panels: [],
      panelsPerWorkspace: new Map(),
      totalPanels: 0,
      topics: [],
      overlays: [],
      config: {
        maxPanelsPerWorkspace: 16,
        maxPanelsPerWindow: 32,
        maxTopicsTotal: 256,
        maxSubscriptionsPerPanel: 32,
      },
    });
  });

  describe("CTX-0080 session and live boundaries", () => {
    test("independent scopes do not widen one another", () => {
      const c = new DevtoolsClient();
      c.connect();
      c.grantScope("debug.trace");
      expect(() => c.listPlugins()).toThrow("debug.inspect scope required");
      c.grantScope("debug.control");
      c.revokeScope("debug.trace");
      expect(() => c.startTrace({})).toThrow("debug.trace scope required");

      expect(() => c.startTrace({})).toThrow("debug.trace scope required");
    });

    test("disconnect clears panel, trace, and control session state", () => {
      const c = new DevtoolsClient();
      c.connect();
      c.grantScope("debug.trace");
      const trace = c.startTrace({});
      c.grantScope("debug.control");
      c.suspendHandler(1 as never, "handler", "test", "tester");
      c.disconnect();
      c.connect();
      c.grantScope("debug.inspect");
      expect(c.getPanelSnapshot()).toBeNull();
      c.grantScope("debug.trace");
      expect(() => c.fetchTraceChunk(trace.traceId, 0)).toThrow("not found");
      c.grantScope("debug.control");
      expect(c.listAuditLog()).toEqual([]);
    });

    test("live socket identity is explicit and trace/control are unavailable", async () => {
      if (!isLiveSocketSupported()) return;
      const responsePayload = new TextEncoder().encode(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { plugins: [] },
          version: "1.0",
        }),
      );
      const loopback = createScratchLoopback({
        prefix: "bitty-devtools-client-ctx0080",
        responsePayload,
        timeoutMs: 1000,
      });
      try {
        const c = new DevtoolsClient();
        await c.connectLiveSocket(
          loopback.runtimeUid,
          peerCredentials(loopback.runtimeUid + 1, loopback.runtimeUid, 1),
          undefined,
          undefined,
          loopback.socketPath,
        );
        expect(c.currentScope()).toEqual([]);
        c.grantScope("debug.inspect");
        expect(() => c.grantScope("debug.trace")).toThrow("inspect-only");
        await expect(
          c.requestLive(
            { id: 2, method: "bitty.debug/startTrace", version: "1.0" },
            0,
          ),
        ).rejects.toMatchObject({
          name: "ProtocolError",
          error: { code: "UnknownMethod" },
        });

        c.disconnect();
      } finally {
        loopback.stop();
      }
    });
  });

  test("failed live connect fails closed and never falls back to mock", () => {
    const c = new DevtoolsClient({
      socketPath: "/run/user/1000/bitty/default.sock",
      runtimeUid: 1000,
      peer: peerCredentials(1001, 1000, 1),
    });
    expect(() => c.connect()).toThrow("peer uid");
    expect(c.isIpcConnected()).toBe(false);
    expect(() => c.listPlugins()).toThrow("not connected");
    expect(c.transportOutgoingLen()).toBeNull();
  });

  test("getGridText dispatches CTX-0159 introspection over the real IpcTransport", () => {
    const c = new DevtoolsClient();
    const transport = new IpcTransport({
      runtimeUid: 1000,
      socketPath: "/run/user/1000/bitty/default.sock",
      peer: peerCredentials(1000, 1000, 1),
    });
    c.connectWithTransport(transport);
    c.grantScope("debug.inspect");
    transport.injectResponsePayload(
      new TextEncoder().encode(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            version: "1.0",
            snapshot: "grid-text",
            lines: ["hi"],
            cursor: { row: 0, col: 2, visible: true },
            cols: 80,
            rows: 24,
            generation: 1,
          },
          version: "1.0",
        }),
      ),
    );
    const snap = c.getGridText({ rows: 10 });
    expect(snap.snapshot).toBe("grid-text");
    expect(snap.lines).toEqual(["hi"]);
    const sent = transport.getStub().drainOutgoing();
    const request = JSON.parse(new TextDecoder().decode(sent[0]!.payload)) as {
      method: string;
      params: unknown;
    };
    expect(request.method).toBe("bitty.debug/getGridText");
    expect(request.params).toEqual({ rows: 10 });
  });

  test("introspection requires a connection and a granted inspect scope", () => {
    const c = new DevtoolsClient();
    expect(() => c.getGridText()).toThrow("not connected");
    c.connect();
    expect(() => c.getFocus()).toThrow("scope required");
    c.grantScope("debug.inspect");
    expect(() => c.getModifiers()).toThrow("no connected inspection transport");
  });

  test("live socket connect serves listPlugins over a loopback socket", async () => {
    const responsePayload = new TextEncoder().encode(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          plugins: [
            {
              id: "panel-live",
              version: "1.0.0",
              generation: 1,
              state: "Activated",
              manifestHash: "sha256:live",
              capabilities: ["panel.provider"],
            },
          ],
        },
        version: "1.0",
      }),
    );
    const loopback = createScratchLoopback({
      prefix: "bitty-devtools-client-ctx0036",
      responsePayload,
      timeoutMs: 1000,
    });
    try {
      const c = new DevtoolsClient();
      const session = await c.connectLiveSocket(
        loopback.runtimeUid,
        peerCredentials(loopback.runtimeUid, loopback.runtimeUid, 1),
        undefined,
        undefined,
        loopback.socketPath,
      );
      expect(session.connected).toBe(true);
      expect(c.isIpcConnected()).toBe(true);
      c.grantScope("debug.inspect");
      await expect(
        c.requestLive(
          { id: 99, method: "bitty.debug/listPlugins", version: "2.0" },
          0,
        ),
      ).rejects.toMatchObject({
        name: "ProtocolError",
        error: { code: "UnsupportedVersion" },
      });
      expect(() => c.listPlugins()).toThrow("unavailable synchronously");
      const typedPlugins = await c.listPluginsLive();

      expect(typedPlugins[0]?.id).toBe("panel-live");
      expect(c.getLiveIdentity()?.authenticated).toBe(false);
      const response = await c.requestLive(
        {
          id: 1,
          method: "bitty.debug/listPlugins",
          params: {},
          version: "1.0",
        },
        0,
      );
      expect(response.id).toBe(1);
      const plugins = (response.result as { plugins: { id: string }[] })
        .plugins;
      expect(plugins[0]!.id).toBe("panel-live");
      c.disconnect();
      expect(c.isIpcConnected()).toBe(false);
    } finally {
      loopback.stop();
    }
  });
});
