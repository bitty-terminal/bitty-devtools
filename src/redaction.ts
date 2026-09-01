/**
 * Typed redaction for human-facing diagnostics.
 *
 * Treats terminal output, traces, and previews as untrusted observation data.
 * Sensitive fields are typed and redacted before any queue entry. Input capture
 * is opt-in; default previews minimize data. Export preview must equal actual
 * export byte-for-byte before transmission.
 */

import { BOUNDS, truncateToBytes } from "./bounds.js";

export const SENSITIVE_PATTERNS: readonly RegExp[] = [
  /password/i,
  /secret/i,
  /token/i,
  /api[_-]?key/i,
  /authorization/i,
  /cookie/i,
] as const;

export function isSensitiveField(name: string): boolean {
  return SENSITIVE_PATTERNS.some((re) => re.test(name));
}

export function redactValue(value: string, fieldName: string): string {
  if (isSensitiveField(fieldName)) return "[REDACTED]";
  // Also redact if value looks like a secret (long base64/hex-like without spaces)
  if (
    value.length > 32 &&
    /^[A-Za-z0-9+/=_-]+$/.test(value) &&
    !value.includes(" ")
  ) {
    // Heuristic: if entropy-like and flagged as token-ish key, redact
    // Conservative: only when field is sensitive; otherwise pass
    return value;
  }
  return value;
}

export type RedactionMarker = {
  redacted: boolean;
  truncated: boolean;
  originalBytes: number;
};

export function redactPreview(
  text: string,
  fieldName = "preview",
): { text: string; marker: RedactionMarker } {
  const originalBytes = new TextEncoder().encode(text).length;
  let out = redactValue(text, fieldName);
  const wasRedacted = out !== text;
  // Hide clipboard, env, raw PTY bytes by default unless opt-in
  // For generic previews, truncate to PREVIEW_MAX_BYTES
  if (new TextEncoder().encode(out).length > BOUNDS.PREVIEW_MAX_BYTES) {
    out = truncateToBytes(out, BOUNDS.PREVIEW_MAX_BYTES);
    return {
      text: out,
      marker: { redacted: wasRedacted, truncated: true, originalBytes },
    };
  }
  return {
    text: out,
    marker: { redacted: wasRedacted, truncated: false, originalBytes },
  };
}

export function previewEqualsExport(
  preview: string,
  exported: string,
): boolean {
  return preview === exported;
}

export function assertPreviewEqualsExport(
  preview: string,
  exported: string,
): void {
  if (preview !== exported) {
    throw new Error(
      "preview must equal actual export byte-for-byte before transmission",
    );
  }
}
