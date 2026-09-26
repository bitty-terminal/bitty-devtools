import { describe, expect, test } from "bun:test";
import * as publicApi from "../src/index.js";
import { DevtoolsClient } from "../src/client.js";
import { redactPreview } from "../src/redaction.js";
import {
  assertPreviewMatchesExport,
  TracingClient,
  TracingError,
  type StructuredTraceEvent,
} from "../src/tracing.js";
import type { PanelRuntimeSnapshot } from "../src/panel-runtime.js";
import { BOUNDS } from "../src/bounds.js";
import { DIR_MODE, SOCKET_MODE } from "../src/auth.js";
import {
  RateLimiter,
  checkConnectionCap,
  checkPayloadCap,
} from "../src/transport.js";
import { exitCodeForError } from "../src/cli.js";
import { EXIT_GENERIC, EXIT_PERM } from "../src/campaign.js";

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
  test("low-level tracing client is not part of the public package surface", () => {
    expect(Object.hasOwn(publicApi, "TracingClient")).toBe(false);
  });

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

  test("low-level tracing accessors require trace scope", () => {
    const tracing = new TracingClient();
    const start = tracing.startTrace("debug.trace", {});
    expect(() =>
      tracing.appendToTrace("debug.control", start.traceId, "x"),
    ).toThrow("debug.trace scope required");
    expect(() => tracing.listTraces("debug.control")).toThrow(
      "debug.trace scope required",
    );
    tracing.stopTrace("debug.trace", start.traceId);
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

  test("streamEvents admits records against the requested byte budget", () => {
    const c = new DevtoolsClient();
    c.connect();
    c.grantScope("debug.trace");
    const first = {
      owner: "panel-1",
      kind: "one",
      payload: JSON.stringify({ count: 1 }),
    };
    const firstBytes = new TextEncoder().encode(JSON.stringify([first])).length;
    const batch = c.streamEvents(["one", "two"], {
      maxEvents: 2,
      maxBytes: firstBytes,
    });
    expect(batch.records).toHaveLength(1);
    expect(batch.dropCount).toBe(1);
    expect(new TextEncoder().encode(JSON.stringify(batch.records)).length).toBe(
      firstBytes,
    );
  });

  test("filtered streams use the same requested byte budget", () => {
    const c = new DevtoolsClient();
    c.connect();
    c.grantScope("debug.trace");
    const record = {
      owner: "panel-1",
      kind: "one",
      payload: JSON.stringify({ count: 1 }),
    };
    const maxBytes = new TextEncoder().encode(JSON.stringify([record])).length;
    const batch = c.streamFilteredEvents(
      { kinds: ["one", "two"] },
      { maxEvents: 2, maxBytes },
    );
    expect(batch.records).toHaveLength(1);
    expect(batch.dropCount).toBe(1);
  });

  test("filtered stream kind cardinality matches Rust", () => {
    const c = new DevtoolsClient();
    c.connect();
    c.grantScope("debug.trace");
    expect(() =>
      c.streamFilteredEvents(
        { kinds: Array.from({ length: 33 }, (_, index) => `event.${index}`) },
        { maxEvents: 32, maxBytes: 8192 },
      ),
    ).toThrow("filter.kinds");
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

  for (const structured of [false, true]) {
    test(`variable-size ${structured ? "structured" : "raw"} pages match the retained stream`, () => {
      const c = new TracingClient();
      const scope = "debug.trace";
      const start = c.startTrace(scope, { maxBytes: 1024 * 1024 });
      const records: string[] = [];
      const chunks: string[] = [];
      for (let i = 0; i < 80; i++) {
        const payload = `${i}:` + "abcdef".repeat(900 + (i % 5) * 100);
        const event = {
          sequence: i,
          owner: "panel-1",
          kind: "sample",
          payload,
          generation: 1,
          wallClockMs: i,
        };
        const record = structured ? JSON.stringify(event) : payload;
        records.push(record);
        const last = chunks.length - 1;
        if (
          last < 0 ||
          chunks[last]!.length + record.length > start.chunkBytes
        ) {
          chunks.push(record);
        } else {
          chunks[last] += record;
        }
        if (structured) c.appendStructuredEvent(scope, start.traceId, event);
        else c.appendToTrace(scope, start.traceId, payload);
      }
      const reference = records.join("");
      expect(chunks.length).toBeGreaterThan(2);
      expect(chunks[0]!.length).toBeLessThan(start.chunkBytes);
      let startOffset = 0;
      for (const expectedChunk of chunks) {
        for (const intraOffset of [0, 1, expectedChunk.length - 1]) {
          const offset = startOffset + intraOffset;
          const page = c.fetchTraceChunk(scope, start.traceId, offset);
          expect(page.offset).toBe(offset);
          expect(page.chunk).toBe(expectedChunk.slice(intraOffset));
          expect(page.chunk).toBe(
            reference.slice(offset, offset + page.chunk.length),
          );
          expect(page.preview).toBe(
            redactPreview(page.chunk.slice(0, 512), "trace.preview").text,
          );
          expect(page.chunk.length).toBeLessThanOrEqual(start.chunkBytes);
          expect(page.continuation).toBe(
            offset + page.chunk.length < reference.length,
          );
        }
        startOffset += expectedChunk.length;
      }
      let offset = 0;
      let reconstructed = "";
      for (let i = 0; i < chunks.length; i++) {
        const page = c.fetchTraceChunk(scope, start.traceId, offset);
        expect(page.chunk.length).toBeGreaterThan(0);
        reconstructed += page.chunk;
        offset += page.chunk.length;
        expect(page.continuation).toBe(i < chunks.length - 1);
      }
      expect(reconstructed).toBe(reference);
      const end = c.fetchTraceChunk(scope, start.traceId, reference.length);
      expect(end.chunk).toBe("");
      expect(end.continuation).toBe(false);
    });
  }

  test("fetch offsets use UTF-8 boundaries and preserve text", () => {
    const c = new TracingClient();
    const scope = "debug.trace";
    const start = c.startTrace(scope, {});
    const source = "aé中🙂\uFEFFz";
    c.appendToTrace(scope, start.traceId, source);
    const encoder = new TextEncoder();
    let offset = 0;
    let charOffset = 0;
    for (const char of source) {
      const page = c.fetchTraceChunk(scope, start.traceId, offset);
      expect(page.offset).toBe(offset);
      expect(page.chunk).toBe(source.slice(charOffset));
      expect(encoder.encode(page.chunk).length).toBe(
        encoder.encode(source).length - offset,
      );
      expect(page.continuation).toBe(false);
      offset += encoder.encode(char).length;
      charOffset += char.length;
    }
    expect(c.fetchTraceChunk(scope, start.traceId, offset).chunk).toBe("");
    expect(() => c.fetchTraceChunk(scope, start.traceId, 2)).toThrow();
  });

  test("normalized raw fragments paginate within retained byte budgets", () => {
    const scalar = "𐐷";
    const fragments = [scalar.slice(0, 1), scalar.slice(1), "\uFEFF", "é", "z"];
    const expected = "\uFFFD\uFFFD\uFEFFéz";
    const encoder = new TextEncoder();
    const bytes = encoder.encode(expected).length;
    for (const retentionFirst of [true, false]) {
      const c = new TracingClient();
      const scope = "debug.trace";
      const { traceId } = c.startTrace("debug.trace", {
        maxBytes: retentionFirst ? bytes * 2 : bytes,
        retention: { maxBytes: retentionFirst ? bytes : bytes * 2 },
      });
      for (const fragment of fragments)
        c.appendToTrace(scope, traceId, fragment);
      const before = c.fetchTraceChunk("debug.trace", traceId, 0);
      expect(before.chunk).toBe(expected);
      c.appendToTrace(scope, traceId, "extra");
      expect(c.fetchTraceChunk("debug.trace", traceId, 0)).toEqual(before);
      let offset = 0;
      let charOffset = 0;
      for (const char of expected) {
        const page = c.fetchTraceChunk("debug.trace", traceId, offset);
        expect(page.chunk).toBe(expected.slice(charOffset));
        expect(encoder.encode(page.chunk)).toEqual(
          encoder.encode(expected).slice(offset),
        );
        expect(page.continuation).toBe(false);
        offset += encoder.encode(char).length;
        charOffset += char.length;
      }
      const end = c.fetchTraceChunk("debug.trace", traceId, bytes);
      expect(end.chunk).toBe("");
      expect(end.continuation).toBe(false);
      const stopped = c.stopTrace("debug.trace", traceId);
      expect(stopped.byteCount).toBe(bytes);
      expect(stopped.dropCount).toBe(1);
    }
  });

  for (const structured of [false, true]) {
    test(`multilingual ${structured ? "structured" : "raw"} pages preserve retained bytes across chunks`, () => {
      const c = new TracingClient();
      const scope = "debug.trace";
      const { traceId, chunkBytes } = c.startTrace("debug.trace", {
        maxBytes: 1024 * 1024,
      });
      const encoder = new TextEncoder();
      const chunks: string[] = [];
      const records: string[] = [];
      for (let i = 0; i < 100; i++) {
        const payload = "\uFEFF" + "é中𐐷".repeat(600 + (i % 4) * 50) + "z";
        const event: StructuredTraceEvent = {
          sequence: i,
          owner: "panel-1",
          kind: "sample",
          payload,
          generation: 1,
          wallClockMs: i,
        };
        const record = structured ? JSON.stringify(event) : payload;
        records.push(record);
        const last = chunks.length - 1;
        if (
          last < 0 ||
          encoder.encode(chunks[last]! + record).length > chunkBytes
        )
          chunks.push(record);
        else chunks[last] += record;
        if (structured) c.appendStructuredEvent(scope, traceId, event);
        else c.appendToTrace(scope, traceId, payload);
      }
      const reference = records.join("");
      const referenceBytes = encoder.encode(reference);
      expect(chunks.length).toBeGreaterThan(2);
      let offset = 0;
      let reconstructed = "";
      for (const expectedChunk of chunks) {
        const page = c.fetchTraceChunk("debug.trace", traceId, offset);
        const length = encoder.encode(expectedChunk).length;
        expect(page.chunk).toBe(expectedChunk);
        expect(encoder.encode(page.chunk)).toEqual(
          referenceBytes.slice(offset, offset + length),
        );
        expect(length).toBeLessThanOrEqual(chunkBytes);
        expect(page.continuation).toBe(offset + length < referenceBytes.length);
        const lastByte = c.fetchTraceChunk(
          "debug.trace",
          traceId,
          offset + length - 1,
        );
        expect(lastByte.chunk).toBe(expectedChunk.slice(-1));
        expect(lastByte.continuation).toBe(page.continuation);
        reconstructed += page.chunk;
        offset += length;
      }
      expect(reconstructed).toBe(reference);
      expect(c.fetchTraceChunk("debug.trace", traceId, offset).chunk).toBe("");
      expect(
        c.fetchTraceChunk("debug.trace", traceId, offset).continuation,
      ).toBe(false);
      expect(c.stopTrace("debug.trace", traceId).byteCount).toBe(offset);
    });
  }

  test("empty, end and appended-tail offsets have explicit continuation", () => {
    const c = new TracingClient();
    const scope = "debug.trace";
    const start = c.startTrace(scope, {});
    expect(c.fetchTraceChunk(scope, start.traceId, 0).chunk).toBe("");
    expect(c.fetchTraceChunk(scope, start.traceId, 0).continuation).toBe(false);
    c.appendToTrace(scope, start.traceId, "hello");
    const first = c.fetchTraceChunk(scope, start.traceId, 0);
    expect(first.continuation).toBe(false);
    c.appendToTrace(scope, start.traceId, " world");
    const tail = c.fetchTraceChunk(scope, start.traceId, first.chunk.length);
    expect(tail.chunk).toBe(" world");
    expect(tail.continuation).toBe(false);
    expect(c.fetchTraceChunk(scope, start.traceId, 11).chunk).toBe("");
    for (const offset of [-1, 0.5, 12, NaN, Infinity]) {
      expect(() => c.fetchTraceChunk(scope, start.traceId, offset)).toThrow();
    }
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
          const scope = "debug.trace";
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
            c.appendToTrace(scope, traceId, record);
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
        const scope = "debug.trace";
        const { traceId } = c.startTrace("debug.trace", {
          maxBytes: retentionFirst ? bytes * 2 : limit,
          retention: { maxBytes: retentionFirst ? limit : bytes * 2 },
        });
        const before = structuredClone(c["traces"].get(traceId)!);
        c.appendStructuredEvent(scope, traceId, event);
        const state = c["traces"].get(traceId)!;
        if (limit < bytes) {
          expect({ ...state, drops: before.drops }).toEqual(before);
          expect(state.drops).toBe(1);
        } else {
          expect(state.chunks.join("")).toBe(json);
          expect(state.bytes).toBe(bytes);
          expect(state.events).toEqual([event]);
          const accepted = structuredClone(state);
          c.appendStructuredEvent(scope, traceId, event);
          expect({ ...state, drops: accepted.drops }).toEqual(accepted);
          expect(state.drops).toBe(1);
        }
      }
    }
  });

  test("retained redaction is measured and detached from caller events", () => {
    const c = new TracingClient();
    const scope = "debug.trace";
    const { traceId } = c.startTrace("debug.trace", { maxBytes: 512 });
    const event: StructuredTraceEvent = {
      sequence: 1,
      owner: "panel-1",
      kind: "trace.record",
      payload: "password=example",
      generation: 1,
      wallClockMs: 10,
    };
    c.appendStructuredEvent(scope, traceId, event);
    const retained = { ...event, payload: "[REDACTED]" };
    event.payload = "changed after append";
    const state = c["traces"].get(traceId)!;
    expect(state.events).toEqual([retained]);
    expect(state.chunks.join("")).toBe(JSON.stringify(retained));
    expect(state.bytes).toBe(
      new TextEncoder().encode(JSON.stringify(retained)).length,
    );
    const raw = c.startTrace("debug.trace", { maxBytes: 10 });
    c.appendToTrace(scope, raw.traceId, "password=example");
    expect(c["traces"].get(raw.traceId)!.chunks).toEqual(["[REDACTED]"]);
    expect(c.stopTrace("debug.trace", raw.traceId).byteCount).toBe(10);
  });

  test("opaque raw records never partially coalesce with event metadata", () => {
    for (const coalesce of ["budget", "none"] as const) {
      const c = new TracingClient();
      const scope = "debug.trace";
      const { traceId } = c.startTrace("debug.trace", { coalesce });
      c.appendToTrace(scope, traceId, "你好");
      c.appendToTrace(scope, traceId, "trace.record café");
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
    const scope = "debug.trace";
    const { traceId } = c.startTrace("debug.trace", {
      filter: { kinds: ["trace.record"] },
    });
    c.appendToTrace(scope, traceId, "café");
    const before = structuredClone(c["traces"].get(traceId)!);
    const event: StructuredTraceEvent = {
      sequence: 2,
      owner: "panel-1",
      kind: "trace.record",
      payload: "你好",
      generation: -1,
      wallClockMs: 10,
    };
    expect(() => c.appendStructuredEvent(scope, traceId, event)).toThrow();
    expect(c["traces"].get(traceId)).toEqual(before);
    c.appendStructuredEvent(scope, traceId, {
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
    const scope = "debug.trace";
    const { traceId } = c.startTrace("debug.trace", {
      maxBytes: 16,
      retention: { maxBytes: 32 },
      coalesce: "budget",
    });
    c.appendToTrace(scope, traceId, lead);
    let state = c["traces"].get(traceId)!;
    expect(state.chunks).toEqual([replacement]);
    expect(state.bytes).toBe(3);
    expect(state.events.map((event) => event.payload)).toEqual([replacement]);
    c.appendToTrace(scope, traceId, trail);
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
    const replayScope = "debug.trace";
    const whole = replay.startTrace("debug.trace", {
      maxBytes: 16,
      retention: { maxBytes: 16 },
      coalesce: "budget",
    });
    replay.appendToTrace(replayScope, whole.traceId, scalar);
    const wholeState = replay["traces"].get(whole.traceId)!;
    expect(wholeState.bytes).toBe(4);
    expect(wholeState.chunks).toEqual([scalar]);
    expect(wholeState.events.map((event) => event.payload)).toEqual([scalar]);
    const owned = new TracingClient();
    const ownedScope = "debug.trace";
    const { traceId: ownedId } = owned.startTrace("debug.trace", {
      maxBytes: 2,
      retention: { maxBytes: 4 },
    });
    const before = structuredClone(owned["traces"].get(ownedId)!);
    owned.appendToTrace(ownedScope, ownedId, scalar);
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

describe("wire-trace negatives N5-N14", () => {
  test("N5 inspect scope denies stop and fetch chunk exit 7", () => {
    const c = new DevtoolsClient();
    c.connect();
    c.grantScope("debug.inspect");
    const t = new TracingClient();
    const started = t.startTrace("debug.trace", { maxBytes: 1024 });
    expect(() => t.stopTrace("debug.inspect", started.traceId)).toThrow(
      "debug.trace scope required",
    );
    expect(() =>
      t.fetchTraceChunk("debug.inspect", started.traceId, 0),
    ).toThrow("debug.trace scope required");
    expect(() => c.startTrace({})).toThrow("debug.trace scope required");
    expect(exitCodeForError(new TracingError("ScopeDenied", "x"))).toBe(
      EXIT_PERM,
    );
    c.disconnect();
  });

  test("N6 direct duration rejects zero float and over max", () => {
    const t = new TracingClient();
    expect(() => t.startTrace("debug.trace", { durationMs: 0 })).toThrow();
    expect(() => t.startTrace("debug.trace", { durationMs: 1.5 })).toThrow();
    expect(() =>
      t.startTrace("debug.trace", {
        durationMs: BOUNDS.MAX_TRACE_DURATION_MS + 1,
      }),
    ).toThrow();
    expect(() =>
      t.startTrace("debug.trace", { durationMs: Number.NaN }),
    ).toThrow();
  });

  test("N7 direct maxBytes rejects zero float and over max", () => {
    const t = new TracingClient();
    expect(() => t.startTrace("debug.trace", { maxBytes: 0 })).toThrow();
    expect(() => t.startTrace("debug.trace", { maxBytes: 1.5 })).toThrow();
    expect(() =>
      t.startTrace("debug.trace", { maxBytes: BOUNDS.MAX_TRACE_BYTES + 1 }),
    ).toThrow();
  });

  test("N8 direct offset rejects negative noninteger and over bytes", () => {
    const t = new TracingClient();
    const s = t.startTrace("debug.trace", { maxBytes: 1024 });
    t.appendToTrace("debug.trace", s.traceId, "hello");
    expect(() => t.fetchTraceChunk("debug.trace", s.traceId, -1)).toThrow();
    expect(() => t.fetchTraceChunk("debug.trace", s.traceId, 1.5)).toThrow();
    expect(() => t.fetchTraceChunk("debug.trace", s.traceId, 6)).toThrow();
    expect(exitCodeForError(new TracingError("InvalidOffset", "x"))).toBe(
      EXIT_GENERIC,
    );
    const ok = t.fetchTraceChunk("debug.trace", s.traceId, 5);
    expect(ok.chunk).toBe("");
    expect(ok.continuation).toBe(false);
    t.stopTrace("debug.trace", s.traceId);
  });

  test("N9 input default off with redaction on opt in", () => {
    const t = new TracingClient();
    const s = t.startTrace("debug.trace", { maxBytes: 1024 });
    t.appendToTrace(
      "debug.trace",
      s.traceId,
      "clipboard=top-secret-value password=hide",
    );
    const page = t.fetchTraceChunk("debug.trace", s.traceId, 0);
    expect(page.chunk).not.toContain("hide");
    expect(page.chunk).toBe("[REDACTED]");
    t.stopTrace("debug.trace", s.traceId);
    const s2 = t.startTrace("debug.trace", {
      maxBytes: 1024,
      includeInput: true,
    });
    t.appendToTrace("debug.trace", s2.traceId, "password=hide-me");
    const page2 = t.fetchTraceChunk("debug.trace", s2.traceId, 0);
    expect(page2.chunk).toBe("[REDACTED]");
    t.stopTrace("debug.trace", s2.traceId);
  });

  test("N10 spool 0600 dir 0700 and preview mismatch", () => {
    expect(DIR_MODE).toBe(0o700);
    expect(SOCKET_MODE).toBe(0o600);
    const t = new TracingClient();
    const s = t.startTrace("debug.trace", { maxBytes: 2048 });
    t.appendToTrace("debug.trace", s.traceId, "token=sk-live-abcdefgh12345678");
    const stopped = t.stopTrace("debug.trace", s.traceId);
    expect(stopped.spoolMode).toBe("memory");
    expect(stopped.previews.join("")).not.toContain("sk-live");
    expect(() => assertPreviewMatchesExport("hello", "hello-tampered")).toThrow(
      "preview must equal export",
    );
  });

  test("N11 byte counts use UTF-8 not length", () => {
    const enc = new TextEncoder();
    expect(enc.encode("aé中").length).toBe(6);
    expect("aé中".length).toBe(3);
    const t = new TracingClient();
    const s = t.startTrace("debug.trace", { maxBytes: 1024 });
    t.appendToTrace("debug.trace", s.traceId, "é");
    const state = t.listTraces("debug.trace");
    expect(state).toContain(s.traceId);
    expect(() => t.fetchTraceChunk("debug.trace", s.traceId, 1)).toThrow();
    const p0 = t.fetchTraceChunk("debug.trace", s.traceId, 0);
    expect(enc.encode(p0.chunk).length).toBe(2);
    t.stopTrace("debug.trace", s.traceId);
  });

  test("N14 RC-9 payload connection and drop shedding", () => {
    const limiter = RateLimiter.rc9Default();
    for (let i = 0; i < 200; i += 1) {
      limiter.check(i);
    }
    expect(() => limiter.check(200)).toThrow("rate limited");
    expect(() => checkPayloadCap(2 * 1024 * 1024)).toThrow();
    expect(() => checkConnectionCap(16)).toThrow("shed newest");
    const t = new TracingClient();
    const s = t.startTrace("debug.trace", { maxBytes: 5 });
    t.appendToTrace("debug.trace", s.traceId, "hello");
    t.appendToTrace("debug.trace", s.traceId, "extra-bytes");
    const stopped = t.stopTrace("debug.trace", s.traceId);
    expect(stopped.dropCount).toBe(1);
    expect(stopped.truncated).toBe(true);
  });
});
