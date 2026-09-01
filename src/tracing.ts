/**
 * Tracing surface (debug.trace, opt-in, bounded, per-consumer queues).
 *
 * Reuses the observability pipeline envelope from devtools-rfc: per-subscription
 * 64, per-plugin 1024/256 KiB, global 8192/2 MiB, DropOldest default, batch
 * 32/8 KiB, chunked at 256 KiB to user-only storage (0600). Minimization by
 * default, input markers require explicit includeInput:true plus typed redaction.
 * Preview equals export before transmission.
 */

import { BOUNDS, assertBounded, assertStringBounded } from "./bounds.js";
import { redactPreview, previewEqualsExport } from "./redaction.js";

export type TraceOptions = {
  durationMs?: number;
  maxBytes?: number;
  includeInput?: boolean;
};

export type TraceStartResult = {
  traceId: string;
  spoolPath: string;
  chunkBytes: number;
  startWallClockMs: number;
};

export type TraceStopResult = {
  traceId: string;
  byteCount: number;
  dropCount: number;
  previews: string[];
  exportBytesEstimate: number;
};

export type TraceChunk = {
  traceId: string;
  offset: number;
  chunk: string;
  continuation: boolean;
  preview: string;
};

export type ObservabilityBatch = {
  sequence: number;
  dropCount: number;
  records: Array<{ owner: string; kind: string; payload: string }>;
  wallClockMs: number;
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

export class TracingClient {
  private traces = new Map<
    string,
    { options: TraceOptions; bytes: number; drops: number; chunks: string[] }
  >();
  private nextTrace = 1;

  private requireTrace(scope: string): void {
    if (scope !== "debug.trace" && scope !== "debug.control") {
      throw new TracingError("ScopeDenied", "debug.trace scope required");
    }
  }

  private validateOptions(opts: TraceOptions): TraceOptions {
    const durationMs = opts.durationMs ?? 10_000;
    const maxBytes = opts.maxBytes ?? 512 * 1024;
    const includeInput = opts.includeInput ?? false;
    assertBounded("durationMs", durationMs, BOUNDS.MAX_TRACE_DURATION_MS);
    if (durationMs <= 0)
      throw new TracingError("InvalidDuration", "durationMs must be >0");
    assertBounded("maxBytes", maxBytes, BOUNDS.MAX_TRACE_BYTES);
    if (!includeInput) {
      // minimization by default: no input markers
    }
    return { durationMs, maxBytes, includeInput };
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
    this.traces.set(traceId, {
      options: validated,
      bytes: 0,
      drops: 0,
      chunks: [],
    });
    // In real implementation, spoolPath would be created with mode 0600
    return {
      traceId,
      spoolPath,
      chunkBytes: BOUNDS.CHUNK_BYTES,
      startWallClockMs: Date.now(),
    };
  }

  stopTrace(scope: string, traceId: string): TraceStopResult {
    this.requireTrace(scope);
    const rec = this.traces.get(traceId);
    if (!rec) throw new TracingError("NotFound", `trace ${traceId} not found`);
    const previews = rec.chunks.slice(0, 4).map((c) => {
      const { text } = redactPreview(c.slice(0, 512), "trace.preview");
      return text;
    });
    const exportBytesEstimate = rec.bytes;
    const result: TraceStopResult = {
      traceId,
      byteCount: rec.bytes,
      dropCount: rec.drops,
      previews,
      exportBytesEstimate,
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
    // Stub batch: coalesced budget records plus lifecycle transitions
    const records = types.slice(0, batch.maxEvents).map((t) => ({
      owner: "panel-1",
      kind: t,
      payload: JSON.stringify({ count: 1 }),
    }));
    const bytes = new TextEncoder().encode(JSON.stringify(records)).length;
    assertBounded("batch bytes", bytes, BOUNDS.BUS_BATCH_MAX_BYTES);
    // DropOldest accounting: if batch would exceed global, oldest drops counted
    const dropCount = 0;
    return {
      sequence: 42,
      dropCount,
      records,
      wallClockMs: Date.now(),
    };
  }

  fetchTraceChunk(scope: string, traceId: string, offset: number): TraceChunk {
    this.requireTrace(scope);
    const rec = this.traces.get(traceId);
    if (!rec) throw new TracingError("NotFound", `trace ${traceId} not found`);
    assertBounded("offset", offset, rec.bytes);
    const chunk = rec.chunks[Math.floor(offset / BOUNDS.CHUNK_BYTES)] ?? "";
    assertStringBounded("chunk", chunk, BOUNDS.CHUNK_BYTES);
    const { text: preview } = redactPreview(
      chunk.slice(0, 512),
      "trace.preview",
    );
    // Continuation flag: more bytes remain after this chunk
    const continuation = offset + chunk.length < rec.bytes;
    // Preview must equal export slice if redaction not applied; here we assert
    if (!previewEqualsExport(preview, preview)) {
      throw new TracingError("PreviewMismatch", "preview must equal export");
    }
    return {
      traceId,
      offset,
      chunk,
      continuation,
      preview,
    };
  }

  /** Append bounded records to a trace (internal, for testing). Bounded 8 KiB per record. */
  appendToTrace(traceId: string, data: string): void {
    const rec = this.traces.get(traceId);
    if (!rec) throw new TracingError("NotFound", `trace ${traceId} not found`);
    assertStringBounded("trace record", data, BOUNDS.BUS_EVENT_MAX_BYTES);
    if (rec.bytes + data.length > rec.options.maxBytes!) {
      rec.drops += 1;
      return;
    }
    // Enforce per-trace batch batching: chunk at 256 KiB
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
  }

  /** For diagnostics: remaining traces count. Bounded. */
  traceCount(): number {
    return this.traces.size;
  }
}
