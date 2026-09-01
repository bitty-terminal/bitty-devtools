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
  // Truncate at char boundary without splitting UTF-8
  let truncated = input;
  while (new TextEncoder().encode(truncated).length > maxBytes) {
    truncated = truncated.slice(0, -1);
  }
  return truncated;
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
