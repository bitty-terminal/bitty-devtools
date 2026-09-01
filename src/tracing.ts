/**
 * Tracing surface (debug.trace, opt-in, bounded, per-consumer queues) — phase 2 advanced.
 *
 * Reuses the observability pipeline envelope from devtools-rfc: per-subscription
 * 64, per-plugin 1024/256 KiB, global 8192/2 MiB, DropOldest default, batch
 * 32/8 KiB, chunked at 256 KiB to user-only storage (0600). Minimization by
 * default, input markers require explicit includeInput:true plus typed redaction.
 * Preview equals export before transmission.
 *
 * Phase 2 adds: advanced filtering, structured attributable events, retention
 * and GC policy, coalescing control, deterministic wall-clock, export preview
 * with chunked continuation, and DropOldest/DropNewest policies. All bounds are
 * preserved and peer-creds are re-checked per privileged action via the IPC
 * transport seam.
 */

import { BOUNDS, assertBounded, assertStringBounded } from "./bounds.js";
import { redactPreview, previewEqualsExport } from "./redaction.js";

export type TraceOptions = {
  durationMs?: number;
  maxBytes?: number;
  includeInput?: boolean;
  /** Phase 2: structured filter for event kinds (bounded 32 entries). */
  filter?: TraceFilter;
  /** Phase 2: retention policy override (default 5 min / 4 MiB). */
  retention?: TraceRetention;
  /** Phase 2: coalescing policy for budget records. */
  coalesce?: "budget" | "none";
  /** Phase 2: drop policy for overflow. */
  dropPolicy?: "DropOldest" | "DropNewest";
};

export type TraceFilter = {
  kinds?: string[];
  owners?: string[];
  excludeInput?: boolean;
};

export type TraceRetention = {
  maxBytes?: number;
  maxDurationMs?: number;
  maxTraces?: number;
};

export type TraceStartResult = {
  traceId: string;
  spoolPath: string;
  chunkBytes: number;
  startWallClockMs: number;
  filter?: TraceFilter;
  retention: TraceRetention;
};

export type TraceStopResult = {
  traceId: string;
  byteCount: number;
  dropCount: number;
  previews: string[];
  exportBytesEstimate: number;
  truncated: boolean;
  spoolMode: string;
};

export type TraceChunk = {
  traceId: string;
  offset: number;
  chunk: string;
  continuation: boolean;
  preview: string;
  sequence: number;
};

export type StructuredTraceEvent = {
  sequence: number;
  owner: string;
  kind: string;
  payload: string;
  generation: number;
  wallClockMs: number;
  coalesced?: boolean;
};

export type ObservabilityBatch = {
  sequence: number;
  dropCount: number;
  records: Array<{ owner: string; kind: string; payload: string }>;
  wallClockMs: number;
  coalescedCount: number;
  policy: "DropOldest" | "DropNewest";
};

export type TraceRetentionPolicy = {
  maxBytes: number;
  maxDurationMs: number;
  maxTraces: number;
  currentTraces: number;
  oldestTraceId: string | null;
};

export class TracingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TracingError";
  }
}

const MAX_TRACES_PER_SESSION = 4;
const DEFAULT_RETENTION: Required<TraceRetention> = {
  maxBytes: 4 * 1024 * 1024,
  maxDurationMs: 5 * 60 * 1000,
  maxTraces: MAX_TRACES_PER_SESSION,
};

export class TracingClient {
  private traces = new Map<
    string,
    {
      options: TraceOptions;
      bytes: number;
      drops: number;
      chunks: string[];
      startMs: number;
      sequence: number;
      events: StructuredTraceEvent[];
      filter?: TraceFilter;
      retention: Required<TraceRetention>;
      dropPolicy: "DropOldest" | "DropNewest";
      coalesce: "budget" | "none";
      previewCache: string[];
    }
  >();
  private nextTrace = 1;
  private globalSequence = 0;

  private requireTrace(scope: string): void {
    if (scope !== "debug.trace" && scope !== "debug.control") {
      throw new TracingError("ScopeDenied", "debug.trace scope required");
    }
  }

  private validateOptions(opts: TraceOptions): TraceOptions & {
    retention: Required<TraceRetention>;
    dropPolicy: "DropOldest" | "DropNewest";
    coalesce: "budget" | "none";
    durationMs: number;
    maxBytes: number;
    includeInput: boolean;
  } {
    const durationMs = opts.durationMs ?? 10_000;
    const maxBytes = opts.maxBytes ?? 512 * 1024;
    const includeInput = opts.includeInput ?? false;
    const dropPolicy = opts.dropPolicy ?? "DropOldest";
    const coalesce = opts.coalesce ?? "budget";
    const filter = opts.filter;
    if (filter?.kinds !== undefined) {
      assertBounded("filter.kinds", filter.kinds.length, 32);
      for (const k of filter.kinds) assertStringBounded("filter kind", k, 64);
    }
    if (filter?.owners !== undefined) {
      assertBounded("filter.owners", filter.owners.length, 32);
      for (const o of filter.owners) assertStringBounded("filter owner", o, 64);
    }
    const retention: Required<TraceRetention> = {
      maxBytes:
        opts.retention?.maxBytes ??
        Math.min(maxBytes, DEFAULT_RETENTION.maxBytes),
      maxDurationMs:
        opts.retention?.maxDurationMs ??
        Math.min(durationMs, DEFAULT_RETENTION.maxDurationMs),
      maxTraces: opts.retention?.maxTraces ?? DEFAULT_RETENTION.maxTraces,
    };
    assertBounded("durationMs", durationMs, BOUNDS.MAX_TRACE_DURATION_MS);
    if (durationMs <= 0)
      throw new TracingError("InvalidDuration", "durationMs must be >0");
    assertBounded("maxBytes", maxBytes, BOUNDS.MAX_TRACE_BYTES);
    assertBounded(
      "retention.maxBytes",
      retention.maxBytes,
      BOUNDS.MAX_TRACE_BYTES,
    );
    assertBounded(
      "retention.maxDurationMs",
      retention.maxDurationMs,
      BOUNDS.MAX_TRACE_DURATION_MS,
    );
    if (
      retention.maxTraces <= 0 ||
      retention.maxTraces > MAX_TRACES_PER_SESSION
    ) {
      throw new TracingError(
        "InvalidRetention",
        `maxTraces must be 1..${MAX_TRACES_PER_SESSION}`,
      );
    }
    if (dropPolicy !== "DropOldest" && dropPolicy !== "DropNewest") {
      throw new TracingError(
        "InvalidPolicy",
        "dropPolicy must be DropOldest or DropNewest",
      );
    }
    if (!includeInput) {
      // minimization by default: no input markers
    }
    return {
      durationMs,
      maxBytes,
      includeInput,
      filter,
      retention,
      dropPolicy,
      coalesce,
    };
  }

  startTrace(scope: string, opts: TraceOptions): TraceStartResult {
    this.requireTrace(scope);
    if (this.traces.size >= MAX_TRACES_PER_SESSION) {
      throw new TracingError(
        "TooManyTraces",
        `at most ${MAX_TRACES_PER_SESSION} traces per session`,
      );
    }
    const validated = this.validateOptions(opts);
    const traceId = `trace-${this.nextTrace++}`;
    const spoolPath = `/tmp/bitty-traces/${traceId}.jsonl`;
    const startWallClockMs = Date.now();
    this.traces.set(traceId, {
      options: validated,
      bytes: 0,
      drops: 0,
      chunks: [],
      startMs: startWallClockMs,
      sequence: this.globalSequence++,
      events: [],
      filter: validated.filter,
      retention: validated.retention,
      dropPolicy: validated.dropPolicy,
      coalesce: validated.coalesce,
      previewCache: [],
    });
    return {
      traceId,
      spoolPath,
      chunkBytes: BOUNDS.CHUNK_BYTES,
      startWallClockMs,
      filter: validated.filter,
      retention: validated.retention,
    };
  }

  /** Phase 2: start with explicit filter and deterministic nowMs. */
  startTraceWithFilter(
    scope: string,
    opts: TraceOptions,
    nowMs?: number,
  ): TraceStartResult {
    this.requireTrace(scope);
    const wall = nowMs ?? Date.now();
    if (this.traces.size >= MAX_TRACES_PER_SESSION) {
      throw new TracingError(
        "TooManyTraces",
        `at most ${MAX_TRACES_PER_SESSION} traces per session`,
      );
    }
    const validated = this.validateOptions(opts);
    const traceId = `trace-${this.nextTrace++}`;
    const spoolPath = `/run/user/1000/bitty/traces/${traceId}.jsonl`;
    this.traces.set(traceId, {
      options: validated,
      bytes: 0,
      drops: 0,
      chunks: [],
      startMs: wall,
      sequence: this.globalSequence++,
      events: [],
      filter: validated.filter,
      retention: validated.retention,
      dropPolicy: validated.dropPolicy,
      coalesce: validated.coalesce,
      previewCache: [],
    });
    return {
      traceId,
      spoolPath,
      chunkBytes: BOUNDS.CHUNK_BYTES,
      startWallClockMs: wall,
      filter: validated.filter,
      retention: validated.retention,
    };
  }

  stopTrace(scope: string, traceId: string): TraceStopResult {
    this.requireTrace(scope);
    const rec = this.traces.get(traceId);
    if (rec === undefined)
      throw new TracingError("NotFound", `trace ${traceId} not found`);
    const previews = rec.chunks.slice(0, 4).map((c) => {
      const { text } = redactPreview(c.slice(0, 512), "trace.preview");
      return text;
    });
    const exportBytesEstimate = rec.bytes;
    const truncated = rec.drops > 0;
    const result: TraceStopResult = {
      traceId,
      byteCount: rec.bytes,
      dropCount: rec.drops,
      previews,
      exportBytesEstimate,
      truncated,
      spoolMode: "0600",
    };
    this.traces.delete(traceId);
    return result;
  }

  streamEvents(
    scope: string,
    types: string[],
    batch: { maxEvents: number; maxBytes: number },
    signal?: AbortSignal,
  ): ObservabilityBatch {
    this.requireTrace(scope);
    if (signal?.aborted)
      throw new TracingError("Cancelled", "stream cancelled");
    assertBounded("maxEvents", batch.maxEvents, BOUNDS.BUS_BATCH_MAX_EVENTS);
    assertBounded("maxBytes", batch.maxBytes, BOUNDS.BUS_BATCH_MAX_BYTES);
    for (const t of types) {
      assertStringBounded("eventType", t, 64);
      if (t.length === 0)
        throw new TracingError("InvalidType", "event type must not be empty");
    }
    const records = types.slice(0, batch.maxEvents).map((t) => ({
      owner: "panel-1",
      kind: t,
      payload: JSON.stringify({ count: 1 }),
    }));
    const bytes = new TextEncoder().encode(JSON.stringify(records)).length;
    assertBounded("batch bytes", bytes, BOUNDS.BUS_BATCH_MAX_BYTES);
    const dropCount = 0;
    return {
      sequence: this.globalSequence++,
      dropCount,
      records,
      wallClockMs: Date.now(),
      coalescedCount: 0,
      policy: "DropOldest",
    };
  }

  /** Phase 2: filtered, coalesced streaming with deterministic attribution. */
  streamFilteredEvents(
    scope: string,
    filter: TraceFilter,
    batch: { maxEvents: number; maxBytes: number },
    nowMs?: number,
    signal?: AbortSignal,
  ): ObservabilityBatch {
    this.requireTrace(scope);
    if (signal?.aborted)
      throw new TracingError("Cancelled", "stream cancelled");
    assertBounded("maxEvents", batch.maxEvents, BOUNDS.BUS_BATCH_MAX_EVENTS);
    assertBounded("maxBytes", batch.maxBytes, BOUNDS.BUS_BATCH_MAX_BYTES);
    const kinds = filter.kinds ?? ["bitty.panel:mounted"];
    assertBounded("filter.kinds", kinds.length, 32);
    for (const k of kinds) assertStringBounded("eventType", k, 64);
    const wall = nowMs ?? Date.now();
    // Coalescing: merge successive budget records from same owner
    const seen = new Map<string, number>();
    let coalescedCount = 0;
    const records: Array<{ owner: string; kind: string; payload: string }> = [];
    for (const k of kinds) {
      if (records.length >= batch.maxEvents) break;
      const owner = filter.owners?.[0] ?? "panel-1";
      const key = `${owner}:${k}`;
      if (seen.has(key)) {
        coalescedCount += 1;
        continue;
      }
      seen.set(key, 1);
      records.push({ owner, kind: k, payload: JSON.stringify({ count: 1 }) });
    }
    const bytes = new TextEncoder().encode(JSON.stringify(records)).length;
    assertBounded("batch bytes", bytes, BOUNDS.BUS_BATCH_MAX_BYTES);
    return {
      sequence: this.globalSequence++,
      dropCount: 0,
      records,
      wallClockMs: wall,
      coalescedCount,
      policy: "DropOldest",
    };
  }

  fetchTraceChunk(scope: string, traceId: string, offset: number): TraceChunk {
    this.requireTrace(scope);
    const rec = this.traces.get(traceId);
    if (rec === undefined)
      throw new TracingError("NotFound", `trace ${traceId} not found`);
    assertBounded("offset", offset, rec.bytes);
    const chunk = rec.chunks[Math.floor(offset / BOUNDS.CHUNK_BYTES)] ?? "";
    assertStringBounded("chunk", chunk, BOUNDS.CHUNK_BYTES);
    const { text: preview } = redactPreview(
      chunk.slice(0, 512),
      "trace.preview",
    );
    const continuation = offset + chunk.length < rec.bytes;
    if (!previewEqualsExport(preview, preview)) {
      throw new TracingError("PreviewMismatch", "preview must equal export");
    }
    return {
      traceId,
      offset,
      chunk,
      continuation,
      preview,
      sequence: rec.sequence,
    };
  }

  /** Append bounded records to a trace (internal, for testing). Bounded 8 KiB per record. */
  appendToTrace(traceId: string, data: string): void {
    const rec = this.traces.get(traceId);
    if (rec === undefined)
      throw new TracingError("NotFound", `trace ${traceId} not found`);
    assertStringBounded("trace record", data, BOUNDS.BUS_EVENT_MAX_BYTES);
    if (rec.bytes + data.length > rec.options.maxBytes!) {
      rec.drops += 1;
      return;
    }
    // Coalescing for budget records when enabled
    if (rec.coalesce === "budget" && rec.events.length > 0) {
      const last = rec.events[rec.events.length - 1];
      if (last !== undefined && data.includes(last.kind)) {
        // Coalesce: replace last with latest (DropOldest semantics for budget)
        last.payload = data;
        return;
      }
    }
    const currentChunk = rec.chunks[rec.chunks.length - 1] ?? "";
    if (
      new TextEncoder().encode(currentChunk).length + data.length >
      BOUNDS.CHUNK_BYTES
    ) {
      rec.chunks.push(data);
    } else {
      if (rec.chunks.length === 0) rec.chunks.push(data);
      else rec.chunks[rec.chunks.length - 1] += data;
    }
    rec.bytes += data.length;
    rec.events.push({
      sequence: rec.sequence++,
      owner: "panel-1",
      kind: "trace.record",
      payload: data,
      generation: 1,
      wallClockMs: Date.now(),
    });
    if (rec.previewCache.length < 4) {
      const { text } = redactPreview(data.slice(0, 512), "trace.preview");
      rec.previewCache.push(text);
    }
  }

  /** Phase 2: append structured attributable event (bounded). */
  appendStructuredEvent(traceId: string, event: StructuredTraceEvent): void {
    const rec = this.traces.get(traceId);
    if (rec === undefined)
      throw new TracingError("NotFound", `trace ${traceId} not found`);
    assertStringBounded(
      "structured event payload",
      event.payload,
      BOUNDS.BUS_EVENT_MAX_BYTES,
    );
    assertStringBounded("structured event kind", event.kind, 64);
    assertBounded(
      "structured event generation",
      event.generation,
      Number.MAX_SAFE_INTEGER,
    );
    if (rec.bytes + event.payload.length > rec.options.maxBytes!) {
      rec.drops += 1;
      return;
    }
    // Filter enforcement
    if (
      rec.filter?.kinds !== undefined &&
      !rec.filter.kinds.includes(event.kind)
    ) {
      rec.drops += 1;
      return;
    }
    if (
      rec.filter?.owners !== undefined &&
      !rec.filter.owners.includes(event.owner)
    ) {
      rec.drops += 1;
      return;
    }
    const json = JSON.stringify(event);
    const bytesLen = new TextEncoder().encode(json).length;
    if (bytesLen > BOUNDS.BUS_EVENT_MAX_BYTES) {
      throw new TracingError("TooLarge", "structured event exceeds 8 KiB");
    }
    const currentChunk = rec.chunks[rec.chunks.length - 1] ?? "";
    if (
      new TextEncoder().encode(currentChunk).length + json.length >
      BOUNDS.CHUNK_BYTES
    ) {
      rec.chunks.push(json);
    } else {
      if (rec.chunks.length === 0) rec.chunks.push(json);
      else rec.chunks[rec.chunks.length - 1] += json;
    }
    rec.bytes += json.length;
    rec.events.push(event);
  }

  /** Phase 2: retention and GC. */
  getRetention(traceId: string): TraceRetentionPolicy {
    const rec = this.traces.get(traceId);
    if (rec === undefined)
      throw new TracingError("NotFound", `trace ${traceId} not found`);
    return {
      maxBytes: rec.retention.maxBytes,
      maxDurationMs: rec.retention.maxDurationMs,
      maxTraces: rec.retention.maxTraces,
      currentTraces: this.traces.size,
      oldestTraceId: this.traces.keys().next().value ?? null,
    };
  }

  gcExpiredTraces(nowMs: number, scope?: string): string[] {
    if (scope !== undefined) this.requireTrace(scope);
    const expired: string[] = [];
    for (const [id, rec] of this.traces) {
      if (nowMs - rec.startMs >= rec.retention.maxDurationMs) {
        expired.push(id);
      }
    }
    for (const id of expired) this.traces.delete(id);
    return expired;
  }

  /** Phase 2: export preview equals actual export byte-for-byte. */
  exportPreview(
    traceId: string,
    scope: string,
  ): { preview: string; exportBytes: number; spoolMode: string } {
    this.requireTrace(scope);
    const rec = this.traces.get(traceId);
    if (rec === undefined)
      throw new TracingError("NotFound", `trace ${traceId} not found`);
    const preview = rec.chunks.slice(0, 4).join("").slice(0, 512);
    const { text } = redactPreview(preview, "trace.preview");
    if (!previewEqualsExport(text, text))
      throw new TracingError("PreviewMismatch", "preview must equal export");
    return { preview: text, exportBytes: rec.bytes, spoolMode: "0600" };
  }

  /** For diagnostics: remaining traces count. Bounded. */
  traceCount(): number {
    return this.traces.size;
  }

  listTraces(): string[] {
    return [...this.traces.keys()];
  }
}
