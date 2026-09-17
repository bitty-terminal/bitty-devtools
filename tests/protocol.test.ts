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
