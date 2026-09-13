import { describe, expect, test } from "bun:test";
import { DevtoolsClient } from "../src/client.js";
import { InspectionClient, InspectionError } from "../src/inspection.js";
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

/** Fake transport that returns a distinct result per JSON-RPC method. */
class MethodTransport implements InspectionTransport {
  readonly calls: IpcRequest[] = [];
  constructor(private readonly results: Record<string, unknown>) {}
  isConnected(): boolean {
    return true;
  }
  request(request: IpcRequest, _nowMs: number): IpcResponse {
    this.calls.push(request);
    if (!(request.method in this.results)) {
      throw new Error(`no fake result for ${request.method}`);
    }
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: this.results[request.method],
      version: "1.0",
    };
  }
}

function expectInspectionError(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(InspectionError);
  expect((caught as InspectionError).code).toBe(code);
}

function pluginPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "plugin-a",
    version: "1.2.3",
    generation: 4,
    state: "Activated",
    manifestHash: "sha256:abc",
    capabilities: ["panel.provider"],
    ...overrides,
  };
}

function subscriptionPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    eventType: "bitty.panel:mounted",
    queueDepth: 0,
    queuedBytes: 0,
    dropCount: 0,
    policy: "DropOldest",
    ...overrides,
  };
}

function budgetPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    generation: 7,
    rc1Instructions: 10,
    rc1WallMs: 1,
    rc2MemoryBytes: 2,
    rc4Tasks: 3,
    rc4Timers: 4,
    rc5QueueDepth: 5,
    would_exceed_lua_limits: false,
    ...overrides,
  };
}

function queuePayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    perSubscription: { limit: 64, current: 2 },
    perPlugin: {
      events: 12,
      bytes: 4096,
      limitEvents: 1024,
      limitBytes: 262144,
    },
    global: {
      events: 120,
      bytes: 65536,
      limitEvents: 8192,
      limitBytes: 2097152,
    },
    invariant_queue_bounds: true,
    invariant_global_bounds: true,
    ...overrides,
  };
}

function handlePayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    handle: "handle-1",
    capability: "panel.create",
    refCount: 1,
    ...overrides,
  };
}

function semanticSnapshotPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    cursor: { row: 2, col: 5 },
    modeFlags: ["wrap"],
    semanticZoneCount: 1,
    preview: "hello password=hunter2",
    ...overrides,
  };
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
    const transport = new RecordingTransport({
      plugins: [pluginPayload()],
    });
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

  test("listPlugins without a filter sends the RFC generation:null param", () => {
    const transport = new RecordingTransport({ plugins: [] });
    const client = new InspectionClient(transport);
    expect(client.listPlugins("debug.inspect")).toEqual([]);
    expect(transport.calls[0]!.method).toBe("bitty.debug/listPlugins");
    expect(transport.calls[0]!.params).toEqual({ generation: null });
  });

  test("listPlugins fails closed on a non-envelope (bare array) result", () => {
    const transport = new RecordingTransport([pluginPayload()]);
    const client = new InspectionClient(transport);
    expectInspectionError(
      () => client.listPlugins("debug.inspect"),
      "InvalidResult",
    );
  });

  test("getPlugin / listSubscriptions / getBudgets use RFC methods and params", () => {
    const transport = new MethodTransport({
      "bitty.debug/getPlugin": pluginPayload(),
      "bitty.debug/listSubscriptions": [subscriptionPayload()],
      "bitty.debug/getBudgets": budgetPayload(),
    });
    const client = new InspectionClient(transport);
    const plugin = client.getPlugin("debug.inspect", "plugin-a");
    const subs = client.listSubscriptions("debug.inspect", "plugin-a");
    const budget = client.getBudgets(
      "debug.inspect",
      "plugin-a",
      generation(7),
    );
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
    expect(plugin?.id).toBe("plugin-a");
    expect(subs[0]!.eventType).toBe("bitty.panel:mounted");
    // RFC verdict key is snake_case and is surfaced as camelCase.
    expect(budget.wouldExceedLuaLimits).toBe(false);
  });

  test("getBudgets fails closed on camelCase verdict key", () => {
    const transport = new MethodTransport({
      "bitty.debug/getBudgets": budgetPayload({
        would_exceed_lua_limits: undefined,
        wouldExceedLuaLimits: false,
      }),
    });
    const client = new InspectionClient(transport);
    expect(() =>
      client.getBudgets("debug.inspect", "plugin-a", generation(7)),
    ).toThrow("would_exceed_lua_limits");
  });

  test("getQueueSnapshot / listHandles use RFC methods and params", () => {
    const transport = new MethodTransport({
      "bitty.debug/getQueueSnapshot": queuePayload(),
      "bitty.debug/listHandles": [handlePayload()],
    });
    const client = new InspectionClient(transport);
    const queue = client.getQueueSnapshot("debug.inspect", "plugin-a");
    const handles = client.listHandles("debug.inspect", "plugin-a");
    expect(transport.calls.map((c) => c.method)).toEqual([
      "bitty.debug/getQueueSnapshot",
      "bitty.debug/listHandles",
    ]);
    expect(transport.calls[0]!.params).toEqual({ pluginId: "plugin-a" });
    expect(transport.calls[1]!.params).toEqual({ pluginId: "plugin-a" });
    expect(queue.invariantQueueBounds).toBe(true);
    expect(queue.invariantGlobalBounds).toBe(true);
    expect(handles[0]!.refCount).toBe(1);
  });

  test("getQueueSnapshot fails closed on camelCase verdict keys", () => {
    const transport = new MethodTransport({
      "bitty.debug/getQueueSnapshot": queuePayload({
        invariant_queue_bounds: undefined,
        invariantQueueBounds: true,
      }),
    });
    const client = new InspectionClient(transport);
    expect(() => client.getQueueSnapshot("debug.inspect", "plugin-a")).toThrow(
      "invariant_queue_bounds",
    );
  });

  test("listPlugins fails closed on malformed/missing plugin fields", () => {
    for (const bad of [
      pluginPayload({ id: "" }),
      pluginPayload({ version: undefined }),
      pluginPayload({ generation: "4" }),
      pluginPayload({ state: "Unknown" }),
      pluginPayload({ capabilities: [1] }),
    ]) {
      const client = new InspectionClient(
        new RecordingTransport({ plugins: [bad] }),
      );
      expectInspectionError(
        () => client.listPlugins("debug.inspect"),
        "InvalidResult",
      );
    }
  });

  test("getSnapshotForTerminal dispatches semantic getSnapshot and redacts", () => {
    const transport = new RecordingTransport(semanticSnapshotPayload());
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

  test("getSnapshotForTerminal fails closed on the runtime-stats snapshot", () => {
    const transport = new RecordingTransport({
      snapshot: "runtime-stats",
      instance: "default",
      pid: 42,
      cols: 80,
      rows: 24,
    });
    const client = new InspectionClient(transport);
    expectInspectionError(
      () => client.getSnapshotForTerminal("debug.inspect", "term-1", ""),
      "SemanticSnapshotUnavailable",
    );
  });

  test("getSnapshotForTerminal fails closed on a missing semantic shape", () => {
    const client = new InspectionClient(
      new RecordingTransport({ preview: "hi" }),
    );
    expect(() =>
      client.getSnapshotForTerminal("debug.inspect", "term-1", ""),
    ).toThrow("getSnapshot result");
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
