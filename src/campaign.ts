/**
 * Live client campaign conformance harness (CTX-0325 / devtools CTX-0019).
 *
 * The CTX-0320 campaign exercised the live `bitty ctl` client by hand and filed
 * three defects (D1 terminal text, D2 workspace id, D3 terminal spawn). This
 * module turns that campaign into a repeatable, bounded harness that runs over
 * the DevTools dispatch seam so the checks are headless-testable and the live
 * path is explicit and opt-in.
 *
 * Two seams are used, mirroring the accepted DevTools contract:
 * - a {@link CtlDispatcher} adapts the core `bitty.debug/*` Dispatcher surface
 *   through the `ctl` facade (the verb -> envelope + exit-code seam); and
 * - the socket preflight reuses the DevTools `IpcTransport` endpoint rules
 *   (`0700` directory, owner UID) declared in `auth.ts`, producing an actionable
 *   diagnostic before a live connection is attempted.
 *
 * Everything here is observation data: envelopes, text, and diagnostics are
 * untrusted and must never be treated as instructions. Live checks are opt-in;
 * the default `bun test` path only exercises the scripted dispatcher.
 *
 * `ctl` protocol ownership remains in `bitty` (`crates/bitty-app/src/ctl.rs`
 * `exit_for_server_error`, and `crates/bitty-ipc/src/ctl.rs`). The constants
 * below are a consumer-side mirror, not a second source of truth.
 */

import { DIR_MODE } from "./auth.js";
import { truncateToBytes } from "./bounds.js";
import { redactSensitiveText, sanitizeTerminalOutput } from "./redaction.js";

function isAbsoluteSocketPath(socketPath: string): boolean {
  const platform = (globalThis as { process?: { platform?: string } }).process
    ?.platform;
  if (platform === "win32") {
    return /^[A-Za-z]:[\\/]/.test(socketPath) || socketPath.startsWith("\\\\");
  }
  return socketPath.startsWith("/");
}

function campaignFailureMessage(error: unknown): string {
  return error instanceof CampaignError
    ? safeReportText(`campaign failure (${error.code}): ${error.message}`)
    : "campaign operation failed";
}

// ---------------------------------------------------------------------------
// ctl exit codes and envelope (consumer mirror of bitty-app/src/ctl.rs)
// ---------------------------------------------------------------------------

/** `ctl` envelope schema version (`{"v":1,...}`). */
export const CTL_ENVELOPE_VERSION = 1 as const;

/** Success (ok:true). */
export const EXIT_OK = 0 as const;
/** Generic failure / `usage` after IPC, including `NotFound`. */
export const EXIT_GENERIC = 1 as const;
/** CLI usage error before IPC (no envelope). */
export const EXIT_USAGE = 2 as const;
/** Config error. */
export const EXIT_CONFIG = 3 as const;
/** Protocol/compatibility mismatch. */
export const EXIT_COMPAT = 5 as const;
/** Runtime/transport failure (`Unavailable`, timeout, rate limit). */
export const EXIT_RUNTIME = 6 as const;
/** Permission failure (`ScopeDenied`/`ScopeViolation`, needs elevation). */
export const EXIT_PERM = 7 as const;
/** Conflict (resource busy, not-focused send, alias collision). */
export const EXIT_CONFLICT = 8 as const;

/** Harness-only sentinel for a live command that exceeded its timeout. */
export const EXIT_TIMEOUT = 124 as const;

/** Default live-command timeout, bounded. */
export const DEFAULT_TIMEOUT_MS = 10_000 as const;
/** Default bound on captured live output (guards Debug-dump blowups). */
export const MAX_CAMPAIGN_OUTPUT_BYTES = 4 * 1024 * 1024;
export const MAX_CAMPAIGN_COMMAND_BYTES = 512 as const;
export const MAX_CAMPAIGN_ERROR_CLASS_BYTES = 128 as const;
export const MAX_CAMPAIGN_ERROR_MESSAGE_BYTES = 1024 as const;
export const MAX_CAMPAIGN_STRING_BYTES = 256 * 1024;
export const MAX_CAMPAIGN_ARRAY_ITEMS = 256 as const;
export const MAX_CAMPAIGN_OBJECT_KEYS = 128 as const;
export const MAX_CAMPAIGN_JSON_DEPTH = 16 as const;
export const MAX_CAMPAIGN_JSON_NODES = 4096 as const;
export const MAX_CAMPAIGN_WORKSPACES = 64 as const;
export const MAX_CAMPAIGN_MATRIX_ROWS = 64 as const;
export const MAX_CAMPAIGN_REPORT_RESULTS = 128 as const;
export const MAX_CAMPAIGN_REPORT_EVIDENCE_ITEMS = 16 as const;
export const MAX_CAMPAIGN_REPORT_TEXT_BYTES = 1024 as const;
export const MAX_CAMPAIGN_ARGS = 64 as const;
export const MAX_CAMPAIGN_ARG_BYTES = 4096 as const;
export const MAX_CAMPAIGN_IDENTIFIER_BYTES = 128 as const;
export const MAX_CAMPAIGN_CHILD_ENV_VALUE_BYTES = 4096 as const;

export const CAMPAIGN_CHILD_ENV_ALLOWLIST = [
  "PATH",
  "Path",
  "HOME",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "PATHEXT",
  "COMSPEC",
] as const;

/** Stable exit-code table, keyed by normalized failure class/code. */
export function expectedExitForError(errorClass: string, code: string): number {
  if (
    code === "ScopeDenied" ||
    code === "ScopeViolation" ||
    code === "ForbiddenField" ||
    code === "Denied" ||
    code === "Unauthenticated"
  ) {
    return EXIT_PERM;
  }
  if (code === "Conflict") return EXIT_CONFLICT;
  if (code === "ConfigError" || code === "InvalidConfig") return EXIT_CONFIG;
  if (code === "UnsupportedVersion" || code === "VersionMismatch") {
    return EXIT_COMPAT;
  }
  if (
    code === "FrameTooLarge" ||
    code === "PayloadTooLarge" ||
    code === "PayloadCap" ||
    code === "RateLimited" ||
    code === "Timeout" ||
    code === "Unavailable" ||
    code === "Transport"
  ) {
    return EXIT_RUNTIME;
  }
  switch (errorClass) {
    case "Denied":
      return EXIT_PERM;
    case "Conflict":
      return EXIT_CONFLICT;
    case "ConfigError":
      return EXIT_CONFIG;
    case "VersionMismatch":
      return EXIT_COMPAT;
    case "Unavailable":
      return EXIT_RUNTIME;
    case "NotFound":
      return EXIT_GENERIC;
    case "Error":
      return EXIT_GENERIC;
    default:
      return EXIT_GENERIC;
  }
}

export type CtlErrorEnvelope = {
  class: string;
  code: string;
  message: string;
};

export type CtlSuccessEnvelope = {
  v: typeof CTL_ENVELOPE_VERSION;
  command: string;
  ok: true;
  result: unknown;
};

export type CtlFailureEnvelope = {
  v: typeof CTL_ENVELOPE_VERSION;
  command: string;
  ok: false;
  error: CtlErrorEnvelope;
};

export type CtlEnvelope = CtlSuccessEnvelope | CtlFailureEnvelope;

/** Raised when a `ctl` result is not a valid v1 envelope. */
export class CampaignError extends Error {
  constructor(
    public readonly code:
      | "MalformedEnvelope"
      | "MissingField"
      | "InvalidJson"
      | "EmptyOutput"
      | "OutputTooLarge",
    message: string,
  ) {
    super(message);
    this.name = "CampaignError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function assertBoundedString(
  field: string,
  value: unknown,
  maxBytes: number,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CampaignError(
      "MalformedEnvelope",
      `${field} must be a non-empty string`,
    );
  }
  if (utf8Bytes(value) > maxBytes) {
    throw new CampaignError(
      "OutputTooLarge",
      `${field} exceeds ${maxBytes} bytes`,
    );
  }
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
}

function validateBoundedJsonValue(value: unknown): string[] {
  const problems: string[] = [];
  let nodes = 0;
  const visit = (entry: unknown, depth: number, path: string): void => {
    nodes += 1;
    if (nodes > MAX_CAMPAIGN_JSON_NODES) {
      problems.push(`result exceeds ${MAX_CAMPAIGN_JSON_NODES} values`);
      return;
    }
    if (depth > MAX_CAMPAIGN_JSON_DEPTH) {
      problems.push(`result exceeds depth ${MAX_CAMPAIGN_JSON_DEPTH}`);
      return;
    }
    if (typeof entry === "string") {
      if (utf8Bytes(entry) > MAX_CAMPAIGN_STRING_BYTES) {
        problems.push(
          `result string at ${path} exceeds ${MAX_CAMPAIGN_STRING_BYTES} bytes`,
        );
      }
      return;
    }
    if (Array.isArray(entry)) {
      if (entry.length > MAX_CAMPAIGN_ARRAY_ITEMS) {
        problems.push(
          `result array at ${path} exceeds ${MAX_CAMPAIGN_ARRAY_ITEMS} items`,
        );
        return;
      }
      for (const [index, item] of entry.entries()) {
        visit(item, depth + 1, `${path}[${index}]`);
        if (problems.length >= 8) return;
      }
      return;
    }
    if (isRecord(entry)) {
      const keys = Object.keys(entry);
      if (keys.length > MAX_CAMPAIGN_OBJECT_KEYS) {
        problems.push(
          `result object at ${path} exceeds ${MAX_CAMPAIGN_OBJECT_KEYS} fields`,
        );
        return;
      }
      for (const key of keys) {
        if (utf8Bytes(key) > MAX_CAMPAIGN_IDENTIFIER_BYTES) {
          problems.push(
            `result key at ${path} exceeds ${MAX_CAMPAIGN_IDENTIFIER_BYTES} bytes`,
          );
          continue;
        }
        visit(entry[key], depth + 1, `${path}.${key}`);
        if (problems.length >= 8) return;
      }
      return;
    }
    if (typeof entry === "number" && !Number.isFinite(entry)) {
      problems.push(`result number at ${path} must be finite`);
    }
  };
  visit(value, 0, "result");
  return problems;
}

function unexpectedEnvelopeFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
): string[] {
  const allowSet = new Set(allowed);
  return Object.keys(value)
    .filter((key) => !allowSet.has(key))
    .map((key) => `unexpected field ${JSON.stringify(safeReportText(key))}`);
}

/**
 * Validate the shape of a decoded envelope. Returns a list of human-readable
 * problems (empty when the envelope is well formed). Never throws.
 */
export function validateEnvelopeShape(value: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(value)) return ["envelope is not a JSON object"];
  if (value["v"] !== CTL_ENVELOPE_VERSION) {
    problems.push(`v must be ${CTL_ENVELOPE_VERSION}`);
  }
  const command = value["command"];
  if (typeof command !== "string" || command.length === 0) {
    problems.push("command must be a non-empty string");
  } else {
    if (utf8Bytes(command) > MAX_CAMPAIGN_COMMAND_BYTES) {
      problems.push(`command exceeds ${MAX_CAMPAIGN_COMMAND_BYTES} bytes`);
    }
    if (hasControlCharacters(command)) {
      problems.push("command must not contain control characters");
    }
  }
  if (typeof value["ok"] !== "boolean") {
    problems.push("ok must be boolean");
  } else if (value["ok"] === true) {
    if (!Object.hasOwn(value, "result")) {
      problems.push("result/error branches are exclusive");
    }
    if (Object.hasOwn(value, "error")) {
      problems.push("result/error branches are exclusive");
    }
    problems.push(
      ...unexpectedEnvelopeFields(value, ["v", "command", "ok", "result"]),
    );
    if (Object.hasOwn(value, "result")) {
      problems.push(...validateBoundedJsonValue(value["result"]));
    }
  } else {
    const error = value["error"];
    if (Object.hasOwn(value, "result") || !Object.hasOwn(value, "error")) {
      problems.push("result/error branches are exclusive");
    }
    problems.push(
      ...unexpectedEnvelopeFields(value, ["v", "command", "ok", "error"]),
    );
    if (!isRecord(error)) {
      problems.push("ok:false requires an error object");
    } else {
      problems.push(
        ...unexpectedEnvelopeFields(error, ["class", "code", "message"]),
      );
      const fields = [
        ["class", MAX_CAMPAIGN_ERROR_CLASS_BYTES],
        ["code", MAX_CAMPAIGN_ERROR_CLASS_BYTES],
        ["message", MAX_CAMPAIGN_ERROR_MESSAGE_BYTES],
      ] as const;
      for (const [key, limit] of fields) {
        const entry = error[key];
        if (typeof entry !== "string" || entry.length === 0) {
          problems.push(`error.${key} must be a non-empty string`);
        } else {
          if (utf8Bytes(entry) > limit) {
            problems.push(`error.${key} exceeds ${limit} bytes`);
          }
          if (hasControlCharacters(entry)) {
            problems.push(`error.${key} must not contain control characters`);
          }
          if (redactSensitiveText(entry) !== entry) {
            problems.push(`error.${key} contains sensitive material`);
          }
        }
      }
    }
  }
  return [...new Set(problems)].slice(0, 8).map(safeReportText);
}

/**
 * Reject a ctl stdout envelope that repeats an object key. `JSON.parse` keeps
 * the last occurrence, so a duplicate key lets a hostile target show one value
 * to the operator and hand a different one to every later consumer.
 * Single-line JSONL only: `parseCtlEnvelopeShape` rejects embedded newlines
 * before this runs.
 */
function assertCtlEnvelopeUniqueKeys(raw: string): void {
  const stack: Array<
    { kind: "object"; keys: Set<string> } | { kind: "array" }
  > = [];
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === "{") {
      stack.push({ kind: "object", keys: new Set<string>() });
      continue;
    }
    if (character === "[") {
      stack.push({ kind: "array" });
      continue;
    }
    if (character === "}" || character === "]") {
      const expected = character === "}" ? "object" : "array";
      const current = stack.pop();
      if (current?.kind !== expected) {
        throw new SyntaxError("JSON contains mismatched structure");
      }
      continue;
    }
    if (character !== '"') continue;
    let end = index + 1;
    let escaped = false;
    for (; end < raw.length; end += 1) {
      const code = raw.charCodeAt(end);
      if (escaped) {
        escaped = false;
        continue;
      }
      if (raw[end] === "\\") {
        escaped = true;
        continue;
      }
      if (raw[end] === '"') break;
      if (code < 0x20) {
        throw new SyntaxError("JSON string contains a control character");
      }
    }
    if (end >= raw.length) {
      throw new SyntaxError("JSON contains an unterminated string");
    }
    const current = stack.at(-1);
    if (current?.kind === "object") {
      let next = end + 1;
      while (next < raw.length && /\s/u.test(raw[next] ?? "")) next += 1;
      if (raw[next] === ":") {
        const parsedKey: unknown = JSON.parse(raw.slice(index, end + 1));
        if (typeof parsedKey !== "string") {
          throw new SyntaxError("JSON object key is not a string");
        }
        if (current.keys.has(parsedKey)) {
          throw new SyntaxError("JSON contains a duplicate object key");
        }
        current.keys.add(parsedKey);
      }
    }
    index = end;
  }
  if (stack.length > 0) {
    throw new SyntaxError("JSON contains unclosed structure");
  }
}

function parseCtlEnvelopeShape(stdout: string): CtlEnvelope {
  if (utf8Bytes(stdout) > MAX_CAMPAIGN_OUTPUT_BYTES) {
    throw new CampaignError(
      "OutputTooLarge",
      `ctl stdout exceeds ${MAX_CAMPAIGN_OUTPUT_BYTES} bytes`,
    );
  }
  let line = stdout;
  if (line.endsWith("\r\n")) line = line.slice(0, -2);
  else if (line.endsWith("\n")) line = line.slice(0, -1);
  if (line.trim().length === 0) {
    throw new CampaignError("EmptyOutput", "ctl produced no stdout envelope");
  }
  if (line.includes("\n") || line.includes("\r")) {
    throw new CampaignError(
      "MalformedEnvelope",
      "ctl stdout must contain exactly one JSONL record",
    );
  }
  let parsed: unknown;
  try {
    assertCtlEnvelopeUniqueKeys(line);
    parsed = JSON.parse(line);
  } catch {
    throw new CampaignError("InvalidJson", "ctl stdout is not valid JSON");
  }
  const problems = validateEnvelopeShape(parsed);
  if (problems.length > 0) {
    throw new CampaignError(
      "MalformedEnvelope",
      safeReportText(`invalid ctl envelope: ${problems.join("; ")}`),
    );
  }
  return parsed as CtlEnvelope;
}

/** Parse a v1 `ctl` envelope from CLI stdout; throws {@link CampaignError}. */
export function parseCtlEnvelope(stdout: string): CtlEnvelope {
  const envelope = parseCtlEnvelopeShape(stdout);
  if (envelope.ok) {
    if (!envelope.command.startsWith("core.")) {
      throw new CampaignError(
        "MalformedEnvelope",
        "ctl command does not name a known registry verb",
      );
    }
    assertCtlResultProjection(envelope.command.slice(5), envelope);
  }
  return envelope;
}

/** Result of one `ctl` invocation (bounded, observation-only). */
export type CtlResult = {
  argv: readonly string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

function assertBoundedCtlResult(result: CtlResult): void {
  if (
    !Number.isSafeInteger(result.exitCode) ||
    typeof result.timedOut !== "boolean" ||
    !Array.isArray(result.argv) ||
    result.argv.length > MAX_CAMPAIGN_ARGS
  ) {
    throw new CampaignError(
      "MalformedEnvelope",
      "ctl result metadata is invalid",
    );
  }
  for (const argument of result.argv) {
    assertBoundedProcessToken(argument, "ctl result argv");
  }
  for (const [field, value] of [
    ["stdout", result.stdout],
    ["stderr", result.stderr],
  ] as const) {
    if (typeof value !== "string") {
      throw new CampaignError(
        "MalformedEnvelope",
        `ctl ${field} must be a string`,
      );
    }
    if (utf8Bytes(value) > MAX_CAMPAIGN_OUTPUT_BYTES) {
      throw new CampaignError(
        "OutputTooLarge",
        `ctl ${field} exceeds ${MAX_CAMPAIGN_OUTPUT_BYTES} bytes`,
      );
    }
  }
}

/** One `ctl` invocation to dispatch. */
export type CtlInvocation = {
  /** Stable verb label, e.g. `workspace.list`. */
  verb: string;
  /** CLI tokens after the program, e.g. `["workspace","list","--format","json"]`. */
  args: readonly string[];
  /**
   * Whether the invocation requests server-side elevation. The process
   * dispatcher forwards this as the `BITTY_CTL_ELEVATE` scope allowlist; it is
   * a pre-grant hint, not a client-side authority flag. The server evaluates
   * the announced scopes against its own allowlist and remains the authority.
   */
  elevated: boolean;
};

/**
 * The DevTools dispatch seam. A live implementation shells out to the real
 * `bitty ctl` client; tests inject a scripted implementation. Keeping the
 * interface this small keeps every probe headless-testable.
 */
export interface CtlDispatcher {
  dispatch(invocation: CtlInvocation): Promise<CtlResult>;
  attestSocketTarget?(absoluteSocketPath: string): boolean;
}

/** A synchronous or asynchronous dispatch handler. */
export type CtlDispatchHandler = (
  invocation: CtlInvocation,
) => CtlResult | Promise<CtlResult>;

/** Headless dispatcher that returns canned results from a handler. */
export class ScriptedCtlDispatcher implements CtlDispatcher {
  private readonly calls: CtlInvocation[] = [];
  constructor(private readonly handler: CtlDispatchHandler) {}

  async dispatch(invocation: CtlInvocation): Promise<CtlResult> {
    this.calls.push(invocation);
    return this.handler(invocation);
  }

  /** Invocations seen so far (for assertions). */
  seen(): readonly CtlInvocation[] {
    return this.calls;
  }
}

/** Build a success {@link CtlResult} with a v1 envelope. */
export function makeOkResult(
  command: string,
  result: unknown,
  argv: readonly string[] = [command],
): CtlResult {
  return {
    argv,
    exitCode: EXIT_OK,
    stdout: JSON.stringify({
      v: CTL_ENVELOPE_VERSION,
      command,
      ok: true,
      result,
    }),
    stderr: "",
    timedOut: false,
  };
}

/** Build a failure {@link CtlResult} with a v1 envelope. */
export function makeErrorResult(
  command: string,
  error: CtlErrorEnvelope,
  exitCode: number,
  argv: readonly string[] = [command],
): CtlResult {
  return {
    argv,
    exitCode,
    stdout: JSON.stringify({
      v: CTL_ENVELOPE_VERSION,
      command,
      ok: false,
      error,
    }),
    stderr: "",
    timedOut: false,
  };
}

/** Build a pre-IPC usage failure (stderr only, exit 2, no envelope). */
export function makeUsageResult(
  argv: readonly string[] = [],
  stderr = "usage: bitty ctl <verb>",
): CtlResult {
  return { argv, exitCode: EXIT_USAGE, stdout: "", stderr, timedOut: false };
}

// ---------------------------------------------------------------------------
// Live process dispatcher (opt-in; never used by headless tests)
// ---------------------------------------------------------------------------

/** Low-level spawn signature, injectable for tests/tooling. */
export type SpawnSyncFn = (
  program: string,
  args: readonly string[],
  options: {
    timeoutMs: number;
    /** Allowlisted environment overlay applied to the minimal child environment. */
    env: Record<string, string | undefined>;
    cwd?: string;
  },
) => CtlResult;

/** Default server-side scope allowlist; each verb announces only its mapped scope. */
export const DEFAULT_ELEVATION_SCOPES = "terminal.manage,config.modify";

const ELEVATION_SCOPE_BY_VERB: Readonly<Record<string, string>> = {
  "terminal.spawn": "terminal.manage",
  "terminal.close": "terminal.manage",
  "workspace.close": "terminal.manage",
  "config.reload": "config.modify",
};

const SUPPORTED_ELEVATION_SCOPES = new Set([
  "terminal.manage",
  "config.modify",
]);

function parseElevationScopes(raw: string): ReadonlySet<string> {
  const entries = raw.split(",");
  if (entries.length === 0 || entries.length > 8) {
    throw new CampaignError(
      "MalformedEnvelope",
      "elevation scope list is empty or too large",
    );
  }
  const scopes = new Set<string>();
  for (const entry of entries) {
    if (!SUPPORTED_ELEVATION_SCOPES.has(entry)) {
      throw new CampaignError(
        "MalformedEnvelope",
        "elevation scope list contains an unsupported scope",
      );
    }
    scopes.add(entry);
  }
  return scopes;
}

export type ProcessDispatcherConfig = {
  /** Program to execute; defaults to `bitty`. */
  program?: string;
  /** Base arguments before the verb; defaults to `["ctl"]`. */
  baseArgs?: readonly string[];
  /** Explicit `--socket` path; omitted for instance discovery. */
  socketPath?: string;
  /** Command timeout in milliseconds. */
  timeoutMs?: number;
  /** Allowlisted environment overrides (e.g. `XDG_RUNTIME_DIR`). */
  env?: Record<string, string>;
  /** Comma-separated upper bound for per-verb `BITTY_CTL_ELEVATE` scopes. */
  elevationScopes?: string;
  /** Working directory. */
  cwd?: string;
};

type BunSpawnResult = {
  exitCode: number | null;
  stdout?: { byteLength?: number; toString(): string } | null;
  stderr?: { byteLength?: number; toString(): string } | null;
  signalCode?: string | null;
  success?: boolean;
};

type BunSpawnSync = (options: {
  cmd: string[];
  stdout?: "pipe";
  stderr?: "pipe";
  env?: Record<string, string | undefined>;
  cwd?: string;
  timeout?: number;
  maxBuffer?: number;
}) => BunSpawnResult;

/** Resolve the runtime `Bun.spawnSync` without taking a compile-time node dep. */
function resolveBunSpawnSync(): BunSpawnSync | null {
  const bun = (globalThis as { Bun?: { spawnSync?: BunSpawnSync } }).Bun;
  return bun?.spawnSync ?? null;
}

/** Resolve the host environment from the Bun runtime, without a node types dep. */
function resolveHostEnv(): Record<string, string | undefined> {
  const bun = (
    globalThis as { Bun?: { env?: Record<string, string | undefined> } }
  ).Bun;
  return bun?.env ?? {};
}

function boundedEnvironmentValue(key: string, value: string): string {
  if (
    utf8Bytes(value) > MAX_CAMPAIGN_CHILD_ENV_VALUE_BYTES ||
    hasControlCharacters(value)
  ) {
    throw new CampaignError(
      "MalformedEnvelope",
      `child environment value for ${key} is invalid`,
    );
  }
  return value;
}

export function buildCampaignChildEnvironment(
  hostEnv: Readonly<Record<string, string | undefined>>,
  requestedEnv: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const key of CAMPAIGN_CHILD_ENV_ALLOWLIST) {
    const requested = Object.hasOwn(requestedEnv, key);
    const value = requested ? requestedEnv[key] : hostEnv[key];
    if (value !== undefined) env[key] = boundedEnvironmentValue(key, value);
  }
  if (
    Object.hasOwn(requestedEnv, "BITTY_CTL_ELEVATE") &&
    requestedEnv["BITTY_CTL_ELEVATE"] !== undefined
  ) {
    const elevation = requestedEnv["BITTY_CTL_ELEVATE"];
    if (elevation !== "terminal.manage" && elevation !== "config.modify") {
      throw new CampaignError(
        "MalformedEnvelope",
        "child elevation must name exactly one supported scope",
      );
    }
    env["BITTY_CTL_ELEVATE"] = boundedEnvironmentValue(
      "BITTY_CTL_ELEVATE",
      elevation,
    );
  }
  return env;
}

function boundedSpawnOutput(
  output: { byteLength?: number; toString(): string } | null | undefined,
  field: string,
): string {
  if (output == null) return "";
  if (
    output.byteLength !== undefined &&
    output.byteLength > MAX_CAMPAIGN_OUTPUT_BYTES
  ) {
    throw new CampaignError(
      "OutputTooLarge",
      `ctl ${field} exceeds ${MAX_CAMPAIGN_OUTPUT_BYTES} bytes`,
    );
  }
  const value = output.toString();
  if (utf8Bytes(value) > MAX_CAMPAIGN_OUTPUT_BYTES) {
    throw new CampaignError(
      "OutputTooLarge",
      `ctl ${field} exceeds ${MAX_CAMPAIGN_OUTPUT_BYTES} bytes`,
    );
  }
  return value;
}

/**
 * Default live spawn over the runtime's `Bun.spawnSync`, with a hard timeout
 * and bounded capture. No node builtin types are required, so the harness
 * type-checks under the repository's committed dependency pins.
 */
function defaultSpawnSync(
  program: string,
  args: readonly string[],
  options: {
    timeoutMs: number;
    env: Record<string, string | undefined>;
    cwd?: string;
  },
): CtlResult {
  const spawn = resolveBunSpawnSync();
  if (spawn === null) {
    throw new CampaignError(
      "EmptyOutput",
      "no Bun runtime available for the live dispatcher; pass an explicit spawn implementation",
    );
  }
  const res = spawn({
    cmd: [program, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: buildCampaignChildEnvironment(resolveHostEnv(), options.env),
    cwd: options.cwd,
    timeout: options.timeoutMs,
    maxBuffer: MAX_CAMPAIGN_OUTPUT_BYTES,
  });
  const timedOut = res.exitCode === null && res.signalCode === "SIGTERM";
  return {
    argv: [program, ...args],
    exitCode: timedOut ? EXIT_TIMEOUT : (res.exitCode ?? EXIT_GENERIC),
    stdout: boundedSpawnOutput(res.stdout, "stdout"),
    stderr: boundedSpawnOutput(res.stderr, "stderr"),
    timedOut,
  };
}

function assertBoundedProcessToken(value: string, field: string): void {
  if (
    value.length === 0 ||
    utf8Bytes(value) > MAX_CAMPAIGN_ARG_BYTES ||
    hasControlCharacters(value)
  ) {
    throw new CampaignError(
      "MalformedEnvelope",
      `${field} is empty, oversized, or contains control characters`,
    );
  }
}

function assertBoundedInvocation(invocation: CtlInvocation): void {
  assertBoundedProcessToken(invocation.verb, "ctl verb");
  if (invocation.args.length > MAX_CAMPAIGN_ARGS) {
    throw new CampaignError(
      "MalformedEnvelope",
      `ctl argv exceeds ${MAX_CAMPAIGN_ARGS} arguments`,
    );
  }
  for (const argument of invocation.args) {
    assertBoundedProcessToken(argument, "ctl argument");
  }
}

/**
 * Live dispatcher that executes the real `bitty ctl` client. Construct it with
 * an explicit socket and timeout; call it only from an opt-in live entry point.
 */
export class ProcessCtlDispatcher implements CtlDispatcher {
  private readonly program: string;
  private readonly baseArgs: readonly string[];
  private readonly socketPath: string | undefined;
  private readonly timeoutMs: number;
  private readonly env: Record<string, string | undefined>;
  private readonly elevationScopes: ReadonlySet<string>;
  private readonly cwd: string | undefined;
  private readonly spawn: SpawnSyncFn;

  constructor(
    config: ProcessDispatcherConfig = {},
    spawn: SpawnSyncFn = defaultSpawnSync,
  ) {
    this.program = config.program ?? "bitty";
    this.baseArgs = [...(config.baseArgs ?? ["ctl"])];
    this.socketPath = config.socketPath;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.env = buildCampaignChildEnvironment(
      {},
      { ...(config.env ?? {}), BITTY_CTL_ELEVATE: undefined },
    );
    this.elevationScopes = parseElevationScopes(
      config.elevationScopes ?? DEFAULT_ELEVATION_SCOPES,
    );
    this.cwd = config.cwd;
    assertBoundedProcessToken(this.program, "ctl program");
    if (this.baseArgs.length > MAX_CAMPAIGN_ARGS) {
      throw new CampaignError(
        "MalformedEnvelope",
        `ctl base argv exceeds ${MAX_CAMPAIGN_ARGS} arguments`,
      );
    }
    for (const argument of this.baseArgs) {
      assertBoundedProcessToken(argument, "ctl base argument");
    }
    if (this.socketPath !== undefined) {
      assertBoundedProcessToken(this.socketPath, "ctl socket path");
    }
    if (this.cwd !== undefined) {
      assertBoundedProcessToken(this.cwd, "ctl working directory");
    }
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new CampaignError(
        "MalformedEnvelope",
        "ctl timeout must be a positive safe integer",
      );
    }
    this.spawn = spawn;
  }

  attestSocketTarget(absoluteSocketPath: string): boolean {
    return (
      isAbsoluteSocketPath(absoluteSocketPath) &&
      this.socketPath === absoluteSocketPath
    );
  }

  async dispatch(invocation: CtlInvocation): Promise<CtlResult> {
    assertBoundedInvocation(invocation);
    const args = [...this.baseArgs];
    if (this.socketPath !== undefined) {
      args.push("--socket", this.socketPath);
    }
    args.push(...invocation.args);
    if (args.length > MAX_CAMPAIGN_ARGS) {
      throw new CampaignError(
        "MalformedEnvelope",
        `ctl argv exceeds ${MAX_CAMPAIGN_ARGS} arguments`,
      );
    }
    const env: Record<string, string | undefined> = { ...this.env };
    if (invocation.elevated) {
      const required = ELEVATION_SCOPE_BY_VERB[invocation.verb];
      if (required === undefined) {
        throw new CampaignError(
          "MalformedEnvelope",
          "elevated ctl verb has no per-verb scope mapping",
        );
      }
      if (!this.elevationScopes.has(required)) {
        throw new CampaignError(
          "MalformedEnvelope",
          "elevated ctl verb is outside the configured scope allowlist",
        );
      }
      env["BITTY_CTL_ELEVATE"] = required;
    } else {
      env["BITTY_CTL_ELEVATE"] = undefined;
    }
    return this.spawn(this.program, args, {
      timeoutMs: this.timeoutMs,
      env,
      cwd: this.cwd,
    });
  }
}

// ---------------------------------------------------------------------------
// Probe 1: per-verb envelope + exit-code conformance
// ---------------------------------------------------------------------------

export type ExpectedOutcome =
  "ok" | "denied" | "conflict" | "unavailable" | "usage" | "notfound";

const OUTCOME_EXIT: Record<ExpectedOutcome, number> = {
  ok: EXIT_OK,
  denied: EXIT_PERM,
  conflict: EXIT_CONFLICT,
  unavailable: EXIT_RUNTIME,
  usage: EXIT_USAGE,
  notfound: EXIT_GENERIC,
};

const OUTCOME_ERROR: Partial<
  Record<ExpectedOutcome, { class: string; code: string }>
> = {
  denied: { class: "Denied", code: "ScopeDenied" },
  conflict: { class: "Conflict", code: "Conflict" },
  unavailable: { class: "Unavailable", code: "Transport" },
  notfound: { class: "NotFound", code: "NotFound" },
};

export type VerbExpectation = {
  /** Stable label, e.g. `workspace.close`. */
  verb: string;
  /** CLI tokens after `ctl`, with `--format json` last. */
  args: readonly string[];
  /** Deterministic outcome for this verb in the campaign. */
  outcome: ExpectedOutcome;
  /** Whether the verb requires `BITTY_CTL_ELEVATE` authority. */
  elevated: boolean;
  note: string;
  /**
   * Whether the row injects keystrokes into a live terminal. Keystroke rows
   * are excluded from the default matrix (see {@link CTL_VERB_MATRIX}) and
   * only run when {@link keystrokeProbeOptIn} approves an explicit target.
   */
  keystroke?: boolean;
};

/** Canonical keystroke-injection verb label. */
export const KEYSTROKE_PROBE_VERB = "terminal.send" as const;

/** Explicit-opt-in swallow for the keystroke-injection probe target. */
export type KeystrokeProbeTarget = {
  /** Terminal id to probe, e.g. `t:42`. Must not be the default `t:1`. */
  terminalId: string;
  /**
   * Explicit opt-in marker: the caller must deliberately enable live
   * keystroke injection (spreading `BITTY_CAMPAIGN_PROBE` text is never
   * implied by constructing the config).
   */
  allowLiveKeystrokes: boolean;
};

/** Canonical keystroke-injection payload (kept in one place for tests). */
export const KEYSTROKE_PROBE_PAYLOAD = "echo BITTY_CAMPAIGN_PROBE" as const;

const TERMINAL_ID_RE = /^t:\d+$/;
const VIEW_ID_RE = /^v:\d+$/;

/**
 * Validate an explicit keystroke-probe target. Fails closed unless the caller
 * passes `allowLiveKeystrokes: true` AND a syntactically valid, non-default
 * terminal id. The bare default `t:1` is always rejected: a live probe must
 * name a scratch terminal, never whatever happens to be `t:1`.
 */
export function assertKeystrokeProbeTarget(target: KeystrokeProbeTarget): void {
  if (target.allowLiveKeystrokes !== true) {
    throw new CampaignError(
      "MissingField",
      "keystroke probe requires explicit allowLiveKeystrokes: true (never enabled by default)",
    );
  }
  if (
    typeof target.terminalId !== "string" ||
    !TERMINAL_ID_RE.test(target.terminalId)
  ) {
    throw new CampaignError(
      "MissingField",
      "keystroke probe terminal id is invalid",
    );
  }
  if (target.terminalId === "t:1") {
    throw new CampaignError(
      "MissingField",
      "keystroke probe refuses the default t:1 socket (name an explicit scratch terminal)",
    );
  }
}

/**
 * Opt-in gate for the keystroke-injection probe. Returns true only when the
 * caller explicitly opts in with `allowLiveKeystrokes: true` and a valid,
 * non-default terminal id. Never throws; use
 * {@link assertKeystrokeProbeTarget} for the diagnostic form.
 */
export function keystrokeProbeOptIn(
  target: KeystrokeProbeTarget | undefined,
): target is KeystrokeProbeTarget {
  if (target === undefined) return false;
  try {
    assertKeystrokeProbeTarget(target);
    return true;
  } catch {
    return false;
  }
}

/** Build the keystroke-injection row for an approved explicit target. */
export function keystrokeProbeExpectation(
  target: KeystrokeProbeTarget,
): VerbExpectation {
  assertKeystrokeProbeTarget(target);
  return {
    verb: KEYSTROKE_PROBE_VERB,
    args: [
      "terminal",
      "send",
      target.terminalId,
      KEYSTROKE_PROBE_PAYLOAD,
      "--format",
      "json",
    ],
    outcome: "ok",
    elevated: false,
    note: "terminal.input, explicit scratch target only",
    keystroke: true,
  };
}

/** True when the row would inject keystrokes into a live terminal. */
export function isKeystrokeProbeRow(row: VerbExpectation): boolean {
  return row.keystroke === true || row.verb === KEYSTROKE_PROBE_VERB;
}

/**
 * The CTX-0320 campaign `ctl` verb matrix. Outcomes are deterministic for the
 * baseline live instance (empty or single-window); denied rows assert the
 * fail-closed elevation policy and no partial state. The matrix is
 * keystroke-free by default: the legacy `terminal.send` keystroke-injection
 * probe (H-DEV-04) is NOT a matrix row. It only runs when the caller passes an
 * explicit opt-in target (see {@link keystrokeProbeExpectation} and the
 * `keystrokeTarget` option), so a default or headless run never types into
 * whatever terminal happens to be `t:1`. Mutating rows (`view.split`,
 * `workspace.new`) remain, so a live run must still target a scratch
 * instance. `workspace.close` and the currently-unfocused `terminal.send`
 * conflict case are environment-dependent and are exercised by the dedicated
 * round-trip/spawn probes instead.
 */
export const CTL_VERB_MATRIX: readonly VerbExpectation[] = [
  {
    verb: "instance.list",
    args: ["instance", "list", "--format", "json"],
    outcome: "ok",
    elevated: false,
    note: "no live instance needed",
  },
  {
    verb: "window.list",
    args: ["window", "list", "--format", "json"],
    outcome: "ok",
    elevated: false,
    note: "read-only inspect",
  },
  {
    verb: "view.list",
    args: ["view", "list", "--format", "json"],
    outcome: "ok",
    elevated: false,
    note: "read-only inspect",
  },
  {
    verb: "terminal.list",
    args: ["terminal", "list", "--format", "json"],
    outcome: "ok",
    elevated: false,
    note: "read-only inspect",
  },
  {
    verb: "terminal.text",
    args: ["terminal", "text", "t:1", "--format", "json"],
    outcome: "ok",
    elevated: false,
    note: "read-only inspect; shape guarded separately",
  },
  {
    verb: "workspace.list",
    args: ["workspace", "list", "--format", "json"],
    outcome: "ok",
    elevated: false,
    note: "read-only inspect",
  },
  {
    verb: "workspace.new",
    args: ["workspace", "new", "--format", "json"],
    outcome: "ok",
    elevated: false,
    note: "view.manage, mutates",
  },
  {
    verb: "workspace.focus",
    args: ["workspace", "focus", "ws:1", "--format", "json"],
    outcome: "ok",
    elevated: false,
    note: "view.manage",
  },
  {
    verb: "view.split",
    args: ["view", "split", "--right", "--format", "json"],
    outcome: "ok",
    elevated: false,
    note: "view.manage, no elevation",
  },
  {
    verb: "view.focus",
    args: ["view", "focus", "v:1", "--format", "json"],
    outcome: "ok",
    elevated: false,
    note: "view.manage, no elevation",
  },
  {
    verb: "terminal.spawn",
    args: ["terminal", "spawn", "--format", "json"],
    outcome: "denied",
    elevated: false,
    note: "terminal.manage requires elevation",
  },
  {
    verb: "terminal.close",
    args: ["terminal", "close", "t:1", "--format", "json"],
    outcome: "denied",
    elevated: false,
    note: "terminal.manage requires elevation",
  },
  {
    verb: "workspace.close",
    args: ["workspace", "close", "ws:1", "--format", "json"],
    outcome: "denied",
    elevated: false,
    note: "terminal.manage requires elevation",
  },
  {
    verb: "config.reload",
    args: ["config", "reload", "--format", "json"],
    outcome: "denied",
    elevated: false,
    note: "config.modify requires elevation",
  },
  {
    verb: "frobnicate.list",
    args: ["frobnicate", "list"],
    outcome: "usage",
    elevated: false,
    note: "unknown verb: usage before IPC",
  },
];

/**
 * Environment-dependent example: `view list` against no live instance must fail
 * closed with `Unavailable`/exit 6. Kept out of {@link CTL_VERB_MATRIX} because
 * it contradicts the live `view.list` success row; inject it explicitly when
 * probing a no-instance environment.
 */
export const NO_INSTANCE_VIEW_LIST: readonly VerbExpectation[] = [
  {
    verb: "view.list.no-instance",
    args: ["view", "list", "--format", "json"],
    outcome: "unavailable",
    elevated: false,
    note: "no instance: fail closed",
  },
];

/** A single probe outcome. */
export type ProbeStatus = "pass" | "fail" | "skip";

export type ProbeResult = {
  name: string;
  status: ProbeStatus;
  detail: string;
  evidence: readonly string[];
};

function safeReportText(value: string): string {
  const redacted = redactSensitiveText(value);
  const sanitized = sanitizeTerminalOutput(
    redacted,
    MAX_CAMPAIGN_REPORT_TEXT_BYTES,
  );
  if (
    new TextEncoder().encode(sanitized).length <
    new TextEncoder().encode(redacted).length
  ) {
    const suffix = "...[truncated]";
    const prefixLimit = Math.max(
      0,
      MAX_CAMPAIGN_REPORT_TEXT_BYTES - new TextEncoder().encode(suffix).length,
    );
    return `${truncateToBytes(sanitized, prefixLimit)}${suffix}`;
  }
  return sanitized;
}

function normalizeProbeResult(result: ProbeResult): ProbeResult {
  const status: ProbeStatus =
    result.status === "pass" || result.status === "skip"
      ? result.status
      : "fail";
  return {
    name: safeReportText(result.name),
    status,
    detail: safeReportText(result.detail),
    evidence: result.evidence
      .slice(0, MAX_CAMPAIGN_REPORT_EVIDENCE_ITEMS)
      .map(safeReportText),
  };
}

function pass(
  name: string,
  detail: string,
  evidence: readonly string[] = [],
): ProbeResult {
  return normalizeProbeResult({ name, status: "pass", detail, evidence });
}

function fail(
  name: string,
  detail: string,
  evidence: readonly string[] = [],
): ProbeResult {
  return normalizeProbeResult({ name, status: "fail", detail, evidence });
}

function skip(
  name: string,
  detail: string,
  evidence: readonly string[] = [],
): ProbeResult {
  return normalizeProbeResult({ name, status: "skip", detail, evidence });
}

function expectedErrorFor(
  outcome: ExpectedOutcome,
): { class: string; code: string } | undefined {
  return OUTCOME_ERROR[outcome];
}

function assertBoundedVerbExpectation(
  value: unknown,
): asserts value is VerbExpectation {
  if (!isRecord(value)) {
    throw new CampaignError(
      "MalformedEnvelope",
      "campaign matrix row is invalid",
    );
  }
  const allowed = new Set([
    "verb",
    "args",
    "outcome",
    "elevated",
    "note",
    "keystroke",
  ]);
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    typeof value["verb"] !== "string" ||
    value["verb"].length === 0 ||
    utf8Bytes(value["verb"]) > MAX_CAMPAIGN_IDENTIFIER_BYTES ||
    hasControlCharacters(value["verb"]) ||
    typeof value["elevated"] !== "boolean" ||
    !Array.isArray(value["args"]) ||
    value["args"].length > MAX_CAMPAIGN_ARGS ||
    !["ok", "denied", "conflict", "unavailable", "notfound", "usage"].includes(
      value["outcome"] as string,
    ) ||
    typeof value["note"] !== "string" ||
    utf8Bytes(value["note"]) > MAX_CAMPAIGN_REPORT_TEXT_BYTES ||
    hasControlCharacters(value["note"]) ||
    (value["keystroke"] !== undefined &&
      typeof value["keystroke"] !== "boolean")
  ) {
    throw new CampaignError(
      "MalformedEnvelope",
      "campaign matrix row is invalid",
    );
  }
  for (const argument of value["args"]) {
    if (typeof argument !== "string") {
      throw new CampaignError(
        "MalformedEnvelope",
        "campaign matrix argument is invalid",
      );
    }
    assertBoundedProcessToken(argument, "campaign matrix argument");
  }
}

function campaignMatrixProblem(matrix: unknown): string | undefined {
  if (!Array.isArray(matrix)) return "campaign matrix is invalid";
  if (matrix.length > MAX_CAMPAIGN_MATRIX_ROWS) {
    return `campaign matrix exceeds ${MAX_CAMPAIGN_MATRIX_ROWS} rows`;
  }
  try {
    for (const row of matrix) assertBoundedVerbExpectation(row);
    return undefined;
  } catch (error) {
    return campaignFailureMessage(error);
  }
}

/**
 * Probe one expectation against the dispatcher and return per-verb results.
 * A `usage` row asserts exit 2 with a stderr diagnostic and no envelope; all
 * other rows assert a v1 envelope whose class/code and exit code agree.
 *
 * Keystroke-injection rows are refused fail-closed unless the caller approves
 * them with an explicit opt-in target (see {@link keystrokeProbeOptIn}): a
 * matrix that smuggles a `terminal.send` row (or the bare
 * `terminal.send` verb) dispatches nothing and records a `fail` instead of
 * typing into a live terminal.
 */
export async function probeEnvelopeConformance(
  dispatcher: CtlDispatcher,
  matrix: readonly VerbExpectation[] = CTL_VERB_MATRIX,
  opts: { keystrokeTarget?: KeystrokeProbeTarget } = {},
): Promise<ProbeResult[]> {
  const matrixProblem = campaignMatrixProblem(matrix);
  if (matrixProblem !== undefined) {
    return [fail(campaignMatrixFailureName(matrix), matrixProblem)];
  }
  const results: ProbeResult[] = [];
  const allowKeystrokes = keystrokeProbeOptIn(opts.keystrokeTarget);
  for (const expectation of matrix) {
    const name = `envelope:${expectation.verb}`;
    if (isKeystrokeProbeRow(expectation) && !allowKeystrokes) {
      results.push(
        fail(
          name,
          "keystroke probe refused: pass an explicit keystrokeTarget with allowLiveKeystrokes:true and a non-default terminal id",
        ),
      );
      continue;
    }
    let result: CtlResult;
    try {
      result = await dispatcher.dispatch({
        verb: expectation.verb,
        args: expectation.args,
        elevated: expectation.elevated,
      });
      assertBoundedCtlResult(result);
    } catch (error) {
      results.push(fail(name, campaignFailureMessage(error)));
      continue;
    }
    const evidence = [`exit=${result.exitCode}`];
    if (result.timedOut) {
      results.push(fail(name, "command timed out", evidence));
      continue;
    }
    const expectedExit = OUTCOME_EXIT[expectation.outcome];
    if (expectation.outcome === "usage") {
      if (result.exitCode !== expectedExit) {
        results.push(
          fail(
            name,
            `expected usage exit ${expectedExit}, got ${result.exitCode}`,
            evidence,
          ),
        );
      } else if (result.stderr.trim().length === 0) {
        results.push(
          fail(name, "usage failure produced no stderr diagnostic", evidence),
        );
      } else {
        results.push(pass(name, "usage exit 2 with diagnostic, no envelope"));
      }
      continue;
    }
    let envelope: CtlEnvelope;
    try {
      envelope = parseCtlEnvelope(result.stdout);
    } catch (error) {
      results.push(fail(name, campaignFailureMessage(error), evidence));
      continue;
    }
    if (
      envelope.command !== `core.${canonicalProjectionVerb(expectation.verb)}`
    ) {
      results.push(
        fail(name, "envelope command did not match the verb", evidence),
      );
      continue;
    }
    if (envelope.ok) {
      try {
        assertCtlResultProjection(expectation.verb, envelope);
      } catch (error) {
        results.push(fail(name, campaignFailureMessage(error), evidence));
        continue;
      }
    }
    evidence.push(`ok=${envelope.ok}`);
    const expectOk = expectation.outcome === "ok";
    if (envelope.ok !== expectOk) {
      results.push(
        fail(
          name,
          `expected ok=${expectOk}, envelope ok=${envelope.ok}`,
          evidence,
        ),
      );
      continue;
    }
    if (!envelope.ok) {
      const expectedError = expectedErrorFor(expectation.outcome);
      if (
        expectedError !== undefined &&
        (envelope.error.class !== expectedError.class ||
          envelope.error.code !== expectedError.code)
      ) {
        results.push(
          fail(name, "error class/code did not match expectation", [
            ...evidence,
            `class=${expectedError.class}`,
            `code=${expectedError.code}`,
          ]),
        );
        continue;
      }
    }
    if (result.exitCode !== expectedExit) {
      results.push(
        fail(
          name,
          `expected exit ${expectedExit}, got ${result.exitCode}`,
          evidence,
        ),
      );
      continue;
    }
    results.push(
      pass(
        name,
        `v1 envelope ${expectation.outcome} exit ${result.exitCode}`,
        evidence,
      ),
    );
  }
  return results;
}

// ---------------------------------------------------------------------------
// Probe 2: workspace id round-trip (D2 guard)
// ---------------------------------------------------------------------------

const WORKSPACE_NAME_RE = /^ws(\d+)$/;
const WORKSPACE_ID_RE = /^ws:(\d+)$/;

/**
 * Validate a workspace identifier before it is spliced into spawned `ctl`
 * argv. Listed ids are untrusted observation data: a hostile `workspace
 * list` response (or a compromised `result.created`) could otherwise smuggle
 * a flag token (e.g. `--socket=/tmp/evil.sock`) into the positional slot,
 * where the `ctl` parser would treat it as a flag. Fail closed on any id
 * that is neither the canonical `ws:<digits>` form nor the bare `ws<digits>`
 * alias the round-trip probe accepts.
 */
export function assertSafeWorkspaceId(identifier: string): void {
  if (WORKSPACE_ID_RE.test(identifier) || WORKSPACE_NAME_RE.test(identifier)) {
    return;
  }
  throw new CampaignError("MissingField", "workspace identifier is invalid");
}

function canonicalWorkspaceId(identifier: string): string | undefined {
  const bare = WORKSPACE_NAME_RE.exec(identifier);
  if (bare?.[1] !== undefined) {
    return `ws:${bare[1].replace(/^0+(?=\d)/, "")}`;
  }
  const canonical = WORKSPACE_ID_RE.exec(identifier);
  if (canonical?.[1] !== undefined) {
    return `ws:${canonical[1].replace(/^0+(?=\d)/, "")}`;
  }
  return undefined;
}

function campaignMatrixFailureName(matrix: unknown): string {
  return Array.isArray(matrix) && matrix.length > MAX_CAMPAIGN_MATRIX_ROWS
    ? "campaign:matrix-limit"
    : "campaign:matrix-invalid";
}

/** Candidate verb ids for a listed workspace identifier (`ws4` -> `ws:4`). */
export function workspaceIdCandidates(identifier: string): string[] {
  const candidates = new Set<string>();
  candidates.add(identifier);
  const match = WORKSPACE_NAME_RE.exec(identifier);
  if (match?.[1] !== undefined) {
    candidates.add(`ws:${match[1]}`);
  }
  return [...candidates];
}

/** Read `result.workspaces` (`string[]`) from a workspace-list envelope. */
export function workspaceNamesFrom(envelope: CtlEnvelope): string[] {
  if (!envelope.ok) {
    throw new CampaignError("MissingField", "workspace list returned an error");
  }
  assertCtlResultProjection("workspace.list", envelope);
  const result = envelope.result;
  if (!isRecord(result) || !Array.isArray(result["workspaces"])) {
    throw new CampaignError(
      "MissingField",
      "workspace list result.workspaces missing",
    );
  }
  const workspaces = result["workspaces"];
  if (workspaces.length > MAX_CAMPAIGN_WORKSPACES) {
    throw new CampaignError(
      "OutputTooLarge",
      `workspace list exceeds ${MAX_CAMPAIGN_WORKSPACES} items`,
    );
  }
  const identifiers: string[] = [];
  for (const [index, workspace] of workspaces.entries()) {
    try {
      assertBoundedString(
        "workspace identifier",
        workspace,
        MAX_CAMPAIGN_IDENTIFIER_BYTES,
      );
    } catch {
      throw new CampaignError(
        "MalformedEnvelope",
        `workspace identifier at index ${index} is invalid`,
      );
    }
    identifiers.push(workspace);
  }
  return identifiers;
}

/** Read `result.created` from a workspace-new envelope. */
export function workspaceCreatedFrom(envelope: CtlEnvelope): string {
  if (!envelope.ok) {
    throw new CampaignError("MissingField", "workspace new returned an error");
  }
  assertCtlResultProjection("workspace.new", envelope);
  const result = envelope.result;
  if (!isRecord(result)) {
    throw new CampaignError(
      "MissingField",
      "workspace new result.created missing",
    );
  }
  assertBoundedString(
    "workspace created identifier",
    result["created"],
    MAX_CAMPAIGN_IDENTIFIER_BYTES,
  );
  return result["created"];
}

function projectionObjectProblems(
  value: unknown,
  keys: readonly string[],
): string[] {
  if (!isRecord(value)) return ["result must be an object"];
  const allowed = new Set(keys);
  const problems: string[] = [];
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    problems.push("result has unexpected fields");
  }
  if (keys.some((key) => !Object.hasOwn(value, key))) {
    problems.push("result is missing required fields");
  }
  return problems;
}

function projectionStringProblem(
  value: unknown,
  field: string,
  maxBytes = MAX_CAMPAIGN_STRING_BYTES,
  allowEmpty = false,
): string[] {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    utf8Bytes(value) > maxBytes
  ) {
    return [`result.${field} must be a bounded string`];
  }
  return [];
}

function projectionArrayProblem(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_CAMPAIGN_ARRAY_ITEMS) {
    return [`result.${field} must be a bounded array`];
  }
  return [];
}

function projectionRecordProblem(
  value: unknown,
  keys: readonly string[],
): string[] {
  return projectionObjectProblems(value, keys);
}

function canonicalProjectionVerb(verb: string): string {
  if (verb === "view.list.no-instance") return "view.list";
  if (
    verb === "workspace.list.baseline" ||
    verb === "workspace.list.after-new"
  ) {
    return "workspace.list";
  }
  if (verb === "view.list.before" || verb === "view.list.after") {
    return "view.list";
  }
  if (verb === "terminal.list.before" || verb === "terminal.list.after") {
    return "terminal.list";
  }
  return verb;
}

function ctlResultProjectionProblems(
  verb: string,
  envelope: CtlEnvelope,
): string[] {
  if (!envelope.ok) return [];
  const result = envelope.result;
  const canonicalVerb = canonicalProjectionVerb(verb);
  const problems: string[] = [];
  const requireIdentifier = (
    value: unknown,
    pattern: RegExp,
    field: string,
  ): void => {
    if (typeof value !== "string" || !pattern.test(value)) {
      problems.push(`result.${field} has an invalid identifier`);
    }
  };

  switch (canonicalVerb) {
    case "instance.list": {
      problems.push(...projectionObjectProblems(result, ["instances"]));
      const instances = isRecord(result) ? result["instances"] : undefined;
      problems.push(...projectionArrayProblem(instances, "instances"));
      if (Array.isArray(instances)) {
        const instanceIds = new Set<string>();
        for (const instance of instances) {
          problems.push(
            ...projectionRecordProblem(instance, [
              "instance",
              "socket",
              "live",
            ]),
          );
          if (isRecord(instance)) {
            problems.push(
              ...projectionStringProblem(
                instance["instance"],
                "instance",
                MAX_CAMPAIGN_IDENTIFIER_BYTES,
              ),
              ...projectionStringProblem(instance["socket"], "socket"),
            );
            if (instance["live"] !== true) {
              problems.push("result.instances contains a non-live record");
            }
            if (
              typeof instance["instance"] === "string" &&
              instanceIds.has(instance["instance"])
            ) {
              problems.push("result.instances contains a duplicate id");
            } else if (typeof instance["instance"] === "string") {
              instanceIds.add(instance["instance"]);
            }
          }
        }
      }
      break;
    }
    case "window.list": {
      problems.push(...projectionObjectProblems(result, ["windows"]));
      const windows = isRecord(result) ? result["windows"] : undefined;
      problems.push(...projectionArrayProblem(windows, "windows"));
      if (Array.isArray(windows)) {
        const windowIds = new Set<string>();
        for (const window of windows) {
          problems.push(...projectionRecordProblem(window, ["id"]));
          if (isRecord(window))
            requireIdentifier(window["id"], /^w:\d+$/, "windows.id");
          if (
            isRecord(window) &&
            typeof window["id"] === "string" &&
            windowIds.has(window["id"])
          ) {
            problems.push("result.windows contains a duplicate id");
          } else if (isRecord(window) && typeof window["id"] === "string") {
            windowIds.add(window["id"]);
          }
        }
      }
      break;
    }
    case "view.list":
      try {
        viewsFrom(envelope);
      } catch {
        problems.push("view list projection is invalid");
      }
      break;
    case "terminal.list":
      try {
        terminalsFrom(envelope);
      } catch {
        problems.push("terminal list projection is invalid");
      }
      break;
    case "terminal.text":
      try {
        const text = terminalTextFrom(envelope);
        if (utf8Bytes(text) > MAX_CAMPAIGN_STRING_BYTES) {
          problems.push("terminal text projection is oversized");
        }
      } catch {
        problems.push("terminal text projection is invalid");
      }
      break;
    case "workspace.list": {
      problems.push(
        ...projectionObjectProblems(result, [
          "workspaces",
          "names",
          "active",
          "active_id",
          "count",
          "tabline",
        ]),
      );
      if (isRecord(result)) {
        const workspaces = result["workspaces"];
        const names = result["names"];
        problems.push(
          ...projectionArrayProblem(workspaces, "workspaces"),
          ...projectionArrayProblem(names, "names"),
          ...projectionStringProblem(
            result["tabline"],
            "tabline",
            MAX_CAMPAIGN_STRING_BYTES,
            true,
          ),
        );
        if (Array.isArray(workspaces)) {
          const identifiers = new Set<string>();
          for (const [index, workspace] of workspaces.entries()) {
            problems.push(
              ...projectionStringProblem(
                workspace,
                `workspaces.${index}`,
                MAX_CAMPAIGN_IDENTIFIER_BYTES,
              ),
            );
            if (typeof workspace === "string") {
              try {
                assertSafeWorkspaceId(workspace);
                const canonical = canonicalWorkspaceId(workspace);
                if (canonical === undefined || identifiers.has(canonical)) {
                  problems.push("workspace list projection has an invalid id");
                } else {
                  identifiers.add(canonical);
                }
              } catch {
                problems.push("workspace list projection has an invalid id");
              }
            }
          }
          if (Array.isArray(names)) {
            if (names.length !== workspaces.length) {
              problems.push("workspace names count does not match ids");
            }
            for (const [index, name] of names.entries()) {
              problems.push(
                ...projectionStringProblem(
                  name,
                  `names.${index}`,
                  MAX_CAMPAIGN_STRING_BYTES,
                  true,
                ),
              );
            }
          }
          if (
            !Number.isSafeInteger(result["count"]) ||
            result["count"] !== workspaces.length
          ) {
            problems.push("workspace count does not match ids");
          }
          if (
            !Number.isSafeInteger(result["active"]) ||
            (result["active"] as number) < 1 ||
            (result["active"] as number) > workspaces.length ||
            typeof result["active_id"] !== "string" ||
            canonicalWorkspaceId(result["active_id"]) === undefined ||
            !identifiers.has(canonicalWorkspaceId(result["active_id"]) ?? "")
          ) {
            problems.push("workspace active projection is invalid");
          }
        }
      }
      break;
    }
    case "workspace.new": {
      problems.push(
        ...projectionObjectProblems(result, ["created", "tabline"]),
      );
      if (isRecord(result)) {
        problems.push(
          ...projectionStringProblem(
            result["created"],
            "created",
            MAX_CAMPAIGN_IDENTIFIER_BYTES,
          ),
        );
        problems.push(
          ...projectionStringProblem(
            result["tabline"],
            "tabline",
            MAX_CAMPAIGN_STRING_BYTES,
            true,
          ),
        );
        try {
          assertSafeWorkspaceId(result["created"] as string);
        } catch {
          problems.push("workspace created projection is invalid");
        }
      }
      break;
    }
    case "workspace.focus": {
      problems.push(
        ...projectionObjectProblems(result, ["focused", "tabline"]),
      );
      if (isRecord(result)) {
        problems.push(
          ...projectionStringProblem(
            result["focused"],
            "focused",
            MAX_CAMPAIGN_IDENTIFIER_BYTES,
          ),
        );
        problems.push(
          ...projectionStringProblem(
            result["tabline"],
            "tabline",
            MAX_CAMPAIGN_STRING_BYTES,
            true,
          ),
        );
        try {
          assertSafeWorkspaceId(result["focused"] as string);
        } catch {
          problems.push("workspace focus projection is invalid");
        }
      }
      break;
    }
    case "view.split": {
      problems.push(...projectionObjectProblems(result, ["split", "new_view"]));
      if (isRecord(result)) {
        if (
          !["left", "right", "up", "down"].includes(result["split"] as string)
        ) {
          problems.push("view split direction is invalid");
        }
        requireIdentifier(result["new_view"], VIEW_ID_RE, "new_view");
      }
      break;
    }
    case "view.focus": {
      problems.push(...projectionObjectProblems(result, ["focused"]));
      if (isRecord(result))
        requireIdentifier(result["focused"], VIEW_ID_RE, "focused");
      break;
    }
    case "terminal.spawn":
      try {
        terminalSpawnedFrom(envelope);
      } catch {
        problems.push("terminal spawn projection is invalid");
      }
      break;
    case "terminal.close": {
      problems.push(...projectionObjectProblems(result, ["closed"]));
      if (isRecord(result))
        requireIdentifier(result["closed"], TERMINAL_ID_RE, "closed");
      break;
    }
    case "workspace.close": {
      problems.push(
        ...projectionObjectProblems(result, ["closed", "killed", "tabline"]),
      );
      if (isRecord(result)) {
        requireIdentifier(result["closed"], WORKSPACE_ID_RE, "closed");
        if (typeof result["killed"] !== "boolean") {
          problems.push("workspace close killed projection is invalid");
        }
        problems.push(
          ...projectionStringProblem(
            result["tabline"],
            "tabline",
            MAX_CAMPAIGN_STRING_BYTES,
            true,
          ),
        );
      }
      break;
    }
    case "terminal.send": {
      problems.push(...projectionObjectProblems(result, ["sent_to", "bytes"]));
      if (isRecord(result)) {
        requireIdentifier(result["sent_to"], TERMINAL_ID_RE, "sent_to");
        if (
          !Number.isSafeInteger(result["bytes"]) ||
          (result["bytes"] as number) < 0
        ) {
          problems.push("terminal send byte count is invalid");
        }
      }
      break;
    }
    case "config.reload": {
      problems.push(
        ...projectionObjectProblems(result, [
          "probed",
          "applied",
          "path",
          "hot_swap",
        ]),
      );
      if (isRecord(result)) {
        if (
          result["probed"] !== true ||
          result["applied"] !== false ||
          result["hot_swap"] !== "follow-up"
        ) {
          problems.push("config reload outcome projection is invalid");
        }
        problems.push(
          ...projectionStringProblem(result["path"], "path"),
          ...projectionStringProblem(result["hot_swap"], "hot_swap", 128),
        );
      }
      break;
    }
    default:
      problems.push(`result projection for ${canonicalVerb} is unavailable`);
  }
  return [...new Set(problems)].slice(0, 8);
}

function assertCtlResultProjection(verb: string, envelope: CtlEnvelope): void {
  const problems = ctlResultProjectionProblems(verb, envelope);
  if (problems.length > 0) {
    throw new CampaignError(
      "MalformedEnvelope",
      safeReportText(
        `ctl result projection is invalid: ${problems.join("; ")}`,
      ),
    );
  }
}

async function dispatchRawEnvelope(
  dispatcher: CtlDispatcher,
  invocation: CtlInvocation,
): Promise<CtlEnvelope> {
  const result = await dispatcher.dispatch(invocation);
  assertBoundedCtlResult(result);
  if (result.timedOut) {
    throw new CampaignError("EmptyOutput", "ctl invocation timed out");
  }
  const envelope = parseCtlEnvelopeShape(result.stdout);
  if (envelope.command !== `core.${canonicalProjectionVerb(invocation.verb)}`) {
    throw new CampaignError(
      "MalformedEnvelope",
      "ctl envelope command does not match the invocation",
    );
  }
  return envelope;
}

async function dispatchEnvelope(
  dispatcher: CtlDispatcher,
  invocation: CtlInvocation,
): Promise<CtlEnvelope> {
  const envelope = await dispatchRawEnvelope(dispatcher, invocation);
  assertCtlResultProjection(invocation.verb, envelope);
  return envelope;
}

type WorkspaceObservation = {
  ids: string[];
  problems: number;
};

function observeWorkspaceIds(envelope: CtlEnvelope): WorkspaceObservation {
  let problems = ctlResultProjectionProblems("workspace.list", envelope).length;
  const ids: string[] = [];
  if (!envelope.ok || !isRecord(envelope.result)) {
    return { ids, problems: problems + 1 };
  }
  const workspaces = envelope.result["workspaces"];
  if (
    !Array.isArray(workspaces) ||
    workspaces.length > MAX_CAMPAIGN_WORKSPACES
  ) {
    return { ids, problems: problems + 1 };
  }
  const seen = new Set<string>();
  for (const workspace of workspaces) {
    if (typeof workspace !== "string") {
      problems += 1;
      continue;
    }
    const canonical = canonicalWorkspaceId(workspace);
    if (canonical === undefined) {
      problems += 1;
      continue;
    }
    if (seen.has(canonical)) {
      problems += 1;
      continue;
    }
    seen.add(canonical);
    ids.push(canonical);
  }
  return { ids, problems };
}

/**
 * D2 guard: every workspace identifier a live client can observe must be usable
 * by `focus` (and `close` when elevated). The campaign found `workspace list`
 * emitting ids that `focus`/`close` reject after a close+new.
 */
export async function probeWorkspaceIdRoundTrip(
  dispatcher: CtlDispatcher,
  _opts: { elevated?: boolean } = {},
): Promise<ProbeResult> {
  const name = "workspace:id-round-trip";
  const evidence: string[] = [];
  const problems: string[] = [];
  const declared = new Set<string>();
  const owned = new Set<string>();
  let count = 0;
  try {
    const listed = workspaceNamesFrom(
      await dispatchEnvelope(dispatcher, {
        verb: "workspace.list.baseline",
        args: ["workspace", "list", "--format", "json"],
        elevated: false,
      }),
    );
    evidence.push(`baseline.count=${listed.length}`);
    const baseline = new Set<string>();
    for (const identifier of listed) {
      const canonical = canonicalWorkspaceId(identifier);
      if (canonical === undefined) {
        throw new CampaignError(
          "MissingField",
          "workspace identifier is invalid",
        );
      }
      baseline.add(canonical);
    }

    try {
      const created = workspaceCreatedFrom(
        await dispatchEnvelope(dispatcher, {
          verb: "workspace.new",
          args: ["workspace", "new", "--format", "json"],
          elevated: false,
        }),
      );
      const canonical = canonicalWorkspaceId(created);
      if (canonical === undefined) {
        problems.push("workspace new projection is invalid");
      } else if (baseline.has(canonical)) {
        problems.push("workspace new reported a baseline identifier");
      } else {
        declared.add(canonical);
        owned.add(canonical);
        evidence.push("created=true");
      }
    } catch (error) {
      problems.push(campaignFailureMessage(error));
    }

    const observation = observeWorkspaceIds(
      await dispatchRawEnvelope(dispatcher, {
        verb: "workspace.list.after-new",
        args: ["workspace", "list", "--format", "json"],
        elevated: false,
      }),
    );
    count = observation.ids.length;
    evidence.push(`afterNew.count=${count}`);
    if (observation.problems > 0) {
      problems.push("workspace post-create projection is invalid");
    }
    const observedOwned = new Set<string>();
    for (const identifier of observation.ids) {
      if (baseline.has(identifier)) continue;
      owned.add(identifier);
      observedOwned.add(identifier);
      if (!declared.has(identifier)) {
        problems.push("workspace list contained an unexpected new identifier");
      }
    }
    if (
      declared.size > 0 &&
      [...declared].some((identifier) => !observedOwned.has(identifier))
    ) {
      problems.push("workspace create response was not observed");
    }
    if (observation.ids.length === 0) {
      problems.push("workspace list empty after new");
    }

    if (observation.problems === 0) {
      for (const [index, identifier] of observation.ids.entries()) {
        let accepted = false;
        for (const candidate of workspaceIdCandidates(identifier)) {
          const focused = await dispatchEnvelope(dispatcher, {
            verb: "workspace.focus",
            args: ["workspace", "focus", candidate, "--format", "json"],
            elevated: false,
          });
          const returned =
            focused.ok && isRecord(focused.result)
              ? focused.result["focused"]
              : undefined;
          if (
            focused.ok &&
            typeof returned === "string" &&
            canonicalWorkspaceId(returned) === canonicalWorkspaceId(candidate)
          ) {
            accepted = true;
            evidence.push(`focus.${index}=ok`);
            break;
          }
          if (focused.ok) {
            evidence.push(`focus.${index}=mismatch`);
          }
          evidence.push(`focus.${index}=rejected`);
        }
        if (!accepted) {
          problems.push(`workspace identifier at index ${index} was rejected`);
        }
      }
    }
  } catch (error) {
    problems.push(campaignFailureMessage(error));
  } finally {
    for (const identifier of [...owned].sort()) {
      try {
        const closed = await dispatchEnvelope(dispatcher, {
          verb: "workspace.close",
          args: ["workspace", "close", identifier, "--format", "json"],
          elevated: true,
        });
        if (
          closed.ok &&
          isRecord(closed.result) &&
          typeof closed.result["closed"] === "string" &&
          canonicalWorkspaceId(closed.result["closed"]) === identifier
        ) {
          evidence.push("owned.cleanup=ok");
        } else if (!closed.ok && closed.error.code === "NotFound") {
          evidence.push("owned.cleanup=already-absent");
        } else {
          problems.push("owned workspace cleanup response did not match");
        }
      } catch (error) {
        problems.push(
          `owned workspace cleanup failed: ${campaignFailureMessage(error)}`,
        );
      }
    }
  }
  return problems.length > 0
    ? fail(name, problems.join("; "), evidence)
    : pass(name, `round-trip ok for ${count} workspace id(s)`, evidence);
}

// ---------------------------------------------------------------------------
// Probe 3: terminal text shape (D1 guard)
// ---------------------------------------------------------------------------

const DEBUG_DUMP_RE =
  /(Snapshot\s*\{|Cell\s*\{|Style\s*\{|Attributes\s*\{|,\s*cells:\s*\[)/;

/** True when `text` looks like a Rust `Debug` dump instead of grid text. */
export function detectDebugDump(text: string): boolean {
  return DEBUG_DUMP_RE.test(text);
}

/** Read `result.text` from a terminal-text envelope. */
export function terminalTextFrom(envelope: CtlEnvelope): string {
  if (!envelope.ok) {
    throw new CampaignError("MissingField", "terminal text returned an error");
  }
  const result = envelope.result;
  if (
    !isRecord(result) ||
    projectionObjectProblems(result, ["terminal_id", "text"]).length > 0 ||
    typeof result["terminal_id"] !== "string" ||
    !TERMINAL_ID_RE.test(result["terminal_id"])
  ) {
    throw new CampaignError(
      "MissingField",
      "terminal text result projection is invalid",
    );
  }
  assertBoundedString(
    "terminal text",
    result["text"],
    MAX_CAMPAIGN_STRING_BYTES,
  );
  return result["text"];
}

/**
 * D1 guard: `terminal text` must return the rendered grid as plain text, never
 * a `Snapshot { ... Cell { ... } }` Rust `Debug` dump.
 */
export async function probeTerminalTextShape(
  dispatcher: CtlDispatcher,
  terminalId = "t:1",
): Promise<ProbeResult> {
  const name = "terminal:text-shape";
  if (!TERMINAL_ID_RE.test(terminalId)) {
    return fail(name, "terminal text target is invalid");
  }
  try {
    const envelope = await dispatchEnvelope(dispatcher, {
      verb: "terminal.text",
      args: ["terminal", "text", terminalId, "--format", "json"],
      elevated: false,
    });
    const text = terminalTextFrom(envelope);
    if (detectDebugDump(text)) {
      return fail(
        name,
        `terminal text looks like a Rust Debug dump (${text.length} chars)`,
        ["target=redacted"],
      );
    }
    return pass(name, `plain grid text (${text.length} chars)`, [
      "target=validated",
      `lines=${text.split("\n").length}`,
    ]);
  } catch (error) {
    return fail(name, campaignFailureMessage(error));
  }
}

// ---------------------------------------------------------------------------
// Probe 4: terminal spawn observability (D3 guard)
// ---------------------------------------------------------------------------

type ViewRecord = {
  id: string;
  focused: boolean;
};

type TerminalSummary = {
  views: ViewRecord[];
  terminals: string[];
  paneSessions: boolean[];
  focusedView: string | undefined;
};

function viewsFrom(envelope: CtlEnvelope): ViewRecord[] {
  if (!envelope.ok) throw new CampaignError("MissingField", "view list error");
  const result = envelope.result;
  if (
    !isRecord(result) ||
    projectionObjectProblems(result, ["views"]).length > 0 ||
    !Array.isArray(result["views"])
  ) {
    throw new CampaignError("MissingField", "view list result.views missing");
  }
  if (result["views"].length > MAX_CAMPAIGN_ARRAY_ITEMS) {
    throw new CampaignError(
      "OutputTooLarge",
      `view list exceeds ${MAX_CAMPAIGN_ARRAY_ITEMS} items`,
    );
  }
  const views: ViewRecord[] = [];
  const seen = new Set<string>();
  for (const entry of result["views"]) {
    if (!isRecord(entry)) {
      throw new CampaignError(
        "MalformedEnvelope",
        "view list contains a malformed record",
      );
    }
    const problems = unexpectedEnvelopeFields(entry, ["id", "focused"]);
    if (problems.length > 0 || typeof entry["focused"] !== "boolean") {
      throw new CampaignError(
        "MalformedEnvelope",
        "view list record is invalid",
      );
    }
    assertBoundedString(
      "view identifier",
      entry["id"],
      MAX_CAMPAIGN_IDENTIFIER_BYTES,
    );
    if (!VIEW_ID_RE.test(entry["id"])) {
      throw new CampaignError(
        "MalformedEnvelope",
        "view identifier is invalid",
      );
    }
    if (seen.has(entry["id"])) {
      throw new CampaignError(
        "MalformedEnvelope",
        "view list contains a duplicate identifier",
      );
    }
    seen.add(entry["id"]);
    views.push({ id: entry["id"], focused: entry["focused"] });
  }
  return views;
}

function terminalsFrom(envelope: CtlEnvelope): {
  ids: string[];
  paneSessions: boolean[];
} {
  if (!envelope.ok)
    throw new CampaignError("MissingField", "terminal list error");
  const result = envelope.result;
  if (
    !isRecord(result) ||
    projectionObjectProblems(result, ["terminals"]).length > 0 ||
    !Array.isArray(result["terminals"])
  ) {
    throw new CampaignError(
      "MissingField",
      "terminal list result.terminals missing",
    );
  }
  if (result["terminals"].length > MAX_CAMPAIGN_ARRAY_ITEMS) {
    throw new CampaignError(
      "OutputTooLarge",
      `terminal list exceeds ${MAX_CAMPAIGN_ARRAY_ITEMS} items`,
    );
  }
  const ids: string[] = [];
  const paneSessions: boolean[] = [];
  const seen = new Set<string>();
  for (const entry of result["terminals"]) {
    if (!isRecord(entry)) {
      throw new CampaignError(
        "MalformedEnvelope",
        "terminal list contains a malformed record",
      );
    }
    const problems = unexpectedEnvelopeFields(entry, [
      "id",
      "has_pane_session",
    ]);
    if (problems.length > 0 || typeof entry["has_pane_session"] !== "boolean") {
      throw new CampaignError(
        "MalformedEnvelope",
        "terminal list record is invalid",
      );
    }
    assertBoundedString(
      "terminal identifier",
      entry["id"],
      MAX_CAMPAIGN_IDENTIFIER_BYTES,
    );
    if (!TERMINAL_ID_RE.test(entry["id"])) {
      throw new CampaignError(
        "MalformedEnvelope",
        "terminal identifier is invalid",
      );
    }
    if (seen.has(entry["id"])) {
      throw new CampaignError(
        "MalformedEnvelope",
        "terminal list contains a duplicate identifier",
      );
    }
    seen.add(entry["id"]);
    ids.push(entry["id"]);
    paneSessions.push(entry["has_pane_session"]);
  }
  return { ids, paneSessions };
}

function terminalSpawnedFrom(envelope: CtlEnvelope): {
  terminalId: string;
  viewId: string;
} {
  if (!envelope.ok) {
    throw new CampaignError("MissingField", "terminal spawn returned an error");
  }
  const result = envelope.result;
  if (!isRecord(result)) {
    throw new CampaignError("MissingField", "terminal spawn result is missing");
  }
  const problems = unexpectedEnvelopeFields(result, [
    "spawned",
    "terminal_id",
    "view_id",
  ]);
  if (
    problems.length > 0 ||
    result["spawned"] !== true ||
    typeof result["terminal_id"] !== "string" ||
    typeof result["view_id"] !== "string" ||
    !TERMINAL_ID_RE.test(result["terminal_id"]) ||
    !VIEW_ID_RE.test(result["view_id"])
  ) {
    throw new CampaignError(
      "MalformedEnvelope",
      "terminal spawn result is invalid",
    );
  }
  assertBoundedString(
    "spawned terminal identifier",
    result["terminal_id"],
    MAX_CAMPAIGN_IDENTIFIER_BYTES,
  );
  assertBoundedString(
    "spawned view identifier",
    result["view_id"],
    MAX_CAMPAIGN_IDENTIFIER_BYTES,
  );
  return {
    terminalId: result["terminal_id"],
    viewId: result["view_id"],
  };
}

async function terminalSummary(
  dispatcher: CtlDispatcher,
  phase: string,
): Promise<TerminalSummary> {
  const viewEnvelope = await dispatchEnvelope(dispatcher, {
    verb: `view.list.${phase}`,
    args: ["view", "list", "--format", "json"],
    elevated: false,
  });
  const terminalEnvelope = await dispatchEnvelope(dispatcher, {
    verb: `terminal.list.${phase}`,
    args: ["terminal", "list", "--format", "json"],
    elevated: false,
  });
  const terminals = terminalsFrom(terminalEnvelope);
  const views = viewsFrom(viewEnvelope);
  const terminalIds = new Set(terminals.ids);
  if (
    views.length !== terminalIds.size ||
    views.some((view) => !terminalIds.has(`t:${view.id.slice(2)}`))
  ) {
    throw new CampaignError(
      "MalformedEnvelope",
      "view and terminal lists are inconsistent",
    );
  }
  const focused = views.filter((view) => view.focused);
  if (focused.length > 1) {
    throw new CampaignError(
      "MalformedEnvelope",
      "view list contains multiple focused records",
    );
  }
  return {
    views,
    terminals: terminals.ids,
    paneSessions: terminals.paneSessions,
    focusedView: focused[0]?.id,
  };
}

type TerminalObservation = {
  ids: string[];
  paneSessions: Map<string, boolean>;
  problems: number;
};

function observeTerminalIds(envelope: CtlEnvelope): TerminalObservation {
  let problems = ctlResultProjectionProblems("terminal.list", envelope).length;
  const ids: string[] = [];
  const paneSessions = new Map<string, boolean>();
  if (!envelope.ok || !isRecord(envelope.result)) {
    return { ids, paneSessions, problems: problems + 1 };
  }
  const terminals = envelope.result["terminals"];
  if (
    !Array.isArray(terminals) ||
    terminals.length > MAX_CAMPAIGN_ARRAY_ITEMS
  ) {
    return { ids, paneSessions, problems: problems + 1 };
  }
  const seen = new Set<string>();
  for (const terminal of terminals) {
    if (!isRecord(terminal)) {
      problems += 1;
      continue;
    }
    const id = terminal["id"];
    const paneSession = terminal["has_pane_session"];
    if (
      typeof id !== "string" ||
      !TERMINAL_ID_RE.test(id) ||
      utf8Bytes(id) > MAX_CAMPAIGN_IDENTIFIER_BYTES ||
      typeof paneSession !== "boolean"
    ) {
      problems += 1;
      continue;
    }
    if (seen.has(id)) {
      problems += 1;
      continue;
    }
    seen.add(id);
    ids.push(id);
    paneSessions.set(id, paneSession);
  }
  return { ids, paneSessions, problems };
}

/**
 * D3 guard: `terminal spawn` reporting success must be observable in
 * `view list` / `terminal list` (new id) or in `has_pane_session` flipping.
 */
export async function probeTerminalSpawnObservability(
  dispatcher: CtlDispatcher,
  opts: { elevated?: boolean } = {},
): Promise<ProbeResult> {
  const name = "terminal:spawn-observable";
  const evidence: string[] = [];
  const problems: string[] = [];
  const declared = new Set<string>();
  const owned = new Set<string>();
  let previousFocus: string | undefined;
  let baselineTerminals: ReadonlySet<string>;
  let baselineViews: ReadonlySet<string>;
  try {
    const before = await terminalSummary(dispatcher, "before");
    baselineTerminals = new Set(before.terminals);
    baselineViews = new Set(before.views.map((view) => view.id));
    previousFocus = before.focusedView;
    evidence.push(
      `before.views=${before.views.length}`,
      `before.terminals=${before.terminals.length}`,
    );

    try {
      const spawned = await dispatchEnvelope(dispatcher, {
        verb: "terminal.spawn",
        args: ["terminal", "spawn", "--format", "json"],
        elevated: opts.elevated ?? true,
      });
      if (!spawned.ok) {
        problems.push("terminal spawn returned an error");
      } else {
        const created = terminalSpawnedFrom(spawned);
        if (baselineTerminals.has(created.terminalId)) {
          problems.push("terminal spawn reported a baseline resource");
        } else {
          declared.add(created.terminalId);
          owned.add(created.terminalId);
          if (
            baselineViews.has(created.viewId) ||
            created.terminalId.slice(2) !== created.viewId.slice(2)
          ) {
            problems.push("terminal spawn returned inconsistent identifiers");
          }
          evidence.push("spawned=true");
        }
      }
    } catch (error) {
      problems.push(campaignFailureMessage(error));
    }

    const terminalObservation = observeTerminalIds(
      await dispatchRawEnvelope(dispatcher, {
        verb: "terminal.list.after",
        args: ["terminal", "list", "--format", "json"],
        elevated: false,
      }),
    );
    evidence.push(`after.terminals=${terminalObservation.ids.length}`);
    if (terminalObservation.problems > 0) {
      problems.push("terminal post-create projection is invalid");
    }
    const observedOwned = new Set<string>();
    for (const identifier of terminalObservation.ids) {
      if (baselineTerminals.has(identifier)) continue;
      owned.add(identifier);
      observedOwned.add(identifier);
      if (!declared.has(identifier)) {
        problems.push("terminal list contained an unexpected new identifier");
      }
    }
    if (
      declared.size > 0 &&
      [...declared].some((identifier) => !observedOwned.has(identifier))
    ) {
      problems.push("terminal spawn response was not observed");
    }

    try {
      const afterViews = viewsFrom(
        await dispatchRawEnvelope(dispatcher, {
          verb: "view.list.after",
          args: ["view", "list", "--format", "json"],
          elevated: false,
        }),
      );
      evidence.push(`after.views=${afterViews.length}`);
      const viewIds = new Set(afterViews.map((view) => view.id));
      const declaredViewIds = new Set(
        [...declared].map((identifier) => `v:${identifier.slice(2)}`),
      );
      if (
        afterViews.some(
          (view) =>
            !baselineViews.has(view.id) && !declaredViewIds.has(view.id),
        )
      ) {
        problems.push("view list contained an unexpected new identifier");
      }
      for (const identifier of declared) {
        const viewId = `v:${identifier.slice(2)}`;
        if (
          !viewIds.has(viewId) ||
          terminalObservation.paneSessions.get(identifier) !== true
        ) {
          problems.push(
            "spawn reported success but the created resource was not observable",
          );
        }
      }
    } catch (error) {
      problems.push(campaignFailureMessage(error));
    }
  } catch (error) {
    problems.push(campaignFailureMessage(error));
  } finally {
    for (const identifier of [...owned].sort()) {
      try {
        const closed = await dispatchEnvelope(dispatcher, {
          verb: "terminal.close",
          args: ["terminal", "close", identifier, "--format", "json"],
          elevated: true,
        });
        if (
          closed.ok &&
          isRecord(closed.result) &&
          closed.result["closed"] === identifier
        ) {
          evidence.push("owned.terminal.cleanup=ok");
        } else if (!closed.ok && closed.error.code === "NotFound") {
          evidence.push("owned.terminal.cleanup=already-absent");
        } else {
          problems.push("owned terminal cleanup response did not match");
        }
      } catch (error) {
        problems.push(
          `owned terminal cleanup failed: ${campaignFailureMessage(error)}`,
        );
      }
    }
    if (previousFocus !== undefined) {
      try {
        const focused = await dispatchEnvelope(dispatcher, {
          verb: "view.focus",
          args: ["view", "focus", previousFocus, "--format", "json"],
          elevated: false,
        });
        if (
          focused.ok &&
          isRecord(focused.result) &&
          focused.result["focused"] === previousFocus
        ) {
          evidence.push("baseline.focus.restored=true");
        } else {
          problems.push("baseline focus restoration response did not match");
        }
      } catch (error) {
        problems.push(
          `baseline focus restoration failed: ${campaignFailureMessage(error)}`,
        );
      }
    }
  }
  return problems.length > 0
    ? fail(name, problems.join("; "), evidence)
    : pass(
        name,
        "spawn is observable and every run-owned terminal was cleaned",
        evidence,
      );
}

// ---------------------------------------------------------------------------
// Probe 5: BITTY_SOCKET parent-dir 0700 preflight
// ---------------------------------------------------------------------------

export type SocketDirStat = {
  isDirectory: boolean;
  isSymlink: boolean;
  /** Permission bits masked to `0o777`. */
  mode: number;
  ownerUid: number;
};

export type SocketPreflightResult = {
  ok: boolean;
  socketPath: string;
  parentDir: string;
  mode: number | null;
  ownerUid: number | null;
  diagnostic: string | null;
  remedy: string | null;
};

const dirModeOctal = (mode: number): string =>
  mode.toString(8).padStart(3, "0");

/** Platform-agnostic parent directory (no node types dependency). */
export function parentDirOf(path: string): string {
  // Normalize separators and trim trailing separators without a quantifier
  // regex (a trailing `/+$` pattern is super-linear on long runs and trips
  // CodeQL's ReDoS rule).
  const normalized = path.split("\\").join("/");
  let end = normalized.length;
  while (end > 0 && normalized[end - 1] === "/") end -= 1;
  const trimmed = normalized.slice(0, end);
  const index = trimmed.lastIndexOf("/");
  if (index < 0) return ".";
  if (index === 0) return "/";
  const parent = trimmed.slice(0, index);
  if (
    parent.length === 2 &&
    isAsciiLetter(parent.charCodeAt(0)) &&
    parent[1] === ":"
  ) {
    return `${parent}/`;
  }
  return parent;
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

/**
 * Validate the `BITTY_SOCKET` parent directory before attempting a live
 * connection. The core servo refuses a non-`0700` directory fail-closed; this
 * preflight turns that refusal into an actionable diagnostic (offending mode +
 * `chmod 700` remedy) instead of a raw mode-mismatch error.
 */
export function preflightSocketParentDir(options: {
  socketPath: string;
  runtimeUid: number;
  stat: (dir: string) => SocketDirStat | null;
  requiredMode?: number;
}): SocketPreflightResult {
  const parentDir = parentDirOf(options.socketPath);
  const requiredMode = options.requiredMode ?? DIR_MODE;
  const base: SocketPreflightResult = {
    ok: false,
    socketPath: options.socketPath,
    parentDir,
    mode: null,
    ownerUid: null,
    diagnostic: null,
    remedy: null,
  };
  const stat = options.stat(parentDir);
  if (stat === null) {
    return {
      ...base,
      diagnostic: `BITTY_SOCKET parent directory '${parentDir}' does not exist`,
      remedy: `mkdir -p '${parentDir}' && chmod 700 '${parentDir}'`,
    };
  }
  const observed = { mode: stat.mode, ownerUid: stat.ownerUid };
  if (stat.isSymlink) {
    return {
      ...base,
      ...observed,
      diagnostic: `BITTY_SOCKET parent directory '${parentDir}' is a symlink (refusing to serve)`,
      remedy: "use a real directory owned by the runtime user",
    };
  }
  if (!stat.isDirectory) {
    return {
      ...base,
      ...observed,
      diagnostic: `BITTY_SOCKET parent '${parentDir}' is not a directory`,
      remedy: `replace it with a directory owned by uid ${options.runtimeUid}`,
    };
  }
  if (stat.mode !== requiredMode) {
    return {
      ...base,
      ...observed,
      diagnostic: `BITTY_SOCKET parent directory '${parentDir}' mode ${dirModeOctal(stat.mode)} != ${dirModeOctal(requiredMode)} (must be 0700)`,
      remedy: `chmod 700 '${parentDir}'`,
    };
  }
  if (stat.ownerUid !== options.runtimeUid) {
    return {
      ...base,
      ...observed,
      diagnostic: `BITTY_SOCKET parent directory '${parentDir}' owner uid ${stat.ownerUid} != runtime uid ${options.runtimeUid}`,
      remedy: `chown ${options.runtimeUid} '${parentDir}'`,
    };
  }
  return { ...base, ...observed, ok: true };
}

/** Wrap the preflight as a {@link ProbeResult}. */
export function probeSocketDirPreflight(
  result: SocketPreflightResult,
): ProbeResult {
  const name = "socket:parent-dir-0700";
  if (result.ok) {
    return pass(name, "parent directory is 0700 and owner-matched", [
      `mode=${result.mode === null ? "?" : dirModeOctal(result.mode)}`,
    ]);
  }
  if (result.mode !== null) {
    return fail(
      name,
      "socket parent mode must be 0700; chmod 700 is required",
      [`mode=${dirModeOctal(result.mode)}`],
    );
  }
  return fail(name, "socket parent preflight failed", ["path=redacted"]);
}

// ---------------------------------------------------------------------------
// Probe 6: panel/plugin hooks for the post-D4 round (never blocking)
// ---------------------------------------------------------------------------

export type CampaignHook = {
  name: string;
  /** Always false: hooks must never block the harness. */
  blocking: false;
  owner: string;
  reason: string;
};

/**
 * Panel/plugin coverage hooks reserved for the post-D4 round. They are present
 * so the harness is ready when the plugin host lands, but they are explicitly
 * non-blocking and reported as `skip` today.
 */
export function panelPluginCoverageHooks(): readonly CampaignHook[] {
  return [
    {
      name: "panel:runtime-panels",
      blocking: false,
      owner: "bitty (CTX-0324 plugin host, post-D4)",
      reason: "Panel Runtime panels are blocked on the plugin host landing",
    },
    {
      name: "plugin:command-invocation",
      blocking: false,
      owner: "bitty (CTX-0324 plugin host, post-D4)",
      reason: "plugin command invocation requires the wired plugin host",
    },
    {
      name: "plugin:activity-suite",
      blocking: false,
      owner: "bitty-plugins/activity",
      reason: "activity plugin cannot run inside bitty until the host lands",
    },
  ];
}

/** Report the post-D4 hooks as non-blocking skips. */
export function probePanelPluginHooks(
  hooks: readonly CampaignHook[] = panelPluginCoverageHooks(),
): ProbeResult[] {
  return hooks.map((hook) =>
    skip(`hook:${hook.name}`, `post-D4, non-blocking: ${hook.reason}`, [
      `owner=${hook.owner}`,
    ]),
  );
}

// ---------------------------------------------------------------------------
// Campaign aggregation
// ---------------------------------------------------------------------------

export type CampaignReport = {
  results: readonly ProbeResult[];
  passed: number;
  failed: number;
  skipped: number;
  ok: boolean;
};

/** Aggregate probe results into a report; `ok` is true only when nothing fails. */
export function summarizeCampaign(
  results: readonly ProbeResult[],
): CampaignReport {
  const bounded = results
    .slice(0, MAX_CAMPAIGN_REPORT_RESULTS)
    .map(normalizeProbeResult);
  if (results.length > MAX_CAMPAIGN_REPORT_RESULTS) {
    bounded.push(
      fail(
        "campaign:report-limit",
        `campaign report exceeds ${MAX_CAMPAIGN_REPORT_RESULTS} results`,
      ),
    );
  }
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const result of bounded) {
    if (result.status === "pass") passed += 1;
    else if (result.status === "fail") failed += 1;
    else skipped += 1;
  }
  return { results: bounded, passed, failed, skipped, ok: failed === 0 };
}

export type CampaignOptions = {
  dispatcher: CtlDispatcher;
  mutationConsent?: { socketPath: string; disposable: boolean };
  terminalId?: string;
  /** Socket preflight inputs; omitted to skip the preflight probe. */
  socket?: {
    socketPath: string;
    runtimeUid: number;
    stat: (dir: string) => SocketDirStat | null;
    requiredMode?: number;
  };
  /** Legacy explicit destructive-admission flag; owned cleanup is unconditional. */
  closeWorkspaces?: boolean;
  /** Override the verb matrix (tests inject focused matrices). */
  matrix?: readonly VerbExpectation[];
  /**
   * Explicit opt-in for the keystroke-injection probe. Absent (or invalid) by
   * default, so `terminal.send` rows are refused and never dispatched. When
   * approved, the probe row is appended for the named scratch terminal only.
   */
  keystrokeTarget?: KeystrokeProbeTarget;
};

/**
 * Run the full headless-or-live campaign: envelope conformance, the D1/D2/D3
 * regression guards, the socket preflight, and the non-blocking post-D4 hooks.
 *
 * The default path never injects keystrokes: `terminal.send` is not part of
 * {@link CTL_VERB_MATRIX} and any keystroke row smuggled in via `matrix` is
 * refused fail-closed (recorded as `fail`, dispatched never) unless
 * `keystrokeTarget` explicitly opts in with a non-default terminal id.
 */
export async function runCampaign(
  options: CampaignOptions,
): Promise<CampaignReport> {
  const providedMatrix: unknown = Object.hasOwn(options, "matrix")
    ? options.matrix
    : CTL_VERB_MATRIX;
  const matrixProblem = campaignMatrixProblem(providedMatrix);
  if (matrixProblem !== undefined) {
    return summarizeCampaign([
      fail(campaignMatrixFailureName(providedMatrix), matrixProblem),
    ]);
  }
  const sourceMatrix = providedMatrix as readonly VerbExpectation[];
  const results: ProbeResult[] = [];
  if (options.socket !== undefined) {
    try {
      results.push(
        probeSocketDirPreflight(preflightSocketParentDir(options.socket)),
      );
    } catch (err) {
      results.push(fail("socket:parent-dir-0700", campaignFailureMessage(err)));
    }
    if (results[0]?.status !== "pass") return summarizeCampaign(results);
  } else {
    results.push(
      skip("socket:parent-dir-0700", "no socket configured (headless)"),
    );
  }
  const consent = options.mutationConsent;
  let allowMutations = false;
  try {
    allowMutations =
      consent?.disposable === true &&
      consent.socketPath.length > 0 &&
      isAbsoluteSocketPath(consent.socketPath) &&
      consent.socketPath === options.socket?.socketPath &&
      options.dispatcher.attestSocketTarget?.(consent.socketPath) === true;
  } catch (err) {
    results.push(fail("campaign:admission", campaignFailureMessage(err)));
    return summarizeCampaign(results);
  }
  if (
    (consent !== undefined ||
      options.closeWorkspaces === true ||
      options.keystrokeTarget !== undefined) &&
    !allowMutations
  ) {
    results.push(
      fail(
        "campaign:admission",
        "mutations require disposable-instance consent matching a preflighted socket",
      ),
    );
    return summarizeCampaign(results);
  }
  const allowKeystrokes = keystrokeProbeOptIn(options.keystrokeTarget);
  if (allowKeystrokes && sourceMatrix.length >= MAX_CAMPAIGN_MATRIX_ROWS) {
    return summarizeCampaign([
      fail(
        "campaign:matrix-limit",
        `campaign matrix cannot append keystroke row beyond ${MAX_CAMPAIGN_MATRIX_ROWS} rows`,
      ),
    ]);
  }
  const matrix =
    allowKeystrokes && options.keystrokeTarget !== undefined
      ? [...sourceMatrix, keystrokeProbeExpectation(options.keystrokeTarget)]
      : sourceMatrix;
  const admittedMatrix = matrix.filter((row) => {
    if (row.args[1] === "close") {
      results.push(
        skip(
          `envelope:${row.verb}`,
          "close requires a run-owned identifier; exercised by owned-resource cleanup only",
        ),
      );
      return false;
    }
    if (row.verb === "workspace.new" || row.verb === "terminal.spawn") {
      results.push(
        skip(
          `envelope:${row.verb}`,
          "owned resource creation is exercised by the cleanup probe",
        ),
      );
      return false;
    }
    const readOnly =
      !row.elevated &&
      CTL_VERB_MATRIX.some(
        (known) =>
          [
            "instance.list",
            "window.list",
            "view.list",
            "terminal.list",
            "terminal.text",
            "workspace.list",
          ].includes(known.verb) &&
          row.verb === known.verb &&
          row.args.length === known.args.length &&
          row.args.every((arg, i) => arg === known.args[i]),
      );
    if (!readOnly && !allowMutations) {
      results.push(
        skip(
          `envelope:${row.verb}`,
          "mutating or unknown probe requires disposable-instance consent",
        ),
      );
      return false;
    }
    return true;
  });
  results.push(
    ...(await probeEnvelopeConformance(options.dispatcher, admittedMatrix, {
      keystrokeTarget: options.keystrokeTarget,
    })),
  );
  results.push(
    allowMutations
      ? await probeWorkspaceIdRoundTrip(options.dispatcher)
      : skip("workspace:id-round-trip", "requires disposable-instance consent"),
  );
  results.push(
    await probeTerminalTextShape(
      options.dispatcher,
      options.terminalId ?? "t:1",
    ),
  );
  results.push(
    allowMutations
      ? await probeTerminalSpawnObservability(options.dispatcher, {
          elevated: true,
        })
      : skip(
          "terminal:spawn-observable",
          "requires disposable-instance consent",
        ),
  );
  results.push(...probePanelPluginHooks());
  return summarizeCampaign(results);
}

export type LiveCampaignConfig = ProcessDispatcherConfig & {
  mutationConsent?: CampaignOptions["mutationConsent"];
  terminalId?: string;
  /** Runtime uid for the socket preflight; required for the preflight probe. */
  runtimeUid?: number;
  /** Injectable stat for the preflight; omit to skip the preflight probe. */
  stat?: (dir: string) => SocketDirStat | null;
  /** Legacy explicit destructive-admission flag; owned cleanup is unconditional. */
  closeWorkspaces?: boolean;
  /**
   * Explicit opt-in for the keystroke-injection probe. Absent by default, so
   * even the live entry never types into a terminal unless the caller names
   * a scratch terminal and passes `allowLiveKeystrokes: true`.
   */
  keystrokeTarget?: KeystrokeProbeTarget;
};

/**
 * Opt-in live entry: run the campaign against a real `bitty ctl` over the
 * configured socket. Never called by `bun test`; the caller supplies the socket
 * and (optionally) a stat provider for the `0700` preflight.
 */
export async function runLiveCampaign(
  config: LiveCampaignConfig,
): Promise<CampaignReport> {
  const dispatcher = new ProcessCtlDispatcher(config);
  const socket =
    config.socketPath !== undefined &&
    config.runtimeUid !== undefined &&
    config.stat !== undefined
      ? {
          socketPath: config.socketPath,
          runtimeUid: config.runtimeUid,
          stat: config.stat,
        }
      : undefined;
  return runCampaign({
    dispatcher,
    mutationConsent: config.mutationConsent,
    terminalId: config.terminalId,
    closeWorkspaces: config.closeWorkspaces,
    keystrokeTarget: config.keystrokeTarget,
    socket,
  });
}
