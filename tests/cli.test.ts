import { describe, expect, test } from "bun:test";
import {
  CliConfigError,
  CliUsageError,
  DEFAULT_GENERATION,
  DEFAULT_TRACE_DURATION_MS,
  DEFAULT_TRACE_MAX_BYTES,
  DEFAULT_WATCH_INTERVAL_MS,
  MAX_CELL_CHARS,
  WATCH_CEILING_MS,
  WATCH_FLOOR_MS,
  WATCH_JITTER_FRACTION,
  WATCH_MAX_FAILED_ATTEMPTS,
  WATCH_MAX_TICKS,
  exitCodeForError,
  parseCliArgs,
  runCli,
  runCliLive,
  runCliWatch,
  watchTickDelayMs,
} from "../src/cli.js";
import type { CliRuntime } from "../src/cli.js";
import { DIR_MODE, SOCKET_MODE, peerCredentials } from "../src/auth.js";
import { IpcTransport, TransportError } from "../src/transport.js";
import type { IpcRequest, IpcResponse } from "../src/transport.js";
import {
  EXIT_CONFIG,
  EXIT_GENERIC,
  EXIT_OK,
  EXIT_PERM,
  EXIT_RUNTIME,
  EXIT_USAGE,
} from "../src/campaign.js";
import { TracingError } from "../src/tracing.js";
import { BoundError } from "../src/bounds.js";
import { DevtoolsClient } from "../src/client.js";

type Harness = {
  out: string[];
  err: string[];
  deps: { runtime: CliRuntime; transport?: IpcTransport };
};

function makeHarness(transport?: IpcTransport): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const proc = globalThis.process as unknown as {
    getuid?: () => number;
    getgid?: () => number;
  };
  const uid = typeof proc.getuid === "function" ? proc.getuid() : 1000;
  const gid = typeof proc.getgid === "function" ? proc.getgid() : 1000;
  const runtime: CliRuntime = {
    env: {},
    uid,
    gid,
    pid: 42,
    now: () => 0,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  return { out, err, deps: { runtime, transport } };
}

/** Records the exact JSON-RPC requests before the client disconnects. */
class RecordingTransport extends IpcTransport {
  readonly calls: IpcRequest[] = [];
  override sendRequest(req: IpcRequest, nowMs: number): void {
    this.calls.push(req);
    super.sendRequest(req, nowMs);
  }
}

function makeTransport(): RecordingTransport {
  const { uid, gid, pid } = makeHarness().deps.runtime;
  return new RecordingTransport({
    runtimeUid: uid,
    socketPath: `/run/user/${uid}/bitty/default.sock`,
    peer: peerCredentials(uid, gid, pid),
  });
}

class AlternatingRateLimitTransport extends RecordingTransport {
  attempts = 0;

  override request(req: IpcRequest, _nowMs: number): IpcResponse {
    this.attempts += 1;
    if (this.attempts % 2 === 0) {
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: { category: "budget", code: "RateLimited", message: "fixture" },
        version: "1.0",
      };
    }
    return {
      jsonrpc: "2.0",
      id: req.id,
      result: { plugins: [pluginPayload()] },
      version: "1.0",
    };
  }
}

function responsePayload(id: number, result: unknown): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ jsonrpc: "2.0", id, result, version: "1.0" }),
  );
}

function errorPayload(
  id: number,
  category: string,
  code: string,
  message: string,
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { category, code, message },
      version: "1.0",
    }),
  );
}

function pluginPayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "plugin-a",
    version: "1.2.3",
    generation: 4,
    state: "Activated",
    manifestHash: "sha256:abc",
    capabilities: ["panel.provider"],
    ...overrides,
  };
}

function subscriptionPayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    eventType: "bitty.panel:mounted",
    queueDepth: 2,
    queuedBytes: 256,
    dropCount: 1,
    policy: "DropOldest",
    ...overrides,
  };
}

function budgetPayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    generation: 7,
    rc1Instructions: 10,
    rc1WallMs: 1,
    rc2MemoryBytes: 2,
    rc4Tasks: 3,
    rc4Timers: 4,
    rc5QueueDepth: 5,
    would_exceed_lua_limits: false,
    ...overrides,
  };
}

describe("parseCliArgs", () => {
  test("empty argv and --help yield help", () => {
    expect(parseCliArgs([])).toEqual({ kind: "help" });
    expect(parseCliArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseCliArgs(["inspect", "--help"])).toEqual({ kind: "help" });
  });

  test("parses --plugins with no generation filter", () => {
    expect(parseCliArgs(["inspect", "--plugins"])).toEqual({
      kind: "inspect",
      options: {
        selector: "plugins",
        plugin: null,
        generation: null,
        json: false,
        socket: null,
        instance: null,
        watch: false,
        intervalMs: null,
        maxTicks: null,
      },
    });
  });

  test("parses budgets with plugin, generation, json and connection flags", () => {
    expect(
      parseCliArgs([
        "inspect",
        "--budgets",
        "--plugin",
        "plugin-a",
        "--generation",
        "3",
        "--json",
        "--socket",
        "/tmp/bitty.sock",
        "--instance",
        "dev",
      ]),
    ).toEqual({
      kind: "inspect",
      options: {
        selector: "budgets",
        plugin: "plugin-a",
        generation: 3,
        json: true,
        socket: "/tmp/bitty.sock",
        instance: "dev",
        watch: false,
        intervalMs: null,
        maxTicks: null,
      },
    });
  });

  test("rejects a missing selector", () => {
    expect(() => parseCliArgs(["inspect"])).toThrow(CliUsageError);
  });

  test("rejects multiple selectors", () => {
    expect(() =>
      parseCliArgs(["inspect", "--plugins", "--budgets", "--plugin", "p"]),
    ).toThrow(CliUsageError);
  });

  test("requires --plugin for --budgets and --subscriptions", () => {
    expect(() => parseCliArgs(["inspect", "--budgets"])).toThrow(CliUsageError);
    expect(() => parseCliArgs(["inspect", "--subscriptions"])).toThrow(
      CliUsageError,
    );
  });

  test("rejects a bad generation and unknown arguments", () => {
    expect(() =>
      parseCliArgs(["inspect", "--plugins", "--generation", "0"]),
    ).toThrow(CliUsageError);
    expect(() =>
      parseCliArgs(["inspect", "--plugins", "--generation", "abc"]),
    ).toThrow(CliUsageError);
    expect(() => parseCliArgs(["inspect", "--plugins", "--nope"])).toThrow(
      CliUsageError,
    );
    expect(() => parseCliArgs(["bogus"])).toThrow(CliUsageError);
    expect(() => parseCliArgs(["inspect", "--plugin"])).toThrow(CliUsageError);
    // N4: a following flag is rejected, not consumed as the value.
    expect(() =>
      parseCliArgs(["inspect", "--subscriptions", "--plugin", "--json"]),
    ).toThrow(CliUsageError);
  });
});

describe("runCli dispatch over an injected transport", () => {
  test("--plugins renders a table and sends the RFC request", () => {
    const transport = makeTransport();
    transport.injectResponsePayload(
      responsePayload(1, { plugins: [pluginPayload()] }),
    );
    const harness = makeHarness(transport);
    const code = runCli(["inspect", "--plugins"], harness.deps);

    expect(code).toBe(EXIT_OK);
    expect(harness.err).toEqual([]);
    expect(harness.out.join("")).toContain("ID");
    expect(harness.out.join("")).toContain("plugin-a");
    expect(harness.out.join("")).toContain("Activated");

    expect(transport.calls.length).toBe(1);
    expect(transport.calls[0]!.method).toBe("bitty.debug/listPlugins");
    expect(transport.calls[0]!.params).toEqual({ generation: null });
  });

  test("--plugins --json emits parseable bounded JSON", () => {
    const transport = makeTransport();
    transport.injectResponsePayload(
      responsePayload(1, { plugins: [pluginPayload()] }),
    );
    const harness = makeHarness(transport);
    const code = runCli(["inspect", "--plugins", "--json"], harness.deps);
    expect(code).toBe(EXIT_OK);
    const parsed = JSON.parse(harness.out.join("")) as Array<{ id: string }>;
    expect(parsed.length).toBe(1);
    expect(parsed[0]!.id).toBe("plugin-a");
  });

  test("--subscriptions renders the subscription table", () => {
    const transport = makeTransport();
    transport.injectResponsePayload(
      responsePayload(1, [subscriptionPayload()]),
    );
    const harness = makeHarness(transport);
    const code = runCli(
      ["inspect", "--subscriptions", "--plugin", "plugin-a"],
      harness.deps,
    );
    expect(code).toBe(EXIT_OK);
    const output = harness.out.join("");
    expect(output).toContain("EVENT TYPE");
    expect(output).toContain("bitty.panel:mounted");
    expect(output).toContain("DropOldest");
  });

  test("--budgets defaults to generation 1 and renders key/value rows", () => {
    const transport = makeTransport();
    transport.injectResponsePayload(responsePayload(1, budgetPayload()));
    const harness = makeHarness(transport);
    const code = runCli(
      ["inspect", "--budgets", "--plugin", "plugin-a"],
      harness.deps,
    );
    expect(code).toBe(EXIT_OK);
    const output = harness.out.join("");
    expect(output).toContain("rc1Instructions");
    expect(output).toContain("wouldExceedLuaLimits");

    expect(transport.calls[0]!.method).toBe("bitty.debug/getBudgets");
    expect(transport.calls[0]!.params).toEqual({
      pluginId: "plugin-a",
      generation: DEFAULT_GENERATION,
    });
  });

  test("bounds oversized table cells", () => {
    const transport = makeTransport();
    const huge = "x".repeat(MAX_CELL_CHARS + 50);
    transport.injectResponsePayload(
      responsePayload(1, { plugins: [pluginPayload({ id: huge })] }),
    );
    const harness = makeHarness(transport);
    expect(runCli(["inspect", "--plugins"], harness.deps)).toBe(EXIT_OK);
    const output = harness.out.join("");
    expect(output).toContain(`${"x".repeat(MAX_CELL_CHARS - 3)}...`);
    expect(output).not.toContain(huge);
  });

  test("--json bounds oversized string fields like the table path", () => {
    const transport = makeTransport();
    const huge = "y".repeat(MAX_CELL_CHARS + 40);
    transport.injectResponsePayload(
      responsePayload(1, { plugins: [pluginPayload({ id: huge })] }),
    );
    const harness = makeHarness(transport);
    expect(runCli(["inspect", "--plugins", "--json"], harness.deps)).toBe(
      EXIT_OK,
    );
    const parsed = JSON.parse(harness.out.join("")) as Array<{ id: string }>;
    expect(parsed[0]!.id.endsWith("...")).toBe(true);
    expect(parsed[0]!.id.length).toBe(MAX_CELL_CHARS);
    expect(harness.out.join("")).not.toContain(huge);
  });

  test("surfaces a typed server scope error and maps it to exit 7", () => {
    const transport = makeTransport();
    transport.injectResponsePayload(
      errorPayload(1, "scope", "ScopeDenied", "scope denied"),
    );
    const harness = makeHarness(transport);
    const code = runCli(["inspect", "--plugins"], harness.deps);
    expect(code).toBe(EXIT_PERM);
    expect(harness.err.join("")).toContain("ScopeDenied");
    expect(harness.out).toEqual([]);
  });

  test("fails closed on an unimplemented server method (exit 1, no rows)", () => {
    const transport = makeTransport();
    transport.injectResponsePayload(
      errorPayload(1, "usage", "MethodNotFound", "unknown method"),
    );
    const harness = makeHarness(transport);
    const code = runCli(["inspect", "--plugins"], harness.deps);
    expect(code).toBe(EXIT_GENERIC);
    expect(harness.err.join("")).toContain("MethodNotFound");
    expect(harness.out).toEqual([]);
  });
});

describe("runCli fail-closed connection handling", () => {
  test("no transport and no instance selection exits 6 with a clear remedy", () => {
    const harness = makeHarness();
    const code = runCli(["inspect", "--plugins"], harness.deps);
    expect(code).toBe(EXIT_RUNTIME);
    expect(harness.out).toEqual([]);
    expect(harness.err.join("")).toContain("no connected Bitty instance");
    expect(harness.err.join("")).toContain("BITTY_SOCKET");
  });

  test("usage errors exit 2 and include the help text", () => {
    const harness = makeHarness();
    const code = runCli(["inspect", "--budgets"], harness.deps);
    expect(code).toBe(EXIT_USAGE);
    expect(harness.err.join("")).toContain("--plugin");
    expect(harness.err.join("")).toContain("Usage:");
  });

  test("resolves the socket from XDG_RUNTIME_DIR and fails closed when the live reader has no frame", () => {
    const harness = makeHarness();
    harness.deps.runtime.env = { XDG_RUNTIME_DIR: "/run/user/1000" };
    const code = runCli(["inspect", "--plugins"], harness.deps);
    // The transport connects but no live socket reader supplies a response yet:
    // the CLI must fail closed rather than fabricate rows.
    expect(code).toBe(EXIT_RUNTIME);
    expect(harness.err.join("")).toContain("TransportClosed");
  });

  test("invalid --instance fails closed with exit 2, never a stack trace", () => {
    const harness = makeHarness();
    let caught: unknown = null;
    let code = -1;
    try {
      code = runCli(
        ["inspect", "--plugins", "--instance", "bad id!"],
        harness.deps,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeNull();
    expect(code).toBe(EXIT_USAGE);
    expect(harness.out).toEqual([]);
    expect(harness.err.join("")).toContain("instanceId");
    expect(harness.err.join("")).not.toContain("\n    at ");
  });

  test("invalid BITTY_INSTANCE_ID fails closed with exit 3, never a stack trace", () => {
    const harness = makeHarness();
    harness.deps.runtime.env = {
      XDG_RUNTIME_DIR: "/run/user/1000",
      BITTY_INSTANCE_ID: "bad id!",
    };
    let caught: unknown = null;
    let code = -1;
    try {
      code = runCli(["inspect", "--plugins"], harness.deps);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeNull();
    expect(code).toBe(EXIT_CONFIG);
    expect(harness.out).toEqual([]);
    expect(harness.err.join("")).toContain("instanceId");
    expect(harness.err.join("")).not.toContain("\n    at ");
  });

  test("overlong BITTY_SOCKET fails closed with exit 3", () => {
    const harness = makeHarness();
    harness.deps.runtime.env = { BITTY_SOCKET: "s".repeat(600) };
    const code = runCli(["inspect", "--plugins"], harness.deps);
    expect(code).toBe(EXIT_CONFIG);
    expect(harness.err.join("")).toContain("BITTY_SOCKET");
  });
});

describe("runCliLive over a loopback socket (CTX-0036)", () => {
  test("inspect --plugins renders live rows end to end", async () => {
    const proc = globalThis.process as unknown as {
      getBuiltinModule(id: string): {
        mkdirSync(p: string, o: unknown): void;
        chmodSync(p: string, m: number): void;
        rmSync(p: string, o: unknown): void;
      };
    };
    const fs = proc.getBuiltinModule("node:fs");
    const dir = `${process.env["XDG_RUNTIME_DIR"] ?? "/tmp"}/bitty-devtools-cli-ctx0036-${process.pid}`;
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o700);
    const socketPath = `${dir}/loopback.sock`;
    const responsePayloadBytes = new TextEncoder().encode(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { plugins: [pluginPayload()] },
        version: "1.0",
      }),
    );
    const wire = new Uint8Array(4 + responsePayloadBytes.length);
    new DataView(wire.buffer).setUint32(0, responsePayloadBytes.length, false);
    wire.set(responsePayloadBytes, 4);
    const server = Bun.listen({
      unix: socketPath,
      socket: {
        data(sock, _data) {
          sock.write(wire);
        },
        error() {},
      },
    });
    fs.chmodSync(socketPath, 0o600);
    try {
      const harness = makeHarness();
      harness.deps.runtime.env = { BITTY_SOCKET: socketPath };
      const code = await runCliLive(["inspect", "--plugins"], harness.deps);
      expect(code).toBe(EXIT_OK);
      expect(harness.err).toEqual([]);
      expect(harness.out.join("")).toContain("plugin-a");
      expect(harness.out.join("")).toContain("Activated");
    } finally {
      server.stop(true);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing socket attestation fails closed with exit 7, never a throw", async () => {
    const harness = makeHarness();
    harness.deps.runtime.env = {
      BITTY_SOCKET: `/tmp/bitty-devtools-cli-ctx0036-missing-${process.pid}.sock`,
    };
    let caught: unknown = null;
    let code = -1;
    try {
      code = await runCliLive(["inspect", "--plugins"], harness.deps);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeNull();
    expect(code).toBe(EXIT_PERM);
    expect(harness.out).toEqual([]);
    expect(harness.err.join("")).toContain("Unauthenticated");
  });
});

describe("exitCodeForError", () => {
  test("maps usage to 2, config to its code, and unknown errors to 1", () => {
    expect(exitCodeForError(new CliUsageError("bad"))).toBe(EXIT_USAGE);
    expect(exitCodeForError(new CliConfigError("bad", EXIT_CONFIG))).toBe(
      EXIT_CONFIG,
    );
    expect(exitCodeForError(new CliConfigError("bad", EXIT_USAGE))).toBe(
      EXIT_USAGE,
    );
    expect(exitCodeForError(new Error("boom"))).toBe(EXIT_GENERIC);
  });
});

describe("wire-trace flag contract N1-N15", () => {
  test("N1 trace verbs without --wire-trace exit 2", () => {
    expect(() => parseCliArgs(["trace", "start"])).toThrow(CliUsageError);
    expect(() =>
      parseCliArgs(["trace", "stop", "--trace-id", "trace-1"]),
    ).toThrow(CliUsageError);
    expect(() =>
      parseCliArgs([
        "trace",
        "fetch-chunk",
        "--trace-id",
        "trace-1",
        "--offset",
        "0",
      ]),
    ).toThrow(CliUsageError);
    const h1 = makeHarness();
    expect(runCli(["trace", "start"], h1.deps)).toBe(EXIT_USAGE);
    expect(h1.err.join("")).toContain("Usage:");
    expect(h1.out).toEqual([]);
    const h2 = makeHarness();
    expect(runCli(["trace", "stop", "--trace-id", "trace-1"], h2.deps)).toBe(
      EXIT_USAGE,
    );
    expect(h2.err.join("")).toContain("Usage:");
    expect(h2.out).toEqual([]);
  });

  test("N1 live trace without --wire-trace exits 2", async () => {
    const h = makeHarness();
    expect(
      await runCliLive(
        ["trace", "start", "--duration-ms", "100", "--max-bytes", "1024"],
        h.deps,
      ),
    ).toBe(EXIT_USAGE);
    expect(h.err.join("")).toContain("Usage:");
    expect(h.out).toEqual([]);
  });

  test("N2 inspect with --wire-trace and trace companions exits 2", () => {
    expect(() =>
      parseCliArgs(["inspect", "--plugins", "--wire-trace"]),
    ).toThrow(CliUsageError);
    expect(() =>
      parseCliArgs(["inspect", "--plugins", "--duration-ms", "100"]),
    ).toThrow(CliUsageError);
    expect(() =>
      parseCliArgs(["inspect", "--plugins", "--max-bytes", "1024"]),
    ).toThrow(CliUsageError);
    expect(() =>
      parseCliArgs(["inspect", "--plugins", "--include-input"]),
    ).toThrow(CliUsageError);
    expect(() =>
      parseCliArgs(["inspect", "--plugins", "--trace-id", "trace-1"]),
    ).toThrow(CliUsageError);
    expect(() =>
      parseCliArgs(["inspect", "--plugins", "--offset", "0"]),
    ).toThrow(CliUsageError);
    const h = makeHarness();
    expect(runCli(["inspect", "--plugins", "--wire-trace"], h.deps)).toBe(
      EXIT_USAGE,
    );
    expect(h.err.join("")).toContain("Usage:");
    expect(h.out).toEqual([]);
  });

  test("N3 --wire-trace value forms exit 2", () => {
    expect(() =>
      parseCliArgs(["trace", "start", "--wire-trace=false"]),
    ).toThrow(CliUsageError);
    expect(() => parseCliArgs(["trace", "start", "--wire-trace=0"])).toThrow(
      CliUsageError,
    );
    expect(() => parseCliArgs(["trace", "start", "--wire-trace=1"])).toThrow(
      CliUsageError,
    );
    expect(() =>
      parseCliArgs(["trace", "start", "--wire-trace", "false"]),
    ).toThrow(CliUsageError);
    expect(() =>
      parseCliArgs(["trace", "stop", "--wire-trace=false", "--trace-id", "t"]),
    ).toThrow(CliUsageError);
    const h = makeHarness();
    expect(runCli(["trace", "start", "--wire-trace=false"], h.deps)).toBe(
      EXIT_USAGE,
    );
    expect(h.err.join("")).toContain("Usage:");
  });

  test("N4 flag-as-value for trace companions exits 2", () => {
    expect(() =>
      parseCliArgs([
        "trace",
        "start",
        "--wire-trace",
        "--duration-ms",
        "--json",
      ]),
    ).toThrow(CliUsageError);
    expect(() =>
      parseCliArgs(["trace", "start", "--wire-trace", "--max-bytes", "--json"]),
    ).toThrow(CliUsageError);
    expect(() =>
      parseCliArgs(["trace", "stop", "--wire-trace", "--trace-id", "--json"]),
    ).toThrow(CliUsageError);
    expect(() =>
      parseCliArgs([
        "trace",
        "fetch-chunk",
        "--wire-trace",
        "--trace-id",
        "t",
        "--offset",
        "--json",
      ]),
    ).toThrow(CliUsageError);
  });

  test("N5 inspect scope cannot use trace methods exit 7", () => {
    const c = new DevtoolsClient();
    c.connect();
    c.grantScope("debug.inspect");
    expect(() => c.startTrace({})).toThrow("debug.trace scope required");
    let code: number | null = null;
    try {
      c.startTrace({});
    } catch (e) {
      code = exitCodeForError(e);
    }
    expect(code).toBe(EXIT_PERM);
    expect(exitCodeForError(new TracingError("ScopeDenied", "denied"))).toBe(
      EXIT_PERM,
    );
    expect(exitCodeForError(new BoundError("offset", 10, 5))).toBe(
      EXIT_GENERIC,
    );
    c.disconnect();
  });

  test("N6 bad --duration-ms exits 2", () => {
    for (const bad of ["0", "1.5", "abc", "300001", "1000000", ""]) {
      expect(() =>
        parseCliArgs(["trace", "start", "--wire-trace", "--duration-ms", bad]),
      ).toThrow(CliUsageError);
    }
    expect(() =>
      parseCliArgs([
        "trace",
        "start",
        "--wire-trace",
        "--duration-ms",
        "--json",
      ]),
    ).toThrow(CliUsageError);
    const h = makeHarness();
    expect(
      runCli(["trace", "start", "--wire-trace", "--duration-ms", "0"], h.deps),
    ).toBe(EXIT_USAGE);
    expect(h.err.join("")).toContain("Usage:");
  });

  test("N7 bad --max-bytes exits 2", () => {
    for (const bad of ["0", "abc", "1.5", "4194305", "10000000"]) {
      expect(() =>
        parseCliArgs(["trace", "start", "--wire-trace", "--max-bytes", bad]),
      ).toThrow(CliUsageError);
    }
    const h = makeHarness();
    expect(
      runCli(["trace", "start", "--wire-trace", "--max-bytes", "0"], h.deps),
    ).toBe(EXIT_USAGE);
    expect(h.err.join("")).toContain("Usage:");
  });

  test("N8 bad --offset exits 2 at parse", () => {
    for (const bad of ["abc", "1.5", "NaN"]) {
      expect(() =>
        parseCliArgs([
          "trace",
          "fetch-chunk",
          "--wire-trace",
          "--trace-id",
          "trace-1",
          "--offset",
          bad,
        ]),
      ).toThrow(CliUsageError);
    }
    expect(() =>
      parseCliArgs([
        "trace",
        "fetch-chunk",
        "--wire-trace",
        "--trace-id",
        "trace-1",
        "--offset",
        "--json",
      ]),
    ).toThrow(CliUsageError);
    const h = makeHarness();
    expect(
      runCli(
        [
          "trace",
          "fetch-chunk",
          "--wire-trace",
          "--trace-id",
          "trace-1",
          "--offset",
          "abc",
        ],
        h.deps,
      ),
    ).toBe(EXIT_USAGE);
  });

  test("N9 includeInput defaults false and redaction still applies", () => {
    const parsed = parseCliArgs(["trace", "start", "--wire-trace"]);
    expect(parsed).toEqual({
      kind: "trace-start",
      options: {
        durationMs: DEFAULT_TRACE_DURATION_MS,
        maxBytes: DEFAULT_TRACE_MAX_BYTES,
        includeInput: false,
        json: false,
        socket: null,
        instance: null,
      },
    });
    const withInput = parseCliArgs([
      "trace",
      "start",
      "--wire-trace",
      "--include-input",
    ]);
    expect(withInput).toEqual({
      kind: "trace-start",
      options: {
        durationMs: DEFAULT_TRACE_DURATION_MS,
        maxBytes: DEFAULT_TRACE_MAX_BYTES,
        includeInput: true,
        json: false,
        socket: null,
        instance: null,
      },
    });
    const c = new DevtoolsClient();
    c.connect();
    c.grantScope("debug.trace");
    const s = c.startTrace({ maxBytes: 1024, includeInput: true });
    c.appendToTrace(s.traceId, "password=example");
    const chunk = c.fetchTraceChunk(s.traceId, 0);
    expect(chunk.chunk).toBe("[REDACTED]");
    expect(chunk.chunk).not.toContain("example");
    c.stopTrace(s.traceId);
    c.disconnect();
  });

  test("N10 secret absent spool 0600 and tampered export fails", async () => {
    expect(DIR_MODE).toBe(0o700);
    expect(SOCKET_MODE).toBe(0o600);
    const c = new DevtoolsClient();
    c.connect();
    c.grantScope("debug.trace");
    const s = c.startTrace({ maxBytes: 4096 });
    c.appendToTrace(s.traceId, "password=example-secret-value");
    const fetched = c.fetchTraceChunk(s.traceId, 0);
    expect(fetched.chunk).not.toContain("example-secret-value");
    expect(fetched.preview).not.toContain("example-secret-value");
    const stopped = c.stopTrace(s.traceId);
    expect(stopped.spoolMode).toBe("memory");
    expect(stopped.previews.join("")).not.toContain("example-secret-value");
    const s2 = c.startTrace({ maxBytes: 1024 });
    c.appendToTrace(s2.traceId, "hello");
    const preview = c.exportTracePreview(s2.traceId);
    expect(preview.spoolMode).toBe("memory");
    let tampered: string | null = null;
    try {
      const { assertPreviewMatchesExport } = await import("../src/tracing.js");
      assertPreviewMatchesExport(preview.preview, "tampered-bytes");
    } catch (e) {
      tampered = e instanceof TracingError ? e.code : "threw";
    }
    expect(tampered).toBe("PreviewMismatch");
    c.stopTrace(s2.traceId);
    c.disconnect();
  });

  test("N11 UTF-8 byte bounds stay scalar safe", () => {
    const enc = new TextEncoder();
    expect("é".length).toBe(1);
    expect(enc.encode("é").length).toBe(2);
    expect("中".length).toBe(1);
    expect(enc.encode("中").length).toBe(3);
    const c = new DevtoolsClient();
    c.connect();
    c.grantScope("debug.trace");
    const s = c.startTrace({ maxBytes: 1024 });
    c.appendToTrace(s.traceId, "aé中");
    expect(enc.encode("aé中").length).toBe(6);
    const p0 = c.fetchTraceChunk(s.traceId, 0);
    expect(p0.chunk).toBe("aé中");
    const p1 = c.fetchTraceChunk(s.traceId, 1);
    expect(p1.chunk).toBe("é中");
    expect(() => c.fetchTraceChunk(s.traceId, 2)).toThrow();
    c.stopTrace(s.traceId);
    c.disconnect();
  });

  test("N12 env and bearer do not enable wire trace", () => {
    const h1 = makeHarness();
    h1.deps.runtime.env = { BITTY_WIRE_TRACE: "1" };
    expect(runCli(["trace", "start"], h1.deps)).toBe(EXIT_USAGE);
    expect(h1.out).toEqual([]);
    const h2 = makeHarness();
    h2.deps.runtime.env = { BITTY_CTL_ELEVATE: "1" };
    expect(runCli(["trace", "start"], h2.deps)).toBe(EXIT_USAGE);
    expect(h2.out).toEqual([]);
    expect(() =>
      parseCliArgs(["trace", "start", "--wire-trace", "--bearer", "x"]),
    ).toThrow(CliUsageError);
    expect(() =>
      parseCliArgs(["inspect", "--plugins", "--wire-trace"]),
    ).toThrow(CliUsageError);
  });

  test("N13 trace with no socket exits 6 never mock", () => {
    const h1 = makeHarness();
    expect(runCli(["trace", "start", "--wire-trace"], h1.deps)).toBe(
      EXIT_RUNTIME,
    );
    expect(h1.out).toEqual([]);
    expect(h1.err.join("")).toContain("no connected Bitty instance");
    const h2 = makeHarness();
    const t = makeTransport();
    h2.deps.transport = t;
    expect(
      runCli(["trace", "start", "--wire-trace", "--socket", "/tmp/x.sock"], {
        runtime: h2.deps.runtime,
        transport: t,
      }),
    ).toBe(EXIT_RUNTIME);
    expect(h2.out).toEqual([]);
  });

  test("N13 live trace with no socket exits 6", async () => {
    const h = makeHarness();
    expect(await runCliLive(["trace", "start", "--wire-trace"], h.deps)).toBe(
      EXIT_RUNTIME,
    );
    expect(h.out).toEqual([]);
    expect(h.err.join("")).toContain("inspect-only");
  });

  test("N14 rate and frame shedding fail closed with counted drops", () => {
    const c = new DevtoolsClient();
    c.connect();
    c.grantScope("debug.trace");
    const s = c.startTrace({ maxBytes: 10 });
    c.appendToTrace(s.traceId, "hello");
    c.appendToTrace(s.traceId, "world!");
    const stopped = c.stopTrace(s.traceId);
    expect(stopped.byteCount).toBe(5);
    expect(stopped.dropCount).toBe(1);
    expect(stopped.truncated).toBe(true);
    c.disconnect();
  });

  test("N15 missing trace-id unknown verb and flag exit 2", () => {
    expect(() => parseCliArgs(["trace", "stop", "--wire-trace"])).toThrow(
      CliUsageError,
    );
    expect(() =>
      parseCliArgs(["trace", "fetch-chunk", "--wire-trace", "--trace-id", "t"]),
    ).toThrow(CliUsageError);
    expect(() => parseCliArgs(["trace", "bogus", "--wire-trace"])).toThrow(
      CliUsageError,
    );
    expect(() => parseCliArgs(["trace"])).toThrow(CliUsageError);
    expect(() =>
      parseCliArgs(["trace", "start", "--wire-trace", "--bogus"]),
    ).toThrow(CliUsageError);
    expect(() =>
      parseCliArgs(["trace", "start", "--wire-trace", "--retention-ms", "100"]),
    ).toThrow(CliUsageError);
    const h = makeHarness();
    expect(runCli(["trace", "stop", "--wire-trace"], h.deps)).toBe(EXIT_USAGE);
    expect(h.err.join("")).toContain("Usage:");
    expect(h.out).toEqual([]);
  });

  test("trace start live with fake transport succeeds without mock rows", async () => {
    const transport = makeTransport();
    const h = makeHarness(transport);
    const code = await runCliLive(
      ["trace", "start", "--wire-trace", "--socket", "/tmp/fake-trace.sock"],
      h.deps,
    );
    expect(code).toBe(EXIT_OK);
    expect(h.err).toEqual([]);
    expect(h.out.join("")).toContain("trace-");
    expect(h.out.join("")).toContain("262144");
  });
});

describe("inspect --watch mode per accepted design A4 (CTX-0072)", () => {
  test("W1 parses --watch with defaults (interval null, max-ticks null)", () => {
    expect(parseCliArgs(["inspect", "--plugins", "--watch"])).toEqual({
      kind: "inspect",
      options: {
        selector: "plugins",
        plugin: null,
        generation: null,
        json: false,
        socket: null,
        instance: null,
        watch: true,
        intervalMs: null,
        maxTicks: null,
      },
    });
    expect(DEFAULT_WATCH_INTERVAL_MS).toBe(2000);
    expect(WATCH_FLOOR_MS).toBe(1000);
    expect(WATCH_CEILING_MS).toBe(60000);
    expect(WATCH_JITTER_FRACTION).toBe(0.1);
    expect(WATCH_MAX_TICKS).toBe(1000);
  });

  test("W1 parses --watch with explicit interval and max-ticks", () => {
    expect(
      parseCliArgs([
        "inspect",
        "--budgets",
        "--plugin",
        "plugin-a",
        "--watch",
        "--interval-ms",
        "3000",
        "--max-ticks",
        "4",
      ]),
    ).toEqual({
      kind: "inspect",
      options: {
        selector: "budgets",
        plugin: "plugin-a",
        generation: null,
        json: false,
        socket: null,
        instance: null,
        watch: true,
        intervalMs: 3000,
        maxTicks: 4,
      },
    });
  });

  test("W2 --watch without a selector, with unknown flags, or flag-as-value exits 2", () => {
    expect(() => parseCliArgs(["--watch"])).toThrow(CliUsageError);
    expect(() => parseCliArgs(["inspect", "--watch"])).toThrow(CliUsageError);
    expect(() =>
      parseCliArgs(["inspect", "--plugins", "--watch", "--wire-trace"]),
    ).toThrow(CliUsageError);
    expect(() =>
      parseCliArgs(["inspect", "--plugins", "--watch", "--duration-ms", "100"]),
    ).toThrow(CliUsageError);
    expect(() =>
      parseCliArgs(["inspect", "--plugins", "--watch", "--max-bytes", "1024"]),
    ).toThrow(CliUsageError);
    expect(() =>
      parseCliArgs(["inspect", "--plugins", "--watch", "--include-input"]),
    ).toThrow(CliUsageError);
    expect(() =>
      parseCliArgs(["inspect", "--plugins", "--watch", "--trace-id", "t"]),
    ).toThrow(CliUsageError);
    expect(() =>
      parseCliArgs(["inspect", "--plugins", "--watch", "--offset", "0"]),
    ).toThrow(CliUsageError);
    expect(() =>
      parseCliArgs(["inspect", "--plugins", "--watch", "--bearer", "x"]),
    ).toThrow(CliUsageError);
    expect(() =>
      parseCliArgs([
        "inspect",
        "--plugins",
        "--watch",
        "--interval-ms",
        "--json",
      ]),
    ).toThrow(CliUsageError);
    expect(() =>
      parseCliArgs([
        "inspect",
        "--plugins",
        "--watch",
        "--max-ticks",
        "--json",
      ]),
    ).toThrow(CliUsageError);
    const h = makeHarness();
    expect(runCli(["inspect", "--watch"], h.deps)).toBe(EXIT_USAGE);
    expect(h.err.join("")).toContain("Usage:");
    expect(h.out).toEqual([]);
  });

  test("W2 interval/max-ticks without --watch exits 2 (single-shot takes no watch flags)", () => {
    expect(() =>
      parseCliArgs(["inspect", "--plugins", "--interval-ms", "2000"]),
    ).toThrow(CliUsageError);
    expect(() =>
      parseCliArgs(["inspect", "--plugins", "--max-ticks", "3"]),
    ).toThrow(CliUsageError);
    const h = makeHarness();
    expect(
      runCli(["inspect", "--plugins", "--interval-ms", "2000"], h.deps),
    ).toBe(EXIT_USAGE);
    expect(h.err.join("")).toContain("Usage:");
    expect(h.out).toEqual([]);
  });

  test("W3 bad --interval-ms exits 2 (floor 1000, ceiling 60000)", () => {
    for (const bad of ["0", "999", "60001", "abc", "1.5", "2000ms", ""]) {
      expect(() =>
        parseCliArgs(["inspect", "--plugins", "--watch", "--interval-ms", bad]),
      ).toThrow(CliUsageError);
    }
    expect(() =>
      parseCliArgs([
        "inspect",
        "--plugins",
        "--watch",
        "--interval-ms",
        "--json",
      ]),
    ).toThrow(CliUsageError);
    expect(
      parseCliArgs([
        "inspect",
        "--plugins",
        "--watch",
        "--interval-ms",
        "1000",
      ]),
    ).toEqual(
      expect.objectContaining({
        kind: "inspect",
        options: expect.objectContaining({ intervalMs: 1000 }),
      }),
    );
    expect(
      parseCliArgs([
        "inspect",
        "--plugins",
        "--watch",
        "--interval-ms",
        "60000",
      ]),
    ).toEqual(
      expect.objectContaining({
        kind: "inspect",
        options: expect.objectContaining({ intervalMs: 60000 }),
      }),
    );
    const h = makeHarness();
    expect(
      runCli(
        ["inspect", "--plugins", "--watch", "--interval-ms", "500"],
        h.deps,
      ),
    ).toBe(EXIT_USAGE);
    expect(h.err.join("")).toContain("Usage:");
    expect(h.out).toEqual([]);
  });

  test("W3 bad --max-ticks exits 2 (1..1000)", () => {
    for (const bad of ["0", "1001", "abc", "1.5", "-3", ""]) {
      expect(() =>
        parseCliArgs(["inspect", "--plugins", "--watch", "--max-ticks", bad]),
      ).toThrow(CliUsageError);
    }
    const h = makeHarness();
    expect(
      runCli(["inspect", "--plugins", "--watch", "--max-ticks", "0"], h.deps),
    ).toBe(EXIT_USAGE);
    expect(h.err.join("")).toContain("Usage:");
    expect(h.out).toEqual([]);
  });

  test("W3 jitter clamps to +-10% of the interval", () => {
    expect(watchTickDelayMs(2000, 0)).toBeCloseTo(1800);
    expect(watchTickDelayMs(2000, 0.5)).toBeCloseTo(2000);
    expect(watchTickDelayMs(2000, 1)).toBeCloseTo(2200);
    expect(watchTickDelayMs(1000, 0)).toBe(900);
    expect(watchTickDelayMs(60000, 1)).toBe(66000);
    for (const r of [0, 0.13, 0.5, 0.87, 1]) {
      const delay = watchTickDelayMs(2000, r);
      expect(delay).toBeGreaterThanOrEqual(1800);
      expect(delay).toBeLessThanOrEqual(2200);
    }
  });

  test("W4 sync runCli with --watch exits 2 (async entry required), single-shot unchanged", () => {
    const transport = makeTransport();
    transport.injectResponsePayload(
      responsePayload(1, { plugins: [pluginPayload()] }),
    );
    const harness = makeHarness(transport);
    const code = runCli(["inspect", "--plugins", "--watch"], harness.deps);
    expect(code).toBe(EXIT_USAGE);
    expect(harness.out).toEqual([]);
    expect(harness.err.join("")).toContain("async entry");
    expect(transport.calls).toEqual([]);

    const single = makeTransport();
    single.injectResponsePayload(
      responsePayload(1, { plugins: [pluginPayload()] }),
    );
    const singleHarness = makeHarness(single);
    expect(runCli(["inspect", "--plugins"], singleHarness.deps)).toBe(EXIT_OK);
    expect(single.calls.length).toBe(1);
    expect(single.calls[0]!.method).toBe("bitty.debug/listPlugins");
  });

  test("W5 watch emits one inspect dispatch per tick via the existing path", async () => {
    const transport = makeTransport();
    transport.injectResponsePayload(
      responsePayload(1, { plugins: [pluginPayload()] }),
    );
    transport.injectResponsePayload(
      responsePayload(2, { plugins: [pluginPayload({ id: "plugin-b" })] }),
    );
    const harness = makeHarness(transport);
    const delays: number[] = [];
    const code = await runCliWatch(
      ["inspect", "--plugins", "--watch", "--max-ticks", "2"],
      {
        runtime: harness.deps.runtime,
        transport,
        watch: {
          random01: () => 0.5,
          sleep: async () => {},
          onTick: (_tick, delayMs) => delays.push(delayMs),
        },
      },
    );
    expect(code).toBe(EXIT_OK);
    expect(harness.err).toEqual([]);
    expect(transport.calls.length).toBe(2);
    expect(transport.calls[0]!.method).toBe("bitty.debug/listPlugins");
    expect(transport.calls[0]!.params).toEqual({ generation: null });
    expect(transport.calls[1]!.method).toBe("bitty.debug/listPlugins");
    expect(transport.calls[1]!.params).toEqual({ generation: null });
    const output = harness.out.join("");
    expect(output).toContain("plugin-a");
    expect(output).toContain("plugin-b");
    expect(delays.length).toBe(2);
    expect(delays[0]).toBeCloseTo(DEFAULT_WATCH_INTERVAL_MS);
  });

  test("W5 watch --subscriptions dispatches the exact method and params per tick", async () => {
    const transport = makeTransport();
    transport.injectResponsePayload(
      responsePayload(1, [subscriptionPayload()]),
    );
    const harness = makeHarness(transport);
    const code = await runCliWatch(
      [
        "inspect",
        "--subscriptions",
        "--plugin",
        "plugin-a",
        "--watch",
        "--max-ticks",
        "1",
      ],
      {
        runtime: harness.deps.runtime,
        transport,
        watch: { random01: () => 0.5, sleep: async () => {} },
      },
    );
    expect(code).toBe(EXIT_OK);
    expect(transport.calls.length).toBe(1);
    expect(transport.calls[0]!.method).toBe("bitty.debug/listSubscriptions");
    expect(transport.calls[0]!.params).toEqual({ pluginId: "plugin-a" });
    expect(harness.out.join("")).toContain("bitty.panel:mounted");
  });

  test("W5 watch --budgets uses the default generation per tick", async () => {
    const transport = makeTransport();
    transport.injectResponsePayload(responsePayload(1, budgetPayload()));
    const harness = makeHarness(transport);
    const code = await runCliWatch(
      [
        "inspect",
        "--budgets",
        "--plugin",
        "plugin-a",
        "--watch",
        "--max-ticks",
        "1",
      ],
      {
        runtime: harness.deps.runtime,
        transport,
        watch: { random01: () => 0.5, sleep: async () => {} },
      },
    );
    expect(code).toBe(EXIT_OK);
    expect(transport.calls[0]!.method).toBe("bitty.debug/getBudgets");
    expect(transport.calls[0]!.params).toEqual({
      pluginId: "plugin-a",
      generation: DEFAULT_GENERATION,
    });
  });

  test("W6 server ScopeDenied terminates the loop with exit 7 and zero further ticks", async () => {
    const transport = makeTransport();
    transport.injectResponsePayload(
      responsePayload(1, { plugins: [pluginPayload()] }),
    );
    transport.injectResponsePayload(
      errorPayload(2, "scope", "ScopeDenied", "scope denied"),
    );
    const harness = makeHarness(transport);
    const code = await runCliWatch(
      ["inspect", "--plugins", "--watch", "--max-ticks", "5"],
      {
        runtime: harness.deps.runtime,
        transport,
        watch: { random01: () => 0.5, sleep: async () => {} },
      },
    );
    expect(code).toBe(EXIT_PERM);
    expect(harness.err.join("")).toContain("ScopeDenied");
    expect(transport.calls.length).toBe(2);
    expect(harness.out.length).toBe(1);
    expect(harness.out.join("")).toContain("plugin-a");
  });

  test("W7 server RateLimited skips emission for that tick and defers to the next", async () => {
    const transport = makeTransport();
    transport.injectResponsePayload(
      errorPayload(1, "budget", "RateLimited", "slow down"),
    );
    transport.injectResponsePayload(
      responsePayload(2, { plugins: [pluginPayload()] }),
    );
    const harness = makeHarness(transport);
    let sleeps = 0;
    const code = await runCliWatch(
      ["inspect", "--plugins", "--watch", "--max-ticks", "1"],
      {
        runtime: harness.deps.runtime,
        transport,
        watch: {
          random01: () => 0.5,
          sleep: async () => {
            sleeps += 1;
          },
        },
      },
    );
    expect(code).toBe(EXIT_OK);
    expect(harness.err).toEqual([]);
    expect(transport.calls.length).toBe(2);
    expect(transport.calls[0]!.method).toBe("bitty.debug/listPlugins");
    expect(transport.calls[1]!.method).toBe("bitty.debug/listPlugins");
    expect(harness.out.length).toBe(1);
    expect(harness.out.join("")).toContain("plugin-a");
    expect(sleeps).toBe(1);
  });

  test("W7 RateLimited with zero frames settles on the pending exit 6", async () => {
    const transport = makeTransport();
    transport.injectResponsePayload(
      errorPayload(1, "budget", "RateLimited", "slow down"),
    );
    const harness = makeHarness(transport);
    const controller = new AbortController();
    const code = await runCliWatch(["inspect", "--plugins", "--watch"], {
      runtime: harness.deps.runtime,
      transport,
      watch: {
        random01: () => 0.5,
        sleep: async () => {
          controller.abort();
        },
        signal: controller.signal,
      },
    });
    expect(code).toBe(EXIT_RUNTIME);
    expect(harness.err.join("")).toContain("RateLimited");
    expect(harness.out).toEqual([]);
    expect(transport.calls.length).toBe(1);
    expect(transport.calls[0]!.method).toBe("bitty.debug/listPlugins");
  });

  test("W7 client-side RC-9 RateLimited skips the tick without emitting", async () => {
    const transport = makeTransport();
    transport.injectResponsePayload(
      responsePayload(2, { plugins: [pluginPayload()] }),
    );
    const limiter = transport.getRateLimiter();
    const original = limiter.check.bind(limiter);
    let throwOnce = true;
    limiter.check = (nowMs: number): void => {
      if (throwOnce) {
        throwOnce = false;
        throw new TransportError("RateLimited", "rate limited");
      }
      original(nowMs);
    };
    const harness = makeHarness(transport);
    const code = await runCliWatch(
      ["inspect", "--plugins", "--watch", "--max-ticks", "1"],
      {
        runtime: harness.deps.runtime,
        transport,
        watch: { random01: () => 0.5, sleep: async () => {} },
      },
    );
    expect(code).toBe(EXIT_OK);
    expect(harness.err).toEqual([]);
    expect(transport.calls.length).toBe(2);
    expect(transport.calls[0]!.id).toBe(1);
    expect(transport.calls[1]!.id).toBe(2);
    expect(harness.out.length).toBe(1);
    expect(harness.out.join("")).toContain("plugin-a");
  });

  test("W8 abort before any frame exits 6 with no partial output", async () => {
    const transport = makeTransport();
    transport.injectResponsePayload(
      responsePayload(1, { plugins: [pluginPayload()] }),
    );
    const harness = makeHarness(transport);
    const controller = new AbortController();
    controller.abort();
    const code = await runCliWatch(["inspect", "--plugins", "--watch"], {
      runtime: harness.deps.runtime,
      transport,
      watch: {
        random01: () => 0.5,
        sleep: async () => {},
        signal: controller.signal,
      },
    });
    expect(code).toBe(EXIT_RUNTIME);
    expect(harness.out).toEqual([]);
    expect(transport.calls).toEqual([]);
  });

  test("W8 abort after one frame exits 0 and keeps the complete frame", async () => {
    const transport = makeTransport();
    transport.injectResponsePayload(
      responsePayload(1, { plugins: [pluginPayload()] }),
    );
    transport.injectResponsePayload(
      responsePayload(2, { plugins: [pluginPayload({ id: "plugin-b" })] }),
    );
    const harness = makeHarness(transport);
    const controller = new AbortController();
    let seen = 0;
    const code = await runCliWatch(
      ["inspect", "--plugins", "--watch", "--max-ticks", "5"],
      {
        runtime: harness.deps.runtime,
        transport,
        watch: {
          random01: () => 0.5,
          sleep: async () => {
            seen += 1;
            if (seen >= 1) controller.abort();
          },
          signal: controller.signal,
        },
      },
    );
    expect(code).toBe(EXIT_OK);
    expect(harness.out.length).toBe(1);
    expect(harness.out.join("")).toContain("plugin-a");
    expect(harness.out.join("")).not.toContain("plugin-b");
    expect(transport.calls.length).toBe(1);
  });

  test("W8 transport close before any frame exits 6 with no partial output", async () => {
    const transport = makeTransport();
    transport.injectResponsePayload(
      responsePayload(1, { plugins: [pluginPayload()] }),
    );
    const harness = makeHarness(transport);
    const code = await runCliWatch(["inspect", "--plugins", "--watch"], {
      runtime: harness.deps.runtime,
      transport,
      watch: {
        random01: () => 0.5,
        sleep: async () => {},
        onTick: () => {
          transport.disconnect();
        },
      },
    });
    expect(code).toBe(EXIT_RUNTIME);
    expect(harness.out).toEqual([]);
    expect(transport.calls).toEqual([]);
  });

  test("W8 transport close after one frame exits 0 and discards the in-flight tick", async () => {
    const transport = makeTransport();
    transport.injectResponsePayload(
      responsePayload(1, { plugins: [pluginPayload()] }),
    );
    transport.injectResponsePayload(
      responsePayload(2, { plugins: [pluginPayload({ id: "plugin-b" })] }),
    );
    const harness = makeHarness(transport);
    const code = await runCliWatch(["inspect", "--plugins", "--watch"], {
      runtime: harness.deps.runtime,
      transport,
      watch: {
        random01: () => 0.5,
        sleep: async () => {
          transport.disconnect();
        },
      },
    });
    expect(code).toBe(EXIT_OK);
    expect(harness.err).toEqual([]);
    expect(harness.out.length).toBe(1);
    expect(harness.out.join("")).toContain("plugin-a");
    expect(harness.out.join("")).not.toContain("plugin-b");
    expect(transport.calls.length).toBe(1);
  });

  test("W8 onSignal bridge aborts the loop and detaches once", async () => {
    const transport = makeTransport();
    transport.injectResponsePayload(
      responsePayload(1, { plugins: [pluginPayload()] }),
    );
    transport.injectResponsePayload(
      responsePayload(2, { plugins: [pluginPayload({ id: "plugin-b" })] }),
    );
    const harness = makeHarness(transport);
    let abortLoop: (() => void) | null = null;
    let detached = 0;
    const code = await runCliWatch(["inspect", "--plugins", "--watch"], {
      runtime: harness.deps.runtime,
      transport,
      watch: {
        random01: () => 0.5,
        sleep: async () => {
          abortLoop?.();
        },
        onSignal: (abort) => {
          abortLoop = abort;
          return () => {
            detached += 1;
          };
        },
      },
    });
    expect(code).toBe(EXIT_OK);
    expect(harness.out.length).toBe(1);
    expect(harness.out.join("")).toContain("plugin-a");
    expect(detached).toBe(1);
  });

  test("W9 total rate-limit budget survives alternating successful frames", async () => {
    const { uid, gid, pid } = makeHarness().deps.runtime;
    const transport = new AlternatingRateLimitTransport({
      runtimeUid: uid,
      socketPath: `/run/user/${uid}/bitty/default.sock`,
      peer: peerCredentials(uid, gid, pid),
      capacity: 256,
    });
    const harness = makeHarness(transport);
    const code = await runCliWatch(
      ["inspect", "--plugins", "--watch", "--max-ticks", "1000"],
      {
        runtime: harness.deps.runtime,
        transport,
        watch: { random01: () => 0.5, sleep: async () => {} },
      },
    );
    expect(code).toBe(EXIT_OK);
    expect(transport.attempts).toBeLessThan(WATCH_MAX_FAILED_ATTEMPTS * 3);
    expect(harness.out.length).toBeGreaterThan(0);
  });

  test("W9 per-tick bounds apply and no frames are retained across ticks", async () => {
    const huge = "x".repeat(MAX_CELL_CHARS + 50);
    const transport = makeTransport();
    transport.injectResponsePayload(
      responsePayload(1, { plugins: [pluginPayload({ id: huge })] }),
    );
    transport.injectResponsePayload(
      responsePayload(2, { plugins: [pluginPayload({ id: "plugin-b" })] }),
    );
    const harness = makeHarness(transport);
    const code = await runCliWatch(
      ["inspect", "--plugins", "--watch", "--max-ticks", "2"],
      {
        runtime: harness.deps.runtime,
        transport,
        watch: { random01: () => 0.5, sleep: async () => {} },
      },
    );
    expect(code).toBe(EXIT_OK);
    expect(harness.out.length).toBe(2);
    expect(harness.out[0]).toContain(`${"x".repeat(MAX_CELL_CHARS - 3)}...`);
    expect(harness.out[0]).not.toContain(huge);
    expect(harness.out[1]).toContain("plugin-b");
    expect(harness.out[1]).not.toContain("x".repeat(10));
  });

  test("W9 strict InvalidResult fails closed with exit 1 and no partial row", async () => {
    const transport = makeTransport();
    transport.injectResponsePayload(responsePayload(1, [pluginPayload()]));
    const harness = makeHarness(transport);
    const code = await runCliWatch(
      ["inspect", "--plugins", "--watch", "--max-ticks", "3"],
      {
        runtime: harness.deps.runtime,
        transport,
        watch: { random01: () => 0.5, sleep: async () => {} },
      },
    );
    expect(code).toBe(EXIT_GENERIC);
    expect(harness.err.join("")).toContain("InvalidResult");
    expect(harness.out).toEqual([]);
  });

  test("W9 MAX_PLUGINS fail-closed: the 257th plugin exits 1 with no rows", async () => {
    const transport = makeTransport();
    const plugins = Array.from({ length: 257 }, (_, i) =>
      pluginPayload({ id: `plugin-${i}` }),
    );
    transport.injectResponsePayload(responsePayload(1, { plugins }));
    const harness = makeHarness(transport);
    const code = await runCliWatch(
      ["inspect", "--plugins", "--watch", "--max-ticks", "2"],
      {
        runtime: harness.deps.runtime,
        transport,
        watch: { random01: () => 0.5, sleep: async () => {} },
      },
    );
    expect(code).toBe(EXIT_GENERIC);
    expect(harness.err.join("")).toContain("MAX_PLUGINS");
    expect(harness.out).toEqual([]);
  });

  test("W9 MAX_SUBSCRIPTIONS fail-closed: the 33rd subscription exits 1 with no rows", async () => {
    const transport = makeTransport();
    const subs = Array.from({ length: 33 }, () => subscriptionPayload());
    transport.injectResponsePayload(responsePayload(1, subs));
    const harness = makeHarness(transport);
    const code = await runCliWatch(
      [
        "inspect",
        "--subscriptions",
        "--plugin",
        "plugin-a",
        "--watch",
        "--max-ticks",
        "2",
      ],
      {
        runtime: harness.deps.runtime,
        transport,
        watch: { random01: () => 0.5, sleep: async () => {} },
      },
    );
    expect(code).toBe(EXIT_GENERIC);
    expect(harness.err.join("")).toContain("MAX_SUBSCRIPTIONS");
    expect(harness.out).toEqual([]);
  });

  test("W10 watch pins debug.inspect: trace/control scope callers are denied", async () => {
    const { InspectionClient } = await import("../src/inspection.js");
    const { generation } = await import("../src/panel-runtime.js");
    const offline = {
      isConnected: () => false,
      request: () => {
        throw new Error("IPC must not be used when disconnected");
      },
    };
    const client = new InspectionClient(offline, null);
    expect(() => client.listPlugins("debug.trace", generation(1))).toThrow(
      "debug.inspect scope required",
    );
    expect(() => client.listPlugins("debug.control", generation(1))).toThrow(
      "debug.inspect scope required",
    );
    expect(() => client.listSubscriptions("debug.trace", "plugin-a")).toThrow(
      "debug.inspect scope required",
    );
    expect(() =>
      client.getBudgets("debug.trace", "plugin-a", generation(1)),
    ).toThrow("debug.inspect scope required");
    let traceCode: number | null = null;
    try {
      client.listPlugins("debug.trace", generation(1));
    } catch (error) {
      traceCode = exitCodeForError(error);
    }
    expect(traceCode).toBe(EXIT_PERM);
  });

  test("W10 watch never escalates: no trace/control/automation dispatch exists on the watch path", () => {
    const source = (runCliWatch as (...args: unknown[]) => unknown).toString();
    expect(source).not.toContain("startTrace");
    expect(source).not.toContain("synthesizeInput");
    const liveSource = (
      runCliLive as (...args: unknown[]) => unknown
    ).toString();
    expect(liveSource).not.toContain("startTrace");
    expect(liveSource).not.toContain("synthesizeInput");
  });

  test("W10 watch makes zero trace/control/automation calls", async () => {
    const transport = makeTransport();
    transport.injectResponsePayload(
      responsePayload(1, { plugins: [pluginPayload()] }),
    );
    transport.injectResponsePayload(
      responsePayload(2, { plugins: [pluginPayload({ id: "plugin-b" })] }),
    );
    const harness = makeHarness(transport);
    const names = [
      "startTrace",
      "startTraceWithFilter",
      "stopTrace",
      "streamEvents",
      "streamFilteredEvents",
      "fetchTraceChunk",
      "appendToTrace",
      "appendStructuredEvent",
      "suspendHandler",
      "pauseHandler",
      "resumePlugin",
      "disposeGeneration",
      "automationClient",
    ] as const;
    const proto = DevtoolsClient.prototype as unknown as Record<
      string,
      unknown
    >;
    const original = new Map<string, unknown>();
    const escalated: string[] = [];
    for (const name of names) {
      original.set(name, proto[name]);
      proto[name] = (..._args: unknown[]) => {
        escalated.push(name);
        throw new Error(`watch must not call ${name}`);
      };
    }
    try {
      const code = await runCliWatch(
        ["inspect", "--plugins", "--watch", "--max-ticks", "2"],
        {
          runtime: harness.deps.runtime,
          transport,
          watch: { random01: () => 0.5, sleep: async () => {} },
        },
      );
      expect(code).toBe(EXIT_OK);
      expect(escalated).toEqual([]);
      expect(harness.out.length).toBe(2);
    } finally {
      for (const name of names) {
        proto[name] = original.get(name);
      }
    }
  });
});
