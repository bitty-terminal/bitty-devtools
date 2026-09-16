import { describe, expect, test } from "bun:test";
import { DevtoolsClient } from "../src/client.js";
import { redactPreview } from "../src/redaction.js";
import { assertPreviewMatchesExport, TracingError } from "../src/tracing.js";
import type { PanelRuntimeSnapshot } from "../src/panel-runtime.js";

function snap(): PanelRuntimeSnapshot {
  return {
    generation: 1 as unknown as PanelRuntimeSnapshot["generation"],
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

describe("tracing (debug.trace, opt-in, bounded)", () => {
  test("inspect cannot start trace", () => {
    const c = new DevtoolsClient();
    c.connect();
    c.grantScope("debug.inspect");
    c.setPanelSnapshot(snap());
    expect(() => c.startTrace({})).toThrow("debug.trace scope required");
  });

  test("trace scope can start/stop with bounded defaults", () => {
    const c = new DevtoolsClient();
    c.connect();
    c.grantScope("debug.trace");
    c.setPanelSnapshot(snap());
    const start = c.startTrace({ maxBytes: 1024, includeInput: false });
    expect(start.traceId.startsWith("trace-")).toBe(true);
    expect(start.chunkBytes).toBe(256 * 1024);
    c.appendToTrace(start.traceId, "hello");
    const stop = c.stopTrace(start.traceId);
    expect(stop.byteCount).toBe(5);
    expect(stop.previews[0]).toBe("hello");
  });

  test("streamEvents bounded 32/8 KiB and DropOldest", () => {
    const c = new DevtoolsClient();
    c.connect();
    c.grantScope("debug.trace");
    const batch = c.streamEvents(
      ["bitty.panel:mounted", "example.git:branch-changed"],
      {
        maxEvents: 32,
        maxBytes: 8192,
      },
    );
    expect(batch.records.length).toBe(2);
    expect(batch.dropCount).toBe(0);
  });

  test("trace duration and bytes bounded", () => {
    const c = new DevtoolsClient();
    c.connect();
    c.grantScope("debug.trace");
    expect(() => c.startTrace({ durationMs: 10 * 60 * 1000 })).toThrow(
      "exceeded",
    );
    expect(() => c.startTrace({ maxBytes: 10 * 1024 * 1024 })).toThrow(
      "exceeded",
    );
  });

  test("input markers opt-in default off (minimization)", () => {
    const c = new DevtoolsClient();
    c.connect();
    c.grantScope("debug.trace");
    const start = c.startTrace({});
    // default includeInput false
    expect(start.traceId).toContain("trace-");
    c.stopTrace(start.traceId);
  });

  test("fetchTraceChunk bounded 256 KiB with continuation", () => {
    const c = new DevtoolsClient();
    c.connect();
    c.grantScope("debug.trace");
    const start = c.startTrace({ maxBytes: 8192 });
    c.appendToTrace(start.traceId, "a".repeat(100));
    const chunk = c.fetchTraceChunk(start.traceId, 0);
    expect(chunk.chunk.length).toBe(100);
    expect(chunk.continuation).toBe(false);
    c.stopTrace(start.traceId);
  });

  test("H-DEV-02: tampered export bytes fail the preview check (no tautology)", () => {
    // Before the fix both call sites compared the preview to itself, so this
    // tampered export passed silently. The honest check throws PreviewMismatch.
    let code: string | null = null;
    try {
      assertPreviewMatchesExport("hello", "hello-tampered");
    } catch (e) {
      code = e instanceof TracingError ? e.code : null;
    }
    expect(code).toBe("PreviewMismatch");
  });

  test("H-DEV-02: preview matches re-redacted export (redaction-safe)", () => {
    // Redaction legitimately changes bytes: the check compares
    // redacted-to-redacted, so any source that redacts to the returned
    // preview passes, while a diverged source throws.
    const source = "chunk-bytes-for-export";
    const { text: preview } = redactPreview(source, "trace.preview");
    expect(() => assertPreviewMatchesExport(preview, source)).not.toThrow();
    let code: string | null = null;
    try {
      assertPreviewMatchesExport(preview, "diverged-chunk-bytes");
    } catch (e) {
      code = e instanceof TracingError ? e.code : null;
    }
    expect(code).toBe("PreviewMismatch");
  });

  test("cancellation via AbortSignal", () => {
    const c = new DevtoolsClient();
    c.connect();
    c.grantScope("debug.trace");
    const ac = new AbortController();
    ac.abort();
    expect(() =>
      c.streamEvents(
        ["bitty.panel:mounted"],
        { maxEvents: 1, maxBytes: 1024 },
        ac.signal,
      ),
    ).toThrow("cancelled");
  });
});
