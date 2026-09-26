import { describe, expect, test } from "bun:test";
import { ProtocolErrorImpl } from "../src/protocol.js";
import {
  isValidLiveMethodForScope,
  validateLiveRequest,
} from "../src/protocol-boundary.js";

function expectProtocolCode(action: () => void, code: string): void {
  try {
    action();
    throw new Error("expected protocol admission to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolErrorImpl);
    expect((error as ProtocolErrorImpl).error.code).toBe(code);
  }
}

describe("CTX-0080 live protocol admission", () => {
  test("rejects unsupported protocol versions with a typed error", () => {
    expectProtocolCode(
      () =>
        validateLiveRequest({
          id: 1,
          method: "bitty.debug/listPlugins",
          version: "2.0",
        }),
      "UnsupportedVersion",
    );
  });

  test("rejects unregistered methods and scope widening", () => {
    expectProtocolCode(
      () =>
        validateLiveRequest({
          id: 1,
          method: "bitty.debug/notRegistered",
          version: "1.0",
        }),
      "UnknownMethod",
    );
    expectProtocolCode(
      () =>
        validateLiveRequest({
          id: 1,
          method: "bitty.debug/startTrace",
          version: "1.0",
        }),
      "UnknownMethod",
    );
  });

  test("admits only the registered inspect method set", () => {
    expect(
      isValidLiveMethodForScope("bitty.debug/listPlugins", "debug.inspect"),
    ).toBe(true);
    expect(
      isValidLiveMethodForScope("bitty.debug/getFocus", "debug.trace"),
    ).toBe(false);
    expect(
      isValidLiveMethodForScope("bitty.debug/captureFrame", "debug.trace"),
    ).toBe(true);
    expect(
      isValidLiveMethodForScope("bitty.debug/synthesizeInput", "debug.control"),
    ).toBe(true);
  });
});
