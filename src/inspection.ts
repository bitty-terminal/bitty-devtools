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

export class InspectionClient {
  constructor(
    private readonly getSnapshot: () => PanelRuntimeSnapshot | null,
  ) {}

  private requireInspect(scope: string): void {
    if (
      scope !== "debug.inspect" &&
      scope !== "debug.trace" &&
      scope !== "debug.control"
    ) {
      throw new InspectionError("ScopeDenied", "debug.inspect scope required");
    }
  }

  listPlugins(scope: string, generation?: Generation): PluginSummary[] {
    this.requireInspect(scope);
    // Stub: in real client this would call bitty.debug/listPlugins over IPC.
    // Here we synthesize bounded, redacted observation data from PanelRuntime.
    const snap = this.getSnapshot();
    if (!snap) return [];
    assertBounded("MAX_PLUGINS", snap.panels.length, MAX_PLUGINS);
    return snap.panels.slice(0, MAX_PLUGINS).map((p) => ({
      id: `panel-${p.id}`,
      version: "0.0.1",
      generation: generation ?? p.generation,
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
    const snap = this.getSnapshot();
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
    const snap = this.getSnapshot();
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
