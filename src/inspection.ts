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

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asGeneration(value: unknown, fallback: Generation): Generation {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) {
    return generation(value);
  }
  return fallback;
}

function asPluginState(value: unknown): PluginState {
  return typeof value === "string" &&
    (PLUGIN_STATES as readonly string[]).includes(value)
    ? (value as PluginState)
    : "Activated";
}

function pluginSummaryFrom(value: unknown): PluginSummary {
  const r = asRecord(value);
  return {
    id: asString(r["id"]),
    version: asString(r["version"], "0.0.0"),
    generation: asGeneration(r["generation"], 1 as Generation),
    state: asPluginState(r["state"]),
    manifestHash: asString(r["manifestHash"]),
    capabilities: asArray(r["capabilities"]).filter(
      (c): c is string => typeof c === "string",
    ),
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
      const result = this.rpc(
        "bitty.debug/listPlugins",
        generationFilter === undefined ? {} : { generation: generationFilter },
      );
      const list = asArray(result);
      assertBounded("MAX_PLUGINS", list.length, MAX_PLUGINS);
      return list
        .slice(0, MAX_PLUGINS)
        .map((entry) => pluginSummaryFrom(entry));
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
      return pluginSummaryFrom(result);
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
      const list = asArray(result);
      assertBounded("MAX_SUBSCRIPTIONS", list.length, MAX_SUBSCRIPTIONS);
      return list.slice(0, MAX_SUBSCRIPTIONS).map((entry) => {
        const r = asRecord(entry);
        return {
          eventType: asString(r["eventType"]),
          queueDepth: asNumber(r["queueDepth"], 0),
          queuedBytes: asNumber(r["queuedBytes"], 0),
          dropCount: asNumber(r["dropCount"], 0),
          policy: r["policy"] === "DropNewest" ? "DropNewest" : "DropOldest",
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
      const r = asRecord(result);
      return {
        pluginId,
        generation: asGeneration(r["generation"], gen),
        rc1Instructions: asNumber(r["rc1Instructions"], 0),
        rc1WallMs: asNumber(r["rc1WallMs"], 0),
        rc2MemoryBytes: asNumber(r["rc2MemoryBytes"], 0),
        rc4Tasks: asNumber(r["rc4Tasks"], 0),
        rc4Timers: asNumber(r["rc4Timers"], 0),
        rc5QueueDepth: asNumber(r["rc5QueueDepth"], 0),
        wouldExceedLuaLimits: r["wouldExceedLuaLimits"] === true,
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
      const r = asRecord(result);
      const perSubscription = asRecord(r["perSubscription"]);
      const perPlugin = asRecord(r["perPlugin"]);
      const global = asRecord(r["global"]);
      return {
        perSubscription: {
          limit: asNumber(
            perSubscription["limit"],
            BOUNDS.BUS_PER_SUBSCRIPTION,
          ),
          current: asNumber(perSubscription["current"], 0),
        },
        perPlugin: {
          events: asNumber(perPlugin["events"], 0),
          bytes: asNumber(perPlugin["bytes"], 0),
          limitEvents: asNumber(
            perPlugin["limitEvents"],
            BOUNDS.BUS_PER_PANEL_EVENTS,
          ),
          limitBytes: asNumber(
            perPlugin["limitBytes"],
            BOUNDS.BUS_PER_PANEL_BYTES,
          ),
        },
        global: {
          events: asNumber(global["events"], 0),
          bytes: asNumber(global["bytes"], 0),
          limitEvents: asNumber(
            global["limitEvents"],
            BOUNDS.BUS_GLOBAL_EVENTS,
          ),
          limitBytes: asNumber(global["limitBytes"], BOUNDS.BUS_GLOBAL_BYTES),
        },
        invariantQueueBounds: r["invariantQueueBounds"] === true,
        invariantGlobalBounds: r["invariantGlobalBounds"] === true,
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
      const r = asRecord(result);
      const serverPreview = asString(r["preview"]);
      const bounded = serverPreview.slice(0, MAX_PREVIEW_CHARS);
      const { text, marker } = redactPreview(bounded, "terminal.preview");
      const cursor = asRecord(r["cursor"]);
      return {
        terminalId,
        scope: "semantic",
        cursor: {
          row: asNumber(cursor["row"], 0),
          col: asNumber(cursor["col"], 0),
        },
        modeFlags: asArray(r["modeFlags"]).filter(
          (m): m is string => typeof m === "string",
        ),
        semanticZoneCount: asNumber(r["semanticZoneCount"], 0),
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
      const list = asArray(result);
      assertBounded("MAX_HANDLES", list.length, MAX_HANDLES);
      return list.slice(0, MAX_HANDLES).map((entry) => {
        const r = asRecord(entry);
        return {
          handle: asString(r["handle"]),
          capability: asString(r["capability"]),
          refCount: asNumber(r["refCount"], 0),
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
