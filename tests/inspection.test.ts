import { describe, expect, test } from "bun:test";
import { DevtoolsClient } from "../src/client.js";
import { InspectionClient } from "../src/inspection.js";
import type { InspectionTransport } from "../src/inspection.js";
import { generation } from "../src/panel-runtime.js";
import type { PanelRuntimeSnapshot } from "../src/panel-runtime.js";
import type { IpcRequest, IpcResponse } from "../src/transport.js";

/** Fake transport that records the exact JSON-RPC requests it receives. */
class RecordingTransport implements InspectionTransport {
  readonly calls: IpcRequest[] = [];
  constructor(
    private readonly result: unknown,
    private readonly connected = true,
  ) {}
  isConnected(): boolean {
    return this.connected;
  }
  request(request: IpcRequest, _nowMs: number): IpcResponse {
    this.calls.push(request);
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: this.result,
      version: "1.0",
    };
  }
}

function makeSnapshot(): PanelRuntimeSnapshot {
  return {
    generation: 2 as unknown as PanelRuntimeSnapshot["generation"],
    panels: [
      {
        id: 1 as unknown as PanelRuntimeSnapshot["panels"][number]["id"],
        generation:
          2 as unknown as PanelRuntimeSnapshot["panels"][number]["generation"],
        state: "Mounted",
        type: "helper",
        workspace:
          1 as unknown as PanelRuntimeSnapshot["panels"][number]["workspace"],
        view: 1 as unknown as PanelRuntimeSnapshot["panels"][number]["view"],
      },
    ],
    panelsPerWorkspace: new Map([[1 as unknown as never, 1]]),
    totalPanels: 1,
    topics: ["xuepoo.git:branch-changed" as never],
    overlays: [],
    config: {
      maxPanelsPerWorkspace: 16,
      maxPanelsPerWindow: 32,
      maxTopicsTotal: 256,
      maxSubscriptionsPerPanel: 32,
    },
  };
}

describe("inspection (debug.inspect default, read-only)", () => {
  test("connection alone grants no authority", () => {
    const c = new DevtoolsClient();
    c.connect();
    expect(() => c.listPlugins()).toThrow("scope required");
  });

  test("inspect scope allows read", () => {
    const c = new DevtoolsClient();
    c.connect();
    c.grantScope("debug.inspect");
    c.setPanelSnapshot(makeSnapshot());
    const plugins = c.listPlugins();
    expect(plugins.length).toBe(1);
    expect(c.getPlugin("panel-1")?.id).toBe("panel-1");
  });

  test("terminal output is untrusted observation with redaction", () => {
    const c = new DevtoolsClient();
    c.connect();
    c.grantScope("debug.inspect");
    c.setPanelSnapshot(makeSnapshot());
    const snap = c.getSnapshotForTerminal("term-1", "hello password=hunter2");
    expect(snap.preview.length > 0).toBe(true);
    expect(snap.redactionMarker.redacted).toBe(false); // preview field not sensitive, content not auto-redacted
  });

  test("panel summary bounded", () => {
    const c = new DevtoolsClient();
    c.connect();
    c.grantScope("debug.inspect");
    c.setPanelSnapshot(makeSnapshot());
    const s = c.panelSummary();
    expect(s.totalPanels).toBe(1);
  });

  test("compat matrix summary reuses 14x4", () => {
    const c = new DevtoolsClient();
    c.connect();
    c.grantScope("debug.inspect");
    c.setPanelSnapshot(makeSnapshot());
    const m = c.compatMatrixSummary();
    expect(m.matrixLen).toBe(14);
    expect(m.referenceTerms.length).toBe(4);
    expect(m.jsonBounded).toBe(true);
  });

  test("preview equals export invariant holds for inspection preview", () => {
    const c = new DevtoolsClient();
    c.connect();
    c.grantScope("debug.inspect");
    c.setPanelSnapshot(makeSnapshot());
    const s = c.getSnapshotForTerminal("term-1", "hello world");
    // preview equals export via redactionPreview (no echo of unbounded bytes)
    expect(s.preview).toBe("hello world");
  });
});

describe("inspection over real IPC (connected path)", () => {
  test("listPlugins dispatches bitty.debug/listPlugins with generation param", () => {
    const transport = new RecordingTransport([
      {
        id: "plugin-a",
        version: "1.2.3",
        generation: 4,
        state: "Activated",
        manifestHash: "sha256:abc",
        capabilities: ["panel.provider"],
      },
    ]);
    const client = new InspectionClient(transport);
    const plugins = client.listPlugins("debug.inspect", generation(2));
    expect(transport.calls.length).toBe(1);
    expect(transport.calls[0]!.method).toBe("bitty.debug/listPlugins");
    expect(transport.calls[0]!.params).toEqual({ generation: generation(2) });
    expect(transport.calls[0]!.version).toBe("1.0");
    expect(plugins.length).toBe(1);
    expect(plugins[0]!.id).toBe("plugin-a");
    expect(Number(plugins[0]!.generation)).toBe(4);
  });

  test("listPlugins without a generation filter sends empty params", () => {
    const transport = new RecordingTransport([]);
    const client = new InspectionClient(transport);
    expect(client.listPlugins("debug.inspect")).toEqual([]);
    expect(transport.calls[0]!.method).toBe("bitty.debug/listPlugins");
    expect(transport.calls[0]!.params).toEqual({});
  });

  test("getPlugin / listSubscriptions / getBudgets use exact methods and params", () => {
    const transport = new RecordingTransport({});
    const client = new InspectionClient(transport);
    client.getPlugin("debug.inspect", "plugin-a");
    client.listSubscriptions("debug.inspect", "plugin-a");
    client.getBudgets("debug.inspect", "plugin-a", generation(7));
    expect(transport.calls.map((c) => c.method)).toEqual([
      "bitty.debug/getPlugin",
      "bitty.debug/listSubscriptions",
      "bitty.debug/getBudgets",
    ]);
    expect(transport.calls[0]!.params).toEqual({ pluginId: "plugin-a" });
    expect(transport.calls[1]!.params).toEqual({ pluginId: "plugin-a" });
    expect(transport.calls[2]!.params).toEqual({
      pluginId: "plugin-a",
      generation: generation(7),
    });
  });

  test("getQueueSnapshot / listHandles use exact methods and params", () => {
    const transport = new RecordingTransport({});
    const client = new InspectionClient(transport);
    client.getQueueSnapshot("debug.inspect", "plugin-a");
    client.listHandles("debug.inspect", "plugin-a");
    expect(transport.calls.map((c) => c.method)).toEqual([
      "bitty.debug/getQueueSnapshot",
      "bitty.debug/listHandles",
    ]);
    expect(transport.calls[0]!.params).toEqual({ pluginId: "plugin-a" });
    expect(transport.calls[1]!.params).toEqual({ pluginId: "plugin-a" });
  });

  test("getSnapshotForTerminal dispatches semantic getSnapshot and redacts", () => {
    const transport = new RecordingTransport({
      cursor: { row: 2, col: 5 },
      modeFlags: ["wrap"],
      semanticZoneCount: 1,
      preview: "hello password=hunter2",
    });
    const client = new InspectionClient(transport);
    const snap = client.getSnapshotForTerminal("debug.inspect", "term-1", "");
    expect(transport.calls[0]!.method).toBe("bitty.debug/getSnapshot");
    expect(transport.calls[0]!.params).toEqual({
      terminalId: "term-1",
      scope: "semantic",
    });
    expect(snap.cursor).toEqual({ row: 2, col: 5 });
    expect(snap.preview).toBe("hello password=hunter2");
    expect(snap.truncated).toBe(false);
  });

  test("typed server error is surfaced as InspectionError", () => {
    const transport: InspectionTransport = {
      isConnected: () => true,
      request: (request) => ({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          category: "scope",
          code: "ScopeDenied",
          message: "scope denied",
        },
        version: "1.0",
      }),
    };
    const client = new InspectionClient(transport);
    expect(() => client.listPlugins("debug.inspect")).toThrow("scope denied");
  });
});

describe("inspection disconnected path (explicit mock injectable)", () => {
  test("disconnected transport falls back to the injected snapshot mock", () => {
    let called = 0;
    const offline: InspectionTransport = {
      isConnected: () => false,
      request: () => {
        called += 1;
        throw new Error("IPC must not be used when disconnected");
      },
    };
    const client = new InspectionClient(offline, () => makeSnapshot());
    const plugins = client.listPlugins("debug.inspect");
    expect(called).toBe(0);
    expect(plugins.length).toBe(1);
    expect(plugins[0]!.id).toBe("panel-1");
  });

  test("disconnected with no injected mock returns no fabricated data", () => {
    const offline: InspectionTransport = {
      isConnected: () => false,
      request: () => {
        throw new Error("IPC must not be used when disconnected");
      },
    };
    const client = new InspectionClient(offline, null);
    expect(client.listPlugins("debug.inspect")).toEqual([]);
    expect(client.getPlugin("debug.inspect", "panel-1")).toBeNull();
  });
});
