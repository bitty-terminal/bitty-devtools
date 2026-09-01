/**
 * Human-facing diagnostics client for local debugging (phase 1).
 *
 * This is the primary export of bitty-devtools phase 1. It is a thin,
 * bounded, human-facing client over the existing Panel Runtime snapshot and
 * compat matrix. It consumes the versioned debug protocol (devtools-rfc v1,
 * OQ-019) without owning it. Core protocol ownership remains in `bitty`.
 *
 * Security properties:
 * - Connection alone grants no authority; each operation checks per-call scope.
 * - Read-only inspection is the default (`debug.inspect`).
 * - Terminal output/traces are untrusted observation data, never instructions.
 * - Bounds on parsing, queues, traces, rendering, and retained data.
 * - Per-consumer queues with DropOldest default; coalescing; counted drops.
 */

import { BOUNDS } from "./bounds.js";
import { InspectionClient } from "./inspection.js";
import { TracingClient } from "./tracing.js";
import { ControlClient } from "./control.js";
import type {
  PanelRuntimeSnapshot,
  PanelId,
  Generation,
} from "./panel-runtime.js";
import type { DebugScope } from "./protocol.js";
import {
  PROTOCOL_VERSION,
  negotiateVersion,
  validateFrameBytes,
} from "./protocol.js";
import { generateMatrixJson } from "./compat-matrix.js";

export type ClientConfig = {
  maxConnections?: number;
  version?: string;
};

export type SessionState = {
  connected: boolean;
  version: string;
  scopes: Set<DebugScope>;
  generation: Generation;
};

export class DevtoolsClient {
  private session: SessionState;
  private panelSnapshot: PanelRuntimeSnapshot | null = null;
  private readonly inspection: InspectionClient;
  private readonly tracing: TracingClient;
  private readonly control: ControlClient;

  constructor(config: ClientConfig = {}) {
    const version = config.version ?? PROTOCOL_VERSION;
    negotiateVersion(version);
    this.session = {
      connected: false,
      version,
      scopes: new Set(),
      generation: 1 as Generation,
    };
    this.inspection = new InspectionClient(() => this.panelSnapshot);
    this.tracing = new TracingClient();
    this.control = new ControlClient();
  }

  // -------------------------------------------------------------------------
  // Connection and scope lifecycle (per-client, least-privilege, revocable)
  // -------------------------------------------------------------------------

  connect(): SessionState {
    this.session.connected = true;
    // No scopes granted on connect
    this.session.scopes.clear();
    return { ...this.session, scopes: new Set(this.session.scopes) };
  }

  disconnect(): void {
    this.session.connected = false;
    this.session.scopes.clear();
  }

  grantScope(scope: DebugScope): void {
    this.requireConnected();
    if (!["debug.inspect", "debug.trace", "debug.control"].includes(scope)) {
      throw new Error(`unknown scope ${scope}`);
    }
    // debug.control implies inspect+trace per rfc staging
    if (scope === "debug.control") {
      this.session.scopes.add("debug.inspect");
      this.session.scopes.add("debug.trace");
      this.session.scopes.add("debug.control");
    } else if (scope === "debug.trace") {
      this.session.scopes.add("debug.inspect");
      this.session.scopes.add("debug.trace");
    } else {
      this.session.scopes.add(scope);
    }
  }

  revokeScope(scope: DebugScope): void {
    this.requireConnected();
    this.session.scopes.delete(scope);
    if (scope === "debug.inspect") {
      this.session.scopes.delete("debug.trace");
      this.session.scopes.delete("debug.control");
    } else if (scope === "debug.trace") {
      this.session.scopes.delete("debug.control");
    }
  }

  currentScope(): DebugScope[] {
    return [...this.session.scopes];
  }

  private requireConnected(): void {
    if (!this.session.connected)
      throw new Error("not connected: call connect() first");
  }

  private activeScope(): string {
    if (this.session.scopes.has("debug.control")) return "debug.control";
    if (this.session.scopes.has("debug.trace")) return "debug.trace";
    if (this.session.scopes.has("debug.inspect")) return "debug.inspect";
    return "";
  }

  // -------------------------------------------------------------------------
  // Panel Runtime snapshot (observation-only)
  // -------------------------------------------------------------------------

  setPanelSnapshot(snapshot: PanelRuntimeSnapshot): void {
    this.requireConnected();
    // Validate bounds before commit (fail-closed)
    if (snapshot.totalPanels > BOUNDS.MAX_PANELS_PER_WINDOW) {
      throw new Error(
        `totalPanels ${snapshot.totalPanels} > ${BOUNDS.MAX_PANELS_PER_WINDOW}`,
      );
    }
    if (snapshot.topics.length > BOUNDS.MAX_TOPICS_TOTAL) {
      throw new Error(
        `topics ${snapshot.topics.length} > ${BOUNDS.MAX_TOPICS_TOTAL}`,
      );
    }
    this.panelSnapshot = snapshot;
  }

  getPanelSnapshot(): PanelRuntimeSnapshot | null {
    return this.panelSnapshot;
  }

  // -------------------------------------------------------------------------
  // Inspection (debug.inspect)
  // -------------------------------------------------------------------------

  listPlugins(
    generation?: Generation,
  ): ReturnType<InspectionClient["listPlugins"]> {
    this.requireConnected();
    return this.inspection.listPlugins(this.activeScope(), generation);
  }

  getPlugin(pluginId: string): ReturnType<InspectionClient["getPlugin"]> {
    this.requireConnected();
    return this.inspection.getPlugin(this.activeScope(), pluginId);
  }

  listSubscriptions(
    pluginId: string,
  ): ReturnType<InspectionClient["listSubscriptions"]> {
    this.requireConnected();
    return this.inspection.listSubscriptions(this.activeScope(), pluginId);
  }

  getBudgets(
    pluginId: string,
    gen: Generation,
  ): ReturnType<InspectionClient["getBudgets"]> {
    this.requireConnected();
    return this.inspection.getBudgets(this.activeScope(), pluginId, gen);
  }

  getQueueSnapshot(
    pluginId: string,
  ): ReturnType<InspectionClient["getQueueSnapshot"]> {
    this.requireConnected();
    return this.inspection.getQueueSnapshot(this.activeScope(), pluginId);
  }

  getSnapshotForTerminal(
    terminalId: string,
    previewText: string,
  ): ReturnType<InspectionClient["getSnapshotForTerminal"]> {
    this.requireConnected();
    return this.inspection.getSnapshotForTerminal(
      this.activeScope(),
      terminalId,
      previewText,
    );
  }

  listHandles(pluginId: string): ReturnType<InspectionClient["listHandles"]> {
    this.requireConnected();
    return this.inspection.listHandles(this.activeScope(), pluginId);
  }

  panelSummary(): ReturnType<InspectionClient["panelSummary"]> {
    this.requireConnected();
    return this.inspection.panelSummary(this.activeScope());
  }

  compatMatrixSummary(): ReturnType<InspectionClient["compatMatrixSummary"]> {
    this.requireConnected();
    return this.inspection.compatMatrixSummary(this.activeScope());
  }

  // -------------------------------------------------------------------------
  // Tracing (debug.trace)
  // -------------------------------------------------------------------------

  startTrace(
    opts: Parameters<TracingClient["startTrace"]>[1],
  ): ReturnType<TracingClient["startTrace"]> {
    this.requireConnected();
    return this.tracing.startTrace(this.activeScope(), opts);
  }

  stopTrace(traceId: string): ReturnType<TracingClient["stopTrace"]> {
    this.requireConnected();
    return this.tracing.stopTrace(this.activeScope(), traceId);
  }

  streamEvents(
    types: string[],
    batch: { maxEvents: number; maxBytes: number },
    signal?: AbortSignal,
  ): ReturnType<TracingClient["streamEvents"]> {
    this.requireConnected();
    return this.tracing.streamEvents(this.activeScope(), types, batch, signal);
  }

  fetchTraceChunk(
    traceId: string,
    offset: number,
  ): ReturnType<TracingClient["fetchTraceChunk"]> {
    this.requireConnected();
    return this.tracing.fetchTraceChunk(this.activeScope(), traceId, offset);
  }

  appendToTrace(traceId: string, data: string): void {
    this.tracing.appendToTrace(traceId, data);
  }

  // -------------------------------------------------------------------------
  // Control (debug.control, audited)
  // -------------------------------------------------------------------------

  suspendHandler(
    panelId: PanelId,
    handlerId: string,
    cause: string,
    caller?: string,
  ): ReturnType<ControlClient["suspendHandler"]> {
    this.requireConnected();
    return this.control.suspendHandler(
      this.activeScope(),
      panelId,
      handlerId,
      cause,
      caller,
    );
  }

  resumePlugin(
    panelId: PanelId,
    gen: Generation,
    caller?: string,
  ): ReturnType<ControlClient["resumePlugin"]> {
    this.requireConnected();
    return this.control.resumePlugin(this.activeScope(), panelId, gen, caller);
  }

  disposeGeneration(
    panelId: PanelId,
    gen: Generation,
    caller?: string,
  ): ReturnType<ControlClient["disposeGeneration"]> {
    this.requireConnected();
    return this.control.disposeGeneration(
      this.activeScope(),
      panelId,
      gen,
      caller,
    );
  }

  // -------------------------------------------------------------------------
  // Utilities: compat matrix raw, framing validation (bounded)
  // -------------------------------------------------------------------------

  generateCompatMatrixJson(): string {
    this.requireConnected();
    this.inspection.compatMatrixSummary(this.activeScope());
    return generateMatrixJson();
  }

  validateFrame(raw: string): void {
    validateFrameBytes(raw);
  }

  // Cancellation support for long operations
  withCancellation<T>(fn: (signal: AbortSignal) => T, signal?: AbortSignal): T {
    if (signal?.aborted) throw new Error("cancelled");
    return fn(signal ?? new AbortController().signal);
  }
}
