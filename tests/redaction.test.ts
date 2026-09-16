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

  test("H-DEV-01: sensitive value under innocent field name is redacted", () => {
    expect(redactValue("my password = hunter2-secret", "notes")).toBe(
      "[REDACTED]",
    );
    expect(redactValue("Authorization: Bearer abcdef123456", "message")).toBe(
      "[REDACTED]",
    );
    expect(redactValue("AKIAIOSFODNN7EXAMPLE", "notes")).toBe("[REDACTED]");
    expect(
      redactValue("ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "notes"),
    ).toBe("[REDACTED]");
    expect(
      redactValue("sk-proj-abcdefghijklmnopqrstuvwx1234567890ABCD", "notes"),
    ).toBe("[REDACTED]");
  });

  test("H-DEV-01: entropy heuristic redacts token-like values", () => {
    expect(
      redactValue(
        "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ",
        "preview",
      ),
    ).toBe("[REDACTED]");
    expect(redactValue("K7qZ2mX9pL4vN8wQ3rT6yU1iO5aS0dF8gH2jK4", "notes")).toBe(
      "[REDACTED]",
    );
  });

  test("heuristic avoids false positives on ordinary text", () => {
    expect(redactValue("hello", "preview")).toBe("hello");
    expect(
      redactValue("the quick brown fox jumps over the lazy dog", "notes"),
    ).toBe("the quick brown fox jumps over the lazy dog");
    expect(redactValue("a".repeat(48), "notes")).toBe("a".repeat(48));
    expect(redactValue("123e4567-e89b-12d3-a456-426614174000", "notes")).toBe(
      "123e4567-e89b-12d3-a456-426614174000",
    );
    expect(redactValue("the password is required to log in", "notes")).toBe(
      "the password is required to log in",
    );
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
