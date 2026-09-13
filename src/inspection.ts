/**
 * Inspection surface (debug.inspect, read-only, default).
 *
 * Provides human-facing diagnostics for local debugging over the Panel Runtime
 * snapshot and compat matrix. All results are bounded, redacted, and labeled
 * as untrusted observation data. No trace collection or VM control is exposed
 * here. Scope `debug.inspect` is required; connection alone grants nothing.
 */

import { BOUNDS, assertBounded } from "./bounds.js";
import { redactPreview } from "./redaction.js";
import { generation } from "./panel-runtime.js";
import type {
  PanelRuntimeSnapshot,
  PanelId,
  Generation,
} from "./panel-runtime.js";
import {
  generateMatrixJson,
  MATRIX,
  REFERENCE_TERMS,
} from "./compat-matrix.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import type { IpcRequest, IpcResponse } from "./transport.js";

export type PluginState =
  | "Declared"
  | "Resolved"
  | "Registered"
  | "Activated"
  | "Suspended"
  | "Disposed";

export type PluginSummary = {
  id: string;
  version: string;
  generation: Generation;
  state: PluginState;
  manifestHash: string;
  capabilities: string[];
};

export type SubscriptionInfo = {
  eventType: string;
  queueDepth: number;
  queuedBytes: number;
  dropCount: number;
  policy: "DropOldest" | "DropNewest";
};

export type BudgetSnapshot = {
  pluginId: string;
  generation: Generation;
  rc1Instructions: number;
  rc1WallMs: number;
  rc2MemoryBytes: number;
  rc4Tasks: number;
  rc4Timers: number;
  rc5QueueDepth: number;
  wouldExceedLuaLimits: boolean;
};

export type QueueSnapshot = {
  perSubscription: { limit: number; current: number };
  perPlugin: {
    events: number;
    bytes: number;
    limitEvents: number;
    limitBytes: number;
  };
  global: {
    events: number;
    bytes: number;
    limitEvents: number;
    limitBytes: number;
  };
  invariantQueueBounds: boolean;
  invariantGlobalBounds: boolean;
};

export type SemanticSnapshot = {
  terminalId: string;
  scope: "semantic";
  cursor: { row: number; col: number };
  modeFlags: string[];
  semanticZoneCount: number;
  preview: string;
  redactionMarker: { redacted: boolean; truncated: boolean };
  truncated: boolean;
};

export type HandleInfo = {
  handle: string;
  capability: string;
  refCount: number;
};

export class InspectionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "InspectionError";
  }
}

/**
 * Diagnostics bound for inspection results: each list is capped and each
 * string field is bounded before return (fail-closed).
 */
const MAX_PLUGINS = 256;
const MAX_SUBSCRIPTIONS = 32;
const MAX_HANDLES = 256;
const MAX_PREVIEW_CHARS = 2048;

/**
 * Local, read-only snapshot source. It is consulted only when no transport is
 * connected (headless/unit-test fallback) and is never the production path:
 * production inspection dispatches real JSON-RPC over `InspectionTransport`.
 */
export type InspectionSnapshotSource = () => PanelRuntimeSnapshot | null;

/**
 * JSON-RPC request/response seam for inspection. Production binds this to the
 * connected `IpcTransport`; unit tests inject a fake to assert the exact
 * method names and params. `request` returns the decoded response envelope.
 */
export type InspectionTransport = {
  isConnected(): boolean;
  request(request: IpcRequest, nowMs: number): IpcResponse;
};

const PLUGIN_STATES: readonly PluginState[] = [
  "Declared",
  "Resolved",
  "Registered",
  "Activated",
  "Suspended",
  "Disposed",
];

// ---------------------------------------------------------------------------
// Fail-closed result parsing (H3): the RFC lists the required fields, so a
// missing or mistyped field is a protocol error, never a defaulted value.
// ---------------------------------------------------------------------------

function parseError(field: string, message: string): InspectionError {
  return new InspectionError("InvalidResult", `${field}: ${message}`);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw parseError(field, "expected an object");
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw parseError(field, "expected an array");
  }
  return value;
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  field: string,
): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw parseError(`${field}.${key}`, "expected a string");
  }
  return value;
}

function requireNonEmptyString(
  record: Record<string, unknown>,
  key: string,
  field: string,
): string {
  const value = requireString(record, key, field);
  if (value.length === 0) {
    throw parseError(`${field}.${key}`, "must not be empty");
  }
  return value;
}

function requireNumber(
  record: Record<string, unknown>,
  key: string,
  field: string,
): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw parseError(`${field}.${key}`, "expected a finite number");
  }
  return value;
}

function requireBoolean(
  record: Record<string, unknown>,
  key: string,
  field: string,
): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw parseError(`${field}.${key}`, "expected a boolean");
  }
  return value;
}

function requireGeneration(
  record: Record<string, unknown>,
  key: string,
  field: string,
): Generation {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw parseError(`${field}.${key}`, "expected a positive integer");
  }
  return generation(value);
}

function requirePluginState(
  record: Record<string, unknown>,
  key: string,
  field: string,
): PluginState {
  const value = record[key];
  if (
    typeof value !== "string" ||
    !(PLUGIN_STATES as readonly string[]).includes(value)
  ) {
    throw parseError(
      `${field}.${key}`,
      `unknown plugin state ${String(value)}`,
    );
  }
  return value as PluginState;
}

function requireStringArray(
  record: Record<string, unknown>,
  key: string,
  field: string,
): string[] {
  const value = record[key];
  if (!Array.isArray(value) || !value.every((c) => typeof c === "string")) {
    throw parseError(`${field}.${key}`, "expected an array of strings");
  }
  return value as string[];
}

function pluginSummaryFrom(value: unknown, field = "plugin"): PluginSummary {
  const r = requireRecord(value, field);
  return {
    id: requireNonEmptyString(r, "id", field),
    version: requireNonEmptyString(r, "version", field),
    generation: requireGeneration(r, "generation", field),
    state: requirePluginState(r, "state", field),
    manifestHash: requireNonEmptyString(r, "manifestHash", field),
    capabilities: requireStringArray(r, "capabilities", field),
  };
}

export class InspectionClient {
  private nextRequestId = 1;

  constructor(
    private readonly transport: InspectionTransport | null = null,
    private readonly getSnapshot: InspectionSnapshotSource | null = null,
  ) {}

  private isLive(): boolean {
    return this.transport !== null && this.transport.isConnected();
  }

  private snapshot(): PanelRuntimeSnapshot | null {
    return this.getSnapshot === null ? null : this.getSnapshot();
  }

  private rpc(method: string, params: unknown = {}): unknown {
    const transport = this.transport;
    if (transport === null || !transport.isConnected()) {
      throw new InspectionError(
        "NoTransport",
        "no connected inspection transport",
      );
    }
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const response = transport.request(
      { id, method, params, version: PROTOCOL_VERSION },
      Date.now(),
    );
    if (response.error !== undefined) {
      throw new InspectionError(
        response.error.code,
        `${response.error.category}: ${response.error.message}`,
      );
    }
    return response.result;
  }

  private requireInspect(scope: string): void {
    if (
      scope !== "debug.inspect" &&
      scope !== "debug.trace" &&
      scope !== "debug.control"
    ) {
      throw new InspectionError("ScopeDenied", "debug.inspect scope required");
    }
  }

  listPlugins(scope: string, generationFilter?: Generation): PluginSummary[] {
    this.requireInspect(scope);
    if (this.isLive()) {
      // RFC request example: `params: { "generation": null }`; the accepted
      // result envelope is `{ "plugins": [...] }` (devtools-rfc v1).
      const result = this.rpc("bitty.debug/listPlugins", {
        generation: generationFilter ?? null,
      });
      const envelope = requireRecord(result, "listPlugins result");
      const list = requireArray(
        envelope["plugins"],
        "listPlugins result.plugins",
      );
      assertBounded("MAX_PLUGINS", list.length, MAX_PLUGINS);
      return list
        .slice(0, MAX_PLUGINS)
        .map((entry, i) =>
          pluginSummaryFrom(entry, `listPlugins result.plugins[${i}]`),
        );
    }
    // Headless/unit-test fallback: synthesize bounded observation data from
    // the locally injected PanelRuntime snapshot. Never used when connected.
    const snap = this.snapshot();
    if (!snap) return [];
    assertBounded("MAX_PLUGINS", snap.panels.length, MAX_PLUGINS);
    return snap.panels.slice(0, MAX_PLUGINS).map((p) => ({
      id: `panel-${p.id}`,
      version: "0.0.1",
      generation: generationFilter ?? p.generation,
      state: "Activated" as PluginState,
      manifestHash: "sha256:stub",
      capabilities: ["panel.provider"],
    }));
  }

  getPlugin(scope: string, pluginId: string): PluginSummary | null {
    this.requireInspect(scope);
    if (pluginId.length === 0 || pluginId.length > 128) {
      throw new InspectionError("InvalidPluginId", "pluginId must be 1..128");
    }
    if (this.isLive()) {
      const result = this.rpc("bitty.debug/getPlugin", { pluginId });
      if (result === null || result === undefined) return null;
      return pluginSummaryFrom(result, "getPlugin result");
    }
    const snap = this.snapshot();
    if (!snap) return null;
    const found = snap.panels.find((p) => `panel-${p.id}` === pluginId);
    if (!found) return null;
    return {
      id: pluginId,
      version: "0.0.1",
      generation: found.generation,
      state: "Activated",
      manifestHash: "sha256:stub",
      capabilities: ["panel.provider"],
    };
  }

  listSubscriptions(scope: string, pluginId: string): SubscriptionInfo[] {
    this.requireInspect(scope);
    if (pluginId.length > 128)
      throw new InspectionError("InvalidPluginId", "pluginId too long");
    if (this.isLive()) {
      const result = this.rpc("bitty.debug/listSubscriptions", { pluginId });
      const list = requireArray(result, "listSubscriptions result");
      assertBounded("MAX_SUBSCRIPTIONS", list.length, MAX_SUBSCRIPTIONS);
      return list.slice(0, MAX_SUBSCRIPTIONS).map((entry, i) => {
        const field = `listSubscriptions result[${i}]`;
        const r = requireRecord(entry, field);
        const policy = requireNonEmptyString(r, "policy", field);
        if (policy !== "DropOldest" && policy !== "DropNewest") {
          throw parseError(`${field}.policy`, `unknown policy ${policy}`);
        }
        return {
          eventType: requireNonEmptyString(r, "eventType", field),
          queueDepth: requireNumber(r, "queueDepth", field),
          queuedBytes: requireNumber(r, "queuedBytes", field),
          dropCount: requireNumber(r, "dropCount", field),
          policy,
        };
      });
    }
    // Bounded stub: per-panel 32 topics max, per subscription 64
    const subs: SubscriptionInfo[] = [
      {
        eventType: "bitty.panel:mounted",
        queueDepth: 0,
        queuedBytes: 0,
        dropCount: 0,
        policy: "DropOldest",
      },
      {
        eventType: "xuepoo.git:branch-changed",
        queueDepth: 2,
        queuedBytes: 256,
        dropCount: 1,
        policy: "DropOldest",
      },
    ];
    assertBounded("MAX_SUBSCRIPTIONS", subs.length, MAX_SUBSCRIPTIONS);
    return subs;
  }

  getBudgets(scope: string, pluginId: string, gen: Generation): BudgetSnapshot {
    this.requireInspect(scope);
    if (pluginId.length > 128)
      throw new InspectionError("InvalidPluginId", "pluginId too long");
    if (this.isLive()) {
      const result = this.rpc("bitty.debug/getBudgets", {
        pluginId,
        generation: gen,
      });
      const field = "getBudgets result";
      const r = requireRecord(result, field);
      return {
        pluginId,
        generation: requireGeneration(r, "generation", field),
        rc1Instructions: requireNumber(r, "rc1Instructions", field),
        rc1WallMs: requireNumber(r, "rc1WallMs", field),
        rc2MemoryBytes: requireNumber(r, "rc2MemoryBytes", field),
        rc4Tasks: requireNumber(r, "rc4Tasks", field),
        rc4Timers: requireNumber(r, "rc4Timers", field),
        rc5QueueDepth: requireNumber(r, "rc5QueueDepth", field),
        // RFC v1 verdict spelling is snake_case (devtools-rfc:341).
        wouldExceedLuaLimits: requireBoolean(
          r,
          "would_exceed_lua_limits",
          field,
        ),
      };
    }
    return {
      pluginId,
      generation: gen,
      rc1Instructions: 1_234_567,
      rc1WallMs: 12,
      rc2MemoryBytes: 4 * 1024 * 1024,
      rc4Tasks: 2,
      rc4Timers: 1,
      rc5QueueDepth: 2,
      wouldExceedLuaLimits: false,
    };
  }

  getQueueSnapshot(scope: string, pluginId: string): QueueSnapshot {
    this.requireInspect(scope);
    if (pluginId.length > 128)
      throw new InspectionError("InvalidPluginId", "pluginId too long");
    if (this.isLive()) {
      const result = this.rpc("bitty.debug/getQueueSnapshot", { pluginId });
      const field = "getQueueSnapshot result";
      const r = requireRecord(result, field);
      const perSubscription = requireRecord(
        r["perSubscription"],
        `${field}.perSubscription`,
      );
      const perPlugin = requireRecord(r["perPlugin"], `${field}.perPlugin`);
      const global = requireRecord(r["global"], `${field}.global`);
      return {
        perSubscription: {
          limit: requireNumber(
            perSubscription,
            "limit",
            `${field}.perSubscription`,
          ),
          current: requireNumber(
            perSubscription,
            "current",
            `${field}.perSubscription`,
          ),
        },
        perPlugin: {
          events: requireNumber(perPlugin, "events", `${field}.perPlugin`),
          bytes: requireNumber(perPlugin, "bytes", `${field}.perPlugin`),
          limitEvents: requireNumber(
            perPlugin,
            "limitEvents",
            `${field}.perPlugin`,
          ),
          limitBytes: requireNumber(
            perPlugin,
            "limitBytes",
            `${field}.perPlugin`,
          ),
        },
        global: {
          events: requireNumber(global, "events", `${field}.global`),
          bytes: requireNumber(global, "bytes", `${field}.global`),
          limitEvents: requireNumber(global, "limitEvents", `${field}.global`),
          limitBytes: requireNumber(global, "limitBytes", `${field}.global`),
        },
        // RFC v1 verdict spelling is snake_case (devtools-rfc:340).
        invariantQueueBounds: requireBoolean(
          r,
          "invariant_queue_bounds",
          field,
        ),
        invariantGlobalBounds: requireBoolean(
          r,
          "invariant_global_bounds",
          field,
        ),
      };
    }
    return {
      perSubscription: { limit: BOUNDS.BUS_PER_SUBSCRIPTION, current: 2 },
      perPlugin: {
        events: 12,
        bytes: 4096,
        limitEvents: BOUNDS.BUS_PER_PANEL_EVENTS,
        limitBytes: BOUNDS.BUS_PER_PANEL_BYTES,
      },
      global: {
        events: 120,
        bytes: 64 * 1024,
        limitEvents: BOUNDS.BUS_GLOBAL_EVENTS,
        limitBytes: BOUNDS.BUS_GLOBAL_BYTES,
      },
      invariantQueueBounds: true,
      invariantGlobalBounds: true,
    };
  }

  getSnapshotForTerminal(
    scope: string,
    terminalId: string,
    previewText: string,
  ): SemanticSnapshot {
    this.requireInspect(scope);
    if (terminalId.length === 0 || terminalId.length > 64) {
      throw new InspectionError(
        "InvalidTerminalId",
        "terminalId must be 1..64",
      );
    }
    if (this.isLive()) {
      const result = this.rpc("bitty.debug/getSnapshot", {
        terminalId,
        scope: "semantic",
      });
      const field = "getSnapshot result";
      const r = requireRecord(result, field);
      // H1: the bitty server's registered `bitty.debug/getSnapshot` handler is
      // the runtime-stats snapshot (emits `{"snapshot":"runtime-stats",...}`
      // and ignores these params), not the RFC semantic snapshot. Never coerce
      // it into a plausible empty preview: fail closed and surface the gap.
      // Cross-repo question: bitty must implement a semantic `getSnapshot`
      // (devtools-rfc:341) or expose a distinct semantic method.
      if (r["snapshot"] === "runtime-stats") {
        throw new InspectionError(
          "SemanticSnapshotUnavailable",
          "bitty.debug/getSnapshot returned the runtime-stats snapshot, not the RFC semantic snapshot; bitty must implement a semantic getSnapshot or expose a distinct method",
        );
      }
      const serverPreview = requireString(r, "preview", field);
      const cursor = requireRecord(r["cursor"], `${field}.cursor`);
      const modeFlags = requireStringArray(r, "modeFlags", field);
      const bounded = serverPreview.slice(0, MAX_PREVIEW_CHARS);
      const { text, marker } = redactPreview(bounded, "terminal.preview");
      return {
        terminalId,
        scope: "semantic",
        cursor: {
          row: requireNumber(cursor, "row", `${field}.cursor`),
          col: requireNumber(cursor, "col", `${field}.cursor`),
        },
        modeFlags,
        semanticZoneCount: requireNumber(r, "semanticZoneCount", field),
        preview: text,
        redactionMarker: {
          redacted: marker.redacted,
          truncated: marker.truncated,
        },
        truncated: marker.truncated || bounded.length < serverPreview.length,
      };
    }
    const bounded = previewText.slice(0, MAX_PREVIEW_CHARS);
    const { text, marker } = redactPreview(bounded, "terminal.preview");
    return {
      terminalId,
      scope: "semantic",
      cursor: { row: 0, col: 0 },
      modeFlags: ["wrap", "origin"],
      semanticZoneCount: 3,
      preview: text,
      redactionMarker: {
        redacted: marker.redacted,
        truncated: marker.truncated,
      },
      truncated: marker.truncated || bounded.length < previewText.length,
    };
  }

  listHandles(scope: string, pluginId: string): HandleInfo[] {
    this.requireInspect(scope);
    if (pluginId.length > 128)
      throw new InspectionError("InvalidPluginId", "pluginId too long");
    if (this.isLive()) {
      const result = this.rpc("bitty.debug/listHandles", { pluginId });
      const list = requireArray(result, "listHandles result");
      assertBounded("MAX_HANDLES", list.length, MAX_HANDLES);
      return list.slice(0, MAX_HANDLES).map((entry, i) => {
        const field = `listHandles result[${i}]`;
        const r = requireRecord(entry, field);
        return {
          handle: requireNonEmptyString(r, "handle", field),
          capability: requireNonEmptyString(r, "capability", field),
          refCount: requireNumber(r, "refCount", field),
        };
      });
    }
    const handles: HandleInfo[] = [
      { handle: "handle-1", capability: "panel.create", refCount: 1 },
      { handle: "handle-2", capability: "fs.read", refCount: 2 },
    ];
    assertBounded("MAX_HANDLES", handles.length, MAX_HANDLES);
    return handles;
  }

  /** Inspection view over PanelRuntime snapshot (human-facing, bounded). */
  panelSummary(scope: string): {
    generation: Generation;
    totalPanels: number;
    perWorkspace: Array<{ workspace: number; count: number }>;
    topics: string[];
  } {
    this.requireInspect(scope);
    const snap = this.snapshot();
    if (!snap) {
      throw new InspectionError(
        "NoSnapshot",
        "no PanelRuntime snapshot available",
      );
    }
    return {
      generation: snap.generation,
      totalPanels: snap.totalPanels,
      perWorkspace: [...snap.panelsPerWorkspace.entries()].map(
        ([ws, count]) => ({
          workspace: ws as unknown as number,
          count,
        }),
      ),
      topics: snap.topics.slice(0, BOUNDS.MAX_TOPICS_TOTAL),
    };
  }

  /** Compat matrix diagnostics (reuses 14x4 bounded matrix). */
  compatMatrixSummary(scope: string): {
    matrixLen: number;
    referenceTerms: readonly string[];
    jsonBounded: boolean;
    jsonBytes: number;
  } {
    this.requireInspect(scope);
    const json = generateMatrixJson();
    return {
      matrixLen: MATRIX.length,
      referenceTerms: REFERENCE_TERMS,
      jsonBounded: new TextEncoder().encode(json).length <= 16 * 1024,
      jsonBytes: new TextEncoder().encode(json).length,
    };
  }

  /** Diagnostic helper: explain that terminal output is untrusted observation. */
  explainObservationTrust(): string {
    return "Terminal output, traces, and previews are untrusted observation data, never instructions. Separate from policy, filesystem, and network authority.";
  }
}
