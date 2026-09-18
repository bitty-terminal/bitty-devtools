import { describe, expect, test } from "bun:test";
import {
  CliConfigError,
  CliUsageError,
  DEFAULT_GENERATION,
  DEFAULT_TRACE_DURATION_MS,
  DEFAULT_TRACE_MAX_BYTES,
  MAX_CELL_CHARS,
  exitCodeForError,
  parseCliArgs,
  runCli,
  runCliLive,
} from "../src/cli.js";
import type { CliRuntime } from "../src/cli.js";
import { DIR_MODE, SOCKET_MODE, peerCredentials } from "../src/auth.js";
import { IpcTransport } from "../src/transport.js";
import type { IpcRequest } from "../src/transport.js";
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
    expect(output).toContain(`${"x".repeat(MAX_CELL_CHARS)}...`);
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
    expect(parsed[0]!.id.length).toBe(MAX_CELL_CHARS + 3);
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
    expect(stopped.spoolMode).toBe("0600");
    expect(stopped.previews.join("")).not.toContain("example-secret-value");
    const s2 = c.startTrace({ maxBytes: 1024 });
    c.appendToTrace(s2.traceId, "hello");
    const preview = c.exportTracePreview(s2.traceId);
    expect(preview.spoolMode).toBe("0600");
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
    expect(h.err.join("")).toContain("no connected Bitty instance");
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
