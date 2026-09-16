/**
 * Test-automation bindings (bitty.debug/synthesizeInput, captureFrame, frameHash).
 *
 * Candidate surface (Amendment A1 candidate in `bitty-ipc` CTX-0188 and
 * CTX-0244): headless integration harnesses drive bounded keyboard/mouse
 * trajectories and read back a redacted frame or a stable frame digest instead
 * of requiring manual visual acceptance. DevTools is a consumer only: the wire
 * contract belongs to `bitty` (`crates/bitty-ipc/src/devtools.rs`) and is never
 * owned here.
 *
 * Fail-closed everywhere:
 * - Connection alone grants nothing. Each call needs the debug scope, the
 *   terminal capability scope, and a consent-issued per-session bearer, so
 *   inspect-only callers get a typed `ScopeDenied` and never a silent call.
 * - An unregistered method (`usage`/`UnknownMethod`) becomes a typed
 *   `UnknownMethod` error, so a version-skewed target can never be mistaken for
 *   a successful call or have plausible data fabricated for it.
 * - Trajectories are bounded in points and in client-declared playback
 *   duration; request params, responses, frame geometry, and frame lines are
 *   bounded before they leave this module.
 * - `pixels` capture is masked by the server and no raw pixel channel exists. A
 *   response that smuggles a `pixels` payload is rejected, not decoded.
 *
 * Contract gap: `bitty-docs/docs/specifications/devtools-rfc.md` does not yet
 * name these methods. The bindings are checked against the serving dispatcher
 * and its socket-level tests; the naming/status gap is reported to the owning
 * repositories rather than filled in here.
 */

import { BOUNDS } from "./bounds.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import type { IpcRequest, IpcResponse } from "./transport.js";

/** Wire method for `synthesizeInput` (key/mouse/wheel/paste synthesis). */
export const METHOD_SYNTHESIZE_INPUT = "bitty.debug/synthesizeInput";

/** Wire method for `captureFrame` (bounded redacted frame capture). */
export const METHOD_CAPTURE_FRAME = "bitty.debug/captureFrame";

/** Wire method for `frameHash` (SHA-256 digest over canonical frame bytes). */
export const METHOD_FRAME_HASH = "bitty.debug/frameHash";

/** Terminal capability scope required alongside the debug scope. */
export type AutomationCapability = "terminal.input" | "terminal.inspect";

export type SyntheticKeyEvent = {
  type: "key";
  key: string;
  mods?: string;
  pressed?: boolean;
};

export type MouseButton = "Left" | "Right" | "Middle";
export type MouseAction = "pressed" | "released" | "click" | "drag" | "move";

export type SyntheticMouseEvent = {
  type: "mouse";
  button: MouseButton;
  action: MouseAction;
  col: number;
  row: number;
};

export type SyntheticWheelEvent = {
  type: "wheel";
  deltaRows: number;
  deltaCols?: number;
  col?: number;
  row?: number;
};

export type SyntheticPasteEvent = {
  type: "paste";
  text: string;
};

export type SyntheticEvent =
  | SyntheticKeyEvent
  | SyntheticMouseEvent
  | SyntheticWheelEvent
  | SyntheticPasteEvent;

/** A bounded trajectory plus the caller's intended playback duration. */
export type TrajectoryPlan = {
  events: SyntheticEvent[];
  durationMs: number;
};

export type DragOptions = {
  steps?: number;
  durationMs?: number;
  button?: MouseButton;
};

export type SynthesizeInputRequest = {
  terminalId: string;
  bearer: string;
  originLabel: string;
  events: SyntheticEvent[];
  /** Client-side playback budget; validated but never sent on the wire. */
  durationMs?: number;
};

export type SynthesizeReceipt = {
  version: string;
  receipt: "synthesize";
  terminalId: string;
  accepted: number;
  rejected: number;
  syntheticSeq: number;
  originLabel: string;
  synthetic: true;
};

export type CaptureFrameRequest = {
  terminalId: string;
  bearer: string;
  format?: "semantic" | "pixels";
  explicitOptIn?: boolean;
  rows?: number;
  cols?: number;
};

export type SemanticFrame = {
  version: string;
  snapshot: "frame";
  format: "semantic";
  terminalId: string;
  lines: string[];
  cursor: { row: number; col: number; visible: boolean };
  cols: number;
  rows: number;
  frameSeq: number;
  trust: "untrusted-observation";
};

export type MaskedPixelsFrame = {
  version: string;
  snapshot: "frame";
  format: "pixels";
  terminalId: string;
  masked: true;
  cols: number;
  rows: number;
  frameSeq: number;
  trust: "untrusted-observation";
  caller: string;
  audited: true;
};

export type CaptureFrameResult = SemanticFrame | MaskedPixelsFrame;

export type FrameHashRequest = {
  terminalId: string;
  bearer: string;
};

export type FrameHashResult = {
  version: string;
  snapshot: "frameHash";
  terminalId: string;
  cols: number;
  rows: number;
  widthPx: number;
  heightPx: number;
  frameSeq: number;
  algo: "sha256-v1";
  digest: string;
  trust: "untrusted-observation";
};

export type AutomationErrorCode =
  | "NoTransport"
  | "ScopeDenied"
  | "UnknownMethod"
  | "InvalidParams"
  | "BoundExceeded"
  | "InvalidResult"
  | "Protocol";

export class AutomationError extends Error {
  constructor(
    public readonly code: AutomationErrorCode,
    message: string,
    public readonly category?: string,
    public readonly serverCode?: string,
  ) {
    super(message);
    this.name = "AutomationError";
  }
}

/**
 * JSON-RPC request/response seam for automation. Production binds this to the
 * connected `IpcTransport`; unit tests inject a fake to assert the exact method
 * names, params, and fail-closed handling. Structurally identical to the
 * inspection seam so one connected transport serves both.
 */
export type AutomationTransport = {
  isConnected(): boolean;
  request(request: IpcRequest, nowMs: number): IpcResponse;
};

const MONITORED_BOUND = "MAX_AUTOMATION_RESPONSE_BYTES";
const TRUST_LABEL = "untrusted-observation";
const DIGEST_HEX = /^[0-9a-f]{64}$/;
const TERMINAL_ID = /^t:[0-9]+$/;
const BEARER_SHAPE = /^[A-Za-z0-9_-]+$/;
const MODS_SHAPE = /^[A-Za-z0-9+\-_]*$/;
const MAX_ERROR_MESSAGE_CHARS = 512;

/** Typed bound violation: callers get `BoundExceeded`, never a bare error. */
function bound(boundName: string, observed: number, limit: number): void {
  if (!Number.isFinite(observed) || observed > limit || observed < 0) {
    throw new AutomationError(
      "BoundExceeded",
      `${boundName} exceeded: ${observed} > ${limit}`,
    );
  }
}

function boundBytes(boundName: string, value: string, limit: number): void {
  bound(boundName, new TextEncoder().encode(value).length, limit);
}

// ---------------------------------------------------------------------------
// Fail-closed result parsing (server-owned fields are required, never defaulted)
// ---------------------------------------------------------------------------

function parseError(field: string, message: string): AutomationError {
  return new AutomationError("InvalidResult", `${field}: ${message}`);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw parseError(field, "expected an object");
  }
  return value as Record<string, unknown>;
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

function requireInteger(
  record: Record<string, unknown>,
  key: string,
  field: string,
): number {
  const value = requireNumber(record, key, field);
  if (!Number.isInteger(value) || value < 0) {
    throw parseError(`${field}.${key}`, "expected a non-negative integer");
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

function requireTrust(record: Record<string, unknown>, field: string): void {
  if (requireString(record, "trust", field) !== TRUST_LABEL) {
    throw parseError(`${field}.trust`, `expected ${TRUST_LABEL}`);
  }
}

function parseReceipt(result: unknown): SynthesizeReceipt {
  boundBytes(
    MONITORED_BOUND,
    JSON.stringify(result),
    BOUNDS.MAX_AUTOMATION_RESPONSE_BYTES,
  );
  const field = "synthesizeInput result";
  const r = requireRecord(result, field);
  if (requireString(r, "receipt", field) !== "synthesize") {
    throw parseError(`${field}.receipt`, "expected synthesize");
  }
  const accepted = requireInteger(r, "accepted", field);
  const rejected = requireInteger(r, "rejected", field);
  bound(
    "MAX_SYNTH_EVENTS_PER_CALL",
    accepted,
    BOUNDS.MAX_SYNTH_EVENTS_PER_CALL,
  );
  bound(
    "MAX_SYNTH_EVENTS_PER_CALL",
    rejected,
    BOUNDS.MAX_SYNTH_EVENTS_PER_CALL,
  );
  if (requireBoolean(r, "synthetic", field) !== true) {
    throw parseError(`${field}.synthetic`, "expected true");
  }
  return {
    version: requireString(r, "version", field),
    receipt: "synthesize",
    terminalId: requireNonEmptyString(r, "terminalId", field),
    accepted,
    rejected,
    syntheticSeq: requireInteger(r, "syntheticSeq", field),
    originLabel: requireNonEmptyString(r, "originLabel", field),
    synthetic: true,
  };
}

function parseSemanticFrame(
  r: Record<string, unknown>,
  field: string,
): SemanticFrame {
  const rawLines = r["lines"];
  if (
    !Array.isArray(rawLines) ||
    !rawLines.every((line) => typeof line === "string")
  ) {
    throw parseError(`${field}.lines`, "expected an array of strings");
  }
  bound("MAX_INSPECT_ROWS", rawLines.length, BOUNDS.MAX_INSPECT_ROWS);
  const lines = rawLines.map((line, i) => {
    if ([...line].length > BOUNDS.MAX_INSPECT_COLS) {
      throw parseError(
        `${field}.lines[${i}]`,
        `exceeds ${BOUNDS.MAX_INSPECT_COLS} chars`,
      );
    }
    return line;
  });
  const cursor = requireRecord(r["cursor"], `${field}.cursor`);
  return {
    version: requireString(r, "version", field),
    snapshot: "frame",
    format: "semantic",
    terminalId: requireNonEmptyString(r, "terminalId", field),
    lines,
    cursor: {
      row: requireInteger(cursor, "row", `${field}.cursor`),
      col: requireInteger(cursor, "col", `${field}.cursor`),
      visible: requireBoolean(cursor, "visible", `${field}.cursor`),
    },
    cols: requireInteger(r, "cols", field),
    rows: requireInteger(r, "rows", field),
    frameSeq: requireInteger(r, "frameSeq", field),
    trust: TRUST_LABEL,
  };
}

function parseMaskedPixelsFrame(
  r: Record<string, unknown>,
  field: string,
): MaskedPixelsFrame {
  if ("pixels" in r) {
    throw parseError(`${field}.pixels`, "pixel bytes are never accepted");
  }
  if (requireBoolean(r, "masked", field) !== true) {
    throw parseError(`${field}.masked`, "expected true");
  }
  if (requireBoolean(r, "audited", field) !== true) {
    throw parseError(`${field}.audited`, "expected true");
  }
  return {
    version: requireString(r, "version", field),
    snapshot: "frame",
    format: "pixels",
    terminalId: requireNonEmptyString(r, "terminalId", field),
    masked: true,
    cols: requireInteger(r, "cols", field),
    rows: requireInteger(r, "rows", field),
    frameSeq: requireInteger(r, "frameSeq", field),
    trust: TRUST_LABEL,
    caller: requireNonEmptyString(r, "caller", field),
    audited: true,
  };
}

function parseFrame(result: unknown): CaptureFrameResult {
  boundBytes(
    MONITORED_BOUND,
    JSON.stringify(result),
    BOUNDS.MAX_AUTOMATION_RESPONSE_BYTES,
  );
  const field = "captureFrame result";
  const r = requireRecord(result, field);
  if (requireString(r, "snapshot", field) !== "frame") {
    throw parseError(`${field}.snapshot`, "expected frame");
  }
  requireTrust(r, field);
  const format = requireString(r, "format", field);
  if (format === "semantic") return parseSemanticFrame(r, field);
  if (format === "pixels") return parseMaskedPixelsFrame(r, field);
  throw parseError(`${field}.format`, `unknown format ${format}`);
}

function parseFrameHash(result: unknown): FrameHashResult {
  boundBytes(
    MONITORED_BOUND,
    JSON.stringify(result),
    BOUNDS.MAX_AUTOMATION_RESPONSE_BYTES,
  );
  const field = "frameHash result";
  const r = requireRecord(result, field);
  if (requireString(r, "snapshot", field) !== "frameHash") {
    throw parseError(`${field}.snapshot`, "expected frameHash");
  }
  const algo = requireString(r, "algo", field);
  if (algo !== "sha256-v1") {
    throw parseError(`${field}.algo`, `unknown digest algorithm ${algo}`);
  }
  const digest = requireString(r, "digest", field);
  if (!DIGEST_HEX.test(digest)) {
    throw parseError(`${field}.digest`, "expected 64 lowercase hex chars");
  }
  const widthPx = requireInteger(r, "widthPx", field);
  const heightPx = requireInteger(r, "heightPx", field);
  if (widthPx === 0 || heightPx === 0) {
    throw parseError(`${field}`, "frame geometry must be non-zero");
  }
  bound(
    "MAX_DIGEST_RGBA_BYTES",
    widthPx * heightPx * 4,
    BOUNDS.MAX_DIGEST_RGBA_BYTES,
  );
  requireTrust(r, field);
  return {
    version: requireString(r, "version", field),
    snapshot: "frameHash",
    terminalId: requireNonEmptyString(r, "terminalId", field),
    cols: requireInteger(r, "cols", field),
    rows: requireInteger(r, "rows", field),
    widthPx,
    heightPx,
    frameSeq: requireInteger(r, "frameSeq", field),
    algo: "sha256-v1",
    digest,
    trust: TRUST_LABEL,
  };
}

// ---------------------------------------------------------------------------
// Argument validation (fail closed before any request is sent)
// ---------------------------------------------------------------------------

function validateTerminalId(terminalId: string): void {
  if (!TERMINAL_ID.test(terminalId)) {
    throw new AutomationError(
      "InvalidParams",
      `terminalId must match ^t:[0-9]+$ (no wildcards): ${terminalId}`,
    );
  }
}

function validateBearer(bearer: string): void {
  if (
    bearer.length === 0 ||
    bearer.length > BOUNDS.MAX_BEARER_TOKEN_CHARS ||
    !BEARER_SHAPE.test(bearer)
  ) {
    throw new AutomationError("InvalidParams", "bearer token shape invalid");
  }
}

function validateOriginLabel(originLabel: string): void {
  if (
    originLabel.length === 0 ||
    [...originLabel].length > BOUNDS.MAX_ORIGIN_LABEL_CHARS ||
    hasControlBytes(originLabel)
  ) {
    throw new AutomationError(
      "InvalidParams",
      `originLabel must be 1..${BOUNDS.MAX_ORIGIN_LABEL_CHARS} chars without control bytes`,
    );
  }
}

function hasControlBytes(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function validateKey(event: SyntheticKeyEvent): void {
  if (
    event.key.length === 0 ||
    [...event.key].length > BOUNDS.MAX_SYNTH_KEY_CHARS
  ) {
    throw new AutomationError(
      "InvalidParams",
      `key must be 1..${BOUNDS.MAX_SYNTH_KEY_CHARS} chars`,
    );
  }
  for (const char of event.key) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 && code !== 0x09) {
      throw new AutomationError(
        "InvalidParams",
        "key must not contain control bytes",
      );
    }
  }
  if (event.mods !== undefined) {
    if ([...event.mods].length > 16 || !MODS_SHAPE.test(event.mods)) {
      throw new AutomationError(
        "InvalidParams",
        "mods must be <= 16 alphanumeric/+-_ chars",
      );
    }
  }
}

function validateMouse(event: SyntheticMouseEvent): void {
  if (!["Left", "Right", "Middle"].includes(event.button)) {
    throw new AutomationError(
      "InvalidParams",
      "button must be Left|Right|Middle",
    );
  }
  if (
    !["pressed", "released", "click", "drag", "move"].includes(event.action)
  ) {
    throw new AutomationError(
      "InvalidParams",
      "action must be pressed|released|click|drag|move",
    );
  }
  bound("MAX_SYNTH_CELL", event.col, BOUNDS.MAX_SYNTH_CELL);
  bound("MAX_SYNTH_CELL", event.row, BOUNDS.MAX_SYNTH_CELL);
}

function validateWheel(event: SyntheticWheelEvent): void {
  const cols = event.deltaCols ?? 0;
  if (event.deltaRows === 0 && cols === 0) {
    throw new AutomationError("InvalidParams", "wheel delta must be non-zero");
  }
  bound(
    "MAX_SYNTH_WHEEL_DELTA",
    Math.abs(event.deltaRows),
    BOUNDS.MAX_SYNTH_WHEEL_DELTA,
  );
  bound("MAX_SYNTH_WHEEL_DELTA", Math.abs(cols), BOUNDS.MAX_SYNTH_WHEEL_DELTA);
  if (event.col !== undefined) {
    bound("MAX_SYNTH_CELL", event.col, BOUNDS.MAX_SYNTH_CELL);
  }
  if (event.row !== undefined) {
    bound("MAX_SYNTH_CELL", event.row, BOUNDS.MAX_SYNTH_CELL);
  }
}

function validatePaste(event: SyntheticPasteEvent): void {
  if (event.text.length === 0) {
    throw new AutomationError("InvalidParams", "paste text must not be empty");
  }
  boundBytes("MAX_SYNTH_PASTE_BYTES", event.text, BOUNDS.MAX_SYNTH_PASTE_BYTES);
  if (event.text.includes("\0")) {
    throw new AutomationError(
      "InvalidParams",
      "paste text must not contain NUL",
    );
  }
  // Paste newline injection: a pasted LF/CR submits the line in shells that
  // do not handle bracketed paste, so multi-line paste would execute
  // unintended input. DevTools never synthesizes multi-line pastes; split
  // into single-line pastes and explicit key events instead. Fail closed.
  if (event.text.includes("\n") || event.text.includes("\r")) {
    throw new AutomationError(
      "InvalidParams",
      "paste text must not contain CR or LF",
    );
  }
}

/** Validate one synthetic event against the serving bounds (fail closed). */
export function validateSyntheticEvent(event: SyntheticEvent): void {
  switch (event.type) {
    case "key":
      validateKey(event);
      return;
    case "mouse":
      validateMouse(event);
      return;
    case "wheel":
      validateWheel(event);
      return;
    case "paste":
      validatePaste(event);
      return;
  }
}

/** Bounded keyboard KeyDown event. */
export function keyDown(key: string, mods?: string): SyntheticKeyEvent {
  return mods === undefined
    ? { type: "key", key, pressed: true }
    : { type: "key", key, mods, pressed: true };
}

/** Bounded keyboard KeyUp event. */
export function keyUp(key: string, mods?: string): SyntheticKeyEvent {
  return mods === undefined
    ? { type: "key", key, pressed: false }
    : { type: "key", key, mods, pressed: false };
}

/**
 * Bound a trajectory in points and client-declared playback duration. The
 * event cap mirrors the server's per-call bound; the duration is a client
 * pacing budget the server does not model.
 */
export function assertTrajectoryBounded(
  events: readonly SyntheticEvent[],
  durationMs = 0,
): void {
  if (events.length === 0) {
    throw new AutomationError(
      "InvalidParams",
      "trajectory requires at least one event",
    );
  }
  bound("MAX_TRAJECTORY_POINTS", events.length, BOUNDS.MAX_TRAJECTORY_POINTS);
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new AutomationError(
      "InvalidParams",
      "durationMs must be finite and >= 0",
    );
  }
  if (durationMs > BOUNDS.MAX_TRAJECTORY_DURATION_MS) {
    throw new AutomationError(
      "BoundExceeded",
      `MAX_TRAJECTORY_DURATION_MS exceeded: ${durationMs} > ${BOUNDS.MAX_TRAJECTORY_DURATION_MS}`,
    );
  }
}

/** Bounded mouse click trajectory (press + release at one cell). */
export function clickTrajectory(
  col: number,
  row: number,
  button: MouseButton = "Left",
  durationMs = 0,
): TrajectoryPlan {
  const events: SyntheticEvent[] = [
    { type: "mouse", button, action: "pressed", col, row },
    { type: "mouse", button, action: "released", col, row },
  ];
  assertTrajectoryBounded(events, durationMs);
  return { events, durationMs };
}

/** Bounded mouse drag trajectory (press, interpolated moves, release). */
export function dragTrajectory(
  from: { col: number; row: number },
  to: { col: number; row: number },
  options: DragOptions = {},
): TrajectoryPlan {
  const button = options.button ?? "Left";
  const steps = options.steps ?? 1;
  const durationMs = options.durationMs ?? 0;
  if (!Number.isInteger(steps) || steps < 0) {
    throw new AutomationError(
      "InvalidParams",
      "steps must be a non-negative integer",
    );
  }
  bound("MAX_DRAG_STEPS", steps, BOUNDS.MAX_DRAG_STEPS);
  const events: SyntheticEvent[] = [
    { type: "mouse", button, action: "pressed", col: from.col, row: from.row },
  ];
  for (let i = 1; i <= steps; i += 1) {
    const t = i / (steps + 1);
    events.push({
      type: "mouse",
      button,
      action: "move",
      col: Math.round(from.col + (to.col - from.col) * t),
      row: Math.round(from.row + (to.row - from.row) * t),
    });
  }
  events.push({
    type: "mouse",
    button,
    action: "released",
    col: to.col,
    row: to.row,
  });
  assertTrajectoryBounded(events, durationMs);
  return { events, durationMs };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class AutomationClient {
  private nextRequestId = 1;

  constructor(
    private readonly transport: AutomationTransport | null = null,
    private readonly grantedScopes: ReadonlySet<string> = new Set(),
  ) {}

  private isLive(): boolean {
    return this.transport !== null && this.transport.isConnected();
  }

  private requireScopes(required: readonly string[]): void {
    for (const scope of required) {
      if (!this.grantedScopes.has(scope)) {
        throw new AutomationError(
          "ScopeDenied",
          `${required.join(" + ")} scope required`,
        );
      }
    }
  }

  private mapServerError(error: {
    category: string;
    code: string;
    message: string;
  }): AutomationError {
    const message = error.message.slice(0, MAX_ERROR_MESSAGE_CHARS);
    if (error.code === "UnknownMethod" || error.code === "InvalidMethod") {
      return new AutomationError(
        "UnknownMethod",
        `${error.category}: ${message}`,
        error.category,
        error.code,
      );
    }
    if (error.category === "scope" || error.code === "ScopeDenied") {
      return new AutomationError(
        "ScopeDenied",
        `${error.category}: ${message}`,
        error.category,
        error.code,
      );
    }
    if (
      error.code === "RateLimited" ||
      error.code === "LimitExceeded" ||
      error.code === "PayloadTooLarge" ||
      error.code === "BudgetExceeded"
    ) {
      return new AutomationError(
        "BoundExceeded",
        `${error.category}: ${message}`,
        error.category,
        error.code,
      );
    }
    return new AutomationError(
      "Protocol",
      `${error.category}: ${message}`,
      error.category,
      error.code,
    );
  }

  private rpc(method: string, params: Record<string, unknown>): unknown {
    const transport = this.transport;
    if (transport === null || !transport.isConnected()) {
      throw new AutomationError(
        "NoTransport",
        "no connected automation transport",
      );
    }
    boundBytes(
      "MAX_AUTOMATION_PARAMS_BYTES",
      JSON.stringify(params),
      BOUNDS.MAX_AUTOMATION_PARAMS_BYTES,
    );
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const response = transport.request(
      { id, method, params, version: PROTOCOL_VERSION },
      Date.now(),
    );
    if (response.error !== undefined) {
      throw this.mapServerError(response.error);
    }
    return response.result;
  }

  /**
   * `bitty.debug/synthesizeInput`: dispatch a bounded event trajectory.
   *
   * Requires `debug.control` + `terminal.input` and a live `synthesize`
   * bearer. The optional `durationMs` is a client playback budget; it is
   * validated here and never sent on the wire.
   */
  synthesizeInput(request: SynthesizeInputRequest): SynthesizeReceipt {
    this.requireScopes(["debug.control", "terminal.input"]);
    validateTerminalId(request.terminalId);
    validateBearer(request.bearer);
    validateOriginLabel(request.originLabel);
    bound(
      "MAX_SYNTH_EVENTS_PER_CALL",
      request.events.length,
      BOUNDS.MAX_SYNTH_EVENTS_PER_CALL,
    );
    if (request.events.length === 0) {
      throw new AutomationError(
        "InvalidParams",
        "synthesizeInput requires at least one event",
      );
    }
    for (const event of request.events) validateSyntheticEvent(event);
    assertTrajectoryBounded(request.events, request.durationMs ?? 0);
    return parseReceipt(
      this.rpc(METHOD_SYNTHESIZE_INPUT, {
        terminalId: request.terminalId,
        bearer: request.bearer,
        originLabel: request.originLabel,
        events: request.events,
      }),
    );
  }

  /**
   * `bitty.debug/captureFrame`: read a bounded, redacted frame.
   *
   * Requires `debug.trace` + `terminal.inspect` and a live `capture` bearer.
   * `pixels` is masked by the server and additionally requires explicit
   * opt-in; a response carrying a `pixels` payload is rejected.
   */
  captureFrame(request: CaptureFrameRequest): CaptureFrameResult {
    this.requireScopes(["debug.trace", "terminal.inspect"]);
    validateTerminalId(request.terminalId);
    validateBearer(request.bearer);
    const format = request.format ?? "semantic";
    if (format !== "semantic" && format !== "pixels") {
      throw new AutomationError(
        "InvalidParams",
        "format must be semantic|pixels",
      );
    }
    if (format === "pixels" && request.explicitOptIn !== true) {
      throw new AutomationError(
        "InvalidParams",
        "pixels capture requires explicitOptIn true",
      );
    }
    const params: Record<string, unknown> = {
      terminalId: request.terminalId,
      bearer: request.bearer,
      format,
    };
    if (request.explicitOptIn !== undefined) {
      params["explicitOptIn"] = request.explicitOptIn;
    }
    if (request.rows !== undefined) {
      bound("MAX_INSPECT_ROWS", request.rows, BOUNDS.MAX_INSPECT_ROWS);
      params["rows"] = request.rows;
    }
    if (request.cols !== undefined) {
      bound("MAX_INSPECT_COLS", request.cols, BOUNDS.MAX_INSPECT_COLS);
      params["cols"] = request.cols;
    }
    return parseFrame(this.rpc(METHOD_CAPTURE_FRAME, params));
  }

  /**
   * `bitty.debug/frameHash`: read the stable frame digest for headless
   * equality assertions (no pixel bytes cross IPC).
   *
   * Requires `debug.trace` + `terminal.inspect` and a live `frame-digest`
   * bearer.
   */
  frameHash(request: FrameHashRequest): FrameHashResult {
    this.requireScopes(["debug.trace", "terminal.inspect"]);
    validateTerminalId(request.terminalId);
    validateBearer(request.bearer);
    return parseFrameHash(
      this.rpc(METHOD_FRAME_HASH, {
        terminalId: request.terminalId,
        bearer: request.bearer,
      }),
    );
  }

  /** Whether this client has a connected transport. */
  connected(): boolean {
    return this.isLive();
  }
}
