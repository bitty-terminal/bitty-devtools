import { describe, expect, test } from "bun:test";
import {
  AutomationClient,
  AutomationError,
  METHOD_CAPTURE_FRAME,
  METHOD_FRAME_HASH,
  METHOD_SYNTHESIZE_INPUT,
  assertTrajectoryBounded,
  clickTrajectory,
  dragTrajectory,
  keyDown,
  keyUp,
  validateSyntheticEvent,
} from "../src/automation.js";
import type {
  AutomationErrorCode,
  AutomationTransport,
  SyntheticEvent,
} from "../src/automation.js";
import { BOUNDS } from "../src/bounds.js";
import type { IpcRequest, IpcResponse } from "../src/transport.js";

class FakeTransport implements AutomationTransport {
  requests: IpcRequest[] = [];
  response: IpcResponse | null = null;

  constructor(private connected = true) {}

  setConnected(connected: boolean): void {
    this.connected = connected;
  }

  isConnected(): boolean {
    return this.connected;
  }

  request(request: IpcRequest, _nowMs: number): IpcResponse {
    this.requests.push(request);
    if (this.response === null) {
      throw new Error("no injected response");
    }
    return this.response;
  }
}

function ok(id: number, result: unknown): IpcResponse {
  return { jsonrpc: "2.0", id, result, version: "1.0" };
}

function serverError(
  id: number,
  category: string,
  code: string,
  message: string,
): IpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { category, code, message },
    version: "1.0",
  };
}

function allScopes(): Set<string> {
  return new Set([
    "debug.control",
    "debug.trace",
    "debug.inspect",
    "terminal.input",
    "terminal.inspect",
  ]);
}

function expectCode(fn: () => unknown, code: AutomationErrorCode): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AutomationError);
  expect((caught as AutomationError).code).toBe(code);
}

const TERMINAL = "t:1";
const BEARER = "deadbeefdeadbeefdeadbeefdeadbeef";

function receipt(overrides: Record<string, unknown> = {}): unknown {
  return {
    version: "1.0",
    receipt: "synthesize",
    terminalId: TERMINAL,
    accepted: 2,
    rejected: 0,
    syntheticSeq: 7,
    originLabel: "harness",
    synthetic: true,
    ...overrides,
  };
}

function semanticFrame(overrides: Record<string, unknown> = {}): unknown {
  return {
    version: "1.0",
    snapshot: "frame",
    format: "semantic",
    terminalId: TERMINAL,
    lines: ["$ echo hello", "hello"],
    cursor: { row: 1, col: 5, visible: true },
    cols: 80,
    rows: 24,
    frameSeq: 21,
    trust: "untrusted-observation",
    ...overrides,
  };
}

function pixelsFrame(overrides: Record<string, unknown> = {}): unknown {
  return {
    version: "1.0",
    snapshot: "frame",
    format: "pixels",
    terminalId: TERMINAL,
    masked: true,
    cols: 80,
    rows: 24,
    frameSeq: 21,
    trust: "untrusted-observation",
    caller: "session-1",
    audited: true,
    ...overrides,
  };
}

function frameHash(overrides: Record<string, unknown> = {}): unknown {
  return {
    version: "1.0",
    snapshot: "frameHash",
    terminalId: TERMINAL,
    cols: 80,
    rows: 24,
    widthPx: 640,
    heightPx: 384,
    frameSeq: 21,
    algo: "sha256-v1",
    digest: "e7380e8d0953d0df1f937809825d8b99f93f8ee5d41cbe9d39ab2b6e8c530513",
    trust: "untrusted-observation",
    ...overrides,
  };
}

describe("automation trajectory builders (bounded)", () => {
  test("keyDown/keyUp carry press state", () => {
    expect(keyDown("Enter")).toEqual({
      type: "key",
      key: "Enter",
      pressed: true,
    });
    expect(keyUp("Enter", "Ctrl")).toEqual({
      type: "key",
      key: "Enter",
      mods: "Ctrl",
      pressed: false,
    });
  });

  test("click trajectory is press+release at one cell", () => {
    const plan = clickTrajectory(10, 5, "Left", 100);
    expect(plan.events.length).toBe(2);
    expect(plan.durationMs).toBe(100);
    for (const event of plan.events) validateSyntheticEvent(event);
  });

  test("drag trajectory interpolates and stays within the point bound", () => {
    const plan = dragTrajectory({ col: 0, row: 0 }, { col: 10, row: 10 });
    expect(plan.events.length).toBe(3);
    const first = plan.events[0];
    const last = plan.events[plan.events.length - 1];
    expect(first).toMatchObject({ action: "pressed", col: 0, row: 0 });
    expect(last).toMatchObject({ action: "released", col: 10, row: 10 });
    const max = dragTrajectory(
      { col: 0, row: 0 },
      { col: 20, row: 20 },
      { steps: BOUNDS.MAX_DRAG_STEPS },
    );
    expect(max.events.length).toBe(BOUNDS.MAX_TRAJECTORY_POINTS);
    for (const event of max.events) validateSyntheticEvent(event);
  });

  test("drag rejects steps above the bound", () => {
    expect(() =>
      dragTrajectory(
        { col: 0, row: 0 },
        { col: 1, row: 1 },
        { steps: BOUNDS.MAX_DRAG_STEPS + 1 },
      ),
    ).toThrow("exceeded");
  });
});

describe("automation bounds (fail closed)", () => {
  test("trajectory point count bounded", () => {
    const events: SyntheticEvent[] = Array.from(
      { length: BOUNDS.MAX_TRAJECTORY_POINTS + 1 },
      () => keyDown("a"),
    );
    expect(() => assertTrajectoryBounded(events, 0)).toThrow("exceeded");
  });

  test("trajectory duration bounded", () => {
    expect(() =>
      assertTrajectoryBounded(
        [keyDown("a")],
        BOUNDS.MAX_TRAJECTORY_DURATION_MS + 1,
      ),
    ).toThrow("exceeded");
  });

  test("empty trajectory rejected", () => {
    expect(() => assertTrajectoryBounded([], 0)).toThrow("at least one");
  });
});

describe("AutomationClient fail-closed behavior", () => {
  test("connection alone grants no authority", () => {
    const client = new AutomationClient(new FakeTransport(), new Set());
    expectCode(
      () =>
        client.synthesizeInput({
          terminalId: TERMINAL,
          bearer: BEARER,
          originLabel: "harness",
          events: [keyDown("a")],
        }),
      "ScopeDenied",
    );
  });

  test("synthesize requires debug.control + terminal.input", () => {
    const client = new AutomationClient(
      new FakeTransport(),
      new Set(["debug.control", "terminal.inspect"]),
    );
    expectCode(
      () =>
        client.synthesizeInput({
          terminalId: TERMINAL,
          bearer: BEARER,
          originLabel: "harness",
          events: [keyDown("a")],
        }),
      "ScopeDenied",
    );
  });

  test("capture requires debug.trace + terminal.inspect", () => {
    const client = new AutomationClient(
      new FakeTransport(),
      new Set(["debug.trace", "terminal.input"]),
    );
    expectCode(
      () => client.captureFrame({ terminalId: TERMINAL, bearer: BEARER }),
      "ScopeDenied",
    );
    expectCode(
      () => client.frameHash({ terminalId: TERMINAL, bearer: BEARER }),
      "ScopeDenied",
    );
  });

  test("no transport fails closed", () => {
    const client = new AutomationClient(null, allScopes());
    expectCode(
      () => client.captureFrame({ terminalId: TERMINAL, bearer: BEARER }),
      "NoTransport",
    );
  });

  test("unknown method is a typed UnknownMethod, never fabricated data", () => {
    const transport = new FakeTransport();
    transport.response = serverError(
      1,
      "usage",
      "UnknownMethod",
      "unknown method bitty.debug/synthesizeInput",
    );
    const client = new AutomationClient(transport, allScopes());
    expectCode(
      () =>
        client.synthesizeInput({
          terminalId: TERMINAL,
          bearer: BEARER,
          originLabel: "harness",
          events: [keyDown("a")],
        }),
      "UnknownMethod",
    );
  });

  test("server scope denial maps to typed ScopeDenied", () => {
    const transport = new FakeTransport();
    transport.response = serverError(1, "scope", "ScopeDenied", "denied");
    const client = new AutomationClient(transport, allScopes());
    expectCode(
      () => client.frameHash({ terminalId: TERMINAL, bearer: BEARER }),
      "ScopeDenied",
    );
  });

  test("invalid terminal id, bearer, or origin label never reaches the wire", () => {
    const transport = new FakeTransport();
    const client = new AutomationClient(transport, allScopes());
    const base = {
      terminalId: "t:1",
      bearer: BEARER,
      originLabel: "harness",
      events: [keyDown("a")],
    };
    expectCode(
      () => client.synthesizeInput({ ...base, terminalId: "t:*" }),
      "InvalidParams",
    );
    expectCode(
      () => client.synthesizeInput({ ...base, bearer: "bad token!" }),
      "InvalidParams",
    );
    expectCode(
      () => client.synthesizeInput({ ...base, originLabel: "" }),
      "InvalidParams",
    );
    expect(transport.requests.length).toBe(0);
  });
});

describe("AutomationClient synthesizeInput", () => {
  test("dispatches the exact method/params and parses the receipt", () => {
    const transport = new FakeTransport();
    transport.response = ok(1, receipt());
    const client = new AutomationClient(transport, allScopes());
    const out = client.synthesizeInput({
      terminalId: TERMINAL,
      bearer: BEARER,
      originLabel: "harness",
      events: clickTrajectory(10, 5).events,
      durationMs: 250,
    });
    expect(out.receipt).toBe("synthesize");
    expect(out.accepted).toBe(2);
    expect(out.syntheticSeq).toBe(7);
    const sent = transport.requests[0]!;
    expect(sent.method).toBe(METHOD_SYNTHESIZE_INPUT);
    expect(sent.version).toBe("1.0");
    const params = sent.params as Record<string, unknown>;
    expect(params["terminalId"]).toBe(TERMINAL);
    expect(params["originLabel"]).toBe("harness");
    expect(Array.isArray(params["events"])).toBe(true);
    // durationMs is a client pacing budget, never a wire field.
    expect(params["durationMs"]).toBeUndefined();
  });

  test("rejects a trajectory above the per-call event cap before dispatch", () => {
    const transport = new FakeTransport();
    const client = new AutomationClient(transport, allScopes());
    const events: SyntheticEvent[] = Array.from(
      { length: BOUNDS.MAX_SYNTH_EVENTS_PER_CALL + 1 },
      () => keyDown("a"),
    );
    expectCode(
      () =>
        client.synthesizeInput({
          terminalId: TERMINAL,
          bearer: BEARER,
          originLabel: "harness",
          events,
        }),
      "BoundExceeded",
    );
    expect(transport.requests.length).toBe(0);
  });

  test("rejects paste text with newline injection before dispatch", () => {
    const transport = new FakeTransport();
    const client = new AutomationClient(transport, allScopes());
    // A pasted LF/CR submits the line in shells that do not handle bracketed
    // paste, so multi-line paste would execute unintended input. Fail closed.
    for (const text of [
      "echo hi\nrm -rf /tmp/x\n",
      "line1\nline2",
      "a\rb",
      "a\r\nb",
    ]) {
      expectCode(
        () =>
          client.synthesizeInput({
            terminalId: TERMINAL,
            bearer: BEARER,
            originLabel: "harness",
            events: [{ type: "paste", text }],
          }),
        "InvalidParams",
      );
      expectCode(
        () => validateSyntheticEvent({ type: "paste", text }),
        "InvalidParams",
      );
    }
    expect(transport.requests.length).toBe(0);
  });

  test("rejects an out-of-range event before dispatch", () => {
    const transport = new FakeTransport();
    const client = new AutomationClient(transport, allScopes());
    expectCode(
      () =>
        client.synthesizeInput({
          terminalId: TERMINAL,
          bearer: BEARER,
          originLabel: "harness",
          events: [
            {
              type: "mouse",
              button: "Left",
              action: "click",
              col: 5000,
              row: 0,
            },
          ],
        }),
      "BoundExceeded",
    );
    expect(transport.requests.length).toBe(0);
  });
});

describe("AutomationClient captureFrame", () => {
  test("parses a semantic frame and preserves the trust label", () => {
    const transport = new FakeTransport();
    transport.response = ok(1, semanticFrame());
    const client = new AutomationClient(transport, allScopes());
    const frame = client.captureFrame({ terminalId: TERMINAL, bearer: BEARER });
    expect(frame.format).toBe("semantic");
    if (frame.format !== "semantic") throw new Error("expected semantic");
    expect(frame.lines).toEqual(["$ echo hello", "hello"]);
    expect(frame.trust).toBe("untrusted-observation");
    const sent = transport.requests[0]!;
    expect(sent.method).toBe(METHOD_CAPTURE_FRAME);
    expect((sent.params as Record<string, unknown>)["format"]).toBe("semantic");
  });

  test("pixels capture requires explicit opt-in", () => {
    const transport = new FakeTransport();
    const client = new AutomationClient(transport, allScopes());
    expectCode(
      () =>
        client.captureFrame({
          terminalId: TERMINAL,
          bearer: BEARER,
          format: "pixels",
        }),
      "InvalidParams",
    );
    expect(transport.requests.length).toBe(0);
  });

  test("parses a masked pixels frame with no pixel bytes", () => {
    const transport = new FakeTransport();
    transport.response = ok(1, pixelsFrame());
    const client = new AutomationClient(transport, allScopes());
    const frame = client.captureFrame({
      terminalId: TERMINAL,
      bearer: BEARER,
      format: "pixels",
      explicitOptIn: true,
    });
    expect(frame.format).toBe("pixels");
    expect(frame.masked).toBe(true);
  });

  test("rejects a pixels envelope carrying a tiny non-image sentinel", () => {
    const transport = new FakeTransport();
    transport.response = ok(1, pixelsFrame({ pixels: [1, 2, 3] }));
    const client = new AutomationClient(transport, allScopes());
    expectCode(
      () =>
        client.captureFrame({
          terminalId: TERMINAL,
          bearer: BEARER,
          format: "pixels",
          explicitOptIn: true,
        }),
      "InvalidResult",
    );
    expect(
      (transport.requests[0]!.params as Record<string, unknown>)["format"],
    ).toBe("pixels");
  });

  test("rejects a response that smuggles a pixels payload", () => {
    const transport = new FakeTransport();
    transport.response = ok(1, frameHash({ widthPx: 8192, heightPx: 8192 }));
    const client = new AutomationClient(transport, allScopes());
    expectCode(
      () =>
        client.captureFrame({
          terminalId: TERMINAL,
          bearer: BEARER,
          format: "pixels",
          explicitOptIn: true,
        }),
      "InvalidResult",
    );
  });

  test("rejects a semantic frame above the row bound", () => {
    const transport = new FakeTransport();
    transport.response = ok(
      1,
      semanticFrame({
        lines: Array.from({ length: BOUNDS.MAX_INSPECT_ROWS + 1 }, () => "x"),
      }),
    );
    const client = new AutomationClient(transport, allScopes());
    expectCode(
      () => client.captureFrame({ terminalId: TERMINAL, bearer: BEARER }),
      "BoundExceeded",
    );
  });
});

describe("AutomationClient frameHash", () => {
  test("parses the sha256-v1 digest and geometry", () => {
    const transport = new FakeTransport();
    transport.response = ok(1, frameHash());
    const client = new AutomationClient(transport, allScopes());
    const out = client.frameHash({ terminalId: TERMINAL, bearer: BEARER });
    expect(out.algo).toBe("sha256-v1");
    expect(out.digest.length).toBe(64);
    expect(out.frameSeq).toBe(21);
    const sent = transport.requests[0]!;
    expect(sent.method).toBe(METHOD_FRAME_HASH);
  });

  test("rejects a malformed digest", () => {
    const transport = new FakeTransport();
    transport.response = ok(1, frameHash({ digest: "NOT_HEX" }));
    const client = new AutomationClient(transport, allScopes());
    expectCode(
      () => client.frameHash({ terminalId: TERMINAL, bearer: BEARER }),
      "InvalidResult",
    );
  });

  test("rejects geometry above the frame byte cap", () => {
    const transport = new FakeTransport();
    transport.response = ok(1, frameHash({ widthPx: 8192, heightPx: 8192 }));
    const client = new AutomationClient(transport, allScopes());
    expectCode(
      () => client.frameHash({ terminalId: TERMINAL, bearer: BEARER }),
      "BoundExceeded",
    );
  });
});
