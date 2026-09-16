import { describe, expect, test } from "bun:test";
import {
  CTL_VERB_MATRIX,
  KEYSTROKE_PROBE_PAYLOAD,
  KEYSTROKE_PROBE_VERB,
  CampaignError,
  DEFAULT_ELEVATION_SCOPES,
  EXIT_CONFLICT,
  assertKeystrokeProbeTarget,
  assertSafeWorkspaceId,
  EXIT_GENERIC,
  EXIT_OK,
  EXIT_PERM,
  EXIT_RUNTIME,
  EXIT_TIMEOUT,
  EXIT_USAGE,
  NO_INSTANCE_VIEW_LIST,
  ProcessCtlDispatcher,
  ScriptedCtlDispatcher,
  detectDebugDump,
  expectedExitForError,
  isKeystrokeProbeRow,
  keystrokeProbeExpectation,
  keystrokeProbeOptIn,
  makeErrorResult,
  makeOkResult,
  makeUsageResult,
  parentDirOf,
  parseCtlEnvelope,
  panelPluginCoverageHooks,
  preflightSocketParentDir,
  probeEnvelopeConformance,
  probePanelPluginHooks,
  probeSocketDirPreflight,
  probeTerminalSpawnObservability,
  probeTerminalTextShape,
  probeWorkspaceIdRoundTrip,
  runCampaign,
  summarizeCampaign,
  terminalTextFrom,
  validateEnvelopeShape,
  workspaceCreatedFrom,
  workspaceIdCandidates,
  workspaceNamesFrom,
  type CtlInvocation,
  type CtlResult,
  type ProcessDispatcherConfig,
  type SocketDirStat,
} from "../src/campaign.js";

const DENIED = {
  class: "Denied",
  code: "ScopeDenied",
  message: "needs elevation",
};
const CONFLICT = { class: "Conflict", code: "Conflict", message: "busy" };
const UNAVAILABLE = {
  class: "Unavailable",
  code: "Transport",
  message: "no live instance",
};
const NOTFOUND = { class: "NotFound", code: "NotFound", message: "missing" };

function specialResult(invocation: CtlInvocation): CtlResult | undefined {
  switch (invocation.verb) {
    case "workspace.list.baseline":
      return makeOkResult("core.workspace.list", {
        workspaces: ["ws1"],
        active: 1,
        count: 1,
      });
    case "workspace.new":
      return makeOkResult("core.workspace.new", { created: "ws:2" });
    case "workspace.list.after-new":
      return makeOkResult("core.workspace.list", {
        workspaces: ["ws1", "ws:2"],
        active: 2,
        count: 2,
      });
    case "workspace.focus":
      return makeOkResult("core.workspace.focus", { focused: "ws:2" });
    case "terminal.text":
      return makeOkResult("core.terminal.text", {
        terminal_id: "t:1",
        text: "$ echo hi\nhi\n",
      });
    case "view.list.before":
      return makeOkResult("core.view.list", {
        views: [{ id: "v:1", focused: true }],
      });
    case "terminal.list.before":
      return makeOkResult("core.terminal.list", {
        terminals: [{ id: "t:1", has_pane_session: false }],
      });
    case "view.list.after":
      return makeOkResult("core.view.list", {
        views: [
          { id: "v:1", focused: true },
          { id: "v:2", focused: false },
        ],
      });
    case "terminal.list.after":
      return makeOkResult("core.terminal.list", {
        terminals: [
          { id: "t:1", has_pane_session: false },
          { id: "t:2", has_pane_session: true },
        ],
      });
    default:
      return undefined;
  }
}

function resultFor(invocation: CtlInvocation): CtlResult {
  const special = specialResult(invocation);
  if (special !== undefined) return special;
  const command = `core.${invocation.verb}`;
  const expectation = CTL_VERB_MATRIX.find((v) => v.verb === invocation.verb);
  if (expectation !== undefined) {
    if (invocation.elevated && expectation.outcome === "denied") {
      return makeOkResult(command, {
        spawned: true,
        closed: true,
        reloaded: true,
      });
    }
    switch (expectation.outcome) {
      case "ok":
        return makeOkResult(command, { ok: true });
      case "denied":
        return makeErrorResult(command, DENIED, EXIT_PERM);
      case "conflict":
        return makeErrorResult(command, CONFLICT, EXIT_CONFLICT);
      case "unavailable":
        return makeErrorResult(command, UNAVAILABLE, EXIT_RUNTIME);
      case "notfound":
        return makeErrorResult(command, NOTFOUND, EXIT_GENERIC);
      case "usage":
        return makeUsageResult([command]);
    }
  }
  throw new Error(`unscripted verb ${invocation.verb}`);
}

function campaignDispatcher(
  overrides: Record<string, CtlResult> = {},
): ScriptedCtlDispatcher {
  return new ScriptedCtlDispatcher(
    (inv) => overrides[inv.verb] ?? resultFor(inv),
  );
}

const OK_DIR: SocketDirStat = {
  isDirectory: true,
  isSymlink: false,
  mode: 0o700,
  ownerUid: 1000,
};

describe("campaign envelope conformance (v1 shape + exit codes)", () => {
  test("valid success and failure envelopes parse", () => {
    const ok = parseCtlEnvelope(
      JSON.stringify({
        v: 1,
        command: "core.view.list",
        ok: true,
        result: { views: [] },
      }),
    );
    expect(ok.ok).toBe(true);
    const failure = parseCtlEnvelope(
      JSON.stringify({
        v: 1,
        command: "core.terminal.spawn",
        ok: false,
        error: DENIED,
      }),
    );
    expect(failure.ok).toBe(false);
    if (!failure.ok) expect(failure.error.class).toBe("Denied");
  });

  test("malformed envelopes are rejected with a typed error", () => {
    expect(() =>
      parseCtlEnvelope(
        JSON.stringify({ v: 2, command: "x", ok: true, result: {} }),
      ),
    ).toThrow(CampaignError);
    expect(() => parseCtlEnvelope("not json")).toThrow(CampaignError);
    expect(() => parseCtlEnvelope("")).toThrow(CampaignError);
    expect(() =>
      parseCtlEnvelope(JSON.stringify({ v: 1, command: "x", ok: true })),
    ).toThrow(CampaignError);
    expect(() =>
      parseCtlEnvelope(
        JSON.stringify({ v: 1, command: "x", ok: false, error: {} }),
      ),
    ).toThrow(CampaignError);
  });

  test("shape validation reports specific problems", () => {
    expect(
      validateEnvelopeShape({ v: 1, command: "c", ok: true, result: null }),
    ).toEqual([]);
    const problems = validateEnvelopeShape({ v: 1, command: "", ok: "yes" });
    expect(problems.length).toBeGreaterThan(0);
  });

  test("exit-code table mirrors bitty ctl", () => {
    expect(expectedExitForError("Denied", "ScopeDenied")).toBe(EXIT_PERM);
    expect(expectedExitForError("Conflict", "Conflict")).toBe(EXIT_CONFLICT);
    expect(expectedExitForError("Unavailable", "Unavailable")).toBe(
      EXIT_RUNTIME,
    );
    expect(expectedExitForError("NotFound", "NotFound")).toBe(EXIT_GENERIC);
    expect(expectedExitForError("ConfigError", "ConfigError")).toBe(3);
    expect(expectedExitForError("VersionMismatch", "VersionMismatch")).toBe(5);
    expect(expectedExitForError("Error", "whatever")).toBe(EXIT_GENERIC);
  });

  test("per-verb matrix passes when envelopes and exits agree", async () => {
    const results = await probeEnvelopeConformance(campaignDispatcher());
    expect(results.every((r) => r.status === "pass")).toBe(true);
    expect(results.length).toBe(CTL_VERB_MATRIX.length);
  });

  test("no-instance view list fails closed at exit 6", async () => {
    const dispatcher = new ScriptedCtlDispatcher(() =>
      makeErrorResult("core.view.list", UNAVAILABLE, EXIT_RUNTIME),
    );
    const results = await probeEnvelopeConformance(
      dispatcher,
      NO_INSTANCE_VIEW_LIST,
    );
    expect(results[0]?.status).toBe("pass");
  });

  test("wrong exit code is a conformance failure", async () => {
    const dispatcher = campaignDispatcher({
      "terminal.spawn": makeErrorResult("core.terminal.spawn", DENIED, EXIT_OK),
    });
    const results = await probeEnvelopeConformance(dispatcher);
    const spawn = results.find((r) => r.name === "envelope:terminal.spawn");
    expect(spawn?.status).toBe("fail");
  });

  test("malformed envelope is a conformance failure", async () => {
    const dispatcher = campaignDispatcher({
      "view.list": {
        argv: ["view", "list"],
        exitCode: EXIT_OK,
        stdout: "not-json",
        stderr: "",
        timedOut: false,
      },
    });
    const results = await probeEnvelopeConformance(dispatcher);
    const view = results.find((r) => r.name === "envelope:view.list");
    expect(view?.status).toBe("fail");
  });
});

describe("workspace id round-trip guard (D2)", () => {
  test("candidates normalize the bare name form", () => {
    expect(workspaceIdCandidates("ws4")).toEqual(["ws4", "ws:4"]);
    expect(workspaceIdCandidates("ws:4")).toEqual(["ws:4"]);
  });

  test("passes when listed ids are accepted by focus", async () => {
    const result = await probeWorkspaceIdRoundTrip(campaignDispatcher());
    expect(result.status).toBe("pass");
  });

  test("flag-shaped listed id never reaches focus argv (injection)", async () => {
    // A hostile `workspace list` response (untrusted observation data) must
    // not smuggle a flag into the spawned `workspace focus` argv. The probe
    // fails closed instead of dispatching the injection.
    const seen: CtlInvocation[] = [];
    const dispatcher = new ScriptedCtlDispatcher((inv) => {
      seen.push(inv);
      if (inv.verb === "workspace.list.baseline") {
        return makeOkResult("core.workspace.list", {
          workspaces: ["ws1"],
          active: 1,
          count: 1,
        });
      }
      if (inv.verb === "workspace.new") {
        return makeOkResult("core.workspace.new", { created: "ws:2" });
      }
      if (inv.verb === "workspace.list.after-new") {
        return makeOkResult("core.workspace.list", {
          workspaces: ["--socket=/tmp/evil.sock"],
          active: 1,
          count: 1,
        });
      }
      throw new Error(`unexpected dispatch ${inv.verb}`);
    });
    const result = await probeWorkspaceIdRoundTrip(dispatcher);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("is not a workspace id");
    expect(seen.some((inv) => inv.verb === "workspace.focus")).toBe(false);
  });

  test("bare-dash and empty listed ids never reach focus argv", async () => {
    for (const hostile of ["-f", "--format=json", ""]) {
      const seen: CtlInvocation[] = [];
      const dispatcher = new ScriptedCtlDispatcher((inv) => {
        seen.push(inv);
        if (inv.verb === "workspace.list.baseline") {
          return makeOkResult("core.workspace.list", {
            workspaces: ["ws1"],
            active: 1,
            count: 1,
          });
        }
        if (inv.verb === "workspace.new") {
          return makeOkResult("core.workspace.new", { created: "ws:2" });
        }
        if (inv.verb === "workspace.list.after-new") {
          return makeOkResult("core.workspace.list", {
            workspaces: [hostile],
            active: 1,
            count: 1,
          });
        }
        throw new Error(`unexpected dispatch ${inv.verb}`);
      });
      const result = await probeWorkspaceIdRoundTrip(dispatcher);
      expect(result.status).toBe("fail");
      expect(result.detail).toContain("is not a workspace id");
      expect(seen.some((inv) => inv.verb === "workspace.focus")).toBe(false);
    }
  });

  test("assertSafeWorkspaceId accepts canonical ids, rejects the rest", () => {
    expect(() => assertSafeWorkspaceId("ws:1")).not.toThrow();
    expect(() => assertSafeWorkspaceId("ws12")).not.toThrow();
    for (const hostile of [
      "--socket=x",
      "-f",
      "--format=json",
      "ws:",
      "ws:abc",
      "ws:1;rm -rf /tmp/x",
      "ws:1 ",
      " ws:1",
      "../ws:1",
      "ws:007;echo",
      "",
    ]) {
      expect(() => assertSafeWorkspaceId(hostile)).toThrow(CampaignError);
    }
  });

  test("fails when a listed id is rejected by focus (D2 repro)", async () => {
    const dispatcher = campaignDispatcher({
      "workspace.list.after-new": makeOkResult("core.workspace.list", {
        workspaces: ["ws1", "ws4"],
        active: 2,
        count: 2,
      }),
      "workspace.focus": makeErrorResult(
        "core.workspace.focus",
        NOTFOUND,
        EXIT_GENERIC,
      ),
    });
    const result = await probeWorkspaceIdRoundTrip(dispatcher);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("rejected by focus");
  });

  test("created id must be a ws:<n> id", () => {
    const bad = parseCtlEnvelope(
      JSON.stringify({
        v: 1,
        command: "core.workspace.new",
        ok: true,
        result: { created: "ws2" },
      }),
    );
    expect(workspaceCreatedFrom(bad)).toBe("ws2");
    const names = parseCtlEnvelope(
      JSON.stringify({
        v: 1,
        command: "core.workspace.list",
        ok: true,
        result: { workspaces: ["ws1"] },
      }),
    );
    expect(workspaceNamesFrom(names)).toEqual(["ws1"]);
  });
});

describe("terminal text shape guard (D1)", () => {
  const debugDump =
    "Snapshot { version: 1, generation: 84, width: 155, height: 42, cells: [Cell { glyph: ' ', style: Style { foreground: None } }] }";

  test("detects a Rust Debug dump", () => {
    expect(detectDebugDump(debugDump)).toBe(true);
    expect(detectDebugDump("$ echo hi\nhi\n")).toBe(false);
  });

  test("passes on plain grid text", async () => {
    const result = await probeTerminalTextShape(campaignDispatcher());
    expect(result.status).toBe("pass");
  });

  test("fails on the D1 Debug dump", async () => {
    const dispatcher = campaignDispatcher({
      "terminal.text": makeOkResult("core.terminal.text", {
        terminal_id: "t:1",
        text: debugDump,
      }),
    });
    const result = await probeTerminalTextShape(dispatcher);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("Debug dump");
  });

  test("terminalTextFrom requires a string", () => {
    const envelope = parseCtlEnvelope(
      JSON.stringify({
        v: 1,
        command: "core.terminal.text",
        ok: true,
        result: {},
      }),
    );
    expect(() => terminalTextFrom(envelope)).toThrow(CampaignError);
  });
});

describe("terminal spawn observability guard (D3)", () => {
  test("passes when a new view/terminal is observable", async () => {
    const result = await probeTerminalSpawnObservability(campaignDispatcher());
    expect(result.status).toBe("pass");
  });

  test("passes when only has_pane_session flips", async () => {
    const dispatcher = campaignDispatcher({
      "view.list.after": makeOkResult("core.view.list", {
        views: [{ id: "v:1", focused: true }],
      }),
      "terminal.list.after": makeOkResult("core.terminal.list", {
        terminals: [{ id: "t:1", has_pane_session: true }],
      }),
    });
    const result = await probeTerminalSpawnObservability(dispatcher);
    expect(result.status).toBe("pass");
  });

  test("fails when spawn is a no-op (D3 repro)", async () => {
    const dispatcher = campaignDispatcher({
      "view.list.after": makeOkResult("core.view.list", {
        views: [{ id: "v:1", focused: true }],
      }),
      "terminal.list.after": makeOkResult("core.terminal.list", {
        terminals: [{ id: "t:1", has_pane_session: false }],
      }),
    });
    const result = await probeTerminalSpawnObservability(dispatcher);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("no view/terminal");
  });
});

describe("BITTY_SOCKET parent-dir 0700 preflight", () => {
  test("parentDirOf handles posix, relative, and windows paths", () => {
    expect(parentDirOf("/tmp/ctx/run/default.sock")).toBe("/tmp/ctx/run");
    expect(parentDirOf("default.sock")).toBe(".");
    expect(parentDirOf("/default.sock")).toBe("/");
    expect(parentDirOf("C:\\a\\b.sock")).toBe("C:/a");
  });

  test("mode 0755 yields an actionable diagnostic and chmod remedy", () => {
    const result = preflightSocketParentDir({
      socketPath: "/tmp/opencode/ctx/run/default.sock",
      runtimeUid: 1000,
      stat: () => ({ ...OK_DIR, mode: 0o755 }),
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostic).toContain("755");
    expect(result.diagnostic).toContain("0700");
    expect(result.remedy).toContain("chmod 700");
    expect(probeSocketDirPreflight(result).status).toBe("fail");
  });

  test("mode 0700 with matching owner passes", () => {
    const result = preflightSocketParentDir({
      socketPath: "/run/user/1000/bitty/default.sock",
      runtimeUid: 1000,
      stat: () => OK_DIR,
    });
    expect(result.ok).toBe(true);
    expect(probeSocketDirPreflight(result).status).toBe("pass");
  });

  test("missing directory, symlink, and owner mismatch are distinct", () => {
    const missing = preflightSocketParentDir({
      socketPath: "/nope/x.sock",
      runtimeUid: 1000,
      stat: () => null,
    });
    expect(missing.remedy).toContain("mkdir -p");

    const symlink = preflightSocketParentDir({
      socketPath: "/tmp/link/x.sock",
      runtimeUid: 1000,
      stat: () => ({ ...OK_DIR, isSymlink: true }),
    });
    expect(symlink.diagnostic).toContain("symlink");

    const wrongOwner = preflightSocketParentDir({
      socketPath: "/tmp/x/y.sock",
      runtimeUid: 1000,
      stat: () => ({ ...OK_DIR, ownerUid: 0 }),
    });
    expect(wrongOwner.remedy).toContain("chown 1000");
  });
});

describe("post-D4 coverage hooks are non-blocking", () => {
  test("hooks are declared non-blocking and reported as skip", () => {
    const hooks = panelPluginCoverageHooks();
    expect(hooks.length).toBeGreaterThan(0);
    expect(hooks.every((h) => h.blocking === false)).toBe(true);
    const results = probePanelPluginHooks(hooks);
    expect(results.every((r) => r.status === "skip")).toBe(true);
  });
});

describe("durable dispatcher seam", () => {
  type RecordedCall = {
    program: string;
    args: readonly string[];
    env: Record<string, string | undefined>;
  };

  function recordingDispatcher(config: ProcessDispatcherConfig = {}): {
    dispatcher: ProcessCtlDispatcher;
    calls: RecordedCall[];
  } {
    const calls: RecordedCall[] = [];
    const dispatcher = new ProcessCtlDispatcher(
      config,
      (program, args, options) => {
        calls.push({ program, args, env: options.env });
        return makeOkResult("core.view.list", { views: [] });
      },
    );
    return { dispatcher, calls };
  }

  test("process dispatcher builds argv and elevation env headlessly", async () => {
    const { dispatcher, calls } = recordingDispatcher({
      socketPath: "/run/bitty/default.sock",
      baseArgs: ["ctl"],
    });
    await dispatcher.dispatch({
      verb: "view.list",
      args: ["view", "list"],
      elevated: true,
    });
    expect(calls[0]?.program).toBe("bitty");
    expect(calls[0]?.args).toEqual([
      "ctl",
      "--socket",
      "/run/bitty/default.sock",
      "view",
      "list",
    ]);
    expect(calls[0]?.env["BITTY_CTL_ELEVATE"]).toBe(DEFAULT_ELEVATION_SCOPES);

    await dispatcher.dispatch({
      verb: "view.list",
      args: ["view", "list"],
      elevated: false,
    });
    expect(calls[1]?.env["BITTY_CTL_ELEVATE"]).toBeUndefined();
  });

  test("elevation announces a scope list, never a bare client flag", async () => {
    const { dispatcher, calls } = recordingDispatcher();
    await dispatcher.dispatch({
      verb: "terminal.spawn",
      args: ["terminal", "spawn"],
      elevated: true,
    });
    const announced = calls[0]?.env["BITTY_CTL_ELEVATE"];
    expect(announced).toBe("terminal.manage,config.modify");
    expect(announced).not.toBe("1");
    expect(announced?.split(",")).toContain("terminal.manage");
  });

  test("elevation scopes are configurable and non-elevated clears them", async () => {
    const { dispatcher, calls } = recordingDispatcher({
      elevationScopes: "terminal.manage",
    });
    await dispatcher.dispatch({
      verb: "terminal.spawn",
      args: ["terminal", "spawn"],
      elevated: true,
    });
    expect(calls[0]?.env["BITTY_CTL_ELEVATE"]).toBe("terminal.manage");

    await dispatcher.dispatch({
      verb: "terminal.spawn",
      args: ["terminal", "spawn"],
      elevated: false,
    });
    expect(calls[1]?.env["BITTY_CTL_ELEVATE"]).toBeUndefined();
  });
});

describe("campaign aggregation", () => {
  test("summarize counts and only fails on failure", () => {
    const report = summarizeCampaign([
      { name: "a", status: "pass", detail: "", evidence: [] },
      { name: "b", status: "skip", detail: "", evidence: [] },
    ]);
    expect(report.ok).toBe(true);
    expect(report.passed).toBe(1);
    expect(report.skipped).toBe(1);
    const failing = summarizeCampaign([
      { name: "a", status: "fail", detail: "", evidence: [] },
    ]);
    expect(failing.ok).toBe(false);
  });

  test("headless run passes end to end with a healthy socket", async () => {
    const report = await runCampaign({
      dispatcher: campaignDispatcher(),
      socket: {
        socketPath: "/run/user/1000/bitty/default.sock",
        runtimeUid: 1000,
        stat: () => OK_DIR,
      },
    });
    expect(report.failed).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.skipped).toBe(panelPluginCoverageHooks().length);
  });

  test("headless run without a socket skips the preflight", async () => {
    const report = await runCampaign({ dispatcher: campaignDispatcher() });
    expect(report.ok).toBe(true);
    expect(report.skipped).toBe(panelPluginCoverageHooks().length + 1);
  });

  test("headless run fails when the D1 guard trips", async () => {
    const report = await runCampaign({
      dispatcher: campaignDispatcher({
        "terminal.text": makeOkResult("core.terminal.text", {
          terminal_id: "t:1",
          text: "Snapshot { version: 1, cells: [Cell { glyph: ' ' }] }",
        }),
      }),
    });
    expect(report.ok).toBe(false);
    expect(
      report.results.find((r) => r.name === "terminal:text-shape")?.status,
    ).toBe("fail");
  });

  test("headless run fails when the socket preflight trips", async () => {
    const report = await runCampaign({
      dispatcher: campaignDispatcher(),
      socket: {
        socketPath: "/tmp/opencode/ctx/run/default.sock",
        runtimeUid: 1000,
        stat: () => ({ ...OK_DIR, mode: 0o755 }),
      },
    });
    expect(report.ok).toBe(false);
    const preflight = report.results.find(
      (r) => r.name === "socket:parent-dir-0700",
    );
    expect(preflight?.status).toBe("fail");
    expect(preflight?.detail).toContain("chmod");
  });

  test("timeout sentinel is distinct from a ctl exit code", () => {
    expect(EXIT_TIMEOUT).not.toBe(EXIT_OK);
    expect(EXIT_TIMEOUT).not.toBe(EXIT_USAGE);
  });
});

describe("keystroke-injection probe gating (H-DEV-04)", () => {
  test("default matrix is keystroke-free (no terminal.send row)", () => {
    expect(CTL_VERB_MATRIX.some((row) => isKeystrokeProbeRow(row))).toBe(false);
  });

  test("missing opt-in refuses: nothing dispatched, recorded as fail", async () => {
    let dispatched = 0;
    const dispatcher = new ScriptedCtlDispatcher(() => {
      dispatched += 1;
      return makeOkResult("core.terminal.send", { ok: true });
    });
    const results = await probeEnvelopeConformance(dispatcher, [
      {
        verb: KEYSTROKE_PROBE_VERB,
        args: [
          "terminal",
          "send",
          "t:1",
          KEYSTROKE_PROBE_PAYLOAD,
          "--format",
          "json",
        ],
        outcome: "ok",
        elevated: false,
        note: "smuggled keystroke row",
      },
    ]);
    expect(dispatched).toBe(0);
    expect(results.length).toBe(1);
    expect(results[0]?.status).toBe("fail");
    expect(results[0]?.detail).toContain("keystrokeTarget");
  });

  test("bare terminal.send verb is refused without opt-in", async () => {
    let dispatched = 0;
    const dispatcher = new ScriptedCtlDispatcher(() => {
      dispatched += 1;
      return makeOkResult("core.terminal.send", { ok: true });
    });
    const results = await probeEnvelopeConformance(dispatcher, [
      {
        verb: KEYSTROKE_PROBE_VERB,
        args: ["terminal", "send", "t:9", "hi", "--format", "json"],
        outcome: "ok",
        elevated: false,
        note: "bare verb, no keystroke flag",
      },
    ]);
    expect(dispatched).toBe(0);
    expect(results[0]?.status).toBe("fail");
  });

  test("default campaign run dispatches no keystrokes", async () => {
    const seen: string[] = [];
    const dispatcher = new ScriptedCtlDispatcher((inv) => {
      seen.push(inv.verb);
      return makeOkResult(`core.${inv.verb}`, { ok: true });
    });
    await runCampaign({ dispatcher });
    expect(seen).not.toContain(KEYSTROKE_PROBE_VERB);
  });

  test("opt-in target validation rejects default t:1 and missing flag", () => {
    expect(keystrokeProbeOptIn(undefined)).toBe(false);
    expect(
      keystrokeProbeOptIn({ terminalId: "t:42", allowLiveKeystrokes: false }),
    ).toBe(false);
    expect(
      keystrokeProbeOptIn({ terminalId: "t:1", allowLiveKeystrokes: true }),
    ).toBe(false);
    expect(
      keystrokeProbeOptIn({ terminalId: "nope", allowLiveKeystrokes: true }),
    ).toBe(false);
    expect(
      keystrokeProbeOptIn({ terminalId: "t:42", allowLiveKeystrokes: true }),
    ).toBe(true);
    expect(() =>
      assertKeystrokeProbeTarget({
        terminalId: "t:1",
        allowLiveKeystrokes: true,
      }),
    ).toThrow("t:1");
    const row = keystrokeProbeExpectation({
      terminalId: "t:42",
      allowLiveKeystrokes: true,
    });
    expect(row.args).toContain("t:42");
    expect(row.args).not.toContain("t:1");
  });

  test("opted-in campaign appends the probe for the scratch terminal only", async () => {
    const seen: string[][] = [];
    const dispatcher = new ScriptedCtlDispatcher((inv) => {
      seen.push(inv.args);
      return makeOkResult(`core.${inv.verb}`, { ok: true });
    });
    await runCampaign({
      dispatcher,
      keystrokeTarget: { terminalId: "t:42", allowLiveKeystrokes: true },
    });
    const sends = seen.filter((args) => args[1] === "send");
    expect(sends.length).toBe(1);
    expect(sends[0]).toContain("t:42");
  });
});
