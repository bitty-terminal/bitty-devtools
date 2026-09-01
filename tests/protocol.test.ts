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
