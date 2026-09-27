import { describe, expect, test } from "bun:test";
import {
  PROTOCOL_VERSION,
  negotiateVersion,
  encodeRequest,
  decodeResponse,
  isValidMethodForScope,
  chunkText,
} from "../src/protocol.js";

describe("protocol versioned framing", () => {
  test("version negotiation", () => {
    expect(negotiateVersion("1.0")).toBe(PROTOCOL_VERSION);
    expect(() => negotiateVersion("2.0")).toThrow("unsupported version");
  });

  test("encode rejects unscoped method", () => {
    expect(() =>
      encodeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "bad.method",
        version: "1.0",
      }),
    ).toThrow("must start with bitty.debug/");
  });

  test("frame bytes bounded 1 MiB", () => {
    expect(() =>
      encodeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "bitty.debug/listPlugins",
        params: { x: "a".repeat(2 * 1024 * 1024) },
        version: "1.0",
      }),
    ).toThrow("exceeded");
  });

  test("decode validates shape", () => {
    const raw = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { plugins: [] },
      version: "1.0",
    });
    expect(decodeResponse(raw).result).toEqual({ plugins: [] });
    expect(() => decodeResponse("not json")).toThrow("not valid JSON");
  });

  test("closed decoder requires exactly one non-empty JSONL line", () => {
    const one = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {},
      version: "1.0",
    });
    expect(() => decodeResponse(`${one}\n${one}`)).toThrow(
      "exactly one non-empty JSONL line",
    );
    // Surrounding blank lines around one JSON line are valid JSONL framing.
    expect(decodeResponse(`\n${one}\n`).id).toBe(1);
    expect(decodeResponse(`${one}\n`).id).toBe(1);
  });

  test("closed decoder rejects extra top-level and error fields", () => {
    const base = { jsonrpc: "2.0", id: 1, result: {}, version: "1.0" };
    expect(() =>
      decodeResponse(JSON.stringify({ ...base, injected: true })),
    ).toThrow("field 'injected' is not allowed");
    expect(() =>
      decodeResponse(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: {
            category: "usage",
            code: "Bad",
            message: "m",
            injected: true,
          },
          version: "1.0",
        }),
      ),
    ).toThrow("error field 'injected' is not allowed");
  });

  test("closed decoder enforces result xor error", () => {
    const err = { category: "usage" as const, code: "Bad", message: "m" };
    expect(() =>
      decodeResponse(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {},
          error: err,
          version: "1.0",
        }),
      ),
    ).toThrow("exactly one of result or error");
    expect(() =>
      decodeResponse(JSON.stringify({ jsonrpc: "2.0", id: 1, version: "1.0" })),
    ).toThrow("exactly one of result or error");
    expect(
      decodeResponse(
        JSON.stringify({ jsonrpc: "2.0", id: 1, error: err, version: "1.0" }),
      ).error,
    ).toEqual(err);
    expect(
      decodeResponse(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: null,
          version: "1.0",
        }),
      ).result,
    ).toBeNull();
  });

  test("closed decoder validates error category, code, and message", () => {
    const wrap = (error: unknown): string =>
      JSON.stringify({ jsonrpc: "2.0", id: 1, error, version: "1.0" });
    expect(() =>
      decodeResponse(wrap({ category: "made-up", code: "Bad", message: "m" })),
    ).toThrow("category is not a known category");
    expect(() =>
      decodeResponse(wrap({ category: "usage", code: "", message: "m" })),
    ).toThrow("error code must be a string");
    expect(() =>
      decodeResponse(
        wrap({ category: "usage", code: "C".repeat(129), message: "m" }),
      ),
    ).toThrow("error code must be a string");
    expect(() =>
      decodeResponse(wrap({ category: "usage", code: "Bad", message: 7 })),
    ).toThrow("error message must be a string");
    const long = decodeResponse(
      wrap({ category: "usage", code: "Bad", message: "x".repeat(600) }),
    );
    expect(long.error?.message.length).toBe(512);
    // Every supported category round-trips.
    for (const category of [
      "usage",
      "capability",
      "scope",
      "budget",
      "generation",
      "transport",
    ] as const) {
      expect(
        decodeResponse(wrap({ category, code: "Bad", message: "m" })).error
          ?.category,
      ).toBe(category);
    }
  });

  test("closed decoder rejects duplicate object keys", () => {
    // JSON.parse is last-wins, so a repeated key can mask one value behind
    // another; the decoder must refuse it before parsing.
    expect(() =>
      decodeResponse(
        '{"jsonrpc":"2.0","id":1,"result":{},"result":null,"version":"1.0"}',
      ),
    ).toThrow("repeats field 'result'");
    expect(() =>
      decodeResponse(
        '{"jsonrpc":"2.0","id":1,"error":{"category":"usage","code":"Bad","message":"a","message":"b"},"version":"1.0"}',
      ),
    ).toThrow("repeats field 'message'");
    expect(() =>
      decodeResponse(
        '{"jsonrpc":"2.0","id":1,"result":{"a":1,"a":2},"version":"1.0"}',
      ),
    ).toThrow("repeats field 'a'");
  });

  test("closed decoder bounds error details to 4 KiB", () => {
    const withDetails = (details: unknown): string =>
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { category: "usage", code: "Bad", message: "m", details },
        version: "1.0",
      });
    const atBound = decodeResponse(withDetails({ note: "x".repeat(4085) }));
    expect(atBound.error?.details).toEqual({ note: "x".repeat(4085) });
    expect(() =>
      decodeResponse(withDetails({ note: "x".repeat(4086) })),
    ).toThrow("details must serialize within 4096 bytes");
  });

  test("closed decoder rejects non-object JSON without throwing TypeError", () => {
    expect(() => decodeResponse("null")).toThrow("must be a JSON object");
    expect(() => decodeResponse("[]")).toThrow("must be a JSON object");
    expect(() => decodeResponse('"str"')).toThrow("must be a JSON object");
    expect(() => decodeResponse("42")).toThrow("must be a JSON object");
  });

  test("closed decoder requires a nonnegative safe-integer id", () => {
    const wrap = (id: unknown): string =>
      JSON.stringify({ jsonrpc: "2.0", id, result: {}, version: "1.0" });
    for (const id of [undefined, "1", 1.5, -1, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => decodeResponse(wrap(id))).toThrow(
        "id must be a nonnegative safe integer",
      );
    }
  });

  test("scope matrix", () => {
    expect(
      isValidMethodForScope("bitty.debug/listPlugins", "debug.inspect"),
    ).toBe(true);
    expect(
      isValidMethodForScope("bitty.debug/startTrace", "debug.inspect"),
    ).toBe(false);
    expect(isValidMethodForScope("bitty.debug/startTrace", "debug.trace")).toBe(
      true,
    );
    expect(
      isValidMethodForScope("bitty.debug/suspendHandler", "debug.trace"),
    ).toBe(false);
    expect(
      isValidMethodForScope("bitty.debug/suspendHandler", "debug.control"),
    ).toBe(true);
    // CTX-0159 introspection is inspect-only (never trace/control authority).
    for (const method of [
      "bitty.debug/getGridText",
      "bitty.debug/getInputRing",
      "bitty.debug/getModifiers",
      "bitty.debug/getFocus",
    ]) {
      expect(isValidMethodForScope(method, "debug.inspect")).toBe(true);
    }
  });

  test("scope matrix includes automation methods", () => {
    // CTX-0038: automation drivers were omitted from the scope matrix.
    // synthesizeInput is control-only (input synthesis needs debug.control
    // + terminal.input); captureFrame and frameHash are trace-level reads
    // (debug.trace + terminal.inspect, held also by debug.control).
    expect(
      isValidMethodForScope("bitty.debug/synthesizeInput", "debug.inspect"),
    ).toBe(false);
    expect(
      isValidMethodForScope("bitty.debug/synthesizeInput", "debug.trace"),
    ).toBe(false);
    expect(
      isValidMethodForScope("bitty.debug/synthesizeInput", "debug.control"),
    ).toBe(true);
    for (const method of [
      "bitty.debug/captureFrame",
      "bitty.debug/frameHash",
    ]) {
      expect(isValidMethodForScope(method, "debug.inspect")).toBe(false);
      expect(isValidMethodForScope(method, "debug.trace")).toBe(true);
      expect(isValidMethodForScope(method, "debug.control")).toBe(true);
    }
  });

  test("chunking preserves multilingual text within byte limits", () => {
    const encoder = new TextEncoder();
    const samples = [
      "",
      "Hello world",
      "café Ελληνικά",
      "日本語 हिन्दी العربية",
      "e\u0301 and \u{1d11e} music",
      "\ufeffHello\ufeff世界",
    ];
    for (const text of samples) {
      const minimum = Math.max(
        1,
        ...Array.from(text, (scalar) => encoder.encode(scalar).length),
      );
      for (let limit = minimum; limit <= 16; limit++) {
        const chunks = chunkText(text, limit);
        expect(chunks.join("")).toBe(text);
        for (const chunk of chunks) {
          expect(chunk.length).toBeGreaterThan(0);
          expect(encoder.encode(chunk).length).toBeLessThanOrEqual(limit);
          expect(
            new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
              encoder.encode(chunk),
            ),
          ).toBe(chunk);
        }
      }
    }
  });

  test("chunking packs whole scalars at exact byte boundaries", () => {
    expect(chunkText("abé日本\u{1d11e}z", 4)).toEqual([
      "abé",
      "日",
      "本",
      "\u{1d11e}",
      "z",
    ]);
  });

  test("chunking rejects limits that cannot fit the next scalar", () => {
    for (const scalar of ["é", "日", "\u{1d11e}"]) {
      for (
        let limit = 1;
        limit < new TextEncoder().encode(scalar).length;
        limit++
      ) {
        for (const prefix of ["", "hello "]) {
          expect(() => chunkText(prefix + scalar + " fin", limit)).toThrow(
            "chunkBytes cannot fit the next Unicode scalar",
          );
        }
      }
    }
  });

  test("chunking requires an integer byte limit in range", () => {
    for (const limit of [0, -1, 256 * 1024 + 1, 1.5, NaN, Infinity]) {
      expect(() => chunkText("", limit)).toThrow("chunkBytes must be");
      expect(() => chunkText("hello", limit)).toThrow("chunkBytes must be");
    }
  });

  test("chunking bounded 256 KiB", () => {
    const s = "a".repeat(600 * 1024);
    const chunks = chunkText(s);
    expect(chunks.length).toBe(3);
    for (const c of chunks)
      expect(new TextEncoder().encode(c).length <= 256 * 1024).toBe(true);
    expect(chunks.join("")).toBe(s);
  });
});
