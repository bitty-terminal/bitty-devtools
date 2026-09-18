/**
 * bitty-devtools CLI wrapper (CTX-0025).
 *
 * A lightweight executable over the existing typed diagnostics client. It
 * parses `inspect` selectors, resolves a connection from explicit flags or the
 * advisory environment (`BITTY_SOCKET` / `BITTY_INSTANCE_ID` /
 * `XDG_RUNTIME_DIR`), dispatches through {@link DevtoolsClient} inspection
 * methods, and renders bounded tabular or JSON output.
 *
 * Fail-closed rules:
 * - No selector, unknown flag, or a missing `--plugin` is a usage error (exit 2).
 * - No resolvable instance/transport is reported clearly (exit 6); the CLI never
 *   fabricates observation data and never silently falls back to the headless
 *   snapshot mock.
 * - Typed server/protocol/transport errors are surfaced and mapped to the shared
 *   `ctl` exit-code vocabulary; server methods the core does not yet implement
 *   therefore fail closed instead of printing invented rows.
 *
 * Protocol ownership stays in `bitty`; this is a consumer wrapper over the
 * accepted devtools-rfc v1 methods (`bitty.debug/listPlugins`,
 * `bitty.debug/listSubscriptions`, `bitty.debug/getBudgets`). All output is
 * untrusted observation data, never instructions.
 */

import { BOUNDS, BoundError, truncateToChars } from "./bounds.js";
import { generation } from "./panel-runtime.js";
import { DevtoolsClient } from "./client.js";
import { InspectionError } from "./inspection.js";
import type {
  BudgetSnapshot,
  PluginSummary,
  SubscriptionInfo,
} from "./inspection.js";
import { TracingError } from "./tracing.js";
import type {
  TraceChunk,
  TraceStartResult,
  TraceStopResult,
} from "./tracing.js";
import { AuthError, peerCredentials, resolveSocketPath } from "./auth.js";
import { IpcTransport, TransportError } from "./transport.js";
import { connectLiveSocket } from "./ipc-socket.js";
import { ProtocolErrorImpl } from "./protocol.js";
import {
  EXIT_CONFIG,
  EXIT_GENERIC,
  EXIT_OK,
  EXIT_RUNTIME,
  EXIT_USAGE,
  expectedExitForError,
} from "./campaign.js";

/** Bound on any single rendered table cell (guards hostile/huge fields). */
export const MAX_CELL_CHARS = 120 as const;

/** Bound on `--json` recursion depth before values are passed through as-is. */
export const MAX_JSON_DEPTH = 8 as const;

/** Generation used by `inspect --budgets` when the caller omits one. */
export const DEFAULT_GENERATION = 1 as const;

export const DEFAULT_TRACE_DURATION_MS = 10000 as const;
export const DEFAULT_TRACE_MAX_BYTES = 524288 as const;
export const TRACE_ID_MAX_BYTES = 128 as const;

export type InspectSelector = "plugins" | "budgets" | "subscriptions";

export type InspectOptions = {
  selector: InspectSelector;
  plugin: string | null;
  generation: number | null;
  json: boolean;
  socket: string | null;
  instance: string | null;
};

export type TraceStartOptions = {
  durationMs: number;
  maxBytes: number;
  includeInput: boolean;
  json: boolean;
  socket: string | null;
  instance: string | null;
};

export type TraceStopOptions = {
  traceId: string;
  json: boolean;
  socket: string | null;
  instance: string | null;
};

export type TraceFetchOptions = {
  traceId: string;
  offset: number;
  json: boolean;
  socket: string | null;
  instance: string | null;
};

export type ConnectionOptions = {
  socket: string | null;
  instance: string | null;
};

export type CliCommand =
  | { kind: "help" }
  | { kind: "inspect"; options: InspectOptions }
  | { kind: "trace-start"; options: TraceStartOptions }
  | { kind: "trace-stop"; options: TraceStopOptions }
  | { kind: "trace-fetch"; options: TraceFetchOptions };

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

/**
 * A connection-configuration failure (invalid/oversized instance id or socket
 * path) that must be reported cleanly with a documented exit code instead of
 * escaping as a stack trace. `exitCode` is `EXIT_USAGE` for explicit flags and
 * `EXIT_CONFIG` for environment-derived values.
 */
export class CliConfigError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number,
  ) {
    super(message);
    this.name = "CliConfigError";
  }
}

export const USAGE = `bitty-devtools — human-facing Bitty diagnostics (experimental)

Usage:
  bitty-devtools inspect --plugins [--generation <n>] [options]
  bitty-devtools inspect --subscriptions --plugin <id> [options]
  bitty-devtools inspect --budgets --plugin <id> [--generation <n>] [options]
  bitty-devtools trace start --wire-trace [--duration-ms <n>] [--max-bytes <n>] [--include-input] [options]
  bitty-devtools trace stop --wire-trace --trace-id <id> [options]
  bitty-devtools trace fetch-chunk --wire-trace --trace-id <id> --offset <n> [options]
  bitty-devtools --help

Selectors (exactly one):
  --plugins           List registered plugins and their lifecycle state.
  --subscriptions     List event subscriptions for --plugin.
  --budgets           Show RC-1/RC-2/RC-4/RC-5 budgets for --plugin.

Trace (requires --wire-trace, live socket, debug.trace):
  start               Start a wire trace with bounded duration and bytes.
  stop                Stop a wire trace and show redacted previews.
  fetch-chunk         Fetch one 262144-byte chunk with continuation.

Options:
  --plugin <id>       Plugin id required by --subscriptions and --budgets.
  --generation <n>    Target plugin generation (default ${DEFAULT_GENERATION} for --budgets).
  --wire-trace        Presence-only opt-in for trace verbs, default off.
  --duration-ms <n>   Trace duration 1..300000, default 10000.
  --max-bytes <n>     Trace bytes 1..4194304, default 524288.
  --include-input     Presence-only input capture opt-in, default off.
  --trace-id <id>     Trace id for stop and fetch-chunk.
  --offset <n>        Byte offset for fetch-chunk.
  --socket <path>     Explicit Bitty IPC socket path (advisory).
  --instance <id>     Instance id under $XDG_RUNTIME_DIR/bitty/<id>.sock.
  --json              Emit bounded, pretty-printed JSON instead of a table.
  -h, --help          Show this help.

Option values must not begin with '-' (a following flag is rejected, not
consumed as a value).

Connection:
  With no --socket/--instance, the CLI reads BITTY_SOCKET, then
  BITTY_INSTANCE_ID with XDG_RUNTIME_DIR. It fails closed when no instance is
  selected. Read-only; requires the debug.inspect scope and never fabricates
  data for a server method the core has not implemented. Trace verbs use the
  live socket only, require debug.trace, spool 0600, and never read
  BITTY_WIRE_TRACE. Methods and fields follow the accepted devtools-rfc v1.`;

function takeValue(
  argv: readonly string[],
  index: number,
  flag: string,
): string {
  const value = argv[index];
  if (value === undefined || value.length === 0) {
    throw new CliUsageError(`${flag} requires a value`);
  }
  // N4: never consume the next flag as a value (e.g. `--plugin --json`).
  if (value.startsWith("-")) {
    throw new CliUsageError(
      `${flag} requires a value; '${value}' looks like a flag`,
    );
  }
  return value;
}

function parseInspect(argv: readonly string[]): CliCommand {
  let selector: InspectSelector | null = null;
  let plugin: string | null = null;
  let generationRaw: string | null = null;
  let json = false;
  let socket: string | null = null;
  let instance: string | null = null;

  const setSelector = (next: InspectSelector, flag: string): void => {
    if (selector !== null) {
      throw new CliUsageError(
        `only one of --plugins/--budgets/--subscriptions may be given (saw ${flag})`,
      );
    }
    selector = next;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--plugins":
        setSelector("plugins", arg);
        break;
      case "--budgets":
        setSelector("budgets", arg);
        break;
      case "--subscriptions":
        setSelector("subscriptions", arg);
        break;
      case "--plugin":
        plugin = takeValue(argv, i + 1, arg);
        i += 1;
        break;
      case "--generation":
        generationRaw = takeValue(argv, i + 1, arg);
        i += 1;
        break;
      case "--socket":
        socket = takeValue(argv, i + 1, arg);
        i += 1;
        break;
      case "--instance":
        instance = takeValue(argv, i + 1, arg);
        i += 1;
        break;
      case "--json":
        json = true;
        break;
      case "-h":
      case "--help":
        return { kind: "help" };
      default:
        throw new CliUsageError(`unknown argument '${arg ?? ""}'`);
    }
  }

  if (selector === null) {
    throw new CliUsageError(
      "no inspect selector: use --plugins, --budgets, or --subscriptions",
    );
  }
  if (selector !== "plugins") {
    if (plugin === null || plugin.length === 0) {
      throw new CliUsageError(`--${selector} requires --plugin <id>`);
    }
  }

  let parsedGeneration: number | null = null;
  if (generationRaw !== null) {
    const value = Number(generationRaw);
    if (!/^\d+$/.test(generationRaw) || !Number.isInteger(value) || value < 1) {
      throw new CliUsageError(
        `--generation must be a positive integer (saw '${generationRaw}')`,
      );
    }
    parsedGeneration = value;
  }

  return {
    kind: "inspect",
    options: {
      selector,
      plugin,
      generation: parsedGeneration,
      json,
      socket,
      instance,
    },
  };
}

function parseTraceDurationMs(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new CliUsageError(
      `--duration-ms must be an integer in 1..${BOUNDS.MAX_TRACE_DURATION_MS} (saw '${raw}')`,
    );
  }
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > BOUNDS.MAX_TRACE_DURATION_MS
  ) {
    throw new CliUsageError(
      `--duration-ms must be an integer in 1..${BOUNDS.MAX_TRACE_DURATION_MS} (saw '${raw}')`,
    );
  }
  return value;
}

function parseTraceMaxBytes(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new CliUsageError(
      `--max-bytes must be an integer in 1..${BOUNDS.MAX_TRACE_BYTES} (saw '${raw}')`,
    );
  }
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > BOUNDS.MAX_TRACE_BYTES
  ) {
    throw new CliUsageError(
      `--max-bytes must be an integer in 1..${BOUNDS.MAX_TRACE_BYTES} (saw '${raw}')`,
    );
  }
  return value;
}

function parseTraceOffset(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new CliUsageError(
      `--offset must be a nonnegative byte integer (saw '${raw}')`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CliUsageError(
      `--offset must be a nonnegative byte integer (saw '${raw}')`,
    );
  }
  return value;
}

function parseTraceId(raw: string): string {
  const bytes = new TextEncoder().encode(raw).length;
  if (raw.length === 0 || bytes < 1 || bytes > TRACE_ID_MAX_BYTES) {
    throw new CliUsageError(
      `--trace-id must be 1..${TRACE_ID_MAX_BYTES} UTF-8 bytes`,
    );
  }
  return raw;
}

function parseTraceStart(argv: readonly string[]): CliCommand {
  let wireTrace = false;
  let durationRaw: string | null = null;
  let maxBytesRaw: string | null = null;
  let includeInput = false;
  let json = false;
  let socket: string | null = null;
  let instance: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--wire-trace":
        wireTrace = true;
        break;
      case "--duration-ms":
        durationRaw = takeValue(argv, i + 1, arg);
        i += 1;
        break;
      case "--max-bytes":
        maxBytesRaw = takeValue(argv, i + 1, arg);
        i += 1;
        break;
      case "--include-input":
        includeInput = true;
        break;
      case "--socket":
        socket = takeValue(argv, i + 1, arg);
        i += 1;
        break;
      case "--instance":
        instance = takeValue(argv, i + 1, arg);
        i += 1;
        break;
      case "--json":
        json = true;
        break;
      case "-h":
      case "--help":
        return { kind: "help" };
      default:
        throw new CliUsageError(`unknown argument '${arg ?? ""}'`);
    }
  }
  if (!wireTrace) {
    throw new CliUsageError(`trace start requires --wire-trace`);
  }
  const durationMs =
    durationRaw === null
      ? DEFAULT_TRACE_DURATION_MS
      : parseTraceDurationMs(durationRaw);
  const maxBytes =
    maxBytesRaw === null
      ? DEFAULT_TRACE_MAX_BYTES
      : parseTraceMaxBytes(maxBytesRaw);
  return {
    kind: "trace-start",
    options: { durationMs, maxBytes, includeInput, json, socket, instance },
  };
}

function parseTraceStop(argv: readonly string[]): CliCommand {
  let wireTrace = false;
  let traceIdRaw: string | null = null;
  let json = false;
  let socket: string | null = null;
  let instance: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--wire-trace":
        wireTrace = true;
        break;
      case "--trace-id":
        traceIdRaw = takeValue(argv, i + 1, arg);
        i += 1;
        break;
      case "--socket":
        socket = takeValue(argv, i + 1, arg);
        i += 1;
        break;
      case "--instance":
        instance = takeValue(argv, i + 1, arg);
        i += 1;
        break;
      case "--json":
        json = true;
        break;
      case "-h":
      case "--help":
        return { kind: "help" };
      default:
        throw new CliUsageError(`unknown argument '${arg ?? ""}'`);
    }
  }
  if (!wireTrace) {
    throw new CliUsageError(`trace stop requires --wire-trace`);
  }
  if (traceIdRaw === null) {
    throw new CliUsageError(`trace stop requires --trace-id <id>`);
  }
  const traceId = parseTraceId(traceIdRaw);
  return { kind: "trace-stop", options: { traceId, json, socket, instance } };
}

function parseTraceFetch(argv: readonly string[]): CliCommand {
  let wireTrace = false;
  let traceIdRaw: string | null = null;
  let offsetRaw: string | null = null;
  let json = false;
  let socket: string | null = null;
  let instance: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--wire-trace":
        wireTrace = true;
        break;
      case "--trace-id":
        traceIdRaw = takeValue(argv, i + 1, arg);
        i += 1;
        break;
      case "--offset":
        offsetRaw = takeValue(argv, i + 1, arg);
        i += 1;
        break;
      case "--socket":
        socket = takeValue(argv, i + 1, arg);
        i += 1;
        break;
      case "--instance":
        instance = takeValue(argv, i + 1, arg);
        i += 1;
        break;
      case "--json":
        json = true;
        break;
      case "-h":
      case "--help":
        return { kind: "help" };
      default:
        throw new CliUsageError(`unknown argument '${arg ?? ""}'`);
    }
  }
  if (!wireTrace) {
    throw new CliUsageError(`trace fetch-chunk requires --wire-trace`);
  }
  if (traceIdRaw === null) {
    throw new CliUsageError(`trace fetch-chunk requires --trace-id <id>`);
  }
  if (offsetRaw === null) {
    throw new CliUsageError(`trace fetch-chunk requires --offset <n>`);
  }
  const traceId = parseTraceId(traceIdRaw);
  const offset = parseTraceOffset(offsetRaw);
  return {
    kind: "trace-fetch",
    options: { traceId, offset, json, socket, instance },
  };
}

function parseTrace(argv: readonly string[]): CliCommand {
  const verb = argv[0];
  if (verb === "-h" || verb === "--help") {
    return { kind: "help" };
  }
  if (verb === undefined) {
    throw new CliUsageError("no trace verb: use start|stop|fetch-chunk");
  }
  if (verb === "start") {
    return parseTraceStart(argv.slice(1));
  }
  if (verb === "stop") {
    return parseTraceStop(argv.slice(1));
  }
  if (verb === "fetch-chunk") {
    return parseTraceFetch(argv.slice(1));
  }
  throw new CliUsageError(
    `unknown trace verb '${verb}' (want start|stop|fetch-chunk)`,
  );
}

export function parseCliArgs(argv: readonly string[]): CliCommand {
  const command = argv[0];
  if (command === undefined || command === "-h" || command === "--help") {
    return { kind: "help" };
  }
  if (command === "inspect") {
    return parseInspect(argv.slice(1));
  }
  if (command === "trace") {
    return parseTrace(argv.slice(1));
  }
  throw new CliUsageError(`unknown command '${command}'`);
}

export type CliRuntime = {
  env: Record<string, string | undefined>;
  uid: number;
  gid: number;
  pid: number;
  now: () => number;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

export type CliDeps = {
  runtime: CliRuntime;
  /**
   * Optional injected IPC transport. Tests use this to drive the CLI headlessly
   * with real {@link IpcTransport} scripted-response seams; production resolves
   * one from flags/environment.
   */
  transport?: IpcTransport;
};

/**
 * Resolve the socket path from explicit options then advisory environment.
 *
 * Returns `null` when no instance is selected. All resolved values are routed
 * through {@link resolveSocketPath} so its length/NUL/instance validation runs
 * for `--socket`/`BITTY_SOCKET` too. A validation failure is wrapped in
 * {@link CliConfigError} (usage for explicit flags, config for the
 * environment) so callers report it instead of crashing with a stack trace.
 */
function resolveSocket(
  options: ConnectionOptions,
  runtime: CliRuntime,
): string | null {
  const optionSocket = options.socket;
  const optionInstance = options.instance;
  const envSocket = runtime.env["BITTY_SOCKET"];
  const envInstance = runtime.env["BITTY_INSTANCE_ID"];
  const xdgRuntimeDir = runtime.env["XDG_RUNTIME_DIR"];

  const bittySocket =
    optionSocket !== null && optionSocket.length > 0
      ? optionSocket
      : envSocket !== undefined && envSocket.length > 0
        ? envSocket
        : undefined;
  const instance =
    optionInstance !== null && optionInstance.length > 0
      ? optionInstance
      : envInstance !== undefined && envInstance.length > 0
        ? envInstance
        : undefined;

  if (bittySocket === undefined && instance === undefined && !xdgRuntimeDir) {
    return null; // nothing selected; fail closed before touching the filesystem
  }

  const fromOption =
    (optionSocket !== null && optionSocket.length > 0) ||
    (optionInstance !== null && optionInstance.length > 0);
  try {
    return resolveSocketPath({
      runtimeUid: runtime.uid,
      xdgRuntimeDir,
      bittySocket,
      instanceId: instance,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliConfigError(
      `invalid connection configuration: ${message}`,
      fromOption ? EXIT_USAGE : EXIT_CONFIG,
    );
  }
}

function boundCell(value: string): string {
  const { text, truncated } = truncateToChars(value, MAX_CELL_CHARS);
  return truncated ? `${text}...` : text;
}

function renderTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const bounded = rows.map((row) =>
    headers.map((_, i) => boundCell(row[i] ?? "")),
  );
  const widths = headers.map((header, i) => {
    let width = header.length;
    for (const row of bounded) {
      const cell = row[i];
      if (cell !== undefined && cell.length > width) width = cell.length;
    }
    return width;
  });
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, i) => cell.padEnd(widths[i] ?? cell.length))
      .join("  ")
      .trimEnd();
  return [line(headers), ...bounded.map((row) => line(row))].join("\n");
}

function renderPlugins(plugins: readonly PluginSummary[]): string {
  return renderTable(
    ["ID", "VERSION", "GEN", "STATE", "CAPABILITIES"],
    plugins.map((p) => [
      p.id,
      p.version,
      String(p.generation),
      p.state,
      p.capabilities.join(","),
    ]),
  );
}

function renderSubscriptions(subs: readonly SubscriptionInfo[]): string {
  return renderTable(
    ["EVENT TYPE", "QUEUE DEPTH", "QUEUED BYTES", "DROP COUNT", "POLICY"],
    subs.map((s) => [
      s.eventType,
      String(s.queueDepth),
      String(s.queuedBytes),
      String(s.dropCount),
      s.policy,
    ]),
  );
}

function renderBudgets(budget: BudgetSnapshot): string {
  return renderTable(
    ["FIELD", "VALUE"],
    [
      ["pluginId", budget.pluginId],
      ["generation", String(budget.generation)],
      ["rc1Instructions", String(budget.rc1Instructions)],
      ["rc1WallMs", String(budget.rc1WallMs)],
      ["rc2MemoryBytes", String(budget.rc2MemoryBytes)],
      ["rc4Tasks", String(budget.rc4Tasks)],
      ["rc4Timers", String(budget.rc4Timers)],
      ["rc5QueueDepth", String(budget.rc5QueueDepth)],
      ["wouldExceedLuaLimits", String(budget.wouldExceedLuaLimits)],
    ],
  );
}

/** Recursively bound string fields so `--json` matches the table path (N2). */
function boundJsonValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return boundCell(value);
  if (depth >= MAX_JSON_DEPTH) return value;
  if (Array.isArray(value)) {
    return value.map((entry) => boundJsonValue(entry, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const bounded: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      bounded[key] = boundJsonValue(entry, depth + 1);
    }
    return bounded;
  }
  return value;
}

function toJson(value: unknown): string {
  return JSON.stringify(boundJsonValue(value), null, 2);
}

function renderTraceStart(result: TraceStartResult, json: boolean): string {
  if (json) {
    return toJson(result);
  }
  return renderTable(
    ["FIELD", "VALUE"],
    [
      ["traceId", result.traceId],
      ["spoolPath", result.spoolPath],
      ["chunkBytes", String(result.chunkBytes)],
      ["startWallClockMs", String(result.startWallClockMs)],
    ],
  );
}

function renderTraceStop(result: TraceStopResult, json: boolean): string {
  if (json) {
    return toJson(result);
  }
  return renderTable(
    ["FIELD", "VALUE"],
    [
      ["traceId", result.traceId],
      ["byteCount", String(result.byteCount)],
      ["dropCount", String(result.dropCount)],
      ["exportBytesEstimate", String(result.exportBytesEstimate)],
      ["truncated", String(result.truncated)],
      ["spoolMode", result.spoolMode],
      ["previews", result.previews.join("|")],
    ],
  );
}

function renderTraceChunk(result: TraceChunk, json: boolean): string {
  if (json) {
    return toJson(result);
  }
  return renderTable(
    ["FIELD", "VALUE"],
    [
      ["traceId", result.traceId],
      ["offset", String(result.offset)],
      ["continuation", String(result.continuation)],
      ["sequence", String(result.sequence)],
      ["chunk", result.chunk],
      ["preview", result.preview],
    ],
  );
}

function requirePlugin(options: InspectOptions): string {
  // parseCliArgs guarantees a non-empty plugin for non-plugin selectors.
  if (options.plugin === null || options.plugin.length === 0) {
    throw new CliUsageError(`--${options.selector} requires --plugin <id>`);
  }
  return options.plugin;
}

function dispatch(client: DevtoolsClient, options: InspectOptions): string {
  switch (options.selector) {
    case "plugins": {
      const filter =
        options.generation === null
          ? undefined
          : generation(options.generation);
      const plugins = client.listPlugins(filter);
      return options.json ? toJson(plugins) : renderPlugins(plugins);
    }
    case "subscriptions": {
      const subs = client.listSubscriptions(requirePlugin(options));
      return options.json ? toJson(subs) : renderSubscriptions(subs);
    }
    case "budgets": {
      const budget = client.getBudgets(
        requirePlugin(options),
        generation(options.generation ?? DEFAULT_GENERATION),
      );
      return options.json ? toJson(budget) : renderBudgets(budget);
    }
    default:
      throw new CliUsageError("no inspect selector");
  }
}

function dispatchTraceStart(
  client: DevtoolsClient,
  options: TraceStartOptions,
): string {
  const result = client.startTrace({
    durationMs: options.durationMs,
    maxBytes: options.maxBytes,
    includeInput: options.includeInput,
  });
  return renderTraceStart(result, options.json);
}

function dispatchTraceStop(
  client: DevtoolsClient,
  options: TraceStopOptions,
): string {
  const result = client.stopTrace(options.traceId);
  return renderTraceStop(result, options.json);
}

function dispatchTraceFetch(
  client: DevtoolsClient,
  options: TraceFetchOptions,
): string {
  const result = client.fetchTraceChunk(options.traceId, options.offset);
  return renderTraceChunk(result, options.json);
}

/**
 * Live dispatch for `runCliLive`: same selectors as `dispatch`, but each
 * inspection call goes over the socket via `client.requestLive` instead of
 * the headless stub. Request ids start at 1 per invocation.
 */
async function dispatchLive(
  client: DevtoolsClient,
  options: InspectOptions,
  nowMs: number,
): Promise<string> {
  switch (options.selector) {
    case "plugins": {
      const response = await client.requestLive(
        {
          id: 1,
          method: "bitty.debug/listPlugins",
          params: {
            generation: options.generation,
          },
          version: "1.0",
        },
        nowMs,
      );
      if (response.error !== undefined) {
        throw new InspectionError(
          response.error.code,
          `${response.error.category}: ${response.error.message}`,
        );
      }
      // The accepted result envelope is `{ "plugins": [...] }`
      // (devtools-rfc v1); fail closed on a mistyped envelope.
      const envelope = response.result as { plugins?: unknown };
      if (!Array.isArray(envelope?.plugins)) {
        throw new InspectionError(
          "InvalidResult",
          "listPlugins result.plugins: expected an array",
        );
      }
      const plugins = envelope.plugins as Parameters<typeof renderPlugins>[0];
      return options.json ? toJson(plugins) : renderPlugins(plugins);
    }
    case "subscriptions": {
      const plugin = requirePlugin(options);
      const response = await client.requestLive(
        {
          id: 1,
          method: "bitty.debug/listSubscriptions",
          params: { pluginId: plugin },
          version: "1.0",
        },
        nowMs,
      );
      if (response.error !== undefined) {
        throw new InspectionError(
          response.error.code,
          `${response.error.category}: ${response.error.message}`,
        );
      }
      if (!Array.isArray(response.result)) {
        throw new InspectionError(
          "InvalidResult",
          "listSubscriptions result: expected an array",
        );
      }
      const subs = response.result as Parameters<typeof renderSubscriptions>[0];
      return options.json ? toJson(subs) : renderSubscriptions(subs);
    }
    case "budgets": {
      const plugin = requirePlugin(options);
      const response = await client.requestLive(
        {
          id: 1,
          method: "bitty.debug/getBudgets",
          params: {
            pluginId: plugin,
            generation: options.generation ?? DEFAULT_GENERATION,
          },
          version: "1.0",
        },
        nowMs,
      );
      if (response.error !== undefined) {
        throw new InspectionError(
          response.error.code,
          `${response.error.category}: ${response.error.message}`,
        );
      }
      const budget = response.result as Parameters<typeof renderBudgets>[0];
      return options.json ? toJson(budget) : renderBudgets(budget);
    }
    default:
      throw new CliUsageError("no inspect selector");
  }
}

export function formatCliError(error: unknown): string {
  if (error instanceof CliUsageError) return error.message;
  if (error instanceof CliConfigError) return error.message;
  if (error instanceof InspectionError) {
    return `${error.code}: ${error.message}`;
  }
  if (error instanceof TracingError) {
    return `${error.code}: ${error.message}`;
  }
  if (error instanceof BoundError) {
    return `${error.bound}: ${error.message}`;
  }
  if (error instanceof AuthError) return `${error.code}: ${error.message}`;
  if (error instanceof TransportError) {
    return `${error.code}: ${error.message}`;
  }
  if (error instanceof ProtocolErrorImpl) {
    return `${error.error.category}/${error.error.code}: ${error.error.message}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

export function exitCodeForError(error: unknown): number {
  if (error instanceof CliUsageError) return EXIT_USAGE;
  if (error instanceof CliConfigError) return error.exitCode;
  if (error instanceof InspectionError) {
    return expectedExitForError("Error", error.code);
  }
  if (error instanceof TracingError) {
    return expectedExitForError("Error", error.code);
  }
  if (error instanceof BoundError) {
    return EXIT_GENERIC;
  }
  if (error instanceof AuthError) {
    return expectedExitForError("Denied", error.code);
  }
  if (error instanceof TransportError) {
    return expectedExitForError("Unavailable", error.code);
  }
  if (error instanceof ProtocolErrorImpl) {
    return expectedExitForError(error.error.category, error.error.code);
  }
  return EXIT_GENERIC;
}

/**
 * Run the CLI. Returns the process exit code; all I/O goes through
 * {@link CliDeps.runtime} so tests can capture output with an injected transport.
 *
 * The live-socket path (`deps.liveSocket === true`, CTX-0036) is async via
 * `runCliLiveAsync`; use that entry directly when dialing is wanted.
 */
export function runCli(argv: readonly string[], deps: CliDeps): number {
  const { runtime } = deps;

  let command: CliCommand;
  try {
    command = parseCliArgs(argv);
  } catch (error) {
    runtime.stderr(`bitty-devtools: ${formatCliError(error)}\n\n${USAGE}\n`);
    return EXIT_USAGE;
  }

  if (command.kind === "help") {
    runtime.stdout(`${USAGE}\n`);
    return EXIT_OK;
  }

  if (
    command.kind === "trace-start" ||
    command.kind === "trace-stop" ||
    command.kind === "trace-fetch"
  ) {
    runtime.stderr(
      "bitty-devtools: no connected Bitty instance; trace requires live socket, pass --socket <path> or " +
        "--instance <id> via live entry\n",
    );
    return EXIT_RUNTIME;
  }

  const options = command.options;
  let transport = deps.transport ?? null;
  if (transport === null) {
    let socketPath: string | null;
    try {
      socketPath = resolveSocket(options, runtime);
    } catch (error) {
      // B1: invalid --instance/BITTY_SOCKET/XDG_RUNTIME_DIR must fail closed
      // with a clean message and documented code, never an escaped stack trace.
      runtime.stderr(`bitty-devtools: ${formatCliError(error)}\n`);
      return exitCodeForError(error);
    }
    if (socketPath === null) {
      runtime.stderr(
        "bitty-devtools: no connected Bitty instance; pass --socket <path> or " +
          "--instance <id>, or set BITTY_SOCKET / BITTY_INSTANCE_ID with " +
          "XDG_RUNTIME_DIR\n",
      );
      return EXIT_RUNTIME;
    }
    try {
      transport = new IpcTransport({
        runtimeUid: runtime.uid,
        socketPath,
        peer: peerCredentials(runtime.uid, runtime.gid, runtime.pid),
      });
    } catch (error) {
      runtime.stderr(`bitty-devtools: ${formatCliError(error)}\n`);
      return exitCodeForError(error);
    }
  }

  const client = new DevtoolsClient();
  try {
    client.connectWithTransport(transport);
    client.grantScope("debug.inspect");
    const output = dispatch(client, options);
    runtime.stdout(`${output}\n`);
    return EXIT_OK;
  } catch (error) {
    runtime.stderr(`bitty-devtools: ${formatCliError(error)}\n`);
    return exitCodeForError(error);
  } finally {
    try {
      client.disconnect();
    } catch {
      // Disconnect is best-effort; a closed transport must not mask the result.
    }
  }
}

/**
 * Opt-in live CLI entry (CTX-0036, H-DEV-06): resolve the socket from
 * flags/environment, attest the endpoint, dial the real `AF_UNIX` socket,
 * and dispatch the inspect selector over it. Headless `runCli` never calls
 * this; production wires it behind an explicit flag.
 */
export async function runCliLive(
  argv: readonly string[],
  deps: CliDeps,
): Promise<number> {
  const { runtime } = deps;
  void connectLiveSocket;

  let command: CliCommand;
  try {
    command = parseCliArgs(argv);
  } catch (error) {
    runtime.stderr(`bitty-devtools: ${formatCliError(error)}\n\n${USAGE}\n`);
    return EXIT_USAGE;
  }

  if (command.kind === "help") {
    runtime.stdout(`${USAGE}\n`);
    return EXIT_OK;
  }

  if (
    command.kind === "trace-start" ||
    command.kind === "trace-stop" ||
    command.kind === "trace-fetch"
  ) {
    const traceOptions = command.options;
    let traceSocketPath: string | null;
    try {
      traceSocketPath = resolveSocket(traceOptions, runtime);
    } catch (error) {
      runtime.stderr(`bitty-devtools: ${formatCliError(error)}\n`);
      return exitCodeForError(error);
    }
    if (traceSocketPath === null) {
      runtime.stderr(
        "bitty-devtools: no connected Bitty instance; pass --socket <path> or " +
          "--instance <id>, or set BITTY_SOCKET / BITTY_INSTANCE_ID with " +
          "XDG_RUNTIME_DIR\n",
      );
      return EXIT_RUNTIME;
    }
    const injected = deps.transport ?? null;
    const traceClient = new DevtoolsClient();
    try {
      if (injected !== null) {
        traceClient.connectWithTransport(injected);
      } else {
        await traceClient.connectLiveSocket(
          runtime.uid,
          peerCredentials(runtime.uid, runtime.gid, runtime.pid),
          runtime.env["XDG_RUNTIME_DIR"],
          traceOptions.instance ?? undefined,
          traceSocketPath,
        );
      }
      traceClient.grantScope("debug.trace");
      let traceOutput: string;
      if (command.kind === "trace-start") {
        traceOutput = dispatchTraceStart(traceClient, command.options);
      } else if (command.kind === "trace-stop") {
        traceOutput = dispatchTraceStop(traceClient, command.options);
      } else {
        traceOutput = dispatchTraceFetch(traceClient, command.options);
      }
      runtime.stdout(`${traceOutput}\n`);
      return EXIT_OK;
    } catch (error) {
      runtime.stderr(`bitty-devtools: ${formatCliError(error)}\n`);
      return exitCodeForError(error);
    } finally {
      try {
        traceClient.disconnect();
      } catch {}
    }
  }

  const options = command.options;
  let socketPath: string | null;
  try {
    socketPath = resolveSocket(options, runtime);
  } catch (error) {
    runtime.stderr(`bitty-devtools: ${formatCliError(error)}\n`);
    return exitCodeForError(error);
  }
  if (socketPath === null) {
    runtime.stderr(
      "bitty-devtools: no connected Bitty instance; pass --socket <path> or " +
        "--instance <id>, or set BITTY_SOCKET / BITTY_INSTANCE_ID with " +
        "XDG_RUNTIME_DIR\n",
    );
    return EXIT_RUNTIME;
  }

  const client = new DevtoolsClient();
  try {
    await client.connectLiveSocket(
      runtime.uid,
      peerCredentials(runtime.uid, runtime.gid, runtime.pid),
      runtime.env["XDG_RUNTIME_DIR"],
      options.instance ?? undefined,
      socketPath,
    );
    client.grantScope("debug.inspect");
    const output = await dispatchLive(client, options, runtime.now());
    runtime.stdout(`${output}\n`);
    return EXIT_OK;
  } catch (error) {
    runtime.stderr(`bitty-devtools: ${formatCliError(error)}\n`);
    return exitCodeForError(error);
  } finally {
    try {
      client.disconnect();
    } catch {
      // Disconnect is best-effort; a closed socket must not mask the result.
    }
  }
}
