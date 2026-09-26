import { describe, expect, test } from "bun:test";
import {
  parseCompatMatrixJsonBounded,
  validatePanelSnapshot,
} from "../src/client.js";
import { DevtoolsClient } from "../src/client.js";
import { generateMatrixJson } from "../src/compat-matrix.js";

function snapshot(): Record<string, unknown> {
  return {
    generation: 1,
    panels: [],
    panelsPerWorkspace: new Map(),
    totalPanels: 0,
    topics: [],
    overlays: [],
    config: {
      maxPanelsPerWorkspace: 16,
      maxPanelsPerWindow: 32,
      maxTopicsTotal: 256,
      maxSubscriptionsPerPanel: 32,
    },
  };
}

describe("closed candidate schemas", () => {
  test("panel snapshots reject unknown and malformed nested fields", () => {
    expect(() => validatePanelSnapshot(snapshot())).not.toThrow();
    expect(() =>
      validatePanelSnapshot({ ...snapshot(), injected: true }),
    ).toThrow("not allowed");
    expect(() =>
      validatePanelSnapshot({
        ...snapshot(),
        config: { ...(snapshot().config as Record<string, unknown>), extra: 1 },
      }),
    ).toThrow("not allowed");
    expect(() =>
      validatePanelSnapshot({
        ...snapshot(),
        topics: ["not-a-topic"],
      }),
    ).toThrow("invalid topic");
  });

  test("panel snapshots enforce per-workspace configuration", () => {
    const candidate = snapshot();
    candidate.panels = [
      { id: 1, generation: 1, state: "Mounted", type: "helper" },
      { id: 2, generation: 1, state: "Mounted", type: "helper" },
    ] as never;
    candidate.totalPanels = 2;
    candidate.panelsPerWorkspace = new Map([[1, 2]]) as never;
    (candidate.config as Record<string, unknown>)["maxPanelsPerWorkspace"] = 1;
    expect(() => validatePanelSnapshot(candidate)).toThrow("configured bound");
  });

  test("validated panel snapshots are detached on input and output", () => {
    const client = new DevtoolsClient();
    client.connect();
    client.grantScope("debug.inspect");
    const input = snapshot();
    client.setPanelSnapshot(input as never);
    input.topics = ["not-a-topic"] as never;
    const first = client.getPanelSnapshot();
    expect(first?.topics).toEqual([]);
    if (first !== null) first.topics = ["not-a-topic"] as never;
    expect(client.getPanelSnapshot()?.topics).toEqual([]);
  });

  test("compat matrix parser requires the closed generated shape", () => {
    const generated = generateMatrixJson();
    expect(() => parseCompatMatrixJsonBounded(generated)).not.toThrow();
    const document = JSON.parse(generated) as Record<string, unknown>;
    expect(() =>
      parseCompatMatrixJsonBounded(
        JSON.stringify({ ...document, extra: true }),
      ),
    ).toThrow("not allowed");
    const entries = document["entries"] as Array<Record<string, unknown>>;
    entries[0]!["extra"] = true;
    expect(() =>
      parseCompatMatrixJsonBounded(JSON.stringify(document)),
    ).toThrow("not allowed");
    delete entries[0]!["extra"];
    entries[0]!["bytesLen"] = 0;
    expect(() =>
      parseCompatMatrixJsonBounded(JSON.stringify(document)),
    ).toThrow("empty matrix entry");
  });
});
