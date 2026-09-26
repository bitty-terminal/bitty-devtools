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
  // JWT shape: three dot-joined parts, each at least 8 chars (a real
  // header/payload/signature is far longer; without the floor, version
  // strings like "1.2.3" or "v1.2.3" false-positive).
  /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
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

/* ------------------------------------------------------------------------ *
 * Normalization class
 *
 * NORM-1 (normative, mirrored in crates/devtools-client/src/redaction.rs):
 * the normalization class is every code point above U+007F that Unicode
 * classifies as Default_Ignorable_Code_Point, as general category Cf
 * (Other_Format), or as White_Space. Membership is decided by Unicode
 * character properties only; no hand-written range list is normative.
 *
 * Rationale: every member renders as nothing at all (a format control or a
 * default-ignorable code point) or as blank (a non-ASCII space separator), so
 * a hostile producer can inject any of them to break a literal credential
 * pattern match without changing what the operator sees on screen. They are
 * therefore removed before secret matching and before human rendering.
 * Membership is 4225 code points in 29 ranges for Unicode 17.0 and is pinned
 * by tests/fixtures/redaction-normalization-class.txt, which both language
 * test suites execute.
 *
 * C0, DEL, and C1 controls are deliberately NOT in the class: they are
 * escaped for rendering, not silently deleted, so an escape is never
 * swallowed. U+0085 is the one code point in both sets (Cc and White_Space);
 * the escape branch runs first for rendering, and both implementations
 * remove it for matching.
 * ---------------------------------------------------------------------- */

const UNICODE_DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
const UNICODE_OTHER_FORMAT = /\p{Cf}/u;
const UNICODE_WHITE_SPACE = /\p{White_Space}/u;

/** True when `codePoint` belongs to the NORM-1 normalization class. */
export function isNormalizationSeparator(codePoint: number): boolean {
  if (
    !Number.isInteger(codePoint) ||
    codePoint <= 0x7f ||
    codePoint > 0x10ffff
  ) {
    return false;
  }
  const character = String.fromCodePoint(codePoint);
  return (
    UNICODE_DEFAULT_IGNORABLE.test(character) ||
    UNICODE_OTHER_FORMAT.test(character) ||
    UNICODE_WHITE_SPACE.test(character)
  );
}

function isControlCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    codePoint === 0x7f ||
    (codePoint >= 0x80 && codePoint <= 0x9f)
  );
}

/**
 * Escape C0, DEL, and C1 controls, drop the NORM-1 normalization class, and
 * cap the result at `maxBytes`. Nothing from the normalization class can
 * survive, so a report can never smuggle an invisible code point.
 */
export function sanitizeTerminalOutput(
  value: string,
  maxBytes: number = BOUNDS.PREVIEW_MAX_BYTES,
): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("maxBytes must be a non-negative safe integer");
  }
  const escaped = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) return character;
    if (codePoint === 0x0a) return "\\n";
    if (codePoint === 0x0d) return "\\r";
    if (codePoint === 0x09) return "\\t";
    if (isControlCodePoint(codePoint)) {
      return `\\u${codePoint.toString(16).padStart(4, "0")}`;
    }
    if (isNormalizationSeparator(codePoint)) return "";
    return character;
  }).join("");
  return truncateToBytes(escaped, maxBytes);
}

/**
 * Control-stripped text plus a map back to source UTF-16 offsets, so a match
 * found in the stripped text can be replaced in the original string and the
 * matcher's own semantics never depend on the class.
 */
type ControlNormalizedText = {
  text: string;
  sourceIndexes: number[];
};

function controlNormalizedText(value: string): ControlNormalizedText {
  let text = "";
  const sourceIndexes: number[] = [];
  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) break;
    const width = codePoint > 0xffff ? 2 : 1;
    if (isControlCodePoint(codePoint) || isNormalizationSeparator(codePoint)) {
      index += width;
      continue;
    }
    text += value.slice(index, index + width);
    for (let unit = 0; unit < width; unit += 1) {
      sourceIndexes.push(index + unit);
    }
    index += width;
  }
  return { text, sourceIndexes };
}

/**
 * Assignment and bearer shapes that expose a credential inline. Matching is
 * ASCII-case-insensitive: `Authorization:`, `AUTHORIZATION =`, and
 * `aUtHoRiZaTiOn:` are the same finding, and the case-insensitive verification
 * is reachable for every ASCII spelling of the first byte of every key. The key
 * list matches the Rust `KEYS` table in `crates/devtools-client/src/redaction.rs`
 * so neither implementation is weaker than the other on an assignment, and the
 * delimiter tolerance matches Rust `is_assignment_after` exactly: one optional
 * `-` or `_`, optional spaces and tabs, then `:` or `=`, optional spaces and
 * tabs, then a non-space byte. Space and tab are the only whitespace that can
 * reach this pattern, because normalization has already removed every other
 * whitespace code point. Neither alternative is anchored on a word boundary,
 * because a credential name is routinely glued to a prefix by `_` or `-`
 * (`session_token: v`, `x-api-key: v`) and Rust has no anchor either. A longer
 * word is still not a finding, because the delimiter is what terminates the
 * key: `passwords: v` and `authorizationing: note` do not match.
 */
function assignmentOrBearerPattern(): RegExp {
  return /(?:proxy[-_]?authorization|authorization|api[_-]?key|access[-_]?token|auth[-_]?token|auth|cookie|credential|password|passwd|secret|token)[-_]?[ \t]*[:=][ \t]*(?:"[^"]*"|'[^']*'|(?:bearer[ \t]+)?[^\s,;]+)|bearer(?:[ \t]+[^\s,;]+|[a-z0-9._~+\/=-]{8,})/giu;
}

/**
 * A bare credential-bearing configuration name (`GITHUB_TOKEN`, `API_KEY`,
 * `MY_SECRET_VALUE`) is itself sensitive even with no value beside it.
 *
 * Deliberately case-SENSITIVE on the credential name: only the SCREAMING_SNAKE
 * spelling of SECRET, TOKEN, PASSWORD, CREDENTIAL, and API_KEY is a finding.
 * Running this rule case-insensitively made ordinary prose a finding, so
 * "the password is required to log in" and "Tokens expire after one hour"
 * were redacted while the lowercase keys they mention are not secrets. The
 * case-insensitive rule that *is* wanted lives in
 * {@link assignmentOrBearerPattern}, which requires an assignment.
 *
 * The negative lookahead keeps the rule from double-reporting a name that is
 * already followed by its value: `MY_SECRET: v` is handled by the assignment
 * rule, which replaces the whole `key: value` run.
 */
function credentialNamePattern(): RegExp {
  return /\b(?:[A-Za-z0-9]+[_-])*(?:SECRET|TOKEN|PASSWORD|CREDENTIAL|API_KEY)(?:[_-][A-Za-z0-9]+)*\b(?!\s*[:=])/gu;
}

function collectSecretRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const pattern of [
    assignmentOrBearerPattern(),
    credentialNamePattern(),
  ]) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (match[0].length === 0) {
        pattern.lastIndex += 1;
        continue;
      }
      ranges.push([match.index, match.index + match[0].length]);
    }
  }
  return ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

function redactTypedSecretRanges(value: string): string {
  const normalized = controlNormalizedText(value);
  let cursor = 0;
  let redacted = "";
  for (const [normalizedStart, normalizedEnd] of collectSecretRanges(
    normalized.text,
  )) {
    const start = normalized.sourceIndexes[normalizedStart] ?? value.length;
    const end = normalized.sourceIndexes[normalizedEnd] ?? value.length;
    if (start < cursor) continue;
    redacted += `${value.slice(cursor, start)}[REDACTED]`;
    cursor = end;
  }
  return `${redacted}${value.slice(cursor)}`;
}

/**
 * Inline credential redaction for a free-form human-facing string. The whole
 * string is replaced by the match range so an embedded secret cannot survive
 * in any part of the rendered report.
 */
export function redactSensitiveText(value: string): string {
  return redactTypedSecretRanges(value);
}
