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

import { truncateToChars } from "./bounds.js";
import { generation } from "./panel-runtime.js";
import { DevtoolsClient } from "./client.js";
import { InspectionError } from "./inspection.js";
import type {
  BudgetSnapshot,
  PluginSummary,
  SubscriptionInfo,
} from "./inspection.js";
import { AuthError, peerCredentials, resolveSocketPath } from "./auth.js";
import { IpcTransport, TransportError } from "./transport.js";
import { ProtocolErrorImpl } from "./protocol.js";
import {
  EXIT_GENERIC,
  EXIT_OK,
  EXIT_RUNTIME,
  EXIT_USAGE,
  expectedExitForError,
} from "./campaign.js";

/** Bound on any single rendered table cell (guards hostile/huge fields). */
export const MAX_CELL_CHARS = 120 as const;

/** Generation used by `inspect --budgets` when the caller omits one. */
export const DEFAULT_GENERATION = 1 as const;

export type InspectSelector = "plugins" | "budgets" | "subscriptions";

export type InspectOptions = {
  selector: InspectSelector;
  plugin: string | null;
  generation: number | null;
  json: boolean;
  socket: string | null;
  instance: string | null;
};

export type CliCommand =
  { kind: "help" } | { kind: "inspect"; options: InspectOptions };

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export const USAGE = `bitty-devtools — human-facing Bitty diagnostics (experimental)

Usage:
  bitty-devtools inspect --plugins [--generation <n>] [options]
  bitty-devtools inspect --subscriptions --plugin <id> [options]
  bitty-devtools inspect --budgets --plugin <id> [--generation <n>] [options]
  bitty-devtools --help

Selectors (exactly one):
  --plugins           List registered plugins and their lifecycle state.
  --subscriptions     List event subscriptions for --plugin.
  --budgets           Show RC-1/RC-2/RC-4/RC-5 budgets for --plugin.

Options:
  --plugin <id>       Plugin id required by --subscriptions and --budgets.
  --generation <n>    Target plugin generation (default ${DEFAULT_GENERATION} for --budgets).
  --socket <path>     Explicit Bitty IPC socket path (advisory).
  --instance <id>     Instance id under $XDG_RUNTIME_DIR/bitty/<id>.sock.
  --json              Emit bounded JSON instead of a table.
  -h, --help          Show this help.

Connection:
  With no --socket/--instance, the CLI reads BITTY_SOCKET, then
  BITTY_INSTANCE_ID with XDG_RUNTIME_DIR. It fails closed when no instance is
  selected. Read-only; requires the debug.inspect scope and never fabricates
  data for a server method the core has not implemented. Methods and fields
  follow the accepted devtools-rfc v1.`;

function takeValue(
  argv: readonly string[],
  index: number,
  flag: string,
): string {
  const value = argv[index];
  if (value === undefined || value.length === 0) {
    throw new CliUsageError(`${flag} requires a value`);
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

export function parseCliArgs(argv: readonly string[]): CliCommand {
  const command = argv[0];
  if (command === undefined || command === "-h" || command === "--help") {
    return { kind: "help" };
  }
  if (command === "inspect") {
    return parseInspect(argv.slice(1));
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

/** Resolve the socket path from explicit options then advisory environment. */
function resolveSocket(
  options: InspectOptions,
  runtime: CliRuntime,
): string | null {
  if (options.socket !== null && options.socket.length > 0) {
    return options.socket;
  }
  const envSocket = runtime.env["BITTY_SOCKET"];
  if (envSocket !== undefined && envSocket.length > 0) {
    return envSocket;
  }
  const instance = options.instance ?? runtime.env["BITTY_INSTANCE_ID"];
  const xdgRuntimeDir = runtime.env["XDG_RUNTIME_DIR"];
  if ((instance !== undefined && instance.length > 0) || xdgRuntimeDir) {
    return resolveSocketPath({
      runtimeUid: runtime.uid,
      xdgRuntimeDir,
      bittySocket: undefined,
      instanceId: instance ?? "default",
    });
  }
  return null;
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

function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
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

export function formatCliError(error: unknown): string {
  if (error instanceof CliUsageError) return error.message;
  if (error instanceof InspectionError) {
    return `${error.code}: ${error.message}`;
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
  if (error instanceof InspectionError) {
    return expectedExitForError("Error", error.code);
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

  const options = command.options;
  let transport = deps.transport ?? null;
  if (transport === null) {
    const socketPath = resolveSocket(options, runtime);
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
