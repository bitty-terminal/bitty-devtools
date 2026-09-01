/**
 * Versioned debug protocol consumption (no ownership).
 *
 * The debug protocol belongs inside the core boundary (bitty). DevTools is a
 * consumer that exchanges versioned, schema-validated JSON records over a
 * bounded framing. This module implements the client side only: version
 * negotiation, JSONL framing, bounded payload checks, and typed error shape.
 * It never links private core types or inspects process memory.
 *
 * Transport is assumed to be the existing IPC surface (Unix socket 0600 or
 * Windows named pipe); this file owns only framing and schema validation.
 */

import { BOUNDS, assertBounded, assertStringBounded } from "./bounds.js";

export const PROTOCOL_VERSION = "1.0" as const;
export const SUPPORTED_VERSIONS: readonly string[] = [
  PROTOCOL_VERSION,
] as const;

export type DebugScope = "debug.inspect" | "debug.trace" | "debug.control";

export const DEBUG_SCOPES: readonly DebugScope[] = [
  "debug.inspect",
  "debug.trace",
  "debug.control",
] as const;

export type ErrorCategory =
  "usage" | "capability" | "scope" | "budget" | "generation" | "transport";

export type ProtocolError = {
  category: ErrorCategory;
  code: string;
  message: string;
  details?: unknown;
};

export type RequestFrame = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
  version: string;
};

export type ResponseFrame = {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: ProtocolError;
  version: string;
};

export class ProtocolErrorImpl extends Error {
  constructor(
    public readonly error: ProtocolError,
    public readonly httpStatus?: number,
  ) {
    super(`${error.category}/${error.code}: ${error.message}`);
    this.name = "ProtocolError";
  }
}

export function isSupportedVersion(v: string): boolean {
  return (SUPPORTED_VERSIONS as readonly string[]).includes(v);
}

export function negotiateVersion(clientVersion: string): string {
  if (isSupportedVersion(clientVersion)) return PROTOCOL_VERSION;
  throw new ProtocolErrorImpl({
    category: "usage",
    code: "UnsupportedVersion",
    message: `unsupported version ${clientVersion}, expected ${PROTOCOL_VERSION}`,
  });
}

export function validateFrameBytes(raw: string): void {
  assertStringBounded("MAX_FRAME_BYTES", raw, BOUNDS.MAX_FRAME_BYTES);
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new Error("frame must not be empty");
  if (trimmed.length > BOUNDS.MAX_FRAME_BYTES) {
    throw new Error(`frame exceeds ${BOUNDS.MAX_FRAME_BYTES}`);
  }
}

export function encodeRequest(frame: RequestFrame): string {
  if (!isSupportedVersion(frame.version)) {
    throw new Error(`unsupported version ${frame.version}`);
  }
  assertBounded("request id", frame.id, Number.MAX_SAFE_INTEGER);
  if (!frame.method.startsWith("bitty.debug/")) {
    throw new Error(`method must start with bitty.debug/: ${frame.method}`);
  }
  const json = JSON.stringify(frame);
  validateFrameBytes(json);
  // JSONL framing: one line plus newline
  return json + "\n";
}

export function decodeResponse(raw: string): ResponseFrame {
  validateFrameBytes(raw);
  const line = raw.trim().split("\n")[0] ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new ProtocolErrorImpl({
      category: "usage",
      code: "InvalidJson",
      message: "response is not valid JSON",
    });
  }
  const obj = parsed as Record<string, unknown>;
  if (obj["jsonrpc"] !== "2.0") {
    throw new ProtocolErrorImpl({
      category: "usage",
      code: "InvalidJsonRpc",
      message: "jsonrpc must be 2.0",
    });
  }
  if (typeof obj["id"] !== "number") {
    throw new ProtocolErrorImpl({
      category: "usage",
      code: "MissingId",
      message: "response id must be number",
    });
  }
  if (
    typeof obj["version"] !== "string" ||
    !isSupportedVersion(obj["version"] as string)
  ) {
    throw new ProtocolErrorImpl({
      category: "usage",
      code: "InvalidVersion",
      message: "invalid or unsupported version",
    });
  }
  if (obj["error"] !== undefined) {
    const err = obj["error"] as ProtocolError;
    if (typeof err.code !== "string" || typeof err.category !== "string") {
      throw new ProtocolErrorImpl({
        category: "usage",
        code: "InvalidErrorShape",
        message: "error shape invalid",
      });
    }
    // Never echo unbounded bytes in error
    if (err.message && err.message.length > 512) {
      err.message = err.message.slice(0, 512);
    }
  }
  return parsed as ResponseFrame;
}

export function chunkText(
  text: string,
  chunkBytes: number = BOUNDS.CHUNK_BYTES,
): string[] {
  if (chunkBytes <= 0 || chunkBytes > BOUNDS.CHUNK_BYTES) {
    throw new Error(`chunkBytes must be in (0, ${BOUNDS.CHUNK_BYTES}]`);
  }
  const bytes = new TextEncoder().encode(text);
  if (bytes.length === 0) return [];
  const chunks: string[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const slice = bytes.slice(offset, offset + chunkBytes);
    // Decode at char boundary
    let str = new TextDecoder().decode(slice);
    // Avoid splitting surrogate: ensure round-trip length matches
    // If truncated char, back off until valid
    while (new TextEncoder().encode(str).length > slice.length) {
      str = str.slice(0, -1);
    }
    if (str.length === 0) break;
    chunks.push(str);
    offset += new TextEncoder().encode(str).length;
  }
  return chunks;
}

export function isValidMethodForScope(
  method: string,
  scope: DebugScope,
): boolean {
  const inspectMethods = new Set([
    "bitty.debug/listPlugins",
    "bitty.debug/getPlugin",
    "bitty.debug/listSubscriptions",
    "bitty.debug/getBudgets",
    "bitty.debug/getQueueSnapshot",
    "bitty.debug/getSnapshot",
    "bitty.debug/listHandles",
  ]);
  const traceMethods = new Set([
    "bitty.debug/streamEvents",
    "bitty.debug/startTrace",
    "bitty.debug/stopTrace",
    "bitty.debug/fetchTraceChunk",
  ]);
  const controlMethods = new Set([
    "bitty.debug/suspendHandler",
    "bitty.debug/resumePlugin",
    "bitty.debug/disposeGeneration",
  ]);
  if (inspectMethods.has(method)) return true; // inspect is base for all
  if (traceMethods.has(method))
    return scope === "debug.trace" || scope === "debug.control";
  if (controlMethods.has(method)) return scope === "debug.control";
  return false;
}
