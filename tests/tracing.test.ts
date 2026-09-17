import { describe, expect, test } from "bun:test";
import { DevtoolsClient } from "../src/client.js";
import { redactPreview } from "../src/redaction.js";
import {
  assertPreviewMatchesExport,
  TracingClient,
  TracingError,
  type StructuredTraceEvent,
} from "../src/tracing.js";
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

  test("raw retention follows a small UTF-8 admission model", () => {
    const records = ["你好", "café", "こんにちは", "добрый день", "salut"];
    for (const coalesce of ["budget", "none"] as const) {
      for (const dropPolicy of ["DropOldest", "DropNewest"] as const) {
        for (const [maxBytes, retentionBytes] of [
          [24, 48],
          [48, 24],
        ]) {
          const c = new TracingClient();
          const { traceId } = c.startTrace("debug.trace", {
            maxBytes,
            retention: { maxBytes: retentionBytes },
            coalesce,
            dropPolicy,
          });
          let retained = "";
          let drops = 0;
          for (const record of records) {
            const before = structuredClone(c["traces"].get(traceId)!);
            if (new TextEncoder().encode(retained + record).length <= 24) {
              retained += record;
            } else {
              drops++;
            }
            c.appendToTrace(traceId, record);
            const state = c["traces"].get(traceId)!;
            expect(state.chunks.join("")).toBe(retained);
            expect(state.bytes).toBe(new TextEncoder().encode(retained).length);
            expect(state.drops).toBe(drops);
            if (state.drops > before.drops) {
              expect({ ...state, drops: before.drops }).toEqual(before);
            }
          }
          expect(c.stopTrace("debug.trace", traceId).byteCount).toBe(
            new TextEncoder().encode(retained).length,
          );
        }
      }
    }
  });

  test("structured records bill serialized UTF-8 bytes at both ceilings", () => {
    const event: StructuredTraceEvent = {
      sequence: 1,
      owner: "面板",
      kind: "trace.record",
      payload: 'café says "こんにちは"\n',
      generation: 1,
      wallClockMs: 10,
    };
    const json = JSON.stringify(event);
    const bytes = new TextEncoder().encode(json).length;
    for (const limit of [bytes - 1, bytes, bytes + 1]) {
      for (const retentionFirst of [true, false]) {
        const c = new TracingClient();
        const { traceId } = c.startTrace("debug.trace", {
          maxBytes: retentionFirst ? bytes * 2 : limit,
          retention: { maxBytes: retentionFirst ? limit : bytes * 2 },
        });
        const before = structuredClone(c["traces"].get(traceId)!);
        c.appendStructuredEvent(traceId, event);
        const state = c["traces"].get(traceId)!;
        if (limit < bytes) {
          expect({ ...state, drops: before.drops }).toEqual(before);
          expect(state.drops).toBe(1);
        } else {
          expect(state.chunks.join("")).toBe(json);
          expect(state.bytes).toBe(bytes);
          expect(state.events).toEqual([event]);
          const accepted = structuredClone(state);
          c.appendStructuredEvent(traceId, event);
          expect({ ...state, drops: accepted.drops }).toEqual(accepted);
          expect(state.drops).toBe(1);
        }
      }
    }
  });

  test("retained redaction is measured and detached from caller events", () => {
    const c = new TracingClient();
    const { traceId } = c.startTrace("debug.trace", { maxBytes: 512 });
    const event: StructuredTraceEvent = {
      sequence: 1,
      owner: "panel-1",
      kind: "trace.record",
      payload: "password=example",
      generation: 1,
      wallClockMs: 10,
    };
    c.appendStructuredEvent(traceId, event);
    const retained = { ...event, payload: "[REDACTED]" };
    event.payload = "changed after append";
    const state = c["traces"].get(traceId)!;
    expect(state.events).toEqual([retained]);
    expect(state.chunks.join("")).toBe(JSON.stringify(retained));
    expect(state.bytes).toBe(
      new TextEncoder().encode(JSON.stringify(retained)).length,
    );
    const raw = c.startTrace("debug.trace", { maxBytes: 10 });
    c.appendToTrace(raw.traceId, "password=example");
    expect(c["traces"].get(raw.traceId)!.chunks).toEqual(["[REDACTED]"]);
    expect(c.stopTrace("debug.trace", raw.traceId).byteCount).toBe(10);
  });

  test("opaque raw records never partially coalesce with event metadata", () => {
    for (const coalesce of ["budget", "none"] as const) {
      const c = new TracingClient();
      const { traceId } = c.startTrace("debug.trace", { coalesce });
      c.appendToTrace(traceId, "你好");
      c.appendToTrace(traceId, "trace.record café");
      const state = c["traces"].get(traceId)!;
      expect(state.events.map((event) => event.payload)).toEqual([
        "你好",
        "trace.record café",
      ]);
      expect(state.chunks.join("")).toBe("你好trace.record café");
      expect(state.bytes).toBe(
        new TextEncoder().encode(state.chunks.join("")).length,
      );
    }
  });

  test("validation and filtering leave retained state unchanged", () => {
    const c = new TracingClient();
    const { traceId } = c.startTrace("debug.trace", {
      filter: { kinds: ["trace.record"] },
    });
    c.appendToTrace(traceId, "café");
    const before = structuredClone(c["traces"].get(traceId)!);
    const event: StructuredTraceEvent = {
      sequence: 2,
      owner: "panel-1",
      kind: "trace.record",
      payload: "你好",
      generation: -1,
      wallClockMs: 10,
    };
    expect(() => c.appendStructuredEvent(traceId, event)).toThrow();
    expect(c["traces"].get(traceId)).toEqual(before);
    c.appendStructuredEvent(traceId, {
      ...event,
      generation: 1,
      kind: "other",
    });
    expect({ ...c["traces"].get(traceId), drops: before.drops }).toEqual(
      before,
    );
    expect(c["traces"].get(traceId)!.drops).toBe(before.drops + 1);
  });

  test("retained raw records keep their exact encoded UTF-8 bytes", () => {
    const scalar = "𐐷";
    const [lead, trail] = [scalar.slice(0, 1), scalar.slice(1, 2)];
    const replacement = "\uFFFD";
    const c = new TracingClient();
    const { traceId } = c.startTrace("debug.trace", {
      maxBytes: 16,
      retention: { maxBytes: 32 },
      coalesce: "budget",
    });
    c.appendToTrace(traceId, lead);
    let state = c["traces"].get(traceId)!;
    expect(state.chunks).toEqual([replacement]);
    expect(state.bytes).toBe(3);
    expect(state.events.map((event) => event.payload)).toEqual([replacement]);
    c.appendToTrace(traceId, trail);
    state = c["traces"].get(traceId)!;
    expect(state.chunks).toEqual([replacement + replacement]);
    expect(state.bytes).toBe(6);
    expect(state.events.map((event) => event.payload)).toEqual([
      replacement,
      replacement,
    ]);
    expect(new TextEncoder().encode(state.chunks.join("")).length).toBe(6);
    expect(c.stopTrace("debug.trace", traceId).byteCount).toBe(6);
    const replay = new TracingClient();
    const whole = replay.startTrace("debug.trace", {
      maxBytes: 16,
      retention: { maxBytes: 16 },
      coalesce: "budget",
    });
    replay.appendToTrace(whole.traceId, scalar);
    const wholeState = replay["traces"].get(whole.traceId)!;
    expect(wholeState.bytes).toBe(4);
    expect(wholeState.chunks).toEqual([scalar]);
    expect(wholeState.events.map((event) => event.payload)).toEqual([scalar]);
    const owned = new TracingClient();
    const { traceId: ownedId } = owned.startTrace("debug.trace", {
      maxBytes: 2,
      retention: { maxBytes: 4 },
    });
    const before = structuredClone(owned["traces"].get(ownedId)!);
    owned.appendToTrace(ownedId, scalar);
    state = owned["traces"].get(ownedId)!;
    expect(state.chunks).toEqual([]);
    expect(state.bytes).toBe(0);
    expect({ ...state, drops: before.drops }).toEqual(before);
    expect(state.drops).toBe(before.drops + 1);
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
