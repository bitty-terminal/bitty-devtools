/**
 * Bounded constants for the diagnostics client.
 *
 * Reuses the Panel Runtime (TerminalRegistry + PanelRegistry) and compat matrix
 * envelope verbatim. No new budget family is introduced. All values are
 * validated before mutation (fail-closed) per the accepted Panel and Isolation
 * contracts. This module never claims protocol ownership.
 */

export const BOUNDS = {
  // Panels (bitty-runtime PanelRegistry PR-1..PR-12)
  MAX_PANELS_PER_WORKSPACE: 32,
  MAX_PANELS_PER_WINDOW: 64,
  DEFAULT_MAX_PANELS_PER_WORKSPACE: 16,
  DEFAULT_MAX_PANELS_PER_WINDOW: 32,
  MAX_TOPICS_TOTAL: 256,
  MAX_SUBSCRIPTIONS_PER_PANEL: 32,
  MAX_COMMANDS_PER_PANEL_TYPE: 32,

  // Event bus three-level queue (mirrors Isolation Resource RC budgets)
  BUS_PER_SUBSCRIPTION: 64,
  BUS_PER_PANEL_EVENTS: 1024,
  BUS_PER_PANEL_BYTES: 256 * 1024,
  BUS_GLOBAL_EVENTS: 8192,
  BUS_GLOBAL_BYTES: 2 * 1024 * 1024,
  BUS_EVENT_MAX_BYTES: 8 * 1024,
  BUS_BATCH_MAX_EVENTS: 32,
  BUS_BATCH_MAX_BYTES: 8 * 1024,

  // Overlay (per window 4+1)
  MAX_OVERLAYS_PER_WINDOW: 4,
  MAX_OVERLAY_TEXT_LEN: 128,
  MAX_OVERLAY_TOOLTIP_LEN: 256,

  // Terminal surfaces
  MAX_COLS: 1024,
  MAX_ROWS: 1024,
  MAX_PERSISTENT_ID_LEN: 64,
  RESIZE_DEBOUNCE_CAP: 64,
  GENERATION_RESERVE: 1024,

  // Compat matrix (bitty-compat-lab 14x4)
  MATRIX_LEN: 14,
  MAX_CORPUS_BYTES: 8 * 1024,
  MAX_ACTIONS: 4096,
  MAX_SNAPSHOT_JSON_BYTES: 16 * 1024,

  // DevTools debug protocol framing (devtools-rfc accepted v1)
  MAX_FRAME_BYTES: 1 * 1024 * 1024,
  CHUNK_BYTES: 256 * 1024,
  MAX_TRACE_BYTES: 4 * 1024 * 1024,
  MAX_TRACE_DURATION_MS: 5 * 60 * 1000,
  MAX_CONNECTIONS: 16,

  // Test automation (bitty-ipc CTX-0188/CTX-0244 candidate; wire parity with
  // the `bitty` dispatcher, not a new budget family). `MAX_TRAJECTORY_*` are
  // client-side pacing bounds: the server bounds neither a trajectory's point
  // count beyond the per-call event cap nor its playback duration.
  MAX_SYNTH_EVENTS_PER_CALL: 64,
  MAX_SYNTH_CALLS_PER_SEC: 10,
  MAX_CAPTURE_FPS: 10,
  MAX_AUTOMATION_PARAMS_BYTES: 32 * 1024,
  MAX_AUTOMATION_RESPONSE_BYTES: 32 * 1024,
  MAX_ORIGIN_LABEL_CHARS: 64,
  MAX_BEARER_TOKEN_CHARS: 128,
  MAX_SYNTH_PASTE_BYTES: 16 * 1024,
  MAX_SYNTH_KEY_CHARS: 64,
  MAX_SYNTH_CELL: 1024,
  MAX_SYNTH_WHEEL_DELTA: 64,
  MAX_INSPECT_ROWS: 64,
  MAX_INSPECT_COLS: 256,
  MAX_DIGEST_RGBA_BYTES: 64 * 1024 * 1024,
  MAX_TRAJECTORY_POINTS: 64,
  MAX_DRAG_STEPS: 62,
  MAX_TRAJECTORY_DURATION_MS: 30 * 1000,

  // Preview bounds (redacted)
  PREVIEW_MAX_BYTES: 8 * 1024,
  PREVIEW_MAX_CHARS: 2048,
} as const;

export type BoundName = keyof typeof BOUNDS;

export class BoundError extends Error {
  constructor(
    public readonly bound: string,
    public readonly observed: number,
    public readonly limit: number,
  ) {
    super(`${bound} exceeded: ${observed} > ${limit}`);
    this.name = "BoundError";
  }
}

export function assertBounded(
  bound: string,
  observed: number,
  limit: number,
): void {
  if (!Number.isFinite(observed) || !Number.isFinite(limit)) {
    throw new BoundError(bound, observed, limit);
  }
  if (observed > limit) {
    throw new BoundError(bound, observed, limit);
  }
  if (observed < 0) {
    throw new BoundError(bound, observed, limit);
  }
}

export function assertStringBounded(
  bound: string,
  value: string,
  limitBytes: number,
): void {
  const bytes = new TextEncoder().encode(value).length;
  assertBounded(bound, bytes, limitBytes);
}

export function truncateToBytes(input: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(input);
  if (bytes.length <= maxBytes) return input;
  // Single-pass cut at maxBytes, then back off to a UTF-8 char boundary.
  // Time O(N) for the one encode plus O(1) back-off (at most 3 continuation
  // bytes precede the split lead); space O(N) for the encoded copy.
  let end = Math.max(0, maxBytes);
  const cut: number | undefined = end < bytes.length ? bytes[end] : undefined;
  if (end > 0 && cut !== undefined && (cut & 0xc0) === 0x80) {
    // The cut split a multi-byte sequence: walk back past its continuation
    // bytes, then drop the lead byte. Never splits a surrogate pair, since
    // a whole UTF-8 sequence (hence whole code point) is dropped at once.
    while (end > 0) {
      const prev: number | undefined = bytes[end - 1];
      if (prev === undefined || (prev & 0xc0) !== 0x80) break;
      end -= 1;
    }
    end -= 1;
  }
  return new TextDecoder().decode(bytes.slice(0, end));
}

export function truncateToChars(
  input: string,
  maxChars: number,
): {
  text: string;
  truncated: boolean;
} {
  if ([...input].length <= maxChars) return { text: input, truncated: false };
  return {
    text: [...input].slice(0, maxChars).join(""),
    truncated: true,
  };
}
