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

// ---------------------------------------------------------------------------
// CTX-0159 live read-only introspection bindings. Fixtures mirror the exact
// JSON emitted by `bitty-ipc/src/devtools.rs`
// (`handle_get_grid_text` / `handle_get_input_ring` / `handle_get_modifiers` /
// `handle_get_focus`), including the `version` + `snapshot` envelope tags.
// ---------------------------------------------------------------------------

function gridTextPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: "1.0",
    snapshot: "grid-text",
    lines: ["hello introspect", "second row"],
    cursor: { row: 0, col: 16, visible: true },
    cols: 80,
    rows: 24,
    generation: 7,
    ...overrides,
  };
}

function inputRingPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: "1.0",
    snapshot: "input-ring",
    events: [
      {
        seq: 1,
        kind: "key",
        label: "key:a",
        shift: false,
        control: false,
        alt: false,
        button: null,
        col: null,
        row: null,
        pressed: true,
      },
      {
        seq: 2,
        kind: "mouse",
        label: "mouse:Left pressed col=10 row=5",
        shift: false,
        control: false,
        alt: false,
        button: "Left",
        col: 10,
        row: 5,
        pressed: true,
      },
    ],
    count: 2,
    ...overrides,
  };
}

function modifiersPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: "1.0",
    snapshot: "modifiers",
    shift: true,
    control: false,
    alt: false,
    kitty_flags: 0,
    ...overrides,
  };
}

function focusPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: "1.0",
    snapshot: "focus",
    focused: true,
    focused_view: 1,
    mouse_capture: false,
    alt_screen: false,
    bracketed_paste: false,
    focus_events: false,
    ...overrides,
  };
}

describe("inspection introspection (CTX-0159 read-only RPCs)", () => {
  test("getGridText dispatches the real method and params, parses the fixture", () => {
    const transport = new MethodTransport({
      "bitty.debug/getGridText": gridTextPayload(),
    });
    const client = new InspectionClient(transport);
    const snap = client.getGridText("debug.inspect", { rows: 10 });
    expect(transport.calls.length).toBe(1);
    expect(transport.calls[0]!.method).toBe("bitty.debug/getGridText");
    expect(transport.calls[0]!.params).toEqual({ rows: 10 });
    expect(snap.snapshot).toBe("grid-text");
    expect(snap.lines).toEqual(["hello introspect", "second row"]);
    expect(snap.cursor).toEqual({ row: 0, col: 16, visible: true });
    expect(snap.cols).toBe(80);
    expect(snap.rows).toBe(24);
    expect(snap.generation).toBe(7);
  });

  test("getGridText with no options sends empty params (server defaults)", () => {
    const transport = new MethodTransport({
      "bitty.debug/getGridText": gridTextPayload(),
    });
    const client = new InspectionClient(transport);
    client.getGridText("debug.inspect");
    expect(transport.calls[0]!.params).toEqual({});
  });

  test("getGridText rejects unknown/extra fields and a wrong discriminator", () => {
    for (const bad of [
      gridTextPayload({ extra: true }),
      gridTextPayload({ cursor: { row: 0, col: 1, visible: true, pad: 1 } }),
    ]) {
      const client = new InspectionClient(
        new MethodTransport({
          "bitty.debug/getGridText": bad,
        }),
      );
      expect(() => client.getGridText("debug.inspect")).toThrow(
        "unknown field",
      );
    }
    const wrongTag = new InspectionClient(
      new MethodTransport({
        "bitty.debug/getGridText": gridTextPayload({
          snapshot: "runtime-stats",
        }),
      }),
    );
    expect(() => wrongTag.getGridText("debug.inspect")).toThrow(
      'expected "grid-text"',
    );
  });

  test("getGridText fails closed on malformed or oversized lines", () => {
    for (const bad of [
      gridTextPayload({ lines: [1] }),
      gridTextPayload({ lines: Array(65).fill("x") }),
      gridTextPayload({ lines: ["x".repeat(257)] }),
      gridTextPayload({ cursor: { row: -1, col: 0, visible: true } }),
      gridTextPayload({ cols: "80" }),
      gridTextPayload({ generation: undefined }),
    ]) {
      const client = new InspectionClient(
        new MethodTransport({ "bitty.debug/getGridText": bad }),
      );
      expect(() => client.getGridText("debug.inspect")).toThrow();
    }
  });

  test("getInputRing dispatches with limit and parses nullable mouse fields", () => {
    const transport = new MethodTransport({
      "bitty.debug/getInputRing": inputRingPayload(),
    });
    const client = new InspectionClient(transport);
    const ring = client.getInputRing("debug.inspect", { limit: 2 });
    expect(transport.calls[0]!.method).toBe("bitty.debug/getInputRing");
    expect(transport.calls[0]!.params).toEqual({ limit: 2 });
    expect(ring.snapshot).toBe("input-ring");
    expect(ring.count).toBe(2);
    expect(ring.events[0]!.button).toBeNull();
    expect(ring.events[0]!.col).toBeNull();
    expect(ring.events[1]!.button).toBe("Left");
    expect(ring.events[1]!.col).toBe(10);
    expect(ring.events[1]!.row).toBe(5);
  });

  test("getInputRing rejects unknown event fields and oversized rings", () => {
    const unknown = new InspectionClient(
      new MethodTransport({
        "bitty.debug/getInputRing": inputRingPayload({
          events: [
            {
              seq: 1,
              kind: "key",
              label: "key:a",
              shift: false,
              control: false,
              alt: false,
              button: null,
              col: null,
              row: null,
              pressed: true,
              injected: true,
            },
          ],
        }),
      }),
    );
    expect(() => unknown.getInputRing("debug.inspect")).toThrow(
      "unknown field",
    );
    const oversize = new InspectionClient(
      new MethodTransport({
        "bitty.debug/getInputRing": inputRingPayload({
          events: Array(65).fill({
            seq: 1,
            kind: "key",
            label: "key:a",
            shift: false,
            control: false,
            alt: false,
            button: null,
            col: null,
            row: null,
            pressed: null,
          }),
        }),
      }),
    );
    expect(() => oversize.getInputRing("debug.inspect")).toThrow("exceeded");
  });

  test("getModifiers and getFocus dispatch and parse the fixture", () => {
    const transport = new MethodTransport({
      "bitty.debug/getModifiers": modifiersPayload(),
      "bitty.debug/getFocus": focusPayload({ focused_view: null }),
    });
    const client = new InspectionClient(transport);
    const mods = client.getModifiers("debug.inspect");
    const focus = client.getFocus("debug.inspect");
    expect(transport.calls.map((c) => c.method)).toEqual([
      "bitty.debug/getModifiers",
      "bitty.debug/getFocus",
    ]);
    expect(transport.calls[0]!.params).toEqual({});
    expect(mods.shift).toBe(true);
    expect(mods.kittyFlags).toBe(0);
    expect(focus.focused).toBe(true);
    expect(focus.focusedView).toBeNull();
    expect(focus.mouseCapture).toBe(false);
  });

  test("getModifiers/getFocus reject unknown fields", () => {
    const mods = new InspectionClient(
      new MethodTransport({
        "bitty.debug/getModifiers": modifiersPayload({ capslock: true }),
      }),
    );
    expect(() => mods.getModifiers("debug.inspect")).toThrow("unknown field");
    const focus = new InspectionClient(
      new MethodTransport({
        "bitty.debug/getFocus": focusPayload({ window: 1 }),
      }),
    );
    expect(() => focus.getFocus("debug.inspect")).toThrow("unknown field");
  });

  test("invalid introspection filters fail closed before any IPC", () => {
    const transport = new RecordingTransport(gridTextPayload());
    const client = new InspectionClient(transport);
    for (const options of [{ rows: 0 }, { rows: 65 }, { cols: 257 }]) {
      expectInspectionError(
        () => client.getGridText("debug.inspect", options),
        "InvalidParams",
      );
    }
    expectInspectionError(
      () => client.getInputRing("debug.inspect", { limit: 0 }),
      "InvalidParams",
    );
    expect(transport.calls.length).toBe(0);
  });

  test("introspection without a transport is a typed NoTransport error", () => {
    const client = new InspectionClient();
    expectInspectionError(
      () => client.getGridText("debug.inspect"),
      "NoTransport",
    );
    expectInspectionError(
      () => client.getModifiers("debug.inspect"),
      "NoTransport",
    );
  });

  test("typed server error is surfaced for introspection", () => {
    const transport: InspectionTransport = {
      isConnected: () => true,
      request: (request) => ({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          category: "capability",
          code: "Unsupported",
          message: "introspection disabled",
        },
        version: "1.0",
      }),
    };
    const client = new InspectionClient(transport);
    expectInspectionError(
      () => client.getFocus("debug.inspect"),
      "Unsupported",
    );
  });
});
