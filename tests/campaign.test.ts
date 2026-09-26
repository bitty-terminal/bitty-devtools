import { describe, expect, test } from "bun:test";
import * as campaignModule from "../src/campaign.js";
import {
  CAMPAIGN_CHILD_ENV_ALLOWLIST,
  CTL_VERB_MATRIX,
  KEYSTROKE_PROBE_PAYLOAD,
  KEYSTROKE_PROBE_VERB,
  CampaignError,
  EXIT_CONFLICT,
  assertKeystrokeProbeTarget,
  assertSafeWorkspaceId,
  EXIT_GENERIC,
  EXIT_OK,
  EXIT_PERM,
  EXIT_RUNTIME,
  EXIT_TIMEOUT,
  EXIT_USAGE,
  MAX_CAMPAIGN_ARRAY_ITEMS,
  MAX_CAMPAIGN_MATRIX_ROWS,
  MAX_CAMPAIGN_OUTPUT_BYTES,
  MAX_CAMPAIGN_REPORT_EVIDENCE_ITEMS,
  MAX_CAMPAIGN_REPORT_RESULTS,
  NO_INSTANCE_VIEW_LIST,
  ProcessCtlDispatcher,
  ScriptedCtlDispatcher,
  buildCampaignChildEnvironment,
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
  validateEnvelopeShape,
  workspaceCreatedFrom,
  workspaceIdCandidates,
  workspaceNamesFrom,
  type CtlInvocation,
  type CtlResult,
  type ProcessDispatcherConfig,
} from "../src/campaign.js";
import { ProtocolErrorImpl, decodeResponse } from "../src/protocol.js";
import {
  isNormalizationSeparator,
  redactSensitiveText,
  sanitizeTerminalOutput,
} from "../src/redaction.js";

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

function workspaceListResult(workspaces: string[], activeIndex: number) {
  return {
    workspaces,
    names: workspaces.map(() => ""),
    active: activeIndex,
    active_id: workspaces[activeIndex - 1] ?? "",
    count: workspaces.length,
    tabline: "",
  };
}

function successResultFor(verb: string): Record<string, unknown> {
  switch (verb) {
    case "instance.list":
      return { instances: [] };
    case "window.list":
      return { windows: [{ id: "w:1" }] };
    case "view.list":
      return { views: [{ id: "v:1", focused: true }] };
    case "terminal.list":
      return { terminals: [{ id: "t:1", has_pane_session: false }] };
    case "terminal.text":
      return { terminal_id: "t:1", text: "$ echo hi\nhi\n" };
    case "workspace.list":
      return workspaceListResult(["ws:1"], 1);
    case "workspace.new":
      return { created: "ws:2", tabline: "" };
    case "workspace.focus":
      return { focused: "ws:2", tabline: "" };
    case "view.split":
      return { split: "right", new_view: "v:2" };
    case "view.focus":
      return { focused: "v:1" };
    case "terminal.spawn":
      return { spawned: true, terminal_id: "t:2", view_id: "v:2" };
    case "terminal.close":
      return { closed: "t:2" };
    case "workspace.close":
      return { closed: "ws:2", killed: false, tabline: "" };
    case "terminal.send":
      return { sent_to: "t:42", bytes: 2 };
    case "config.reload":
      return {
        probed: true,
        applied: false,
        path: "(defaults; no file)",
        hot_swap: "follow-up",
      };
    default:
      throw new Error(`missing success projection for ${verb}`);
  }
}

function controlInterleavedAuthorizationCases(marker: string): string[] {
  const controls = ["\u001b", "\u009b"];
  const cases = new Set<string>();
  const insert = (value: string, control: string, index: number): string =>
    `${value.slice(0, index)}${control}${value.slice(index)}`;

  for (const authorizationControl of controls) {
    for (
      let authorizationIndex = 0;
      authorizationIndex <= "Authorization".length;
      authorizationIndex += 1
    ) {
      const authorization = insert(
        "Authorization",
        authorizationControl,
        authorizationIndex,
      );
      for (const bearerControl of controls) {
        for (
          let bearerIndex = 0;
          bearerIndex <= "Bearer".length;
          bearerIndex += 1
        ) {
          const bearer = insert("Bearer", bearerControl, bearerIndex);
          cases.add(`${authorization}: ${bearer} ${marker}`);
        }
      }
    }
  }

  for (const valueControl of controls) {
    for (let markerIndex = 0; markerIndex <= marker.length; markerIndex += 1) {
      const value = insert(marker, valueControl, markerIndex);
      cases.add(`Authorization: Bearer ${value}`);
    }
  }

  for (const authorizationControl of controls) {
    for (const bearerControl of controls) {
      for (const valueControl of controls) {
        cases.add(
          `${insert("Authorization", authorizationControl, 6)}: ${insert("Bearer", bearerControl, 3)} ${insert(marker, valueControl, 10)}`,
        );
      }
    }
  }
  return [...cases];
}

function allControlUnexpectedFieldNames(marker: string): string[] {
  const controls = [
    ...Array.from({ length: 0x20 }, (_, code) => String.fromCharCode(code)),
    String.fromCharCode(0x7f),
    ...Array.from({ length: 0x20 }, (_, index) =>
      String.fromCharCode(0x80 + index),
    ),
  ];
  const cases = new Set<string>();
  const insert = (value: string, control: string, index: number): string =>
    `${value.slice(0, index)}${control}${value.slice(index)}`;

  for (const control of controls) {
    for (let index = 0; index <= "Authorization".length; index += 1) {
      const authorization = insert("Authorization", control, index);
      cases.add(`${authorization}: Bearer ${marker}`);
      cases.add(`Proxy-${authorization}: Bearer ${marker}`);
    }
    for (let index = 0; index <= "Bearer".length; index += 1) {
      cases.add(`Authorization: ${insert("Bearer", control, index)} ${marker}`);
    }
    for (let index = 0; index <= marker.length; index += 1) {
      cases.add(`Authorization: Bearer ${insert(marker, control, index)}`);
    }
  }
  for (const authorizationControl of controls) {
    for (const bearerControl of controls) {
      cases.add(
        `${insert("Authorization", authorizationControl, 6)}: ${insert("Bearer", bearerControl, 3)} ${marker}`,
      );
    }
  }
  return [...cases];
}

const UNICODE_FORMAT_SEPARATORS = [
  "\u00a0",
  "\u00ad",
  "\u034f",
  "\u061c",
  "\u115f",
  "\u1160",
  "\u180e",
  "\u200b",
  "\u200c",
  "\u200d",
  "\u200e",
  "\u200f",
  "\u2028",
  "\u202a",
  "\u202b",
  "\u202c",
  "\u202d",
  "\u202e",
  "\u202f",
  "\u2060",
  "\u2066",
  "\u2067",
  "\u2068",
  "\u2069",
  "\u3000",
  "\u3164",
  "\ufe0f",
  "\ufeff",
  "\uffa0",
  "\u{e0001}",
  "\u{e0100}",
] as const;

function formatSeparatorCredentialFields(marker: string): string[] {
  const cases = new Set<string>([
    `Authorization: Bearer ${marker}`,
    `Proxy-Authorization: Bearer ${marker}`,
    `Bearer ${marker}`,
    `api_key: ${marker}`,
  ]);
  const insert = (value: string, separator: string, index: number): string =>
    `${value.slice(0, index)}${separator}${value.slice(index)}`;

  for (const separator of UNICODE_FORMAT_SEPARATORS) {
    for (let index = 0; index <= "Authorization".length; index += 1) {
      const authorization = insert("Authorization", separator, index);
      cases.add(`${authorization}: Bearer ${marker}`);
      cases.add(`Proxy-${authorization}: Bearer ${marker}`);
    }
    for (let index = 0; index <= "Bearer".length; index += 1) {
      cases.add(
        `Authorization: ${insert("Bearer", separator, index)} ${marker}`,
      );
    }
    for (let index = 0; index <= marker.length; index += 1) {
      cases.add(`Authorization: Bearer ${insert(marker, separator, index)}`);
    }
    cases.add(`api${separator}key: ${marker}`);
    cases.add(
      `${insert("Authorization", separator, 6)}: ${insert("Bearer", separator, 3)} ${insert(marker, separator, 10)}`,
    );
  }
  return [...cases];
}

function specialResult(invocation: CtlInvocation): CtlResult | undefined {
  switch (invocation.verb) {
    case "workspace.list.baseline":
      return makeOkResult(
        "core.workspace.list",
        workspaceListResult(["ws1"], 1),
      );
    case "workspace.new":
      return makeOkResult("core.workspace.new", {
        created: "ws:2",
        tabline: "",
      });
    case "workspace.list.after-new":
      return makeOkResult(
        "core.workspace.list",
        workspaceListResult(["ws1", "ws:2"], 2),
      );
    case "workspace.focus":
      return makeOkResult("core.workspace.focus", {
        focused: invocation.args[2] ?? "ws:2",
        tabline: "",
      });
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
          { id: "v:1", focused: false },
          { id: "v:2", focused: true },
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
  if (invocation.verb === "terminal.spawn" && invocation.elevated) {
    return makeOkResult(command, {
      spawned: true,
      terminal_id: "t:2",
      view_id: "v:2",
    });
  }
  if (expectation !== undefined) {
    if (invocation.elevated || expectation.outcome === "ok") {
      return makeOkResult(command, successResultFor(invocation.verb));
    }
    switch (expectation.outcome) {
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

function attestFixtureDispatcher(
  dispatcher: ScriptedCtlDispatcher,
): ScriptedCtlDispatcher {
  return Object.assign(dispatcher, {
    attestSocketTarget: (socketPath: string) =>
      socketPath === fixtureSocketPath,
  });
}

function campaignDispatcher(
  overrides: Record<string, CtlResult> = {},
): ScriptedCtlDispatcher {
  return attestFixtureDispatcher(
    new ScriptedCtlDispatcher((inv) => overrides[inv.verb] ?? resultFor(inv)),
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

  test("error class and code must both match", async () => {
    const dispatcher = campaignDispatcher({
      "terminal.spawn": makeErrorResult(
        "core.terminal.spawn",
        { class: "Denied", code: "SyntheticWrongCode", message: "synthetic" },
        EXIT_PERM,
      ),
    });
    const results = await probeEnvelopeConformance(dispatcher);
    const spawn = results.find(
      (result) => result.name === "envelope:terminal.spawn",
    );
    expect(spawn?.status).toBe("fail");
    expect(spawn?.detail).toBe("error class/code did not match expectation");
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
        return makeOkResult(
          "core.workspace.list",
          workspaceListResult(["ws1"], 1),
        );
      }
      if (inv.verb === "workspace.new") {
        return makeOkResult("core.workspace.new", {
          created: "ws:2",
          tabline: "",
        });
      }
      if (inv.verb === "workspace.list.after-new") {
        return makeOkResult(
          "core.workspace.list",
          workspaceListResult(["--socket=/tmp/evil.sock"], 1),
        );
      }
      throw new Error(`unexpected dispatch ${inv.verb}`);
    });
    const result = await probeWorkspaceIdRoundTrip(dispatcher);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain(
      "workspace post-create projection is invalid",
    );
    expect(seen.some((inv) => inv.verb === "workspace.focus")).toBe(false);
  });

  test("bare-dash and empty listed ids never reach focus argv", async () => {
    for (const hostile of ["-f", "--format=json", ""]) {
      const seen: CtlInvocation[] = [];
      const dispatcher = new ScriptedCtlDispatcher((inv) => {
        seen.push(inv);
        if (inv.verb === "workspace.list.baseline") {
          return makeOkResult(
            "core.workspace.list",
            workspaceListResult(["ws1"], 1),
          );
        }
        if (inv.verb === "workspace.new") {
          return makeOkResult("core.workspace.new", {
            created: "ws:2",
            tabline: "",
          });
        }
        if (inv.verb === "workspace.list.after-new") {
          return makeOkResult(
            "core.workspace.list",
            workspaceListResult([hostile], 1),
          );
        }
        throw new Error(`unexpected dispatch ${inv.verb}`);
      });
      const result = await probeWorkspaceIdRoundTrip(dispatcher);
      expect(result.status).toBe("fail");
      expect(result.detail).toContain(
        "workspace post-create projection is invalid",
      );
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
      "workspace.list.after-new": makeOkResult(
        "core.workspace.list",
        workspaceListResult(["ws1", "ws4"], 2),
      ),
      "workspace.focus": makeErrorResult(
        "core.workspace.focus",
        NOTFOUND,
        EXIT_GENERIC,
      ),
    });
    const result = await probeWorkspaceIdRoundTrip(dispatcher);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("was rejected");
  });

  test("created id must be a ws:<n> id", () => {
    const bad = parseCtlEnvelope(
      JSON.stringify({
        v: 1,
        command: "core.workspace.new",
        ok: true,
        result: { created: "ws2", tabline: "" },
      }),
    );
    expect(workspaceCreatedFrom(bad)).toBe("ws2");
    const names = parseCtlEnvelope(
      JSON.stringify({
        v: 1,
        command: "core.workspace.list",
        ok: true,
        result: workspaceListResult(["ws1"], 1),
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

  test("terminal text projection requires a string", () => {
    expect(() =>
      parseCtlEnvelope(
        JSON.stringify({
          v: 1,
          command: "core.terminal.text",
          ok: true,
          result: {},
        }),
      ),
    ).toThrow(CampaignError);
  });
});

describe("terminal spawn observability guard (D3)", () => {
  test("passes when a new view/terminal is observable", async () => {
    const result = await probeTerminalSpawnObservability(campaignDispatcher());
    expect(result.status).toBe("pass");
  });

  test("passes when the created terminal owns the flipped pane session", async () => {
    const dispatcher = campaignDispatcher({
      "view.list.after": makeOkResult("core.view.list", {
        views: [
          { id: "v:1", focused: false },
          { id: "v:2", focused: true },
        ],
      }),
      "terminal.list.after": makeOkResult("core.terminal.list", {
        terminals: [
          { id: "t:1", has_pane_session: true },
          { id: "t:2", has_pane_session: true },
        ],
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
    expect(result.detail).toContain("was not observable");
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
      verb: "terminal.spawn",
      args: ["terminal", "spawn"],
      elevated: true,
    });
    expect(calls[0]?.program).toBe("bitty");
    expect(calls[0]?.args).toEqual([
      "ctl",
      "--socket",
      "/run/bitty/default.sock",
      "terminal",
      "spawn",
    ]);
    expect(calls[0]?.env["BITTY_CTL_ELEVATE"]).toBe("terminal.manage");

    await dispatcher.dispatch({
      verb: "terminal.spawn",
      args: ["terminal", "spawn"],
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
    expect(announced).toBe("terminal.manage");
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

const fixtureSocketPath = `${process.cwd()}/fixture.sock`;
const admittedCampaign = {
  mutationConsent: { socketPath: fixtureSocketPath, disposable: true as const },
  socket: {
    socketPath: fixtureSocketPath,
    runtimeUid: OK_DIR.ownerUid,
    stat: () => OK_DIR,
  },
};

describe("campaign admission and ownership", () => {
  test("relative endpoints are refused even when consent and dispatcher strings match", async () => {
    const calls: string[][] = [];
    const dispatcher = new ProcessCtlDispatcher(
      { socketPath: "fixture.sock", cwd: "child" },
      (_program, args) => {
        calls.push([...args]);
        return makeOkResult("core.view.list", { views: [] });
      },
    );
    const report = await runCampaign({
      ...admittedCampaign,
      dispatcher,
      mutationConsent: { socketPath: "fixture.sock", disposable: true },
      socket: { ...admittedCampaign.socket, socketPath: "fixture.sock" },
    });
    expect(report.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  test("windows drive-letter and UNC endpoints are refused on this host", async () => {
    for (const socketPath of [
      "C:\\bitty\\fixture.sock",
      "\\\\pipe\\fixture.sock",
    ]) {
      const calls: string[][] = [];
      const dispatcher = new ProcessCtlDispatcher(
        { socketPath },
        (_program, args) => {
          calls.push([...args]);
          return makeOkResult("core.view.list", { views: [] });
        },
      );
      const report = await runCampaign({
        dispatcher,
        mutationConsent: { socketPath, disposable: true },
        socket: {
          socketPath,
          runtimeUid: OK_DIR.ownerUid,
          stat: () => OK_DIR,
        },
      });
      expect(report.ok).toBe(false);
      expect(calls).toEqual([]);
    }
  });

  test("custom dispatchers without target attestation are refused", async () => {
    const dispatcher = new ScriptedCtlDispatcher(resultFor);
    const socketPath = `${process.cwd()}/fixture.sock`;
    const report = await runCampaign({
      dispatcher,
      mutationConsent: { socketPath, disposable: true },
      socket: { ...admittedCampaign.socket, socketPath },
    });
    expect(report.ok).toBe(false);
    expect(dispatcher.seen()).toEqual([]);
  });

  test("an absolute endpoint is passed unchanged to a process fake with another cwd", async () => {
    const calls: string[][] = [];
    const dispatcher = new ProcessCtlDispatcher(
      { socketPath: fixtureSocketPath, cwd: "child" },
      (_program, args) => {
        calls.push([...args]);
        return makeOkResult("core.view.list", { views: [] });
      },
    );
    await runCampaign({ ...admittedCampaign, dispatcher });
    expect(calls.length).toBeGreaterThan(0);
    expect(
      calls.every(
        (args) => args[args.indexOf("--socket") + 1] === fixtureSocketPath,
      ),
    ).toBe(true);
  });

  test("custom target attestation is checked against the preflight endpoint", async () => {
    const dispatcher = Object.assign(new ScriptedCtlDispatcher(resultFor), {
      attestSocketTarget: (socketPath: string) =>
        socketPath === `${process.cwd()}/other.sock`,
    });
    const report = await runCampaign({ ...admittedCampaign, dispatcher });
    expect(report.ok).toBe(false);
    expect(dispatcher.seen()).toEqual([]);
  });

  for (const thrown of [null, undefined, "fixture failure", 7]) {
    test(`target attestation reports thrown ${String(thrown)}`, async () => {
      const dispatcher = Object.assign(new ScriptedCtlDispatcher(resultFor), {
        attestSocketTarget: () => {
          throw thrown;
        },
      });
      const report = await runCampaign({ ...admittedCampaign, dispatcher });
      expect(report.ok).toBe(false);
      expect(
        report.results.find((r) => r.name === "campaign:admission")?.detail,
      ).toBe("campaign operation failed");
      expect(dispatcher.seen()).toEqual([]);
    });
    test(`preflight reports thrown ${String(thrown)} without dispatch`, async () => {
      const dispatcher = campaignDispatcher();
      const report = await runCampaign({
        ...admittedCampaign,
        dispatcher,
        socket: {
          ...admittedCampaign.socket,
          stat: () => {
            throw thrown;
          },
        },
      });
      expect(report.ok).toBe(false);
      expect(report.results[0]?.detail).toBe("campaign operation failed");
      expect(dispatcher.seen()).toEqual([]);
    });

    test(`observation and cleanup report thrown ${String(thrown)}`, async () => {
      const dispatcher = new ScriptedCtlDispatcher((inv) => {
        if (
          inv.verb === "workspace.list.after-new" ||
          inv.verb === "workspace.close"
        )
          throw thrown;
        return resultFor(inv);
      });
      const result = await probeWorkspaceIdRoundTrip(dispatcher, {
        elevated: true,
      });
      expect(result.status).toBe("fail");
      expect(result.detail).toBe(
        "campaign operation failed; owned workspace cleanup failed: campaign operation failed",
      );
      expect(
        dispatcher
          .seen()
          .filter((inv) => inv.verb === "workspace.close")
          .map((inv) => inv.args[2]),
      ).toEqual(["ws:2"]);
    });
  }

  test("process dispatcher target must match the consented socket", async () => {
    const calls: string[][] = [];
    const dispatcher = new ProcessCtlDispatcher(
      { socketPath: "other.sock" },
      (_program, args) => {
        calls.push([...args]);
        return makeOkResult("core.view.list", { views: [] });
      },
    );
    const report = await runCampaign({ ...admittedCampaign, dispatcher });
    expect(report.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  test("read-only labels do not admit different arguments without consent", async () => {
    const dispatcher = campaignDispatcher();
    await runCampaign({
      dispatcher,
      matrix: [
        {
          verb: "workspace.list",
          args: ["workspace", "new", "--format", "json"],
          outcome: "ok",
          elevated: false,
          note: "benign custom row",
        },
      ],
    });
    expect(dispatcher.seen().map((inv) => inv.verb)).toEqual(["terminal.text"]);
  });

  test("cleanup failure is reported without closing another ID", async () => {
    const dispatcher = campaignDispatcher({
      "workspace.close": makeErrorResult(
        "core.workspace.close",
        DENIED,
        EXIT_PERM,
      ),
    });
    const result = await probeWorkspaceIdRoundTrip(dispatcher, {
      elevated: true,
    });
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("cleanup response did not match");
    expect(
      dispatcher
        .seen()
        .filter((inv) => inv.verb === "workspace.close")
        .map((inv) => inv.args[2]),
    ).toEqual(["ws:2"]);
  });

  test("default campaign dispatches only read-only probes", async () => {
    const dispatcher = campaignDispatcher();
    await runCampaign({ dispatcher });
    expect(dispatcher.seen().length).toBeGreaterThan(0);
    expect(
      dispatcher
        .seen()
        .every((inv) =>
          [
            "instance.list",
            "window.list",
            "view.list",
            "terminal.list",
            "terminal.text",
            "workspace.list",
          ].includes(inv.verb),
        ),
    ).toBe(true);
  });

  for (const admission of [
    "failed",
    "missing",
    "mismatch",
    "throws",
    "not-disposable",
  ] as const) {
    test(`refuses mutations when admission is ${admission}`, async () => {
      const dispatcher = campaignDispatcher();
      const report = await runCampaign({
        ...admittedCampaign,
        dispatcher,
        closeWorkspaces: true,
        keystrokeTarget: { terminalId: "t:42", allowLiveKeystrokes: true },
        mutationConsent: {
          socketPath:
            admission === "mismatch"
              ? `${process.cwd()}/other.sock`
              : fixtureSocketPath,
          disposable: admission !== "not-disposable",
        },
        socket:
          admission === "missing"
            ? undefined
            : {
                ...admittedCampaign.socket,
                stat: () => {
                  if (admission === "throws")
                    throw new Error("fixture stat failed");
                  return admission === "failed"
                    ? { ...OK_DIR, mode: 0o755 }
                    : OK_DIR;
                },
              },
      });
      expect(report.ok).toBe(false);
      expect(dispatcher.seen()).toEqual([]);
    });
  }

  test("preflight runs before any dispatch and admission does not opt into keystrokes", async () => {
    let checked = false;
    const dispatcher = attestFixtureDispatcher(
      new ScriptedCtlDispatcher((inv) => {
        expect(checked).toBe(true);
        return resultFor(inv);
      }),
    );
    await runCampaign({
      ...admittedCampaign,
      dispatcher,
      socket: {
        ...admittedCampaign.socket,
        stat: () => {
          checked = true;
          return OK_DIR;
        },
      },
      closeWorkspaces: true,
    });
    expect(dispatcher.seen().some((inv) => inv.verb === "terminal.spawn")).toBe(
      true,
    );
    expect(
      dispatcher.seen().some((inv) => inv.verb === KEYSTROKE_PROBE_VERB),
    ).toBe(false);
    expect(
      dispatcher
        .seen()
        .filter((inv) => inv.verb === "workspace.close")
        .map((inv) => inv.args[2]),
    ).toEqual(["ws:2"]);
  });

  test("workspace cleanup is complete and idempotent across listed new ids", async () => {
    const dispatcher = campaignDispatcher({
      "workspace.list.after-new": makeOkResult(
        "core.workspace.list",
        workspaceListResult(["ws1", "ws2", "ws:3", "ws:2"], 3),
      ),
    });
    const result = await probeWorkspaceIdRoundTrip(dispatcher, {
      elevated: true,
    });
    expect(result.status).toBe("fail");
    expect(
      dispatcher
        .seen()
        .filter((inv) => inv.verb === "workspace.close")
        .map((inv) => inv.args[2]),
    ).toEqual(["ws:2", "ws:3"]);
  });

  test("a created ID already present under a baseline alias is never closed", async () => {
    const dispatcher = campaignDispatcher({
      "workspace.new": makeOkResult("core.workspace.new", {
        created: "ws:01",
        tabline: "",
      }),
    });
    const result = await probeWorkspaceIdRoundTrip(dispatcher, {
      elevated: true,
    });
    expect(result.status).toBe("fail");
    expect(
      dispatcher
        .seen()
        .filter((inv) => inv.verb === "workspace.close")
        .map((inv) => inv.args[2]),
    ).toEqual(["ws:2"]);
  });

  test("owned cleanup runs after a later observation failure", async () => {
    const dispatcher = campaignDispatcher({
      "workspace.list.after-new": makeErrorResult(
        "core.workspace.list",
        UNAVAILABLE,
        EXIT_RUNTIME,
      ),
    });
    const result = await probeWorkspaceIdRoundTrip(dispatcher, {
      elevated: true,
    });
    expect(result.status).toBe("fail");
    expect(
      dispatcher
        .seen()
        .filter((inv) => inv.verb === "workspace.close")
        .map((inv) => inv.args[2]),
    ).toEqual(["ws:2"]);
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
    expect(
      report.results.find((r) => r.name === "workspace:id-round-trip")?.status,
    ).toBe("skip");
    expect(
      report.results.find((r) => r.name === "terminal:spawn-observable")
        ?.status,
    ).toBe("skip");
  });

  test("headless run without a socket skips the preflight", async () => {
    const report = await runCampaign({ dispatcher: campaignDispatcher() });
    expect(report.ok).toBe(true);
    expect(
      report.results.find((r) => r.name === "socket:parent-dir-0700")?.status,
    ).toBe("skip");
    expect(
      report.results.find((r) => r.name === "workspace:id-round-trip")?.status,
    ).toBe("skip");
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
      return makeOkResult("core.terminal.send", {
        sent_to: "t:42",
        bytes: 2,
      });
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
      return makeOkResult("core.terminal.send", {
        sent_to: "t:42",
        bytes: 2,
      });
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
      return makeOkResult(`core.${inv.verb}`, successResultFor(inv.verb));
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
    const dispatcher = attestFixtureDispatcher(
      new ScriptedCtlDispatcher((inv) => {
        seen.push(inv.args);
        return makeOkResult(`core.${inv.verb}`, successResultFor(inv.verb));
      }),
    );
    await runCampaign({
      ...admittedCampaign,
      dispatcher,
      keystrokeTarget: { terminalId: "t:42", allowLiveKeystrokes: true },
    });
    const sends = seen.filter((args) => args[1] === "send");
    expect(sends.length).toBe(1);
    expect(sends[0]).toContain("t:42");
  });
});

describe("campaign child environment and producer bounds", () => {
  const syntheticSecret = "SYNTHETIC_AMBIENT_SECRET_DO_NOT_PERSIST";

  test("low-level spawn helper is private and combined elevation is rejected", () => {
    expect(campaignModule).not.toHaveProperty("defaultSpawnSync");
    expect(() =>
      buildCampaignChildEnvironment(
        {},
        { BITTY_CTL_ELEVATE: "terminal.manage,config.modify" },
      ),
    ).toThrow(CampaignError);
  });

  test("child environment is rebuilt from an explicit allowlist", () => {
    const env = buildCampaignChildEnvironment(
      {
        PATH: "/synthetic/bin",
        XDG_RUNTIME_DIR: "/synthetic/runtime",
        BITTY_CTL_ELEVATE: "config.modify",
        SSH_AUTH_SOCK: "/synthetic/agent",
        [syntheticSecret]: syntheticSecret,
      },
      {
        BITTY_CTL_ELEVATE: undefined,
        XDG_RUNTIME_DIR: "/synthetic/explicit-runtime",
        ANOTHER_SYNTHETIC_SECRET: syntheticSecret,
      },
    );

    expect(env["PATH"]).toBe("/synthetic/bin");
    expect(env["XDG_RUNTIME_DIR"]).toBe("/synthetic/explicit-runtime");
    expect(env["BITTY_CTL_ELEVATE"]).toBeUndefined();
    expect(env["SSH_AUTH_SOCK"]).toBeUndefined();
    expect(env[syntheticSecret]).toBeUndefined();
    expect(env["ANOTHER_SYNTHETIC_SECRET"]).toBeUndefined();
    expect(
      Object.keys(env).every((key) =>
        [...CAMPAIGN_CHILD_ENV_ALLOWLIST, "BITTY_CTL_ELEVATE"].includes(key),
      ),
    ).toBe(true);
  });

  test("fake spawn receives maxBuffer and no ambient marker", async () => {
    type FakeSpawnOptions = {
      cmd: string[];
      env?: Record<string, string | undefined>;
      maxBuffer?: number;
    };
    type FakeSpawnResult = {
      exitCode: number | null;
      stdout: { byteLength: number; toString(): string };
      stderr: { byteLength: number; toString(): string };
      signalCode: null;
    };
    const runtime = globalThis as unknown as {
      Bun: {
        spawnSync(options: FakeSpawnOptions): FakeSpawnResult;
      };
    };
    const original = runtime.Bun.spawnSync;
    let seen: FakeSpawnOptions | undefined;
    runtime.Bun.spawnSync = (options) => {
      seen = options;
      const stdout = JSON.stringify({
        v: 1,
        command: "core.view.list",
        ok: true,
        result: { views: [] },
      });
      return {
        exitCode: 0,
        stdout: {
          byteLength: new TextEncoder().encode(stdout).length,
          toString: () => stdout,
        },
        stderr: { byteLength: 0, toString: () => "" },
        signalCode: null,
      };
    };

    try {
      const dispatcher = new ProcessCtlDispatcher({
        env: { [syntheticSecret]: syntheticSecret },
      });
      const result = await dispatcher.dispatch({
        verb: "view.list",
        args: ["view", "list"],
        elevated: false,
      });
      expect(result.exitCode).toBe(EXIT_OK);
      expect(seen?.maxBuffer).toBe(MAX_CAMPAIGN_OUTPUT_BYTES);
      expect(seen?.env?.[syntheticSecret]).toBeUndefined();
    } finally {
      runtime.Bun.spawnSync = original;
    }
  });

  test("oversized producer output is rejected without string materialization", async () => {
    type FakeSpawnResult = {
      exitCode: number;
      stdout: { byteLength: number; toString(): string };
      stderr: { byteLength: number; toString(): string };
    };
    const runtime = globalThis as unknown as {
      Bun: {
        spawnSync(options: unknown): FakeSpawnResult;
      };
    };
    const original = runtime.Bun.spawnSync;
    let materialized = false;
    runtime.Bun.spawnSync = () => ({
      exitCode: 0,
      stdout: {
        byteLength: MAX_CAMPAIGN_OUTPUT_BYTES + 1,
        toString: () => {
          materialized = true;
          return "synthetic";
        },
      },
      stderr: { byteLength: 0, toString: () => "" },
    });

    try {
      const dispatcher = new ProcessCtlDispatcher();
      await expect(
        dispatcher.dispatch({
          verb: "view.list",
          args: ["view", "list"],
          elevated: false,
        }),
      ).rejects.toThrow("exceeds");
      expect(materialized).toBe(false);
    } finally {
      runtime.Bun.spawnSync = original;
    }
  });
});

describe("campaign envelope and observation bounds", () => {
  test("requires exactly one closed envelope branch", () => {
    const success = {
      v: 1,
      command: "core.view.list",
      ok: true,
      result: { views: [] },
    };
    expect(() => parseCtlEnvelope(`${JSON.stringify(success)}\n{}\n`)).toThrow(
      CampaignError,
    );
    expect(
      validateEnvelopeShape({ ...success, extra: true }).some((problem) =>
        problem.includes("unexpected field"),
      ),
    ).toBe(true);
    expect(
      validateEnvelopeShape({ ...success, error: DENIED }).some((problem) =>
        problem.includes("exclusive"),
      ),
    ).toBe(true);
    expect(
      validateEnvelopeShape({
        v: 1,
        command: "core.view.list",
        ok: false,
      }).some((problem) => problem.includes("exclusive")),
    ).toBe(true);
  });

  test("rejects oversized bytes, arrays, strings, and nesting before use", () => {
    expect(() =>
      parseCtlEnvelope("x".repeat(MAX_CAMPAIGN_OUTPUT_BYTES + 1)),
    ).toThrow(CampaignError);
    expect(() =>
      parseCtlEnvelope(
        JSON.stringify({
          v: 1,
          command: "core.workspace.list",
          ok: true,
          result: {
            workspaces: Array(MAX_CAMPAIGN_ARRAY_ITEMS + 1).fill("ws:1"),
          },
        }),
      ),
    ).toThrow(CampaignError);
    expect(() =>
      parseCtlEnvelope(
        JSON.stringify({
          v: 1,
          command: "c".repeat(2048),
          ok: true,
          result: {},
        }),
      ),
    ).toThrow(CampaignError);

    let nested: unknown = "synthetic";
    for (let index = 0; index < 32; index += 1) nested = [nested];
    expect(() =>
      parseCtlEnvelope(
        JSON.stringify({
          v: 1,
          command: "core.view.list",
          ok: true,
          result: nested,
        }),
      ),
    ).toThrow(CampaignError);
  });

  test("mixed workspace arrays fail before create, focus, or cleanup", async () => {
    const dispatcher = new ScriptedCtlDispatcher((invocation) => {
      if (invocation.verb === "workspace.list.baseline") {
        return makeOkResult("core.workspace.list", {
          workspaces: ["ws:1", 7],
        });
      }
      throw new Error(`unexpected dispatch ${invocation.verb}`);
    });
    const result = await probeWorkspaceIdRoundTrip(dispatcher);
    expect(result.status).toBe("fail");
    expect(dispatcher.seen().map((invocation) => invocation.verb)).toEqual([
      "workspace.list.baseline",
    ]);
  });

  test("malformed view and terminal arrays fail before spawn", async () => {
    for (const overrides of [
      {
        "view.list.before": makeOkResult("core.view.list", {
          views: [{ focused: true }],
        }),
      },
      {
        "terminal.list.before": makeOkResult("core.terminal.list", {
          terminals: [{ id: "t:1" }],
        }),
      },
      {
        "view.list.before": makeOkResult("core.view.list", {
          views: [
            { id: "v:1", focused: true },
            { id: "v:1", focused: false },
          ],
        }),
      },
      {
        "terminal.list.before": makeOkResult("core.terminal.list", {
          terminals: [
            { id: "t:1", has_pane_session: false },
            { id: "t:1", has_pane_session: false },
          ],
        }),
      },
      {
        "terminal.list.before": makeOkResult("core.terminal.list", {
          terminals: [
            { id: "t:1", has_pane_session: false },
            { id: "t:2", has_pane_session: false },
          ],
        }),
      },
    ]) {
      const dispatcher = campaignDispatcher(overrides);
      const result = await probeTerminalSpawnObservability(dispatcher);
      expect(result.status).toBe("fail");
      expect(
        dispatcher
          .seen()
          .some((invocation) => invocation.verb === "terminal.spawn"),
      ).toBe(false);
    }
  });

  test("matrix cardinality is bounded before any dispatch", async () => {
    const dispatcher = new ScriptedCtlDispatcher(() =>
      makeOkResult("core.oversized", { ok: true }),
    );
    const matrix = Array.from(
      { length: MAX_CAMPAIGN_MATRIX_ROWS + 1 },
      (_, index) => ({
        verb: `oversized.${index}`,
        args: ["oversized"],
        outcome: "ok" as const,
        elevated: false,
        note: "synthetic",
      }),
    );
    const results = await probeEnvelopeConformance(dispatcher, matrix);
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("fail");
    expect(dispatcher.seen()).toEqual([]);
  });

  test("runCampaign rejects oversized matrices before reading or filtering rows", async () => {
    let argsReads = 0;
    const matrix = Array.from({ length: 1000 }, () => ({
      verb: "view.list",
      get args(): string[] {
        argsReads += 1;
        return ["view", "list", "--format", "json"];
      },
      outcome: "ok" as const,
      elevated: false,
      note: "synthetic",
    }));
    const report = await runCampaign({
      ...admittedCampaign,
      dispatcher: campaignDispatcher(),
      matrix,
    });
    expect(argsReads).toBe(0);
    expect(report.results).toHaveLength(1);
    expect(report.results[0]).toMatchObject({
      name: "campaign:matrix-limit",
      status: "fail",
    });
  });

  test("malformed matrix rows fail closed without property dereferences", async () => {
    const dispatcher = new ScriptedCtlDispatcher(() =>
      makeOkResult("core.invalid", {}),
    );
    const results = await probeEnvelopeConformance(dispatcher, [null] as never);
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("fail");
    expect(dispatcher.seen()).toEqual([]);
  });

  test("null matrices fail closed in probe and campaign entry points", async () => {
    const dispatcher = campaignDispatcher();
    const probeResults = await probeEnvelopeConformance(
      dispatcher,
      null as never,
    );
    expect(probeResults).toHaveLength(1);
    expect(probeResults[0]?.status).toBe("fail");

    const report = await runCampaign({
      ...admittedCampaign,
      dispatcher,
      matrix: null as never,
    });
    expect(report.results).toHaveLength(1);
    expect(report.results[0]).toMatchObject({
      name: "campaign:matrix-invalid",
      status: "fail",
    });
    expect(dispatcher.seen()).toEqual([]);
  });

  test("invalid matrix values fail before filtering or dispatch", async () => {
    const valid = {
      verb: "view.list",
      args: ["view", "list", "--format", "json"],
      outcome: "ok" as const,
      elevated: false,
      note: "synthetic",
    };
    for (const invalid of [
      { ...valid, outcome: null },
      { ...valid, args: [null] },
      { ...valid, note: null },
      { ...valid, elevated: null },
    ]) {
      const dispatcher = campaignDispatcher();
      const report = await runCampaign({
        ...admittedCampaign,
        dispatcher,
        matrix: [invalid] as never,
      });
      expect(report.ok).toBe(false);
      expect(report.results[0]?.name).toBe("campaign:matrix-invalid");
      expect(dispatcher.seen()).toEqual([]);
    }
  });

  test("per-verb result projections reject unknown success fields", async () => {
    expect(() =>
      parseCtlEnvelope(
        JSON.stringify({
          v: 1,
          command: "core.instance.list",
          ok: true,
          result: { unexpected: true },
        }),
      ),
    ).toThrow(CampaignError);
    const dispatcher = new ScriptedCtlDispatcher(() =>
      makeOkResult("core.instance.list", {
        unexpected: "\u001b[31m",
      }),
    );
    const results = await probeEnvelopeConformance(dispatcher, [
      {
        verb: "instance.list",
        args: ["instance", "list", "--format", "json"],
        outcome: "ok",
        elevated: false,
        note: "synthetic",
      },
    ]);
    expect(results[0]?.status).toBe("fail");
    expect(results[0]?.detail).toContain("projection");
  });

  test("ctl envelopes reject duplicate keys before interpretation", () => {
    expect(() =>
      parseCtlEnvelope(
        '{"v":1,"command":"core.instance.list","ok":true,"result":{"instances":[]},"result":{"unexpected":true}}',
      ),
    ).toThrow(CampaignError);
    expect(() =>
      parseCtlEnvelope(
        '{"v":1,"command":"core.instance.list","ok":true,"result":{"outer":{"value":1,"value":2}}}',
      ),
    ).toThrow(CampaignError);
  });
  test("ctl validation and parser diagnostics redact every typed control matrix", () => {
    const marker = "SYNTHETIC_OPAQUE_123456";
    const diagnostics: string[] = [];
    for (const field of allControlUnexpectedFieldNames(marker)) {
      const value = {
        v: 1,
        command: "core.view.list",
        ok: true,
        result: {},
        [field]: true,
      };
      diagnostics.push(...validateEnvelopeShape(value));
      try {
        parseCtlEnvelope(JSON.stringify(value));
      } catch (error) {
        diagnostics.push((error as Error).message);
      }
    }
    let errorPayloads = 0;
    let rejectedErrorPayloads = 0;
    for (const field of [
      ...allControlUnexpectedFieldNames(marker),
      `Authorization: Bearer ${marker}`,
      `Proxy-Authorization: Bearer ${marker}`,
      `Bearer ${marker}`,
    ]) {
      for (const carrier of ["class", "code", "message"] as const) {
        errorPayloads += 1;
        const value = {
          v: 1,
          command: "core.terminal.spawn",
          ok: false,
          error: {
            class: "Denied",
            code: "ScopeDenied",
            message: "synthetic",
            [carrier]: field,
          },
        };
        diagnostics.push(...validateEnvelopeShape(value));
        try {
          parseCtlEnvelope(JSON.stringify(value));
        } catch (error) {
          rejectedErrorPayloads += 1;
          diagnostics.push((error as Error).message);
        }
      }
    }
    expect(rejectedErrorPayloads).toBe(errorPayloads);
    for (const command of [
      `core.Authorization: Bearer ${marker}`,
      `core.Proxy-Authorization: Bearer ${marker}`,
      `core.Bearer ${marker}`,
    ]) {
      try {
        parseCtlEnvelope(
          JSON.stringify({
            v: 1,
            command,
            ok: true,
            result: {},
          }),
        );
      } catch (error) {
        diagnostics.push((error as Error).message);
      }
    }
    const serialized = diagnostics.join("");
    expect(serialized).not.toContain(marker);
    expect(/[\u0000-\u001f\u007f-\u009f]/u.test(serialized)).toBe(false);
  });
  test("ctl diagnostics reject unicode-interleaved typed fields", () => {
    const marker = "SYNTHETIC_OPAQUE_123456";
    const diagnostics: string[] = [];
    let rejected = 0;
    for (const field of formatSeparatorCredentialFields(marker)) {
      const values: unknown[] = [
        {
          v: 1,
          command: "core.view.list",
          ok: true,
          result: {},
          [field]: true,
        },
        ...["class", "code", "message"].map((carrier) => ({
          v: 1,
          command: "core.terminal.spawn",
          ok: false,
          error: {
            class: "Denied",
            code: "ScopeDenied",
            message: "synthetic",
            [carrier]: field,
          },
        })),
      ];
      for (const value of values) {
        diagnostics.push(...validateEnvelopeShape(value));
        try {
          parseCtlEnvelope(JSON.stringify(value));
        } catch (error) {
          rejected += 1;
          diagnostics.push((error as Error).message);
        }
      }
    }
    expect(rejected).toBe(formatSeparatorCredentialFields(marker).length * 4);
    const serialized = diagnostics.join("");
    expect(serialized).not.toContain(marker);
    for (const separator of UNICODE_FORMAT_SEPARATORS) {
      expect(serialized).not.toContain(separator);
    }
  });
});

describe("campaign report privacy and control safety", () => {
  const syntheticSecret = "SYNTHETIC_SECRET_DO_NOT_PERSIST";

  test("terminal output sanitizer escapes C0, DEL, and C1 bytes", () => {
    const sanitized = sanitizeTerminalOutput(
      `safe\u0000\u001b[31m\u007f\u0085\u009b${syntheticSecret}\n`,
      1024,
    );
    expect(sanitized).toContain("\\u0000");
    expect(sanitized).toContain("\\u001b");
    expect(sanitized).toContain("\\u007f");
    expect(sanitized).toContain("\\u0085");
    expect(sanitized).toContain("\\u009b");
    expect(sanitized).toContain("\\n");
    expect(/[\u0000-\u001f\u007f-\u009f]/u.test(sanitized)).toBe(false);
    expect(new TextEncoder().encode(sanitized).length).toBeLessThanOrEqual(
      1024,
    );
  });

  test("unicode format separators are removed before redaction and reporting", () => {
    const marker = "SYNTHETIC_OPAQUE_123456";
    for (const separator of UNICODE_FORMAT_SEPARATORS) {
      expect(sanitizeTerminalOutput(`a${separator}b`, 128)).toBe("ab");
    }
    const redacted =
      formatSeparatorCredentialFields(marker).map(redactSensitiveText);
    const report = summarizeCampaign(
      redacted.map((detail) => ({
        name: "unicode-format",
        status: "fail" as const,
        detail,
        evidence: [`Proxy-${detail}`],
      })),
    );
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(marker);
    for (const separator of UNICODE_FORMAT_SEPARATORS) {
      expect(serialized).not.toContain(separator);
    }
  });

  test("shared differential corpus redacts in TypeScript", async () => {
    const corpus = await Bun.file(
      "tests/fixtures/redaction-separator-corpus.txt",
    ).text();
    let cases = 0;
    for (const line of corpus.split("\n")) {
      if (line.length === 0 || line.startsWith("#")) continue;
      const [id, hex, expected] = line.split("\t");
      if (id === undefined || hex === undefined || expected === undefined) {
        throw new Error(`invalid corpus row: ${line}`);
      }
      const bytes = Uint8Array.from(
        (hex.match(/.{2}/gu) ?? []).map((byte) => Number.parseInt(byte, 16)),
      );
      const input = new TextDecoder().decode(bytes);
      const actual = redactSensitiveText(input);
      const wanted = expected === "true" ? "[REDACTED]" : input;
      expect(actual, id).toBe(wanted);
      cases += 1;
    }
    // Exact count, not a floor: a silently dropped fixture must fail here as
    // loudly as a wrong expectation, and the Rust suite asserts the same total.
    expect(cases).toBe(2298);
  });

  test("NORM-1 normalization class matches the shared membership pin", async () => {
    const pin = await Bun.file(
      "tests/fixtures/redaction-normalization-class.txt",
    ).text();
    let members = 0;
    let nonMembers = 0;
    for (const line of pin.split("\n")) {
      if (line.length === 0 || line.startsWith("#")) continue;
      const [kind, hex] = line.split("\t");
      if (kind === undefined || hex === undefined) {
        throw new Error(`invalid class pin row: ${line}`);
      }
      const codePoint = Number.parseInt(hex, 16);
      const label = `U+${hex}`;
      expect(isNormalizationSeparator(codePoint), `${label} ${kind}`).toBe(
        kind === "member",
      );
      if (kind === "member") members += 1;
      else nonMembers += 1;
    }
    expect(members).toBe(4225);
    expect(nonMembers).toBe(266);
  });

  test("NORM-1 class property definition matches the shared membership pin", async () => {
    // The pin is the contract; the predicate is the implementation. Deriving
    // the class a second time from the three Unicode properties and comparing
    // it to the pin catches a pinned row that no longer follows from the
    // definition, which the membership test above cannot see.
    const pin = await Bun.file(
      "tests/fixtures/redaction-normalization-class.txt",
    ).text();
    const pinned = new Set<number>();
    for (const line of pin.split("\n")) {
      if (!line.startsWith("member\t")) continue;
      pinned.add(Number.parseInt(line.split("\t")[1] as string, 16));
    }
    const defaultIgnorable = /\p{Default_Ignorable_Code_Point}/u;
    const otherFormat = /\p{Cf}/u;
    const whiteSpace = /\p{White_Space}/u;
    const derived = new Set<number>();
    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
      const character = String.fromCodePoint(codePoint);
      if (
        codePoint > 0x7f &&
        (defaultIgnorable.test(character) ||
          otherFormat.test(character) ||
          whiteSpace.test(character))
      ) {
        derived.add(codePoint);
      }
    }
    const missing = [...derived].filter((codePoint) => !pinned.has(codePoint));
    const extra = [...pinned].filter((codePoint) => !derived.has(codePoint));
    expect(
      { missing: missing.length, extra: extra.length },
      `missing U+${missing[0]?.toString(16)} extra U+${extra[0]?.toString(16)}`,
    ).toEqual({ missing: 0, extra: 0 });
  });

  test("P1 regression: a capitalized or upper-case key is redacted", () => {
    const marker = "SYNTHETIC_OPAQUE_123456";
    for (const key of [
      "Authorization",
      "AUTHORIZATION",
      "AuThOrIzAtIoN",
      "Token",
      "TOKEN",
      "ToKeN",
      "API_KEY",
      "Cookie",
      "COOKIE",
      "Credential",
      "Password",
      "Secret",
      "Auth",
      "Access_Token",
      "Proxy-Authorization",
      "Passwd",
    ]) {
      for (const delimiter of [": ", "= "]) {
        const input = `${key}${delimiter}${marker}`;
        expect(redactSensitiveText(input), input).toBe("[REDACTED]");
      }
    }
  });

  test("P1 regression: prose that mentions a key name survives", () => {
    for (const text of [
      "the password is required to log in",
      "set the secret before you start the server",
      "The Authorization header is optional",
      "Tokens expire after one hour",
      "my_secret",
      "github_token",
      "api_key",
      "Token",
      "Secret",
      "SECRETARY",
      "TOKENS",
      "PKI_KEYSTORE",
    ]) {
      expect(redactSensitiveText(text), text).toBe(text);
    }
  });

  test("report names, details, and evidence are redacted, escaped, and capped", () => {
    const report = summarizeCampaign([
      {
        name: `probe\u001b[31m${syntheticSecret}`,
        status: "fail",
        detail: `token=${syntheticSecret}\u009b31m`,
        evidence: Array.from(
          { length: MAX_CAMPAIGN_REPORT_EVIDENCE_ITEMS + 20 },
          () => `password=${syntheticSecret}\u0000`,
        ),
      },
    ]);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(syntheticSecret);
    expect(/[\u0000-\u001f\u007f-\u009f]/u.test(serialized)).toBe(false);
    expect(report.results[0]?.detail).toContain("[REDACTED]");
    expect(report.results[0]?.evidence.length).toBe(
      MAX_CAMPAIGN_REPORT_EVIDENCE_ITEMS,
    );
  });

  test("report redaction removes complete bearer credentials", () => {
    const credential = "opaque-value-123456";
    const report = summarizeCampaign([
      {
        name: "bearer",
        status: "fail",
        detail: `Authorization: Bearer ${credential}`,
        evidence: [`Proxy-Authorization: Bearer proxy-${credential}`],
      },
    ]);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(credential);
    expect(serialized).toContain("[REDACTED]");
  });

  test("report redaction removes control-interleaved bearer credentials", () => {
    const credential = "SYNTHETIC_OPAQUE_123456";
    const report = summarizeCampaign([
      {
        name: "interleaved-bearer",
        status: "fail",
        detail: `Authorization:\u001bBearer ${credential}`,
        evidence: [`Proxy-Authorization:\u009bBearer ${credential}`],
      },
    ]);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(credential);
    expect(serialized).toContain("[REDACTED]");
    expect(/[\u0000-\u001f\u007f-\u009f]/u.test(serialized)).toBe(false);
  });

  test("report redaction covers every typed credential control insertion", () => {
    const marker = "SYNTHETIC_OPAQUE_123456";
    const serialized = controlInterleavedAuthorizationCases(marker)
      .map((text) =>
        JSON.stringify(
          summarizeCampaign([
            {
              name: "typed-credential",
              status: "fail",
              detail: text,
              evidence: [`Proxy-${text}`],
            },
          ]),
        ),
      )
      .join("");
    expect(serialized).not.toContain(marker);
    expect(/[\u0000-\u001f\u007f-\u009f]/u.test(serialized)).toBe(false);
  });

  test("oversized reports retain an explicit limit failure", () => {
    const report = summarizeCampaign(
      Array.from({ length: MAX_CAMPAIGN_REPORT_RESULTS + 10 }, (_, index) => ({
        name: `probe.${index}`,
        status: "pass" as const,
        detail: "ok",
        evidence: [],
      })),
    );
    expect(report.results).toHaveLength(MAX_CAMPAIGN_REPORT_RESULTS + 1);
    expect(report.results.at(-1)).toMatchObject({
      name: "campaign:report-limit",
      status: "fail",
    });
    expect(report.ok).toBe(false);
  });

  test("target error fields and thrown secret messages never enter a report", async () => {
    const marker = `SYNTHETIC_SECRET_DO_NOT_PERSIST\u001b]8;;`;
    const dispatcher = new ScriptedCtlDispatcher(() =>
      makeErrorResult(
        "core.terminal.spawn",
        {
          class: marker,
          code: `\u009b${marker}`,
          message: `authorization=${marker}`,
        },
        EXIT_PERM,
      ),
    );
    const results = await probeEnvelopeConformance(dispatcher, [
      {
        verb: "terminal.spawn",
        args: ["terminal", "spawn"],
        outcome: "ok",
        elevated: false,
        note: "synthetic",
      },
    ]);
    const serialized = JSON.stringify(results);
    expect(serialized).not.toContain("SYNTHETIC_SECRET_DO_NOT_PERSIST");
    expect(/[\u0000-\u001f\u007f-\u009f]/u.test(serialized)).toBe(false);

    const thrown = new ScriptedCtlDispatcher(() => {
      throw new Error(`authorization=${marker}\u001b[31m`);
    });
    const thrownResults = await probeEnvelopeConformance(thrown, [
      {
        verb: "terminal.spawn",
        args: ["terminal", "spawn"],
        outcome: "ok",
        elevated: false,
        note: "synthetic",
      },
    ]);
    const thrownSerialized = JSON.stringify(thrownResults);
    expect(thrownSerialized).not.toContain("SYNTHETIC_SECRET_DO_NOT_PERSIST");
    expect(/[\u0000-\u001f\u007f-\u009f]/u.test(thrownSerialized)).toBe(false);
  });
});

describe("campaign owned-resource cleanup and per-verb authority", () => {
  test("workspace cleanup always runs for the exact created id", async () => {
    const dispatcher = campaignDispatcher();
    const result = await probeWorkspaceIdRoundTrip(dispatcher);
    expect(result.status).toBe("pass");
    expect(
      dispatcher
        .seen()
        .filter((invocation) => invocation.verb === "workspace.close")
        .map((invocation) => invocation.args[2]),
    ).toEqual(["ws:2"]);
  });

  test("workspace cleanup survives malformed post-create observations", async () => {
    const dispatcher = campaignDispatcher({
      "workspace.list.after-new": makeOkResult("core.workspace.list", {
        workspaces: ["ws:2", 7],
      }),
    });
    const result = await probeWorkspaceIdRoundTrip(dispatcher);
    expect(result.status).toBe("fail");
    expect(
      dispatcher
        .seen()
        .filter((invocation) => invocation.verb === "workspace.close")
        .map((invocation) => invocation.args[2]),
    ).toEqual(["ws:2"]);
  });

  test("malformed workspace create responses still reconcile and clean new ids", async () => {
    const dispatcher = campaignDispatcher({
      "workspace.new": makeOkResult("core.workspace.new", {
        created: "opaque-create-response",
      }),
    });
    const result = await probeWorkspaceIdRoundTrip(dispatcher);
    expect(result.status).toBe("fail");
    expect(
      dispatcher
        .seen()
        .filter((invocation) => invocation.verb === "workspace.close")
        .map((invocation) => invocation.args[2]),
    ).toEqual(["ws:2"]);
  });

  test("workspace cleanup closes every unexpected new id exactly once", async () => {
    const dispatcher = campaignDispatcher({
      "workspace.list.after-new": makeOkResult("core.workspace.list", {
        workspaces: ["ws1", "ws2", "ws3", "ws3"],
        names: ["", "", "", ""],
        active: 4,
        active_id: "ws:3",
        count: 4,
        tabline: "",
      }),
    });
    const result = await probeWorkspaceIdRoundTrip(dispatcher);
    expect(result.status).toBe("fail");
    expect(
      dispatcher
        .seen()
        .filter((invocation) => invocation.verb === "workspace.close")
        .map((invocation) => invocation.args[2]),
    ).toEqual(["ws:2", "ws:3"]);
  });

  test("workspace cleanup continues after one owned id fails", async () => {
    const overrides: Record<string, CtlResult> = {
      "workspace.list.after-new": makeOkResult(
        "core.workspace.list",
        workspaceListResult(["ws1", "ws:2", "ws:3"], 3),
      ),
    };
    const dispatcher = attestFixtureDispatcher(
      new ScriptedCtlDispatcher((invocation) => {
        if (
          invocation.verb === "workspace.close" &&
          invocation.args[2] === "ws:2"
        ) {
          return makeErrorResult(
            "core.workspace.close",
            CONFLICT,
            EXIT_CONFLICT,
          );
        }
        return overrides[invocation.verb] ?? resultFor(invocation);
      }),
    );
    const result = await probeWorkspaceIdRoundTrip(dispatcher);
    expect(result.status).toBe("fail");
    expect(
      dispatcher
        .seen()
        .filter((invocation) => invocation.verb === "workspace.close")
        .map((invocation) => invocation.args[2]),
    ).toEqual(["ws:2", "ws:3"]);
  });

  test("workspace focus and cleanup responses must match requested ids", async () => {
    for (const overrides of [
      {
        "workspace.focus": makeOkResult("core.workspace.focus", {
          focused: "ws:9",
          tabline: "",
        }),
      },
      {
        "workspace.close": makeOkResult("core.workspace.close", {
          closed: "ws:9",
          killed: false,
          tabline: "",
        }),
      },
    ]) {
      const result = await probeWorkspaceIdRoundTrip(
        campaignDispatcher(overrides),
      );
      expect(result.status).toBe("fail");
    }
  });

  test("terminal cleanup closes only the created id and restores focus", async () => {
    const dispatcher = campaignDispatcher();
    const result = await probeTerminalSpawnObservability(dispatcher);
    expect(result.status).toBe("pass");
    expect(
      dispatcher
        .seen()
        .filter((invocation) => invocation.verb === "terminal.close")
        .map((invocation) => invocation.args[2]),
    ).toEqual(["t:2"]);
    expect(
      dispatcher
        .seen()
        .filter((invocation) => invocation.verb === "view.focus")
        .map((invocation) => invocation.args[2]),
    ).toEqual(["v:1"]);
  });

  test("terminal close and focus responses must match requested ids", async () => {
    for (const overrides of [
      {
        "terminal.close": makeOkResult("core.terminal.close", {
          closed: "t:9",
        }),
      },
      {
        "view.focus": makeOkResult("core.view.focus", {
          focused: "v:9",
        }),
      },
    ]) {
      const result = await probeTerminalSpawnObservability(
        campaignDispatcher(overrides),
      );
      expect(result.status).toBe("fail");
    }
  });

  test("extra post-spawn view deltas are rejected", async () => {
    const dispatcher = campaignDispatcher({
      "view.list.after": makeOkResult("core.view.list", {
        views: [
          { id: "v:1", focused: false },
          { id: "v:2", focused: true },
          { id: "v:3", focused: false },
        ],
      }),
    });
    const result = await probeTerminalSpawnObservability(dispatcher);
    expect(result.status).toBe("fail");
  });

  test("terminal cleanup survives malformed post-spawn observations", async () => {
    const dispatcher = campaignDispatcher({
      "view.list.after": makeOkResult("core.view.list", {
        views: [{ id: "v:2" }],
      }),
    });
    const result = await probeTerminalSpawnObservability(dispatcher);
    expect(result.status).toBe("fail");
    expect(
      dispatcher
        .seen()
        .filter((invocation) => invocation.verb === "terminal.close")
        .map((invocation) => invocation.args[2]),
    ).toEqual(["t:2"]);
  });

  test("malformed terminal spawn responses still reconcile and clean new ids", async () => {
    const dispatcher = campaignDispatcher({
      "terminal.spawn": makeOkResult("core.terminal.spawn", {
        spawned: true,
      }),
    });
    const result = await probeTerminalSpawnObservability(dispatcher);
    expect(result.status).toBe("fail");
    expect(
      dispatcher
        .seen()
        .filter((invocation) => invocation.verb === "terminal.close")
        .map((invocation) => invocation.args[2]),
    ).toEqual(["t:2"]);
  });

  test("terminal cleanup closes every unexpected new id exactly once", async () => {
    const dispatcher = campaignDispatcher({
      "view.list.after": makeOkResult("core.view.list", {
        views: [
          { id: "v:1", focused: false },
          { id: "v:2", focused: true },
          { id: "v:3", focused: false },
        ],
      }),
      "terminal.list.after": makeOkResult("core.terminal.list", {
        terminals: [
          { id: "t:1", has_pane_session: false },
          { id: "t:2", has_pane_session: true },
          { id: "t:3", has_pane_session: true },
        ],
      }),
    });
    const result = await probeTerminalSpawnObservability(dispatcher);
    expect(result.status).toBe("fail");
    expect(
      dispatcher
        .seen()
        .filter((invocation) => invocation.verb === "terminal.close")
        .map((invocation) => invocation.args[2]),
    ).toEqual(["t:2", "t:3"]);
  });

  test("terminal cleanup continues after one owned id fails", async () => {
    const overrides: Record<string, CtlResult> = {
      "view.list.after": makeOkResult("core.view.list", {
        views: [
          { id: "v:1", focused: false },
          { id: "v:2", focused: true },
          { id: "v:3", focused: false },
        ],
      }),
      "terminal.list.after": makeOkResult("core.terminal.list", {
        terminals: [
          { id: "t:1", has_pane_session: false },
          { id: "t:2", has_pane_session: true },
          { id: "t:3", has_pane_session: true },
        ],
      }),
    };
    const dispatcher = attestFixtureDispatcher(
      new ScriptedCtlDispatcher((invocation) => {
        if (
          invocation.verb === "terminal.close" &&
          invocation.args[2] === "t:2"
        ) {
          return makeErrorResult(
            "core.terminal.close",
            CONFLICT,
            EXIT_CONFLICT,
          );
        }
        return overrides[invocation.verb] ?? resultFor(invocation);
      }),
    );
    const result = await probeTerminalSpawnObservability(dispatcher);
    expect(result.status).toBe("fail");
    expect(
      dispatcher
        .seen()
        .filter((invocation) => invocation.verb === "terminal.close")
        .map((invocation) => invocation.args[2]),
    ).toEqual(["t:2", "t:3"]);
  });

  test("inconsistent spawn identifiers still clean the new terminal", async () => {
    const dispatcher = campaignDispatcher({
      "terminal.spawn": makeOkResult("core.terminal.spawn", {
        spawned: true,
        terminal_id: "t:2",
        view_id: "v:1",
      }),
    });
    const result = await probeTerminalSpawnObservability(dispatcher);
    expect(result.status).toBe("fail");
    expect(
      dispatcher
        .seen()
        .filter((invocation) => invocation.verb === "terminal.close")
        .map((invocation) => invocation.args[2]),
    ).toEqual(["t:2"]);
  });

  test("a baseline terminal reported by spawn is preserved while new ids are cleaned", async () => {
    const dispatcher = campaignDispatcher({
      "terminal.spawn": makeOkResult("core.terminal.spawn", {
        spawned: true,
        terminal_id: "t:1",
        view_id: "v:1",
      }),
    });
    const result = await probeTerminalSpawnObservability(dispatcher);
    expect(result.status).toBe("fail");
    expect(
      dispatcher
        .seen()
        .filter((invocation) => invocation.verb === "terminal.close")
        .map((invocation) => invocation.args[2]),
    ).toEqual(["t:2"]);
  });

  test("full admitted campaign delegates creates once and cleans both resources", async () => {
    const dispatcher = campaignDispatcher();
    const report = await runCampaign({ ...admittedCampaign, dispatcher });
    expect(report.ok).toBe(true);
    expect(
      dispatcher
        .seen()
        .filter((invocation) => invocation.verb === "workspace.new"),
    ).toHaveLength(1);
    expect(
      dispatcher
        .seen()
        .filter((invocation) => invocation.verb === "terminal.spawn"),
    ).toHaveLength(1);
    expect(
      dispatcher
        .seen()
        .filter((invocation) => invocation.verb === "workspace.close")
        .map((invocation) => invocation.args[2]),
    ).toEqual(["ws:2"]);
    expect(
      dispatcher
        .seen()
        .filter((invocation) => invocation.verb === "terminal.close")
        .map((invocation) => invocation.args[2]),
    ).toEqual(["t:2"]);
  });

  test("configured scope allowlist refuses unrelated elevated verbs", async () => {
    let dispatches = 0;
    const dispatcher = new ProcessCtlDispatcher(
      { elevationScopes: "config.modify" },
      () => {
        dispatches += 1;
        return makeOkResult("core.terminal.spawn", {
          spawned: true,
          terminal_id: "t:2",
          view_id: "v:2",
        });
      },
    );
    await expect(
      dispatcher.dispatch({
        verb: "terminal.spawn",
        args: ["terminal", "spawn"],
        elevated: true,
      }),
    ).rejects.toThrow(CampaignError);
    expect(dispatches).toBe(0);
  });

  test("elevated announcements are selected per verb and unknown verbs fail closed", async () => {
    const calls: Record<string, string | undefined>[] = [];
    const dispatcher = new ProcessCtlDispatcher(
      {},
      (_program, _args, options) => {
        calls.push(options.env);
        return makeOkResult("core.terminal.spawn", {
          spawned: true,
          terminal_id: "t:2",
          view_id: "v:2",
        });
      },
    );

    await dispatcher.dispatch({
      verb: "terminal.spawn",
      args: ["terminal", "spawn"],
      elevated: true,
    });
    await dispatcher.dispatch({
      verb: "config.reload",
      args: ["config", "reload"],
      elevated: true,
    });
    expect(calls[0]?.["BITTY_CTL_ELEVATE"]).toBe("terminal.manage");
    expect(calls[1]?.["BITTY_CTL_ELEVATE"]).toBe("config.modify");
    expect(calls[0]?.["BITTY_CTL_ELEVATE"]).not.toContain("config.modify");
    expect(calls[1]?.["BITTY_CTL_ELEVATE"]).not.toContain("terminal.manage");

    await expect(
      dispatcher.dispatch({
        verb: "unknown.elevated",
        args: ["unknown"],
        elevated: true,
      }),
    ).rejects.toThrow(CampaignError);
    expect(calls).toHaveLength(2);
  });
});
