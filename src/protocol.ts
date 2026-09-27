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

import {
  BOUNDS,
  assertBounded,
  assertStringBounded,
  truncateToChars,
} from "./bounds.js";
import {
  DuplicateJsonKeyError,
  assertUniqueJsonObjectKeys,
} from "./json-guard.js";

export const PROTOCOL_VERSION = "1.0" as const;
export const SUPPORTED_VERSIONS: readonly string[] = [
  PROTOCOL_VERSION,
] as const;

const ERROR_CATEGORIES: readonly ErrorCategory[] = [
  "usage",
  "capability",
  "scope",
  "budget",
  "generation",
  "transport",
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
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length !== 1) {
    throw new ProtocolErrorImpl({
      category: "usage",
      code: "InvalidJson",
      message: "response must be exactly one non-empty JSONL line",
    });
  }
  // Reject a repeated object key before `JSON.parse`, which is last-wins and
  // would otherwise let a hostile server mask one value behind another.
  try {
    assertUniqueJsonObjectKeys(lines[0] as string);
  } catch (error) {
    if (error instanceof DuplicateJsonKeyError) {
      throw new ProtocolErrorImpl({
        category: "usage",
        code: "DuplicateField",
        message: `response repeats field '${error.key}'`,
      });
    }
    throw new ProtocolErrorImpl({
      category: "usage",
      code: "InvalidJson",
      message: "response is not well-formed JSON",
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(lines[0] as string);
  } catch {
    throw new ProtocolErrorImpl({
      category: "usage",
      code: "InvalidJson",
      message: "response is not valid JSON",
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProtocolErrorImpl({
      category: "usage",
      code: "InvalidJson",
      message: "response must be a JSON object",
    });
  }
  const obj = parsed as Record<string, unknown>;
  const hasResult = Object.hasOwn(obj, "result");
  const hasError = Object.hasOwn(obj, "error");
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_RESPONSE_KEYS.has(key)) {
      throw new ProtocolErrorImpl({
        category: "usage",
        code: "UnknownField",
        message: `response field '${key}' is not allowed`,
      });
    }
  }
  if (obj["jsonrpc"] !== "2.0") {
    throw new ProtocolErrorImpl({
      category: "usage",
      code: "InvalidJsonRpc",
      message: "jsonrpc must be 2.0",
    });
  }
  if (!Number.isSafeInteger(obj["id"]) || (obj["id"] as number) < 0) {
    throw new ProtocolErrorImpl({
      category: "usage",
      code: "InvalidId",
      message: "response id must be a nonnegative safe integer",
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
  if (hasResult === hasError) {
    throw new ProtocolErrorImpl({
      category: "usage",
      code: "InvalidResult",
      message: "response must carry exactly one of result or error",
    });
  }
  if (hasError) {
    return {
      jsonrpc: "2.0",
      id: obj["id"] as number,
      error: decodeErrorField(obj["error"]),
      version: obj["version"] as string,
    };
  }
  return {
    jsonrpc: "2.0",
    id: obj["id"] as number,
    result: obj["result"],
    version: obj["version"] as string,
  };
}

const ALLOWED_RESPONSE_KEYS = new Set([
  "jsonrpc",
  "id",
  "result",
  "error",
  "version",
]);

function decodeErrorField(value: unknown): ProtocolError {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolErrorImpl({
      category: "usage",
      code: "InvalidErrorShape",
      message: "error must be a JSON object",
    });
  }
  const err = value as Record<string, unknown>;
  for (const key of Object.keys(err)) {
    if (!ALLOWED_ERROR_KEYS.has(key)) {
      throw new ProtocolErrorImpl({
        category: "usage",
        code: "UnknownField",
        message: `error field '${key}' is not allowed`,
      });
    }
  }
  const category = err["category"];
  if (
    typeof category !== "string" ||
    !(ERROR_CATEGORIES as readonly string[]).includes(category)
  ) {
    throw new ProtocolErrorImpl({
      category: "usage",
      code: "InvalidErrorShape",
      message: "error category is not a known category",
    });
  }
  const code = err["code"];
  if (
    typeof code !== "string" ||
    code.length === 0 ||
    code.length > MAX_ERROR_CODE_CHARS
  ) {
    throw new ProtocolErrorImpl({
      category: "usage",
      code: "InvalidErrorShape",
      message: `error code must be a string of 1..${MAX_ERROR_CODE_CHARS} chars`,
    });
  }
  const message = err["message"];
  if (typeof message !== "string") {
    throw new ProtocolErrorImpl({
      category: "usage",
      code: "InvalidErrorShape",
      message: "error message must be a string",
    });
  }
  const error: ProtocolError = {
    category: category as ErrorCategory,
    code,
    message: truncateToChars(message, MAX_ERROR_MESSAGE_CHARS).text,
  };
  if (err["details"] !== undefined) {
    // The RFC forbids echoing unbounded untrusted bytes: reject rather than
    // truncate opaque details so a hostile server can never smuggle a large
    // payload (or an over-budget record) through the error channel.
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(err["details"]);
    } catch {
      serialized = undefined;
    }
    if (
      serialized === undefined ||
      new TextEncoder().encode(serialized).length > MAX_ERROR_DETAILS_BYTES
    ) {
      throw new ProtocolErrorImpl({
        category: "usage",
        code: "InvalidErrorShape",
        message: `error details must serialize within ${MAX_ERROR_DETAILS_BYTES} bytes`,
      });
    }
    error.details = err["details"];
  }
  return error;
}

const ALLOWED_ERROR_KEYS = new Set(["category", "code", "message", "details"]);
const MAX_ERROR_MESSAGE_CHARS = 512;
const MAX_ERROR_CODE_CHARS = 128;
const MAX_ERROR_DETAILS_BYTES = 4 * 1024;

export function chunkText(
  text: string,
  chunkBytes: number = BOUNDS.CHUNK_BYTES,
): string[] {
  if (
    !Number.isSafeInteger(chunkBytes) ||
    chunkBytes <= 0 ||
    chunkBytes > BOUNDS.CHUNK_BYTES
  ) {
    throw new Error(`chunkBytes must be in (0, ${BOUNDS.CHUNK_BYTES}]`);
  }
  if (text.length === 0) return [];
  const bytes = new TextEncoder().encode(text);
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  const chunks: string[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    let end = Math.min(offset + chunkBytes, bytes.length);
    while (end > offset && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
      end -= 1;
    }
    if (end === offset) {
      throw new Error("chunkBytes cannot fit the next Unicode scalar");
    }
    chunks.push(decoder.decode(bytes.subarray(offset, end)));
    offset = end;
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
    // CTX-0159 live read-only introspection (server-registered, inspect scope).
    "bitty.debug/getGridText",
    "bitty.debug/getInputRing",
    "bitty.debug/getModifiers",
    "bitty.debug/getFocus",
  ]);
  const traceMethods = new Set([
    "bitty.debug/streamEvents",
    "bitty.debug/startTrace",
    "bitty.debug/stopTrace",
    "bitty.debug/fetchTraceChunk",
    // CTX-0038 automation frame reads (trace scope + terminal.inspect).
    "bitty.debug/captureFrame",
    "bitty.debug/frameHash",
  ]);
  const controlMethods = new Set([
    "bitty.debug/suspendHandler",
    "bitty.debug/resumePlugin",
    "bitty.debug/disposeGeneration",
    // CTX-0038 automation input synthesis (control scope + terminal.input).
    "bitty.debug/synthesizeInput",
  ]);
  if (inspectMethods.has(method)) return true; // inspect is base for all
  if (traceMethods.has(method))
    return scope === "debug.trace" || scope === "debug.control";
  if (controlMethods.has(method)) return scope === "debug.control";
  return false;
}
