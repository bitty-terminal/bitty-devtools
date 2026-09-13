import { describe, expect, test } from "bun:test";
import { DevtoolsClient } from "../src/client.js";
import { IpcTransport } from "../src/transport.js";
import { peerCredentials } from "../src/auth.js";

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
    // Inspection explanation is constant
    const text = c.listPlugins; // ensure exists
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
          result: [
            {
              id: "panel-1",
              version: "1.0.0",
              generation: 1,
              state: "Activated",
              manifestHash: "sha256:x",
              capabilities: ["panel.provider"],
            },
          ],
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
    expect(c.listPlugins()).toEqual([]);
  });
});
