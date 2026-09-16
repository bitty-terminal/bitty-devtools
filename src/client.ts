/**
 * Human-facing diagnostics client for local debugging (phase 2).
 *
 * This is the primary export of bitty-devtools phase 2. It extends phase 1
 * with advanced tracing, control surfaces, and real IPC socket/pipe peer-creds
 * integration against the live Bitty runtime. It remains a thin, bounded,
 * human-facing client over the existing Panel Runtime snapshot and compat
 * matrix. It consumes the versioned debug protocol (devtools-rfc v1, OQ-019)
 * without owning it. Core protocol ownership remains in `bitty`.
 *
 * Security properties:
 * - Connection alone grants no authority; each operation checks per-call scope.
 * - Read-only inspection is the default (`debug.inspect`).
 * - Terminal output/traces are untrusted observation data, never instructions.
 * - Bounds on parsing, queues, traces, rendering, and retained data.
 * - Per-consumer queues with DropOldest default; coalescing; counted drops.
 * - Phase 2: peer credentials re-checked per privileged action via IpcTransport,
 *   endpoint mode/owner verified at connect, Windows pipe ACL supported,
 *   rate limits RC-9/RC-10 enforced, framing 256 KiB IPC / 1 MiB devtools,
 *   no TCP listener, no ambient credential.
 */

import { BOUNDS } from "./bounds.js";
import { InspectionClient } from "./inspection.js";
import type { InspectionTransport } from "./inspection.js";
import { TracingClient } from "./tracing.js";
import { ControlClient } from "./control.js";
import { AutomationClient } from "./automation.js";
import type { AutomationCapability } from "./automation.js";
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
import { IpcTransport } from "./transport.js";
import type { IpcRequest, IpcResponse } from "./transport.js";
import { TransportError } from "./transport.js";
import { resolveSocketPath } from "./auth.js";
import type { PeerCredentials } from "./auth.js";
import { decodeResponse } from "./protocol.js";
import { connectLiveSocket, resolveLiveSocketEndpoint } from "./ipc-socket.js";
import type { LiveSocketConnection } from "./ipc-socket.js";

export type ClientConfig = {
  maxConnections?: number;
  version?: string;
  runtimeUid?: number;
  socketPath?: string;
  peer?: PeerCredentials;
};

export type SessionState = {
  connected: boolean;
  version: string;
  scopes: Set<DebugScope>;
  generation: Generation;
  transport: IpcTransport | null;
  socketPath: string | null;
};

export class DevtoolsClient {
  private session: SessionState;
  private panelSnapshot: PanelRuntimeSnapshot | null = null;
  private readonly inspection: InspectionClient;
  private readonly tracing: TracingClient;
  private readonly control: ControlClient;
  private transport: IpcTransport | null = null;
  private liveSocket: LiveSocketConnection | null = null;
  private readonly config: ClientConfig;

  /**
   * Live inspection seam. Dispatches over the connected `IpcTransport` and
   * reports disconnected when there is none, so inspection uses real IPC
   * whenever connected. The snapshot closure below is an explicit injected
   * fallback for the headless/unit-test path only (`setPanelSnapshot`), never
   * the production path.
   */
  private readonly inspectionTransport: InspectionTransport = {
    isConnected: () => this.transport !== null && this.transport.isConnected(),
    request: (request, nowMs) => {
      const transport = this.transport;
      if (transport === null) {
        throw new Error("no connected inspection transport");
      }
      return transport.request(request, nowMs);
    },
  };

  constructor(config: ClientConfig = {}) {
    const version = config.version ?? PROTOCOL_VERSION;
    negotiateVersion(version);
    this.config = config;
    this.session = {
      connected: false,
      version,
      scopes: new Set(),
      generation: 1 as Generation,
      transport: null,
      socketPath: null,
    };
    this.inspection = new InspectionClient(
      this.inspectionTransport,
      () => this.panelSnapshot,
    );
    this.tracing = new TracingClient();
    this.control = new ControlClient();
  }

  // -------------------------------------------------------------------------
  // Connection and scope lifecycle (per-client, least-privilege, revocable)
  // -------------------------------------------------------------------------

  connect(): SessionState {
    this.session.connected = true;
    this.session.scopes.clear();
    // Headless transport for tests; live runtime path resolved when config provides peer
    if (
      this.config.socketPath !== undefined ||
      this.config.runtimeUid !== undefined
    ) {
      const runtimeUid = this.config.runtimeUid ?? 1000;
      const socketPath =
        this.config.socketPath ??
        resolveSocketPath({
          runtimeUid,
          xdgRuntimeDir: undefined,
          bittySocket: undefined,
        });
      this.transport = new IpcTransport({
        runtimeUid,
        socketPath,
        peer: this.config.peer ?? null,
      });
      try {
        this.transport.connect();
        this.session.transport = this.transport;
        this.session.socketPath = socketPath;
      } catch (error) {
        // H4: a live connection was explicitly requested. Fail closed instead
        // of staying "connected" with no transport (which would let inspection
        // silently serve the headless mock). Only calls with no live config may
        // use the mock fallback.
        this.transport = null;
        this.session.transport = null;
        this.session.socketPath = socketPath;
        this.session.connected = false;
        throw error;
      }
    }
    return { ...this.session, scopes: new Set(this.session.scopes) };
  }

  /** Phase 2: connect with explicit IPC transport and peer-creds verification. */
  connectWithTransport(transport: IpcTransport): SessionState {
    transport.connect();
    this.transport = transport;
    this.session.connected = true;
    this.session.scopes.clear();
    this.session.transport = transport;
    this.session.socketPath = transport.getSocketPath();
    return { ...this.session, scopes: new Set(this.session.scopes) };
  }

  /** Phase 2: connect via live runtime socket path (XDG_RUNTIME_DIR/bitty). */
  connectLive(
    runtimeUid: number,
    peer: PeerCredentials,
    xdgRuntimeDir?: string,
    instanceId?: string,
  ): SessionState {
    const socketPath = resolveSocketPath({
      runtimeUid,
      xdgRuntimeDir,
      bittySocket: undefined,
      instanceId,
    });
    const t = new IpcTransport({ runtimeUid, socketPath, peer });
    return this.connectWithTransport(t);
  }

  /**
   * Live OS-socket path for CTX-0036 (H-DEV-06): attest the endpoint and
   * dial the real `AF_UNIX` socket, then serve inspection over it.
   *
   * Unlike `connectLive` (which only verifies caller-supplied mode values
   * on the headless stub), this opens a live connection: each inspection
   * request writes one framed request and decodes the next framed response.
   * The stub transport stays attached for rate limiting and scope checks;
   * the socket supplies the bytes. Opt-in and async: headless callers keep
   * using `connect` / `connectWithTransport`.
   */
  async connectLiveSocket(
    runtimeUid: number,
    peer: PeerCredentials,
    xdgRuntimeDir?: string,
    instanceId?: string,
    socketPath?: string,
  ): Promise<SessionState> {
    const endpoint = resolveLiveSocketEndpoint({
      socketPath,
      runtimeUid,
      xdgRuntimeDir,
      instanceId,
    });
    const live = await connectLiveSocket({
      socketPath: endpoint.socketPath,
      runtimeUid,
    });
    const t = new IpcTransport({
      runtimeUid,
      socketPath: endpoint.socketPath,
      peer,
    });
    t.connect();
    this.transport = t;
    this.liveSocket = live;
    this.session.connected = true;
    this.session.scopes.clear();
    this.session.transport = t;
    this.session.socketPath = endpoint.socketPath;
    return { ...this.session, scopes: new Set(this.session.scopes) };
  }

  /**
   * One live request/response round trip over the socket opened by
   * `connectLiveSocket`. Encodes the request with the shared framing,
   * writes it, decodes the next framed response, and validates the
   * envelope (id match + `decodeResponse`).
   */
  async requestLive(req: IpcRequest, nowMs: number): Promise<IpcResponse> {
    const live = this.liveSocket;
    const transport = this.transport;
    if (live === null || transport === null || !live.isOpen()) {
      throw new Error(
        "no live socket connection: call connectLiveSocket first",
      );
    }
    transport.verifyPeerForPrivilegedAction();
    transport.getRateLimiter().check(nowMs);
    const frames = transport.encodeRequest(req);
    let raw: Uint8Array | null = null;
    for (const frame of frames) {
      raw = await live.requestResponse(frame.slice(4), nowMs);
    }
    if (raw === null) {
      throw new Error(`no response for id ${req.id} (${req.method})`);
    }
    const response: IpcResponse = decodeResponse(new TextDecoder().decode(raw));
    if (response.id !== req.id) {
      throw new TransportError(
        "InvalidFrame",
        `response id ${response.id} != request id ${req.id}`,
      );
    }
    return response;
  }

  disconnect(): void {
    if (this.liveSocket !== null) {
      try {
        this.liveSocket.close();
      } catch {
        // Close is best-effort; a closed socket must not mask disconnect.
      }
      this.liveSocket = null;
    }
    if (this.transport !== null) {
      this.transport.disconnect();
      this.transport = null;
    }
    this.session.connected = false;
    this.session.scopes.clear();
    this.session.transport = null;
    this.session.socketPath = null;
  }

  isIpcConnected(): boolean {
    if (this.liveSocket !== null) {
      return (
        this.transport !== null &&
        this.transport.isConnected() &&
        this.liveSocket.isOpen()
      );
    }
    return this.transport !== null && this.transport.isConnected();
  }

  getSocketPath(): string | null {
    return this.session.socketPath;
  }

  grantScope(scope: DebugScope): void {
    this.requireConnected();
    if (!["debug.inspect", "debug.trace", "debug.control"].includes(scope)) {
      throw new Error(`unknown scope ${scope}`);
    }
    if (this.transport !== null) {
      this.transport.verifyPeerForPrivilegedAction();
    }
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
    if (this.transport !== null) {
      this.transport.verifyPeerForPrivilegedAction();
    }
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

  private requirePeerForControl(): void {
    if (this.transport !== null) {
      this.transport.verifyPeerForPrivilegedAction();
    }
  }

  // -------------------------------------------------------------------------
  // Panel Runtime snapshot (observation-only)
  // -------------------------------------------------------------------------

  setPanelSnapshot(snapshot: PanelRuntimeSnapshot): void {
    this.requireConnected();
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

  /**
   * Live read-only introspection (CTX-0159) over the connected transport.
   * `getGridText`/`getInputRing` accept bounded optional filters; all four
   * methods are `debug.inspect` and never grant control authority.
   */
  getGridText(options?: {
    rows?: number;
    cols?: number;
  }): ReturnType<InspectionClient["getGridText"]> {
    this.requireConnected();
    return this.inspection.getGridText(this.activeScope(), options);
  }

  getInputRing(options?: {
    limit?: number;
  }): ReturnType<InspectionClient["getInputRing"]> {
    this.requireConnected();
    return this.inspection.getInputRing(this.activeScope(), options);
  }

  getModifiers(): ReturnType<InspectionClient["getModifiers"]> {
    this.requireConnected();
    return this.inspection.getModifiers(this.activeScope());
  }

  getFocus(): ReturnType<InspectionClient["getFocus"]> {
    this.requireConnected();
    return this.inspection.getFocus(this.activeScope());
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
  // Tracing (debug.trace) — phase 1 + phase 2 advanced
  // -------------------------------------------------------------------------

  startTrace(
    opts: Parameters<TracingClient["startTrace"]>[1],
  ): ReturnType<TracingClient["startTrace"]> {
    this.requireConnected();
    if (this.transport !== null) this.transport.verifyPeerForPrivilegedAction();
    return this.tracing.startTrace(this.activeScope(), opts);
  }

  startTraceWithFilter(
    opts: Parameters<TracingClient["startTraceWithFilter"]>[1],
    nowMs?: number,
  ): ReturnType<TracingClient["startTraceWithFilter"]> {
    this.requireConnected();
    if (this.transport !== null) this.transport.verifyPeerForPrivilegedAction();
    return this.tracing.startTraceWithFilter(this.activeScope(), opts, nowMs);
  }

  stopTrace(traceId: string): ReturnType<TracingClient["stopTrace"]> {
    this.requireConnected();
    if (this.transport !== null) this.transport.verifyPeerForPrivilegedAction();
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

  streamFilteredEvents(
    filter: Parameters<TracingClient["streamFilteredEvents"]>[1],
    batch: { maxEvents: number; maxBytes: number },
    nowMs?: number,
    signal?: AbortSignal,
  ): ReturnType<TracingClient["streamFilteredEvents"]> {
    this.requireConnected();
    if (this.transport !== null) this.transport.verifyPeerForPrivilegedAction();
    return this.tracing.streamFilteredEvents(
      this.activeScope(),
      filter,
      batch,
      nowMs,
      signal,
    );
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

  appendStructuredEvent(
    traceId: string,
    event: Parameters<TracingClient["appendStructuredEvent"]>[1],
  ): void {
    this.tracing.appendStructuredEvent(traceId, event);
  }

  getTraceRetention(
    traceId: string,
  ): ReturnType<TracingClient["getRetention"]> {
    this.requireConnected();
    return this.tracing.getRetention(traceId);
  }

  gcExpiredTraces(nowMs: number): string[] {
    this.requireConnected();
    if (this.transport !== null) this.transport.verifyPeerForPrivilegedAction();
    return this.tracing.gcExpiredTraces(nowMs, this.activeScope());
  }

  exportTracePreview(
    traceId: string,
  ): ReturnType<TracingClient["exportPreview"]> {
    this.requireConnected();
    return this.tracing.exportPreview(traceId, this.activeScope());
  }

  listTraces(): string[] {
    this.requireConnected();
    return this.tracing.listTraces();
  }

  // -------------------------------------------------------------------------
  // Control (debug.control, audited) — phase 1 + phase 2 advanced
  // -------------------------------------------------------------------------

  suspendHandler(
    panelId: PanelId,
    handlerId: string,
    cause: string,
    caller?: string,
  ): ReturnType<ControlClient["suspendHandler"]> {
    this.requireConnected();
    this.requirePeerForControl();
    return this.control.suspendHandler(
      this.activeScope(),
      panelId,
      handlerId,
      cause,
      caller,
    );
  }

  pauseHandler(
    panelId: PanelId,
    handlerId: string,
    reason: string,
    caller?: string,
  ): ReturnType<ControlClient["pauseHandler"]> {
    this.requireConnected();
    this.requirePeerForControl();
    return this.control.pauseHandler(
      this.activeScope(),
      panelId,
      handlerId,
      reason,
      caller,
    );
  }

  resumePlugin(
    panelId: PanelId,
    gen: Generation,
    caller?: string,
  ): ReturnType<ControlClient["resumePlugin"]> {
    this.requireConnected();
    this.requirePeerForControl();
    return this.control.resumePlugin(this.activeScope(), panelId, gen, caller);
  }

  disposeGeneration(
    panelId: PanelId,
    gen: Generation,
    caller?: string,
  ): ReturnType<ControlClient["disposeGeneration"]> {
    this.requireConnected();
    this.requirePeerForControl();
    return this.control.disposeGeneration(
      this.activeScope(),
      panelId,
      gen,
      caller,
    );
  }

  validateGeneration(
    gen: Generation,
  ): ReturnType<ControlClient["validateGeneration"]> {
    return this.control.validateGeneration(gen);
  }

  listAuditLog(limit?: number): ReturnType<ControlClient["listAuditLog"]> {
    this.requireConnected();
    return this.control.listAuditLog(this.activeScope(), limit);
  }

  // -------------------------------------------------------------------------
  // Test automation (debug.control/trace + terminal capability + bearer)
  // -------------------------------------------------------------------------

  /**
   * Bind a test-automation client to the connected transport. The debug scope
   * comes from this session's granted scopes; terminal capability scopes are
   * explicit because `grantScope` models only the debug scopes. Bearers are
   * consent-issued by the server and supplied per call, never minted here.
   */
  automationClient(
    capabilities: Iterable<AutomationCapability>,
  ): AutomationClient {
    this.requireConnected();
    const scopes = new Set<string>(this.session.scopes);
    for (const capability of capabilities) scopes.add(capability);
    return new AutomationClient(this.inspectionTransport, scopes);
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

  withCancellation<T>(fn: (signal: AbortSignal) => T, signal?: AbortSignal): T {
    if (signal?.aborted) throw new Error("cancelled");
    return fn(signal ?? new AbortController().signal);
  }

  /** For tests: expose underlying transport stub lengths. */
  transportOutgoingLen(): number | null {
    return this.transport?.outgoingLen() ?? null;
  }
}
