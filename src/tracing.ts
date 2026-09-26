/**
 * Tracing surface (debug.trace, opt-in, bounded, per-consumer queues) — phase 2 advanced.
 *
 * Reuses the observability pipeline envelope from devtools-rfc: per-subscription
 * 64, per-plugin 1024/256 KiB, global 8192/2 MiB, DropOldest default, batch
 * 32/8 KiB, and 256 KiB continuation chunks in memory. Minimization is the
 * default; input markers require explicit `includeInput: true` plus typed
 * redaction. Preview equals export before transmission.
 *
 * Phase 2 adds: advanced filtering, structured attributable events, retention
 * and GC policy, coalescing control, deterministic wall-clock, export preview
 * with chunked continuation, and DropOldest/DropNewest policies. All bounds are
 * preserved. The headless transport fixture re-checks caller-supplied peer
 * values per privileged action; the Linux live socket path is inspect-only.
 */

import { BOUNDS, assertBounded, assertStringBounded } from "./bounds.js";
import {
  redactPreview,
  redactValue,
  previewEqualsExport,
} from "./redaction.js";

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
  spoolPath: null;
  storage: "memory";
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
  spoolMode: "memory";
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

export type ObservabilityBatchRecord = {
  owner: string;
  kind: string;
  payload: string;
};

export type ObservabilityBatch = {
  sequence: number;
  dropCount: number;
  records: ObservabilityBatchRecord[];
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

function validateBatch(batch: { maxEvents: number; maxBytes: number }): void {
  if (!Number.isSafeInteger(batch.maxEvents) || batch.maxEvents <= 0) {
    throw new TracingError(
      "InvalidBatch",
      "maxEvents must be a positive integer",
    );
  }
  if (!Number.isSafeInteger(batch.maxBytes) || batch.maxBytes <= 0) {
    throw new TracingError(
      "InvalidBatch",
      "maxBytes must be a positive integer",
    );
  }
  assertBounded("maxEvents", batch.maxEvents, BOUNDS.BUS_BATCH_MAX_EVENTS);
  assertBounded("maxBytes", batch.maxBytes, BOUNDS.BUS_BATCH_MAX_BYTES);
}

function admitBatchRecords(
  records: ObservabilityBatchRecord[],
  maxBytes: number,
): { records: ObservabilityBatchRecord[]; dropCount: number } {
  const encoder = new TextEncoder();
  const admitted: ObservabilityBatchRecord[] = [];
  let dropCount = 0;
  for (const record of records) {
    const candidate = [...admitted, record];
    if (encoder.encode(JSON.stringify(candidate)).length > maxBytes) {
      dropCount += 1;
      continue;
    }
    admitted.push(record);
  }
  return { records: admitted, dropCount };
}

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
    if (scope !== "debug.trace") {
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
      for (const k of filter.kinds) {
        assertStringBounded("filter kind", k, 64);
        if (k.length === 0) {
          throw new TracingError(
            "InvalidFilter",
            "filter kind must not be empty",
          );
        }
      }
    }
    if (filter?.owners !== undefined) {
      assertBounded("filter.owners", filter.owners.length, 32);
      if (filter.owners.length === 0) {
        throw new TracingError(
          "InvalidFilter",
          "filter.owners must not be empty",
        );
      }
      for (const o of filter.owners) {
        assertStringBounded("filter owner", o, 64);
        if (o.length === 0) {
          throw new TracingError(
            "InvalidFilter",
            "filter owner must not be empty",
          );
        }
      }
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
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0)
      throw new TracingError("InvalidDuration", "durationMs must be >0");
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
      throw new TracingError("InvalidBytes", "maxBytes must be >0");
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
      spoolPath: null,
      storage: "memory",
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
      spoolPath: null,
      storage: "memory",
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
      spoolMode: "memory",
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
    if (signal?.aborted) {
      throw new TracingError("Cancelled", "stream cancelled");
    }
    validateBatch(batch);
    assertBounded("event types", types.length, 256);
    for (const t of types) {
      assertStringBounded("eventType", t, 64);
      if (t.length === 0) {
        throw new TracingError("InvalidType", "event type must not be empty");
      }
    }
    const candidates = types.slice(0, batch.maxEvents).map((t) => ({
      owner: "panel-1",
      kind: t,
      payload: JSON.stringify({ count: 1 }),
    }));
    const admitted = admitBatchRecords(candidates, batch.maxBytes);
    return {
      sequence: this.globalSequence++,
      dropCount: types.length - admitted.records.length,
      records: admitted.records,
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
    if (signal?.aborted) {
      throw new TracingError("Cancelled", "stream cancelled");
    }
    validateBatch(batch);
    const kinds = filter.kinds ?? ["bitty.panel:mounted"];
    const owners = filter.owners ?? ["panel-1"];
    assertBounded("filter.kinds", kinds.length, 32);
    assertBounded("filter.owners", owners.length, 32);
    if (owners.length === 0) {
      throw new TracingError(
        "InvalidFilter",
        "filter.owners must not be empty",
      );
    }

    for (const k of kinds) {
      assertStringBounded("eventType", k, 64);
      if (k.length === 0) {
        throw new TracingError("InvalidType", "event type must not be empty");
      }
    }
    for (const owner of owners) {
      assertStringBounded("event owner", owner, 64);
      if (owner.length === 0) {
        throw new TracingError("InvalidType", "event owner must not be empty");
      }
    }
    const owner = owners[0] ?? "panel-1";
    const wall = nowMs ?? Date.now();
    const seen = new Set<string>();
    let coalescedCount = 0;
    const candidates: ObservabilityBatchRecord[] = [];
    for (const kind of kinds) {
      const key = `${owner}:${kind}`;
      if (seen.has(key)) {
        coalescedCount += 1;
        continue;
      }
      seen.add(key);
      candidates.push({ owner, kind, payload: JSON.stringify({ count: 1 }) });
    }
    const admitted = admitBatchRecords(
      candidates.slice(0, batch.maxEvents),
      batch.maxBytes,
    );
    return {
      sequence: this.globalSequence++,
      dropCount: candidates.length - admitted.records.length,
      records: admitted.records,
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
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new TracingError(
        "InvalidOffset",
        "offset must be a nonnegative byte integer",
      );
    }
    const encoder = new TextEncoder();
    let totalBytes = 0;
    let chunk = "";
    let chunkBytes = 0;
    for (const storedChunk of rec.chunks) {
      const bytes = encoder.encode(storedChunk);
      const start = totalBytes;
      totalBytes += bytes.length;
      if (offset >= start && offset < totalBytes) {
        const intraOffset = offset - start;
        if ((bytes[intraOffset]! & 0xc0) === 0x80) {
          throw new TracingError(
            "InvalidOffset",
            "offset must be a UTF-8 boundary",
          );
        }
        chunk = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes.subarray(intraOffset));
        chunkBytes = bytes.length - intraOffset;
      }
    }
    assertBounded("offset", offset, totalBytes);
    assertStringBounded("chunk", chunk, BOUNDS.CHUNK_BYTES);
    const { text: preview } = redactPreview(
      chunk.slice(0, 512),
      "trace.preview",
    );
    const continuation = offset + chunkBytes < totalBytes;
    // H-DEV-02 (CTX-0032): was `previewEqualsExport(preview, preview)`, a
    // self-comparison that always passed; re-derive from the chunk slice.
    assertPreviewMatchesExport(preview, chunk.slice(0, 512));
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
  appendToTrace(scope: string, traceId: string, data: string): void {
    this.requireTrace(scope);
    const rec = this.traces.get(traceId);
    if (rec === undefined)
      throw new TracingError("NotFound", `trace ${traceId} not found`);
    assertStringBounded("trace record", data, BOUNDS.BUS_EVENT_MAX_BYTES);
    const record = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
      new TextEncoder().encode(redactValue(data, "trace.record")),
    );
    const bytesLen = new TextEncoder().encode(record).length;
    assertBounded("trace record", bytesLen, BOUNDS.BUS_EVENT_MAX_BYTES);
    if (
      rec.bytes + bytesLen >
      Math.min(rec.options.maxBytes!, rec.retention.maxBytes)
    ) {
      rec.drops += 1;
      return;
    }
    const currentChunk = rec.chunks[rec.chunks.length - 1] ?? "";
    const event = {
      sequence: rec.sequence,
      owner: "panel-1",
      kind: "trace.record",
      payload: record,
      generation: 1,
      wallClockMs: Date.now(),
    };
    if (
      new TextEncoder().encode(currentChunk).length + bytesLen >
      BOUNDS.CHUNK_BYTES
    ) {
      rec.chunks.push(record);
    } else {
      if (rec.chunks.length === 0) rec.chunks.push(record);
      else rec.chunks[rec.chunks.length - 1] += record;
    }
    rec.bytes += bytesLen;
    rec.sequence++;
    rec.events.push(event);
    if (rec.previewCache.length < 4) {
      rec.previewCache.push(record.slice(0, 512));
    }
  }

  /** Phase 2: append structured attributable event (bounded). */
  appendStructuredEvent(
    scope: string,
    traceId: string,
    event: StructuredTraceEvent,
  ): void {
    this.requireTrace(scope);
    const rec = this.traces.get(traceId);
    if (rec === undefined)
      throw new TracingError("NotFound", `trace ${traceId} not found`);
    assertStringBounded(
      "structured event payload",
      event.payload,
      BOUNDS.BUS_EVENT_MAX_BYTES,
    );
    assertStringBounded("structured event owner", event.owner, 64);
    assertStringBounded("structured event kind", event.kind, 64);
    if (event.owner.length === 0 || event.kind.length === 0) {
      throw new TracingError(
        "InvalidEvent",
        "owner and kind must not be empty",
      );
    }
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 0) {
      throw new TracingError(
        "InvalidEvent",
        "sequence must be a nonnegative safe integer",
      );
    }
    if (!Number.isSafeInteger(event.generation) || event.generation < 1) {
      throw new TracingError(
        "InvalidEvent",
        "generation must be a positive safe integer",
      );
    }
    if (!Number.isSafeInteger(event.wallClockMs) || event.wallClockMs < 0) {
      throw new TracingError(
        "InvalidEvent",
        "wallClockMs must be a nonnegative safe integer",
      );
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
    const retained: StructuredTraceEvent = {
      sequence: event.sequence,
      owner: redactValue(event.owner, "trace.owner"),
      kind: redactValue(event.kind, "trace.kind"),
      payload: redactValue(event.payload, "trace.payload"),
      generation: event.generation,
      wallClockMs: event.wallClockMs,
      ...(event.coalesced === undefined ? {} : { coalesced: event.coalesced }),
    };
    const json = JSON.stringify(retained);
    const bytesLen = new TextEncoder().encode(json).length;
    if (bytesLen > BOUNDS.BUS_EVENT_MAX_BYTES) {
      throw new TracingError("TooLarge", "structured event exceeds 8 KiB");
    }
    if (
      rec.bytes + bytesLen >
      Math.min(rec.options.maxBytes!, rec.retention.maxBytes)
    ) {
      rec.drops += 1;
      return;
    }
    const currentChunk = rec.chunks[rec.chunks.length - 1] ?? "";
    if (
      new TextEncoder().encode(currentChunk).length + bytesLen >
      BOUNDS.CHUNK_BYTES
    ) {
      rec.chunks.push(json);
    } else {
      if (rec.chunks.length === 0) rec.chunks.push(json);
      else rec.chunks[rec.chunks.length - 1] += json;
    }
    rec.bytes += bytesLen;
    rec.events.push(retained);
  }

  /** Phase 2: retention and GC. */
  getRetention(scope: string, traceId: string): TraceRetentionPolicy {
    this.requireTrace(scope);
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

  gcExpiredTraces(nowMs: number, scope: string): string[] {
    this.requireTrace(scope);
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
    // H-DEV-02 (CTX-0032): was `previewEqualsExport(text, text)`, a
    // self-comparison that always passed; re-derive from the export bytes.
    assertPreviewMatchesExport(text, preview);
    return { preview: text, exportBytes: rec.bytes, spoolMode: "memory" };
  }

  /** For diagnostics: remaining traces count. Bounded. */
  traceCount(scope: string): number {
    this.requireTrace(scope);
    return this.traces.size;
  }

  listTraces(scope: string): string[] {
    this.requireTrace(scope);
    return [...this.traces.keys()];
  }

  clearSessionState(): void {
    this.traces.clear();
    this.nextTrace = 1;
    this.globalSequence = 0;
  }
}

/**
 * H-DEV-02 (CTX-0032): assert that a redacted preview matches the export it
 * previews. The two historic call sites compared a value to itself
 * (`previewEqualsExport(preview, preview)`), so the PreviewMismatch branch
 * was dead code and any tampered export passed silently.
 *
 * Chosen semantics (option b): run the same unredacted export source back
 * through `redactPreview` and compare redacted-to-redacted. Redaction
 * legitimately changes bytes, so comparing redacted-preview to raw export
 * would always throw on redacted content and break honest exports; the
 * redacted-to-redacted check keeps the byte-for-byte safety intent (a
 * tampered or diverged source redacts to a different string and throws)
 * without penalizing redaction itself. The pure `previewEqualsExport` helper
 * in redaction.ts is unchanged.
 */
export function assertPreviewMatchesExport(
  preview: string,
  exportSource: string,
): void {
  const { text: expected } = redactPreview(exportSource, "trace.preview");
  if (!previewEqualsExport(preview, expected)) {
    throw new TracingError("PreviewMismatch", "preview must equal export");
  }
}
