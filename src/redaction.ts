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

/**
 * Provider-issued credential shapes that are recognizable on sight,
 * regardless of the field name carrying them. Checked before the generic
 * entropy gate below so fixed-shape secrets never depend on tuning there.
 */
const SECRET_TOKEN_PATTERNS: readonly RegExp[] = [
  /sk-(?:proj|live|test)-[A-Za-z0-9_-]{8,}/,
  /sk-ant-[A-Za-z0-9_-]{8,}/,
  /xox[bpas]-[A-Za-z0-9-]{8,}/,
  /gh[pousr]_[A-Za-z0-9_]{8,}/,
  /github_pat_[A-Za-z0-9_]{8,}/,
  /gsk_[A-Za-z0-9_]{8,}/,
  /AIza[A-Za-z0-9_-]{8,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  /\b[0-9a-fA-F]{40}\b/,
  /\b[0-9a-fA-F]{64}\b/,
] as const;

/** Assignment and bearer phrases that expose a credential inline. */
const SECRET_PHRASE_PATTERNS: readonly RegExp[] = [
  /password\s*[:=]\s*\S+/i,
  /passwd\s*[:=]\s*\S+/i,
  /secret\s*[:=]\s*\S+/i,
  /api[_-]?key\s*[:=]\s*\S+/i,
  /auth[_-]?token\s*[:=]\s*\S+/i,
  /access[_-]?token\s*[:=]\s*\S+/i,
  /bearer\s+[A-Za-z0-9\-._~+/]+/i,
] as const;

function containsSecretPattern(value: string): boolean {
  return (
    SECRET_TOKEN_PATTERNS.some((re) => re.test(value)) ||
    SECRET_PHRASE_PATTERNS.some((re) => re.test(value))
  );
}

/** Shannon entropy in bits per character over the value's alphabet. */
function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * High-entropy token gate for values with no recognizable shape: a long
 * separator-free run mixing at least two of lowercase/uppercase/digits, with
 * entropy at or above the threshold. Ordinary prose (even without spaces),
 * slugs, UUIDs, timestamps, single-class runs, and paths stay below it.
 */
const ENTROPY_MIN_LENGTH = 32;
const ENTROPY_THRESHOLD_BITS = 4.5;
const SECRET_CHARSET = /^[A-Za-z0-9+_=.~-]+$/;

function looksLikeHighEntropySecret(value: string): boolean {
  if (value.length < ENTROPY_MIN_LENGTH) return false;
  if (!SECRET_CHARSET.test(value)) return false;
  let lower = 0;
  let upper = 0;
  let digits = 0;
  for (const ch of value) {
    if (ch >= "a" && ch <= "z") lower += 1;
    else if (ch >= "A" && ch <= "Z") upper += 1;
    else if (ch >= "0" && ch <= "9") digits += 1;
  }
  const mixedClasses = [lower, upper, digits].filter((n) => n >= 2).length >= 2;
  if (!mixedClasses) return false;
  return shannonEntropy(value) >= ENTROPY_THRESHOLD_BITS;
}

export function looksSecret(value: string): boolean {
  return containsSecretPattern(value) || looksLikeHighEntropySecret(value);
}

export function redactValue(value: string, fieldName: string): string {
  if (isSensitiveField(fieldName)) return "[REDACTED]";
  // Value-side scan: embedded credential shapes and high-entropy tokens
  // redact regardless of the field name.
  if (looksSecret(value)) return "[REDACTED]";
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
