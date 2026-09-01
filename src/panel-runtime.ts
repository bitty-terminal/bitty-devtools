/**
 * Panel Runtime re-use for diagnostics (no ownership).
 *
 * This module reuses the accepted Panel Runtime types and bounds from
 * `bitty-runtime` (PanelRegistry) and `bitty-ui` (PanelId, PanelState,
 * PanelType, ViewId). It does not link private core types or inspect process
 * memory. All handles are validated as (id, generation) pairs and fail with
 * typed errors before any state access (fail-closed).
 *
 * No PTY file descriptor, GPU object, or OS window handle is ever held.
 */

import {
  BOUNDS,
  assertBounded,
  assertStringBounded,
  truncateToChars,
} from "./bounds.js";

// Distinct newtypes: branded to prevent PanelId/ViewId/TerminalId confusion.
export type PanelId = number & { readonly __brand: "PanelId" };
export type ViewId = number & { readonly __brand: "ViewId" };
export type TerminalId = number & { readonly __brand: "TerminalId" };
export type WorkspaceId = number & { readonly __brand: "WorkspaceId" };
export type Generation = number & { readonly __brand: "Generation" };

export function panelId(raw: number): PanelId {
  assertBounded("PanelId", raw, Number.MAX_SAFE_INTEGER);
  if (!Number.isInteger(raw) || raw <= 0)
    throw new Error("PanelId must be positive integer");
  return raw as PanelId;
}

export function viewId(raw: number): ViewId {
  if (!Number.isInteger(raw) || raw <= 0)
    throw new Error("ViewId must be positive integer");
  return raw as ViewId;
}

export function terminalId(raw: number): TerminalId {
  if (!Number.isInteger(raw) || raw <= 0)
    throw new Error("TerminalId must be positive integer");
  return raw as TerminalId;
}

export function generation(raw: number): Generation {
  if (!Number.isInteger(raw) || raw < 1)
    throw new Error("Generation must be >=1");
  if (raw >= Number.MAX_SAFE_INTEGER - BOUNDS.GENERATION_RESERVE) {
    throw new Error("generation exhausted");
  }
  return raw as Generation;
}

export function isGenerationExhausted(gen: Generation): boolean {
  return Number(gen) >= Number.MAX_SAFE_INTEGER - BOUNDS.GENERATION_RESERVE;
}

export type PanelType = "terminal" | "rich" | "browser" | "helper" | "canvas";
export const PANEL_TYPES: readonly PanelType[] = [
  "terminal",
  "rich",
  "browser",
  "helper",
  "canvas",
] as const;

export function parsePanelType(raw: string): PanelType | null {
  return (PANEL_TYPES as readonly string[]).includes(raw)
    ? (raw as PanelType)
    : null;
}

export type PanelState =
  "Declared" | "Created" | "Mounted" | "Focused" | "Suspended" | "Disposed";

export const PANEL_TRANSITIONS: ReadonlyMap<string, boolean> = (() => {
  const allowed: Array<[PanelState, PanelState]> = [
    ["Declared", "Created"],
    ["Created", "Mounted"],
    ["Mounted", "Focused"],
    ["Mounted", "Suspended"],
    ["Focused", "Suspended"],
    ["Focused", "Mounted"],
    ["Suspended", "Mounted"],
    ["Suspended", "Focused"],
    ["Created", "Disposed"],
    ["Mounted", "Disposed"],
    ["Focused", "Disposed"],
    ["Suspended", "Disposed"],
  ];
  const m = new Map<string, boolean>();
  for (const [a, b] of allowed) m.set(`${a}->${b}`, true);
  return m;
})();

export function canTransition(from: PanelState, to: PanelState): boolean {
  return PANEL_TRANSITIONS.has(`${from}->${to}`);
}

export type EventTopic = string & { readonly __brand: "EventTopic" };

const TOPIC_RE = /^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*:[a-z][a-z0-9_.-]*$/;

export function parseEventTopic(raw: string): EventTopic {
  if (raw.length === 0 || raw.length > 64)
    throw new Error("topic must be 1..64 bytes");
  if (!TOPIC_RE.test(raw)) throw new Error(`invalid topic grammar: ${raw}`);
  if (raw.startsWith("bitty.") && !raw.startsWith("bitty.panel:")) {
    throw new Error("non-Core bitty.* topic is forbidden");
  }
  return raw as EventTopic;
}

export function isCoalescableTopic(topic: string): boolean {
  return (
    topic.includes("focus") ||
    topic.includes("cwd") ||
    topic.includes("title") ||
    topic.includes("file.open")
  );
}

export class BoundedPayload {
  readonly value: string;
  constructor(raw: string) {
    assertStringBounded("BUS_EVENT_MAX_BYTES", raw, BOUNDS.BUS_EVENT_MAX_BYTES);
    this.value = raw;
  }
  static tryNew(raw: string): BoundedPayload {
    return new BoundedPayload(raw);
  }
  get bytes(): number {
    return new TextEncoder().encode(this.value).length;
  }
}

export type OverlayKind = "Modal" | "NonModal" | "Tooltip" | "Palette";

export type Overlay = {
  id: number;
  kind: OverlayKind;
  bounds: { x: number; y: number; width: number; height: number };
  text: string;
  tooltip?: string;
  generation: Generation;
  truncated: boolean;
};

export type PanelHandle = {
  id: PanelId;
  generation: Generation;
};

export type PanelErrorCode =
  | "TooManyPanels"
  | "TooManyTopics"
  | "TooManySubscriptions"
  | "PayloadTooLarge"
  | "UnknownPanelType"
  | "UnknownTopic"
  | "UndisclosedTopic"
  | "AlreadyMounted"
  | "PanelAlreadyMounted"
  | "StaleHandle"
  | "RegistryDisposed"
  | "GenerationExhausted"
  | "OverlayBusy"
  | "TooManyOverlays"
  | "CapabilityDenied"
  | "InvalidCommand"
  | "DuplicateCommand"
  | "TooManyCommands"
  | "NotFound"
  | "InvalidState"
  | "ResourceExhausted";

export class PanelError extends Error {
  constructor(
    public readonly code: PanelErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PanelError";
  }
}

/**
 * Diagnostics view over a PanelRegistry snapshot.
 * This is observation-only; it never mutates grid or PTY and holds no handles.
 */
export type PanelRuntimeSnapshot = {
  generation: Generation;
  panels: Array<{
    id: PanelId;
    generation: Generation;
    state: PanelState;
    type: PanelType;
    workspace?: WorkspaceId;
    view?: ViewId;
    title?: string;
  }>;
  panelsPerWorkspace: Map<WorkspaceId, number>;
  totalPanels: number;
  topics: EventTopic[];
  overlays: Overlay[];
  config: {
    maxPanelsPerWorkspace: number;
    maxPanelsPerWindow: number;
    maxTopicsTotal: number;
    maxSubscriptionsPerPanel: number;
  };
};

export function validatePanelBounds(
  maxPanelsPerWorkspace: number,
  maxPanelsPerWindow: number,
): void {
  assertBounded(
    "maxPanelsPerWorkspace",
    maxPanelsPerWorkspace,
    BOUNDS.MAX_PANELS_PER_WORKSPACE,
  );
  if (maxPanelsPerWorkspace < 1)
    throw new Error("maxPanelsPerWorkspace must be >=1");
  assertBounded(
    "maxPanelsPerWindow",
    maxPanelsPerWindow,
    BOUNDS.MAX_PANELS_PER_WINDOW,
  );
  if (maxPanelsPerWindow < 1) throw new Error("maxPanelsPerWindow must be >=1");
}

export function validateOverlayText(text: string): {
  text: string;
  truncated: boolean;
} {
  return truncateToChars(text, BOUNDS.MAX_OVERLAY_TEXT_LEN);
}

export function validateOverlayTooltip(tooltip: string): {
  text: string;
  truncated: boolean;
} {
  return truncateToChars(tooltip, BOUNDS.MAX_OVERLAY_TOOLTIP_LEN);
}
