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

function isAbsoluteSocketPath(socketPath: string): boolean {
  const platform = (globalThis as { process?: { platform?: string } }).process
    ?.platform;
  if (platform === "win32") {
    return /^[A-Za-z]:[\\/]/.test(socketPath) || socketPath.startsWith("\\\\");
  }
  return socketPath.startsWith("/");
}

function campaignFailureMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "unknown campaign failure";
  }
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
      "MalformedEnvelope" | "MissingField" | "InvalidJson" | "EmptyOutput",
    message: string,
  ) {
    super(message);
    this.name = "CampaignError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  if (typeof value["command"] !== "string" || value["command"].length === 0) {
    problems.push("command must be a non-empty string");
  }
  if (typeof value["ok"] !== "boolean") {
    problems.push("ok must be boolean");
  } else if (value["ok"] === true) {
    if (!("result" in value)) problems.push("ok:true requires a result field");
  } else {
    const err = value["error"];
    if (!isRecord(err)) {
      problems.push("ok:false requires an error object");
    } else {
      for (const key of ["class", "code", "message"] as const) {
        if (typeof err[key] !== "string" || err[key].length === 0) {
          problems.push(`error.${key} must be a non-empty string`);
        }
      }
    }
  }
  return problems;
}

/** Parse a v1 `ctl` envelope from CLI stdout; throws {@link CampaignError}. */
export function parseCtlEnvelope(stdout: string): CtlEnvelope {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw new CampaignError("EmptyOutput", "ctl produced no stdout envelope");
  }
  const line = trimmed.split("\n")[0] ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new CampaignError("InvalidJson", "ctl stdout is not valid JSON");
  }
  const problems = validateEnvelopeShape(parsed);
  if (problems.length > 0) {
    throw new CampaignError(
      "MalformedEnvelope",
      `invalid ctl envelope: ${problems.join("; ")}`,
    );
  }
  return parsed as CtlEnvelope;
}

/** Result of one `ctl` invocation (bounded, observation-only). */
export type CtlResult = {
  argv: readonly string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

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
    /** Environment delta merged over the host environment by the default spawn. */
    env: Record<string, string | undefined>;
    cwd?: string;
  },
) => CtlResult;

/**
 * `BITTY_CTL_ELEVATE` scope list announced for elevated invocations.
 *
 * The variable is a server-side pre-grant allowlist of comma-separated scope
 * names (for example `terminal.manage,config.modify`); the server intersects
 * them with its own allowlist and unknown names grant nothing. A bare `1` is
 * not a scope and therefore grants nothing, which is why an elevated probe
 * must announce the scopes it needs. This is observation-only wiring: the
 * server remains the authority and still fails closed on a missing grant.
 */
export const DEFAULT_ELEVATION_SCOPES = "terminal.manage,config.modify";

export type ProcessDispatcherConfig = {
  /** Program to execute; defaults to `bitty`. */
  program?: string;
  /** Base arguments before the verb; defaults to `["ctl"]`. */
  baseArgs?: readonly string[];
  /** Explicit `--socket` path; omitted for instance discovery. */
  socketPath?: string;
  /** Command timeout in milliseconds. */
  timeoutMs?: number;
  /** Extra environment (e.g. `XDG_RUNTIME_DIR`). */
  env?: Record<string, string>;
  /**
   * Comma-separated `BITTY_CTL_ELEVATE` scope list announced for elevated
   * invocations. Defaults to {@link DEFAULT_ELEVATION_SCOPES}.
   */
  elevationScopes?: string;
  /** Working directory. */
  cwd?: string;
};

type BunSpawnResult = {
  exitCode: number | null;
  stdout?: { toString(): string } | null;
  stderr?: { toString(): string } | null;
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

/**
 * Default live spawn over the runtime's `Bun.spawnSync`, with a hard timeout
 * and bounded capture. No node builtin types are required, so the harness
 * type-checks under the repository's committed dependency pins.
 */
export function defaultSpawnSync(
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
    env: { ...resolveHostEnv(), ...options.env },
    cwd: options.cwd,
    timeout: options.timeoutMs,
  });
  const timedOut = res.exitCode === null && res.signalCode === "SIGTERM";
  const stdout = res.stdout?.toString() ?? "";
  const stderr = res.stderr?.toString() ?? "";
  return {
    argv: [program, ...args],
    exitCode: timedOut ? EXIT_TIMEOUT : (res.exitCode ?? EXIT_GENERIC),
    stdout: stdout.slice(0, MAX_CAMPAIGN_OUTPUT_BYTES),
    stderr: stderr.slice(0, MAX_CAMPAIGN_OUTPUT_BYTES),
    timedOut,
  };
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
  private readonly env: Record<string, string>;
  private readonly elevationScopes: string;
  private readonly cwd: string | undefined;
  private readonly spawn: SpawnSyncFn;

  constructor(
    config: ProcessDispatcherConfig = {},
    spawn: SpawnSyncFn = defaultSpawnSync,
  ) {
    this.program = config.program ?? "bitty";
    this.baseArgs = config.baseArgs ?? ["ctl"];
    this.socketPath = config.socketPath;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.env = config.env ?? {};
    this.elevationScopes = config.elevationScopes ?? DEFAULT_ELEVATION_SCOPES;
    this.cwd = config.cwd;
    this.spawn = spawn;
  }

  attestSocketTarget(absoluteSocketPath: string): boolean {
    return (
      isAbsoluteSocketPath(absoluteSocketPath) &&
      this.socketPath === absoluteSocketPath
    );
  }

  async dispatch(invocation: CtlInvocation): Promise<CtlResult> {
    const args = [...this.baseArgs];
    if (this.socketPath !== undefined) {
      args.push("--socket", this.socketPath);
    }
    args.push(...invocation.args);
    const env: Record<string, string | undefined> = { ...this.env };
    env["BITTY_CTL_ELEVATE"] = invocation.elevated
      ? this.elevationScopes
      : undefined;
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

const OUTCOME_CLASS: Partial<Record<ExpectedOutcome, string>> = {
  denied: "Denied",
  conflict: "Conflict",
  unavailable: "Unavailable",
  notfound: "NotFound",
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
      `invalid keystroke probe terminal id '${target.terminalId}' (want t:<n>)`,
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

function pass(
  name: string,
  detail: string,
  evidence: readonly string[] = [],
): ProbeResult {
  return { name, status: "pass", detail, evidence };
}

function fail(
  name: string,
  detail: string,
  evidence: readonly string[] = [],
): ProbeResult {
  return { name, status: "fail", detail, evidence };
}

function skip(
  name: string,
  detail: string,
  evidence: readonly string[] = [],
): ProbeResult {
  return { name, status: "skip", detail, evidence };
}

function expectedClassFor(outcome: ExpectedOutcome): string | undefined {
  return OUTCOME_CLASS[outcome];
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
  const results: ProbeResult[] = [];
  const allowKeystrokes = keystrokeProbeOptIn(opts.keystrokeTarget);
  for (const expectation of matrix) {
    const name = `envelope:${expectation.verb}`;
    if (isKeystrokeProbeRow(expectation) && !allowKeystrokes) {
      results.push(
        fail(
          name,
          "keystroke probe refused: pass an explicit keystrokeTarget with allowLiveKeystrokes:true and a non-default terminal id",
          [`verb=${expectation.verb}`],
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
    } catch (err) {
      results.push(
        fail(name, `dispatch threw: ${campaignFailureMessage(err)}`),
      );
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
    } catch (err) {
      results.push(fail(name, campaignFailureMessage(err), evidence));
      continue;
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
      const expectedClass = expectedClassFor(expectation.outcome);
      if (
        expectedClass !== undefined &&
        envelope.error.class !== expectedClass
      ) {
        results.push(
          fail(
            name,
            `expected class ${expectedClass}, got ${envelope.error.class}/${envelope.error.code}`,
            [
              ...evidence,
              `class=${envelope.error.class}`,
              `code=${envelope.error.code}`,
            ],
          ),
        );
        continue;
      }
    }
    if (result.exitCode !== expectedExit) {
      results.push(
        fail(name, `expected exit ${expectedExit}, got ${result.exitCode}`, [
          ...evidence,
          `class=${envelope.ok ? "-" : envelope.error.class}`,
          `code=${envelope.ok ? "-" : envelope.error.code}`,
        ]),
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
const WORKSPACE_ID_RE = /^ws:\d+$/;

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
  throw new CampaignError(
    "MissingField",
    `invalid workspace id '${identifier}' (want ws:<n> or ws<n>)`,
  );
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
  const result = envelope.result;
  if (!isRecord(result) || !Array.isArray(result["workspaces"])) {
    throw new CampaignError(
      "MissingField",
      "workspace list result.workspaces missing",
    );
  }
  return result["workspaces"].filter((v): v is string => typeof v === "string");
}

/** Read `result.created` from a workspace-new envelope. */
export function workspaceCreatedFrom(envelope: CtlEnvelope): string {
  if (!envelope.ok) {
    throw new CampaignError("MissingField", "workspace new returned an error");
  }
  const result = envelope.result;
  if (!isRecord(result) || typeof result["created"] !== "string") {
    throw new CampaignError(
      "MissingField",
      "workspace new result.created missing",
    );
  }
  return result["created"];
}

async function dispatchEnvelope(
  dispatcher: CtlDispatcher,
  invocation: CtlInvocation,
): Promise<CtlEnvelope> {
  const result = await dispatcher.dispatch(invocation);
  if (result.timedOut) {
    throw new CampaignError("EmptyOutput", `${invocation.verb} timed out`);
  }
  return parseCtlEnvelope(result.stdout);
}

/**
 * D2 guard: every workspace identifier a live client can observe must be usable
 * by `focus` (and `close` when elevated). The campaign found `workspace list`
 * emitting ids that `focus`/`close` reject after a close+new.
 */
export async function probeWorkspaceIdRoundTrip(
  dispatcher: CtlDispatcher,
  opts: { elevated?: boolean } = {},
): Promise<ProbeResult> {
  const name = "workspace:id-round-trip";
  const evidence: string[] = [];
  const problems: string[] = [];
  let owned: string | undefined;
  let count = 0;
  try {
    const listed = workspaceNamesFrom(
      await dispatchEnvelope(dispatcher, {
        verb: "workspace.list.baseline",
        args: ["workspace", "list", "--format", "json"],
        elevated: false,
      }),
    );
    evidence.push(`baseline=[${listed.join(",")}]`);
    const baseline = new Set(
      listed.map((id) => {
        assertSafeWorkspaceId(id);
        return id.replace(/^ws:?0*(?=\d)/, "ws:");
      }),
    );

    const created = workspaceCreatedFrom(
      await dispatchEnvelope(dispatcher, {
        verb: "workspace.new",
        args: ["workspace", "new", "--format", "json"],
        elevated: false,
      }),
    );
    evidence.push(`created=${created}`);
    if (!WORKSPACE_ID_RE.test(created)) {
      throw new CampaignError(
        "MissingField",
        `workspace new created non-id '${created}'`,
      );
    }
    if (baseline.has(created.replace(/^ws:?0*(?=\d)/, "ws:"))) {
      throw new CampaignError(
        "MissingField",
        "workspace new returned a pre-existing id",
      );
    }
    owned = created;

    const afterNew = workspaceNamesFrom(
      await dispatchEnvelope(dispatcher, {
        verb: "workspace.list.after-new",
        args: ["workspace", "list", "--format", "json"],
        elevated: false,
      }),
    );
    evidence.push(`afterNew=[${afterNew.join(",")}]`);

    count = afterNew.length;
    if (afterNew.length === 0) {
      problems.push("workspace list empty after new");
    }
    for (const identifier of afterNew) {
      try {
        assertSafeWorkspaceId(identifier);
      } catch {
        problems.push(`listed id '${identifier}' is not a workspace id`);
        continue;
      }
      let accepted = false;
      const candidates = workspaceIdCandidates(identifier);
      for (const candidate of candidates) {
        const focused = await dispatchEnvelope(dispatcher, {
          verb: "workspace.focus",
          args: ["workspace", "focus", candidate, "--format", "json"],
          elevated: false,
        });
        if (focused.ok) {
          accepted = true;
          evidence.push(`focus(${candidate})=ok`);
          break;
        }
        evidence.push(
          `focus(${candidate})=${focused.error.class}/${focused.error.code}`,
        );
      }
      if (!accepted) {
        problems.push(`listed id ${identifier} rejected by focus`);
      }
    }
  } catch (err) {
    problems.push(campaignFailureMessage(err));
  } finally {
    if (opts.elevated === true && owned !== undefined) {
      try {
        const closed = await dispatchEnvelope(dispatcher, {
          verb: "workspace.close",
          args: ["workspace", "close", owned, "--format", "json"],
          elevated: true,
        });
        if (!closed.ok) {
          problems.push(
            `owned id ${owned} rejected by close (${closed.error.class}/${closed.error.code})`,
          );
        } else {
          evidence.push(`close(${owned})=ok`);
        }
      } catch (err) {
        problems.push(
          `owned workspace cleanup failed: ${campaignFailureMessage(err)}`,
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
  if (!isRecord(result) || typeof result["text"] !== "string") {
    throw new CampaignError(
      "MissingField",
      "terminal text result.text missing",
    );
  }
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
        [`terminal=${terminalId}`, `preview=${text.slice(0, 120)}`],
      );
    }
    return pass(name, `plain grid text (${text.length} chars)`, [
      `terminal=${terminalId}`,
      `lines=${text.split("\n").length}`,
    ]);
  } catch (err) {
    return fail(name, campaignFailureMessage(err), [`terminal=${terminalId}`]);
  }
}

// ---------------------------------------------------------------------------
// Probe 4: terminal spawn observability (D3 guard)
// ---------------------------------------------------------------------------

type TerminalSummary = {
  views: string[];
  terminals: string[];
  paneSessions: boolean[];
};

function viewsFrom(envelope: CtlEnvelope): string[] {
  if (!envelope.ok) throw new CampaignError("MissingField", "view list error");
  const result = envelope.result;
  if (!isRecord(result) || !Array.isArray(result["views"])) {
    throw new CampaignError("MissingField", "view list result.views missing");
  }
  return result["views"]
    .map((v) => (isRecord(v) ? v["id"] : undefined))
    .filter((v): v is string => typeof v === "string");
}

function terminalsFrom(envelope: CtlEnvelope): {
  ids: string[];
  paneSessions: boolean[];
} {
  if (!envelope.ok)
    throw new CampaignError("MissingField", "terminal list error");
  const result = envelope.result;
  if (!isRecord(result) || !Array.isArray(result["terminals"])) {
    throw new CampaignError(
      "MissingField",
      "terminal list result.terminals missing",
    );
  }
  const ids: string[] = [];
  const paneSessions: boolean[] = [];
  for (const entry of result["terminals"]) {
    if (!isRecord(entry)) continue;
    if (typeof entry["id"] === "string") ids.push(entry["id"]);
    paneSessions.push(entry["has_pane_session"] === true);
  }
  return { ids, paneSessions };
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
  return {
    views: viewsFrom(viewEnvelope),
    terminals: terminals.ids,
    paneSessions: terminals.paneSessions,
  };
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
  try {
    const before = await terminalSummary(dispatcher, "before");
    evidence.push(
      `before.views=${before.views.length}`,
      `before.terminals=${before.terminals.length}`,
    );

    const spawned = await dispatchEnvelope(dispatcher, {
      verb: "terminal.spawn",
      args: ["terminal", "spawn", "--format", "json"],
      elevated: opts.elevated ?? true,
    });
    if (!spawned.ok) {
      return fail(
        name,
        `spawn failed: ${spawned.error.class}/${spawned.error.code}`,
        evidence,
      );
    }
    evidence.push("spawned=true");

    const after = await terminalSummary(dispatcher, "after");
    evidence.push(
      `after.views=${after.views.length}`,
      `after.terminals=${after.terminals.length}`,
    );
    evidence.push(
      `paneSession.before=${before.paneSessions.join(",")}`,
      `paneSession.after=${after.paneSessions.join(",")}`,
    );

    const newView = after.views.some((id) => !before.views.includes(id));
    const newTerminal = after.terminals.some(
      (id) => !before.terminals.includes(id),
    );
    const paneFlipped =
      after.paneSessions.some((v) => v) && !before.paneSessions.some((v) => v);
    if (!newView && !newTerminal && !paneFlipped) {
      return fail(
        name,
        "spawn reported success but no view/terminal/has_pane_session change",
        evidence,
      );
    }
    return pass(
      name,
      "spawn is observable in view/terminal list or pane session",
      evidence,
    );
  } catch (err) {
    return fail(name, campaignFailureMessage(err), evidence);
  }
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
    return pass(name, `parent ${result.parentDir} is 0700 and owner-matched`, [
      `mode=${result.mode === null ? "?" : dirModeOctal(result.mode)}`,
    ]);
  }
  const diagnostic = result.diagnostic ?? "socket preflight failed";
  const detail =
    result.remedy === null ? diagnostic : `${diagnostic}; ${result.remedy}`;
  return fail(name, detail, [
    result.remedy === null ? "" : `remedy=${result.remedy}`,
  ]);
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
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const result of results) {
    if (result.status === "pass") passed += 1;
    else if (result.status === "fail") failed += 1;
    else skipped += 1;
  }
  return { results, passed, failed, skipped, ok: failed === 0 };
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
  /** Set true to also exercise workspace `close` (destructive; live only). */
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
  const matrix =
    allowKeystrokes && options.keystrokeTarget !== undefined
      ? [
          ...(options.matrix ?? CTL_VERB_MATRIX),
          keystrokeProbeExpectation(options.keystrokeTarget),
        ]
      : (options.matrix ?? CTL_VERB_MATRIX);
  const admittedMatrix = matrix.filter((row) => {
    if (row.args[1] === "close") {
      results.push(
        skip(
          `envelope:${row.verb}`,
          "close requires a run-owned identifier; exercised by workspace cleanup only",
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
      ? await probeWorkspaceIdRoundTrip(options.dispatcher, {
          elevated: options.closeWorkspaces ?? false,
        })
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
  /** Set true to also exercise workspace `close` (destructive; live only). */
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
