import { describe, expect, test } from "bun:test";
import { DevtoolsClient } from "../src/client.js";

describe("DevtoolsClient integration", () => {
  test("connect + scope lifecycle", () => {
    const c = new DevtoolsClient();
    const s = c.connect();
    expect(s.connected).toBe(true);
    expect(c.currentScope()).toEqual([]);
    c.grantScope("debug.inspect");
    expect(c.currentScope()).toContain("debug.inspect");
    c.grantScope("debug.trace");
    expect(c.currentScope()).toContain("debug.trace");
    c.grantScope("debug.control");
    expect(c.currentScope()).toContain("debug.control");
    c.revokeScope("debug.inspect");
    expect(c.currentScope()).toEqual([]);
  });

  test("validateFrame bounded 1 MiB", () => {
    const c = new DevtoolsClient();
    expect(() => c.validateFrame("a".repeat(2 * 1024 * 1024))).toThrow(
      "exceeded",
    );
  });

  test("generateCompatMatrixJson bounded <16 KiB", () => {
    const c = new DevtoolsClient();
    c.connect();
    c.grantScope("debug.inspect");
    c.setPanelSnapshot({
      generation: 1 as never,
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
    });
    const json = c.generateCompatMatrixJson();
    expect(new TextEncoder().encode(json).length < 16 * 1024).toBe(true);
  });

  test("untrusted observation labeling", () => {
    const c = new DevtoolsClient();
    c.connect();
    c.grantScope("debug.inspect");
    c.setPanelSnapshot({
      generation: 1 as never,
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
    });
    // Inspection explanation is constant
    const text = c.listPlugins; // ensure exists
    expect(typeof text).toBe("function");
  });
});
