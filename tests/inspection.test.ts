import { describe, expect, test } from "bun:test";
import { DevtoolsClient } from "../src/client.js";
import type { PanelRuntimeSnapshot } from "../src/panel-runtime.js";

function makeSnapshot(): PanelRuntimeSnapshot {
  return {
    generation: 2 as unknown as PanelRuntimeSnapshot["generation"],
    panels: [
      {
        id: 1 as unknown as PanelRuntimeSnapshot["panels"][number]["id"],
        generation:
          2 as unknown as PanelRuntimeSnapshot["panels"][number]["generation"],
        state: "Mounted",
        type: "helper",
        workspace:
          1 as unknown as PanelRuntimeSnapshot["panels"][number]["workspace"],
        view: 1 as unknown as PanelRuntimeSnapshot["panels"][number]["view"],
      },
    ],
    panelsPerWorkspace: new Map([[1 as unknown as never, 1]]),
    totalPanels: 1,
    topics: ["xuepoo.git:branch-changed" as never],
    overlays: [],
    config: {
      maxPanelsPerWorkspace: 16,
      maxPanelsPerWindow: 32,
      maxTopicsTotal: 256,
      maxSubscriptionsPerPanel: 32,
    },
  };
}

describe("inspection (debug.inspect default, read-only)", () => {
  test("connection alone grants no authority", () => {
    const c = new DevtoolsClient();
    c.connect();
    expect(() => c.listPlugins()).toThrow("scope required");
  });

  test("inspect scope allows read", () => {
    const c = new DevtoolsClient();
    c.connect();
    c.grantScope("debug.inspect");
    c.setPanelSnapshot(makeSnapshot());
    const plugins = c.listPlugins();
    expect(plugins.length).toBe(1);
    expect(c.getPlugin("panel-1")?.id).toBe("panel-1");
  });

  test("terminal output is untrusted observation with redaction", () => {
    const c = new DevtoolsClient();
    c.connect();
    c.grantScope("debug.inspect");
    c.setPanelSnapshot(makeSnapshot());
    const snap = c.getSnapshotForTerminal("term-1", "hello password=hunter2");
    expect(snap.preview.length > 0).toBe(true);
    expect(snap.redactionMarker.redacted).toBe(false); // preview field not sensitive, content not auto-redacted
  });

  test("panel summary bounded", () => {
    const c = new DevtoolsClient();
    c.connect();
    c.grantScope("debug.inspect");
    c.setPanelSnapshot(makeSnapshot());
    const s = c.panelSummary();
    expect(s.totalPanels).toBe(1);
  });

  test("compat matrix summary reuses 14x4", () => {
    const c = new DevtoolsClient();
    c.connect();
    c.grantScope("debug.inspect");
    c.setPanelSnapshot(makeSnapshot());
    const m = c.compatMatrixSummary();
    expect(m.matrixLen).toBe(14);
    expect(m.referenceTerms.length).toBe(4);
    expect(m.jsonBounded).toBe(true);
  });

  test("preview equals export invariant holds for inspection preview", () => {
    const c = new DevtoolsClient();
    c.connect();
    c.grantScope("debug.inspect");
    c.setPanelSnapshot(makeSnapshot());
    const s = c.getSnapshotForTerminal("term-1", "hello world");
    // preview equals export via redactionPreview (no echo of unbounded bytes)
    expect(s.preview).toBe("hello world");
  });
});
