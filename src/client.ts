/**
 * Human-facing diagnostics client for local debugging (phase 2).
 *
 * This is the primary export of bitty-devtools phase 2. It extends phase 1
 * with advanced tracing, control surfaces, a headless transport fixture, and
 * a Linux-only endpoint-attested live socket inspection path. It remains a
 * thin, bounded, human-facing client over the existing Panel Runtime snapshot
 * and compat matrix. It consumes the versioned debug protocol (devtools-rfc
 * v1, OQ-019) without owning it. Core protocol ownership remains in `bitty`.
 *
 * Security properties:
 * - Connection alone grants no authority; each operation checks per-call scope.
 * - Read-only inspection is the default (`debug.inspect`).
 * - Terminal output/traces are untrusted observation data, never instructions.
 * - Bounds on parsing, queues, traces, rendering, and retained data.
 * - Per-consumer queues with DropOldest default; coalescing; counted drops.
 * - Phase 2: caller-supplied fixture credentials are re-checked per
 *   privileged action; live Linux sockets attest endpoint mode/owner and
 *   remain inspect-only. Windows and macOS live dialing is unsupported.
 *   Rate limits RC-9/RC-10 and framing 256 KiB IPC / 1 MiB devtools are
 *   no TCP listener, no ambient credential.
 */

import { BOUNDS } from "./bounds.js";
import {
  InspectionClient,
  InspectionError,
  parseInspectionResult,
} from "./inspection.js";
import type { InspectionTransport } from "./inspection.js";
import { TracingClient, TracingError } from "./tracing.js";
import { ControlClient, ControlError } from "./control.js";
import { AutomationClient } from "./automation.js";
import type { AutomationCapability } from "./automation.js";
import type {
  PanelRuntimeSnapshot,
  PanelId,
  Generation,
} from "./panel-runtime.js";
import { parseEventTopic, parsePanelType } from "./panel-runtime.js";
import type { DebugScope } from "./protocol.js";
import {
  PROTOCOL_VERSION,
  decodeResponse,
  negotiateVersion,
  validateFrameBytes,
} from "./protocol.js";
import { validateLiveRequest } from "./protocol-boundary.js";
import {
  generateMatrixJson,
  validateMatrixJsonDocument,
} from "./compat-matrix.js";
import type { MatrixJson } from "./compat-matrix.js";
import { IpcTransport } from "./transport.js";
import type { IpcRequest, IpcResponse } from "./transport.js";
import { TransportError } from "./transport.js";
import { resolveSocketPath } from "./auth.js";
import type { PeerCredentials } from "./auth.js";
import { connectLiveSocket, resolveLiveSocketEndpoint } from "./ipc-socket.js";
import type { LiveSocketConnection, LiveSocketIdentity } from "./ipc-socket.js";

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

function decodeLiveResponse(raw: Uint8Array, expectedId: number): IpcResponse {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      raw,
    );
  } catch {
    throw new TransportError("InvalidFrame", "response is not valid UTF-8");
  }
  const response = decodeResponse(text);
  if (response.id !== expectedId) {
    throw new TransportError(
      "InvalidFrame",
      `response id ${response.id} does not match request ${expectedId}`,
    );
  }
  return response;
}

const PANEL_STATES = new Set([
  "Declared",
  "Created",
  "Mounted",
  "Focused",
  "Suspended",
  "Disposed",
]);
const OVERLAY_KINDS = new Set(["Modal", "NonModal", "Tooltip", "Palette"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireSafeInteger(
  value: unknown,
  field: string,
  minimum = 0,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${field} must be a safe integer >= ${minimum}`);
  }
  return value as number;
}

function requireBoundedString(
  value: unknown,
  field: string,
  maxBytes: number,
): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  if (new TextEncoder().encode(value).length > maxBytes) {
    throw new Error(`${field} exceeds ${maxBytes} bytes`);
  }
  return value;
}

function requireExactObjectFields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
  field = "object",
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${field}.${key} is not allowed`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new Error(`${field}.${key} is required`);
    }
  }
}

export function validatePanelSnapshot(
  value: unknown,
): asserts value is PanelRuntimeSnapshot {
  if (!isRecord(value)) throw new Error("panel snapshot must be an object");
  requireExactObjectFields(
    value,
    [
      "generation",
      "panels",
      "panelsPerWorkspace",
      "totalPanels",
      "topics",
      "overlays",
      "config",
    ],
    [],
    "panel snapshot",
  );
  requireSafeInteger(value["generation"], "panel snapshot.generation", 1);
  if (!Array.isArray(value["panels"])) {
    throw new Error("panel snapshot.panels must be an array");
  }
  const panels = value["panels"];
  if (panels.length > BOUNDS.MAX_PANELS_PER_WINDOW) {
    throw new Error("panel snapshot.panels exceeds the panel bound");
  }
  const panelIds = new Set<number>();
  for (const [index, panel] of panels.entries()) {
    if (!isRecord(panel)) {
      throw new Error(`panel snapshot.panels[${index}] must be an object`);
    }
    requireExactObjectFields(
      panel,
      ["id", "generation", "state", "type"],
      ["workspace", "view", "title"],
      `panel snapshot.panels[${index}]`,
    );
    const id = requireSafeInteger(panel["id"], `panel ${index}.id`, 1);
    if (panelIds.has(id)) throw new Error(`duplicate panel id ${id}`);
    panelIds.add(id);
    requireSafeInteger(panel["generation"], `panel ${index}.generation`, 1);
    if (
      typeof panel["state"] !== "string" ||
      !PANEL_STATES.has(panel["state"])
    ) {
      throw new Error(`panel ${index}.state is invalid`);
    }
    if (
      typeof panel["type"] !== "string" ||
      parsePanelType(panel["type"]) === null
    ) {
      throw new Error(`panel ${index}.type is invalid`);
    }
    if (panel["workspace"] !== undefined) {
      requireSafeInteger(panel["workspace"], `panel ${index}.workspace`, 1);
    }
    if (panel["view"] !== undefined) {
      requireSafeInteger(panel["view"], `panel ${index}.view`, 1);
    }
    if (panel["title"] !== undefined) {
      requireBoundedString(panel["title"], `panel ${index}.title`, 128);
    }
  }
  const totalPanels = requireSafeInteger(
    value["totalPanels"],
    "panel snapshot.totalPanels",
  );
  if (totalPanels > BOUNDS.MAX_PANELS_PER_WINDOW) {
    throw new Error("panel snapshot.totalPanels exceeds the panel bound");
  }
  if (!(value["panelsPerWorkspace"] instanceof Map)) {
    throw new Error("panel snapshot.panelsPerWorkspace must be a Map");
  }
  const workspaceCounts = value["panelsPerWorkspace"] as Map<unknown, unknown>;
  if (workspaceCounts.size > BOUNDS.MAX_PANELS_PER_WINDOW) {
    throw new Error("panel snapshot workspace map exceeds the panel bound");
  }
  let mappedPanels = 0;
  for (const [workspace, count] of workspaceCounts as Map<unknown, unknown>) {
    requireSafeInteger(workspace, "panel snapshot.workspace", 1);
    requireSafeInteger(count, "panel snapshot.workspace count");
    mappedPanels += count as number;
    if (!Number.isSafeInteger(mappedPanels)) {
      throw new Error("panel snapshot workspace counts exceed safe bounds");
    }
  }
  if (mappedPanels !== totalPanels || panels.length !== totalPanels) {
    throw new Error(
      "panel snapshot panel/workspace counts do not match totalPanels",
    );
  }
  if (!Array.isArray(value["topics"])) {
    throw new Error("panel snapshot.topics must be an array");
  }
  if (value["topics"].length > BOUNDS.MAX_TOPICS_TOTAL) {
    throw new Error("panel snapshot.topics exceeds the topic bound");
  }
  const topics = new Set<string>();
  for (const [index, topic] of value["topics"].entries()) {
    if (typeof topic !== "string")
      throw new Error(`topic ${index} must be a string`);
    const parsed = parseEventTopic(topic);
    if (topics.has(parsed)) throw new Error(`duplicate topic ${parsed}`);
    topics.add(parsed);
  }
  if (!Array.isArray(value["overlays"])) {
    throw new Error("panel snapshot.overlays must be an array");
  }
  if (value["overlays"].length > BOUNDS.MAX_OVERLAYS_PER_WINDOW) {
    throw new Error("panel snapshot.overlays exceeds the overlay bound");
  }
  const overlayIds = new Set<number>();
  for (const [index, overlay] of value["overlays"].entries()) {
    if (!isRecord(overlay))
      throw new Error(`overlay ${index} must be an object`);
    requireExactObjectFields(
      overlay,
      ["id", "kind", "bounds", "text", "generation", "truncated"],
      ["tooltip"],
      `panel snapshot.overlays[${index}]`,
    );
    const id = requireSafeInteger(overlay["id"], `overlay ${index}.id`, 1);
    if (overlayIds.has(id)) throw new Error(`duplicate overlay id ${id}`);
    overlayIds.add(id);
    if (
      typeof overlay["kind"] !== "string" ||
      !OVERLAY_KINDS.has(overlay["kind"])
    ) {
      throw new Error(`overlay ${index}.kind is invalid`);
    }
    requireSafeInteger(overlay["generation"], `overlay ${index}.generation`, 1);
    if (typeof overlay["truncated"] !== "boolean") {
      throw new Error(`overlay ${index}.truncated must be boolean`);
    }
    if (!isRecord(overlay["bounds"])) {
      throw new Error(`overlay ${index}.bounds must be an object`);
    }
    requireExactObjectFields(
      overlay["bounds"],
      ["x", "y", "width", "height"],
      [],
      `overlay ${index}.bounds`,
    );
    for (const key of ["x", "y", "width", "height"] as const) {
      requireSafeInteger(
        overlay["bounds"][key],
        `overlay ${index}.bounds.${key}`,
      );
    }
    if (
      (overlay["bounds"]["width"] as number) < 1 ||
      (overlay["bounds"]["height"] as number) < 1
    ) {
      throw new Error(`overlay ${index}.bounds must be positive`);
    }
    requireBoundedString(overlay["text"], `overlay ${index}.text`, 128);
    if (overlay["tooltip"] !== undefined) {
      requireBoundedString(overlay["tooltip"], `overlay ${index}.tooltip`, 256);
    }
  }
  if (!isRecord(value["config"])) {
    throw new Error("panel snapshot.config must be an object");
  }
  requireExactObjectFields(
    value["config"],
    [
      "maxPanelsPerWorkspace",
      "maxPanelsPerWindow",
      "maxTopicsTotal",
      "maxSubscriptionsPerPanel",
    ],
    [],
    "panel snapshot.config",
  );
  const maxPanelsPerWorkspace = value["config"][
    "maxPanelsPerWorkspace"
  ] as number;
  for (const count of workspaceCounts.values()) {
    if ((count as number) > maxPanelsPerWorkspace) {
      throw new Error(
        "panel snapshot workspace count exceeds configured bound",
      );
    }
  }
  for (const [key, limit] of [
    ["maxPanelsPerWorkspace", BOUNDS.MAX_PANELS_PER_WORKSPACE],
    ["maxPanelsPerWindow", BOUNDS.MAX_PANELS_PER_WINDOW],
    ["maxTopicsTotal", BOUNDS.MAX_TOPICS_TOTAL],
    ["maxSubscriptionsPerPanel", BOUNDS.MAX_SUBSCRIPTIONS_PER_PANEL],
  ] as const) {
    const configured = requireSafeInteger(
      value["config"][key],
      `panel snapshot.config.${key}`,
      1,
    );
    if (configured > limit)
      throw new Error(`panel snapshot.config.${key} exceeds ${limit}`);
  }
}

export function validateCompatMatrixDocument(
  value: unknown,
): asserts value is MatrixJson {
  validateMatrixJsonDocument(value);
}

export function parseCompatMatrixJsonBounded(raw: string): MatrixJson {
  if (new TextEncoder().encode(raw).length > BOUNDS.MAX_SNAPSHOT_JSON_BYTES) {
    throw new Error("compat matrix exceeds 16 KiB");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("invalid compat matrix JSON");
  }
  validateMatrixJsonDocument(parsed);
  return parsed;
}

export class DevtoolsClient {
  private session: SessionState;
  private panelSnapshot: PanelRuntimeSnapshot | null = null;
  private readonly inspection: InspectionClient;
  private tracing: TracingClient;
  private control: ControlClient;
  private transport: IpcTransport | null = null;
  private liveSocket: LiveSocketConnection | null = null;
  private liveRequestId = 1;
  private readonly config: ClientConfig;

  /**
   * Synchronous headless inspection seam. Live sessions use the async typed
   * methods below, which dispatch through `requestLive`; they never fall back
   * to this in-memory transport.
   */
  private readonly inspectionTransport: InspectionTransport = {
    isConnected: () =>
      this.liveSocket === null &&
      this.transport !== null &&
      this.transport.isConnected(),
    request: (request, nowMs) => {
      if (this.liveSocket !== null) {
        throw new TransportError(
          "TransportClosed",
          "synchronous inspection is unavailable on live sessions; use the async live method",
        );
      }
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

  private resetSessionState(): void {
    this.session.connected = false;
    this.session.transport = null;
    this.session.socketPath = null;
    this.panelSnapshot = null;
    this.tracing = new TracingClient();
    this.control = new ControlClient();
    this.session.scopes.clear();
    this.session.generation = 1 as Generation;
    this.liveRequestId = 1;
  }

  private closeLiveSocket(): void {
    if (this.liveSocket === null) return;
    try {
      this.liveSocket.close();
    } catch {
      return;
    } finally {
      this.liveSocket = null;
    }
  }

  // -------------------------------------------------------------------------
  // Connection and scope lifecycle (per-client, least-privilege, revocable)
  // -------------------------------------------------------------------------

  connect(): SessionState {
    this.closeLiveSocket();
    if (this.transport !== null) this.transport.disconnect();
    this.transport = null;
    this.resetSessionState();
    this.session.connected = true;
    // Explicit socket configuration still selects the bounded headless fixture;
    // use connectLiveSocket() for the Linux endpoint-attested OS socket path.
    if (
      this.config.socketPath !== undefined ||
      this.config.runtimeUid !== undefined
    ) {
      if (
        this.config.socketPath !== undefined &&
        this.config.runtimeUid === undefined
      ) {
        this.session.connected = false;
        throw new Error("runtimeUid is required when socketPath is configured");
      }
      const runtimeUid = this.config.runtimeUid ?? 0;
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
        this.session.socketPath = null;
        this.session.connected = false;
        throw error;
      }
    }
    return { ...this.session, scopes: new Set(this.session.scopes) };
  }

  /** Connect to the bounded headless fixture with caller-supplied peer values. */
  connectWithTransport(transport: IpcTransport): SessionState {
    this.closeLiveSocket();
    if (this.transport !== null && this.transport !== transport) {
      this.transport.disconnect();
    }
    this.transport = null;
    this.resetSessionState();
    transport.connect();
    this.transport = transport;
    this.session.connected = true;
    this.session.transport = transport;
    this.session.socketPath = transport.getSocketPath();
    return { ...this.session, scopes: new Set(this.session.scopes) };
  }

  /** Connect the headless fixture using a resolved endpoint and peer values. */
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
   * The headless transport is retained only as a bounded request codec and
   * rate limiter; the socket supplies the response bytes and typed live
   * methods never use its in-memory queues. Opt-in and async: headless callers keep
   * using `connect` / `connectWithTransport`.
   */
  async connectLiveSocket(
    runtimeUid: number,
    _peer?: PeerCredentials,
    xdgRuntimeDir?: string,
    instanceId?: string,
    socketPath?: string,
  ): Promise<SessionState> {
    this.closeLiveSocket();
    if (this.transport !== null) this.transport.disconnect();
    this.transport = null;
    this.resetSessionState();
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
      peer: null,
    });
    try {
      t.connect();
    } catch (error) {
      live.close();
      this.session.connected = false;
      this.session.transport = null;
      this.session.socketPath = null;
      throw error;
    }
    this.transport = t;
    this.liveSocket = live;
    this.session.connected = true;
    this.session.transport = t;
    this.session.socketPath = endpoint.socketPath;
    return { ...this.session, scopes: new Set(this.session.scopes) };
  }

  /**
   * One live request/response round trip over the socket opened by
   * `connectLiveSocket`. Encodes the request with the shared framing,
   * writes it, decodes the next framed response, and validates the closed
   * response envelope, including the expected request id.
   */
  async requestLive(
    req: IpcRequest,
    nowMs: number,
    signal?: AbortSignal,
  ): Promise<IpcResponse> {
    const live = this.liveSocket;
    const transport = this.transport;
    if (
      live === null ||
      transport === null ||
      !live.isOpen() ||
      !transport.isConnected()
    ) {
      throw new TransportError(
        "TransportClosed",
        "no live socket connection: call connectLiveSocket first",
      );
    }
    this.requireScope("debug.inspect");
    validateLiveRequest(req, "debug.inspect");
    if (signal?.aborted) {
      throw new TransportError("TransportClosed", "request cancelled");
    }
    transport.getRateLimiter().check(nowMs);
    const frames = transport.encodeRequest(req);
    if (frames.length !== 1) {
      throw new TransportError(
        "FrameTooLarge",
        "live request requires a server continuation contract",
      );
    }
    const raw = await live.requestResponse(
      frames[0]!.slice(4),
      nowMs,
      req.id,
      signal,
    );
    return decodeLiveResponse(raw, req.id);
  }

  private async liveResult<T>(
    method: string,
    params: Record<string, unknown>,
    nowMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.liveSocket === null) {
      throw new TransportError(
        "TransportClosed",
        "no live socket connection: call connectLiveSocket first",
      );
    }
    if (this.liveRequestId > Number.MAX_SAFE_INTEGER) {
      throw new TransportError(
        "TransportFull",
        "live request id space exhausted",
      );
    }
    const response = await this.requestLive(
      {
        id: this.liveRequestId++,
        method,
        params,
        version: PROTOCOL_VERSION,
      },
      nowMs,
      signal,
    );
    if (response.error !== undefined) {
      throw new InspectionError(
        response.error.code,
        `${response.error.category}: ${response.error.message}`,
      );
    }
    return parseInspectionResult(method, params, response.result) as T;
  }

  getLiveIdentity(): LiveSocketIdentity | null {
    return this.liveSocket?.identity ?? null;
  }

  async listPluginsLive(
    generation?: Generation,
    nowMs = Date.now(),
    signal?: AbortSignal,
  ): Promise<ReturnType<InspectionClient["listPlugins"]>> {
    return this.liveResult(
      "bitty.debug/listPlugins",
      { generation: generation ?? null },
      nowMs,
      signal,
    );
  }

  async getPluginLive(
    pluginId: string,
    nowMs = Date.now(),
    signal?: AbortSignal,
  ): Promise<ReturnType<InspectionClient["getPlugin"]>> {
    return this.liveResult(
      "bitty.debug/getPlugin",
      { pluginId },
      nowMs,
      signal,
    );
  }

  async listSubscriptionsLive(
    pluginId: string,
    nowMs = Date.now(),
    signal?: AbortSignal,
  ): Promise<ReturnType<InspectionClient["listSubscriptions"]>> {
    return this.liveResult(
      "bitty.debug/listSubscriptions",
      { pluginId },
      nowMs,
      signal,
    );
  }

  async getBudgetsLive(
    pluginId: string,
    gen: Generation,
    nowMs = Date.now(),
    signal?: AbortSignal,
  ): Promise<ReturnType<InspectionClient["getBudgets"]>> {
    return this.liveResult(
      "bitty.debug/getBudgets",
      { pluginId, generation: gen },
      nowMs,
      signal,
    );
  }

  async getQueueSnapshotLive(
    pluginId: string,
    nowMs = Date.now(),
    signal?: AbortSignal,
  ): Promise<ReturnType<InspectionClient["getQueueSnapshot"]>> {
    return this.liveResult(
      "bitty.debug/getQueueSnapshot",
      { pluginId },
      nowMs,
      signal,
    );
  }

  async getSnapshotForTerminalLive(
    terminalId: string,
    nowMs = Date.now(),
    signal?: AbortSignal,
  ): Promise<ReturnType<InspectionClient["getSnapshotForTerminal"]>> {
    return this.liveResult(
      "bitty.debug/getSnapshot",
      { terminalId, scope: "semantic" },
      nowMs,
      signal,
    );
  }

  async listHandlesLive(
    pluginId: string,
    nowMs = Date.now(),
    signal?: AbortSignal,
  ): Promise<ReturnType<InspectionClient["listHandles"]>> {
    return this.liveResult(
      "bitty.debug/listHandles",
      { pluginId },
      nowMs,
      signal,
    );
  }

  async getGridTextLive(
    options: { rows?: number; cols?: number } = {},
    nowMs = Date.now(),
    signal?: AbortSignal,
  ): Promise<ReturnType<InspectionClient["getGridText"]>> {
    return this.liveResult(
      "bitty.debug/getGridText",
      { ...options },
      nowMs,
      signal,
    );
  }

  async getInputRingLive(
    options: { limit?: number } = {},
    nowMs = Date.now(),
    signal?: AbortSignal,
  ): Promise<ReturnType<InspectionClient["getInputRing"]>> {
    return this.liveResult(
      "bitty.debug/getInputRing",
      { ...options },
      nowMs,
      signal,
    );
  }

  async getModifiersLive(
    nowMs = Date.now(),
    signal?: AbortSignal,
  ): Promise<ReturnType<InspectionClient["getModifiers"]>> {
    return this.liveResult("bitty.debug/getModifiers", {}, nowMs, signal);
  }

  async getFocusLive(
    nowMs = Date.now(),
    signal?: AbortSignal,
  ): Promise<ReturnType<InspectionClient["getFocus"]>> {
    return this.liveResult("bitty.debug/getFocus", {}, nowMs, signal);
  }

  disconnect(): void {
    this.closeLiveSocket();
    if (this.transport !== null) {
      this.transport.disconnect();
      this.transport = null;
    }
    this.resetSessionState();
    this.session.connected = false;
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
    if (this.liveSocket !== null && scope !== "debug.inspect") {
      throw new TransportError(
        "Unauthenticated",
        "live socket sessions are inspect-only; trace and control are unavailable",
      );
    }
    if (this.liveSocket === null && this.transport !== null) {
      this.transport.verifyPeerForPrivilegedAction();
    }
    this.session.scopes.add(scope);
  }

  revokeScope(scope: DebugScope): void {
    this.requireConnected();
    if (!["debug.inspect", "debug.trace", "debug.control"].includes(scope)) {
      throw new Error(`unknown scope ${scope}`);
    }
    if (this.liveSocket !== null && scope !== "debug.inspect") {
      throw new TransportError(
        "Unauthenticated",
        "live socket sessions are inspect-only; trace and control are unavailable",
      );
    }
    if (this.liveSocket === null && this.transport !== null) {
      this.transport.verifyPeerForPrivilegedAction();
    }
    this.session.scopes.delete(scope);
  }

  currentScope(): DebugScope[] {
    return [...this.session.scopes];
  }

  private requireConnected(): void {
    if (!this.session.connected)
      throw new Error("not connected: call connect() first");
  }

  private requireScope(scope: DebugScope): void {
    this.requireConnected();
    if (!this.session.scopes.has(scope)) {
      throw new Error(`${scope} scope required`);
    }
  }

  private requireHeadlessInspection(operation: string): void {
    if (this.liveSocket !== null) {
      throw new TransportError(
        "TransportClosed",
        `${operation} is unavailable synchronously on live sessions; use ${operation}Live`,
      );
    }
  }

  private requireSimulationOnly(operation: string): void {
    if (this.liveSocket !== null) {
      throw new TransportError(
        "TransportClosed",
        `${operation} is unavailable on the inspect-only live socket session`,
      );
    }
  }

  private requireTraceAccess(operation: string): void {
    this.requireConnected();
    this.requireSimulationOnly(operation);
    if (!this.session.scopes.has("debug.trace")) {
      throw new TracingError("ScopeDenied", "debug.trace scope required");
    }
    if (this.transport !== null) {
      this.transport.verifyPeerForPrivilegedAction();
    }
  }

  private requireControlAccess(operation: string): void {
    this.requireConnected();
    this.requireSimulationOnly(operation);
    if (!this.session.scopes.has("debug.control")) {
      throw new ControlError("ScopeDenied", "debug.control scope required");
    }
    this.requirePeerForControl();
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
    this.requireSimulationOnly("setPanelSnapshot");
    this.requireConnected();
    validatePanelSnapshot(snapshot);
    const detached = structuredClone(snapshot);
    validatePanelSnapshot(detached);
    this.panelSnapshot = detached;
  }

  getPanelSnapshot(): PanelRuntimeSnapshot | null {
    this.requireHeadlessInspection("getPanelSnapshot");
    this.requireScope("debug.inspect");
    return this.panelSnapshot === null
      ? null
      : structuredClone(this.panelSnapshot);
  }

  // -------------------------------------------------------------------------
  // Inspection (debug.inspect)
  // -------------------------------------------------------------------------

  listPlugins(
    generation?: Generation,
  ): ReturnType<InspectionClient["listPlugins"]> {
    this.requireHeadlessInspection("listPlugins");
    this.requireScope("debug.inspect");
    return this.inspection.listPlugins("debug.inspect", generation);
  }

  getPlugin(pluginId: string): ReturnType<InspectionClient["getPlugin"]> {
    this.requireHeadlessInspection("getPlugin");
    this.requireScope("debug.inspect");
    return this.inspection.getPlugin("debug.inspect", pluginId);
  }

  listSubscriptions(
    pluginId: string,
  ): ReturnType<InspectionClient["listSubscriptions"]> {
    this.requireHeadlessInspection("listSubscriptions");
    this.requireScope("debug.inspect");
    return this.inspection.listSubscriptions("debug.inspect", pluginId);
  }

  getBudgets(
    pluginId: string,
    gen: Generation,
  ): ReturnType<InspectionClient["getBudgets"]> {
    this.requireHeadlessInspection("getBudgets");
    this.requireScope("debug.inspect");
    return this.inspection.getBudgets("debug.inspect", pluginId, gen);
  }

  getQueueSnapshot(
    pluginId: string,
  ): ReturnType<InspectionClient["getQueueSnapshot"]> {
    this.requireHeadlessInspection("getQueueSnapshot");
    this.requireScope("debug.inspect");
    return this.inspection.getQueueSnapshot("debug.inspect", pluginId);
  }

  getSnapshotForTerminal(
    terminalId: string,
    previewText: string,
  ): ReturnType<InspectionClient["getSnapshotForTerminal"]> {
    this.requireHeadlessInspection("getSnapshotForTerminal");
    this.requireScope("debug.inspect");
    return this.inspection.getSnapshotForTerminal(
      "debug.inspect",
      terminalId,
      previewText,
    );
  }

  listHandles(pluginId: string): ReturnType<InspectionClient["listHandles"]> {
    this.requireHeadlessInspection("listHandles");
    this.requireScope("debug.inspect");
    return this.inspection.listHandles("debug.inspect", pluginId);
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
    this.requireHeadlessInspection("getGridText");
    this.requireScope("debug.inspect");
    return this.inspection.getGridText("debug.inspect", options);
  }

  getInputRing(options?: {
    limit?: number;
  }): ReturnType<InspectionClient["getInputRing"]> {
    this.requireHeadlessInspection("getInputRing");
    this.requireScope("debug.inspect");
    return this.inspection.getInputRing("debug.inspect", options);
  }

  getModifiers(): ReturnType<InspectionClient["getModifiers"]> {
    this.requireHeadlessInspection("getModifiers");
    this.requireScope("debug.inspect");
    return this.inspection.getModifiers("debug.inspect");
  }

  getFocus(): ReturnType<InspectionClient["getFocus"]> {
    this.requireHeadlessInspection("getFocus");
    this.requireScope("debug.inspect");
    return this.inspection.getFocus("debug.inspect");
  }

  panelSummary(): ReturnType<InspectionClient["panelSummary"]> {
    this.requireHeadlessInspection("panelSummary");
    this.requireScope("debug.inspect");
    return this.inspection.panelSummary("debug.inspect");
  }

  compatMatrixSummary(): ReturnType<InspectionClient["compatMatrixSummary"]> {
    this.requireHeadlessInspection("compatMatrixSummary");
    this.requireScope("debug.inspect");
    return this.inspection.compatMatrixSummary("debug.inspect");
  }

  // -------------------------------------------------------------------------
  // Tracing (debug.trace) — phase 1 + phase 2 advanced
  // -------------------------------------------------------------------------

  startTrace(
    opts: Parameters<TracingClient["startTrace"]>[1],
  ): ReturnType<TracingClient["startTrace"]> {
    this.requireTraceAccess("startTrace");
    return this.tracing.startTrace("debug.trace", opts);
  }

  startTraceWithFilter(
    opts: Parameters<TracingClient["startTraceWithFilter"]>[1],
    nowMs?: number,
  ): ReturnType<TracingClient["startTraceWithFilter"]> {
    this.requireTraceAccess("startTraceWithFilter");
    return this.tracing.startTraceWithFilter("debug.trace", opts, nowMs);
  }

  stopTrace(traceId: string): ReturnType<TracingClient["stopTrace"]> {
    this.requireTraceAccess("stopTrace");
    return this.tracing.stopTrace("debug.trace", traceId);
  }

  streamEvents(
    types: string[],
    batch: { maxEvents: number; maxBytes: number },
    signal?: AbortSignal,
  ): ReturnType<TracingClient["streamEvents"]> {
    this.requireTraceAccess("streamEvents");
    return this.tracing.streamEvents("debug.trace", types, batch, signal);
  }

  streamFilteredEvents(
    filter: Parameters<TracingClient["streamFilteredEvents"]>[1],
    batch: { maxEvents: number; maxBytes: number },
    nowMs?: number,
    signal?: AbortSignal,
  ): ReturnType<TracingClient["streamFilteredEvents"]> {
    this.requireTraceAccess("streamFilteredEvents");
    return this.tracing.streamFilteredEvents(
      "debug.trace",
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
    this.requireTraceAccess("fetchTraceChunk");
    return this.tracing.fetchTraceChunk("debug.trace", traceId, offset);
  }

  appendToTrace(traceId: string, data: string): void {
    this.requireTraceAccess("appendToTrace");
    this.tracing.appendToTrace("debug.trace", traceId, data);
  }

  appendStructuredEvent(
    traceId: string,
    event: Parameters<TracingClient["appendStructuredEvent"]>[2],
  ): void {
    this.requireTraceAccess("appendStructuredEvent");
    this.tracing.appendStructuredEvent("debug.trace", traceId, event);
  }

  getTraceRetention(
    traceId: string,
  ): ReturnType<TracingClient["getRetention"]> {
    this.requireTraceAccess("getTraceRetention");
    return this.tracing.getRetention("debug.trace", traceId);
  }

  gcExpiredTraces(nowMs: number): string[] {
    this.requireTraceAccess("gcExpiredTraces");
    return this.tracing.gcExpiredTraces(nowMs, "debug.trace");
  }

  exportTracePreview(
    traceId: string,
  ): ReturnType<TracingClient["exportPreview"]> {
    this.requireTraceAccess("exportTracePreview");
    return this.tracing.exportPreview(traceId, "debug.trace");
  }

  listTraces(): string[] {
    this.requireTraceAccess("listTraces");
    return this.tracing.listTraces("debug.trace");
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
    this.requireControlAccess("suspendHandler");
    return this.control.suspendHandler(
      "debug.control",
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
    this.requireControlAccess("pauseHandler");
    return this.control.pauseHandler(
      "debug.control",
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
    this.requireControlAccess("resumePlugin");
    return this.control.resumePlugin("debug.control", panelId, gen, caller);
  }

  disposeGeneration(
    panelId: PanelId,
    gen: Generation,
    caller?: string,
  ): ReturnType<ControlClient["disposeGeneration"]> {
    this.requireControlAccess("disposeGeneration");
    return this.control.disposeGeneration(
      "debug.control",
      panelId,
      gen,
      caller,
    );
  }

  validateGeneration(
    gen: Generation,
  ): ReturnType<ControlClient["validateGeneration"]> {
    this.requireControlAccess("validateGeneration");
    return this.control.validateGeneration(gen);
  }

  listAuditLog(limit?: number): ReturnType<ControlClient["listAuditLog"]> {
    this.requireControlAccess("listAuditLog");
    return this.control.listAuditLog("debug.control", limit);
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
    this.requireSimulationOnly("automationClient");
    const scopes = new Set<string>(this.session.scopes);
    for (const capability of capabilities) scopes.add(capability);
    return new AutomationClient(this.inspectionTransport, scopes);
  }

  // -------------------------------------------------------------------------
  // Utilities: compat matrix raw, framing validation (bounded)
  // -------------------------------------------------------------------------

  generateCompatMatrixJson(): string {
    this.requireScope("debug.inspect");
    this.inspection.compatMatrixSummary("debug.inspect");
    const json = generateMatrixJson();
    parseCompatMatrixJsonBounded(json);
    return json;
  }

  validateFrame(raw: string): void {
    validateFrameBytes(raw);
  }

  withCancellation<T>(fn: (signal: AbortSignal) => T, signal?: AbortSignal): T {
    const controller = new AbortController();
    const externalAbort = (): void => controller.abort();
    if (signal !== undefined) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", externalAbort, { once: true });
    }
    const cleanup = (): void => {
      signal?.removeEventListener("abort", externalAbort);
    };
    if (controller.signal.aborted) {
      cleanup();
      throw new TransportError("TransportClosed", "cancelled");
    }
    try {
      const result = fn(controller.signal);
      if (
        result !== null &&
        typeof result === "object" &&
        typeof (result as { then?: unknown }).then === "function"
      ) {
        return Promise.resolve(result).finally(cleanup) as T;
      }
      cleanup();
      return result;
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  /** For tests: expose underlying transport stub lengths. */
  transportOutgoingLen(): number | null {
    return this.transport?.outgoingLen() ?? null;
  }
}
