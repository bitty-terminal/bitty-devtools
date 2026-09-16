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

  test("chunking bounded 256 KiB", () => {
    const s = "a".repeat(600 * 1024);
    const chunks = chunkText(s);
    expect(chunks.length).toBe(3);
    for (const c of chunks)
      expect(new TextEncoder().encode(c).length <= 256 * 1024).toBe(true);
    expect(chunks.join("")).toBe(s);
  });
});
