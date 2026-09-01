import { describe, expect, test } from "bun:test";
import {
  isSensitiveField,
  redactValue,
  redactPreview,
  previewEqualsExport,
} from "../src/redaction.js";

describe("redaction", () => {
  test("sensitive field typed", () => {
    expect(isSensitiveField("password")).toBe(true);
    expect(isSensitiveField("api_key")).toBe(true);
    expect(isSensitiveField("safe")).toBe(false);
  });

  test("redactValue redacts sensitive", () => {
    expect(redactValue("hunter2", "password")).toBe("[REDACTED]");
    expect(redactValue("hello", "preview")).toBe("hello");
  });

  test("redactPreview truncates 8 KiB", () => {
    const long = "a".repeat(9000);
    const { text, marker } = redactPreview(long);
    expect(new TextEncoder().encode(text).length <= 8192).toBe(true);
    expect(marker.truncated).toBe(true);
  });

  test("preview equals export byte-for-byte", () => {
    const p = "hello";
    const e = "hello";
    expect(previewEqualsExport(p, e)).toBe(true);
    expect(previewEqualsExport("a", "b")).toBe(false);
  });
});
