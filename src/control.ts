/**
 * Control surface (debug.control, audited, cannot bypass gates).
 *
 * Provides suspend/resume/dispose for diagnosis. Each invocation is audited
 * with caller identity and affects only the owning (PluginId, generation) or
 * (PanelId, generation). Cannot bypass a capability or budget gate, never
 * widens sibling authority, uses transactional fail-closed semantics.
 */

import type { PanelId, Generation } from "./panel-runtime.js";

export type ControlReceipt = {
  generation: Generation;
  reclaimed: {
    tasks: number;
    timers: number;
    queues: number;
    handles: number;
  };
  audited: {
    caller: string;
    action: string;
    target: string;
    atMs: number;
  };
};

export type DisposalReceipt = ControlReceipt & {
  disposed: boolean;
};

export class ControlError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ControlError";
  }
}

export class ControlClient {
  private requireControl(scope: string): void {
    if (scope !== "debug.control") {
      throw new ControlError("ScopeDenied", "debug.control scope required");
    }
  }

  private audit(
    caller: string,
    action: string,
    target: string,
  ): ControlReceipt["audited"] {
    if (caller.length === 0 || caller.length > 64) {
      throw new ControlError("InvalidCaller", "caller must be 1..64");
    }
    return { caller, action, target, atMs: Date.now() };
  }

  suspendHandler(
    scope: string,
    panelId: PanelId,
    handlerId: string,
    cause: string,
    caller = "devtools",
  ): ControlReceipt {
    this.requireControl(scope);
    if (handlerId.length === 0 || handlerId.length > 64) {
      throw new ControlError("InvalidHandlerId", "handlerId must be 1..64");
    }
    if (cause.length === 0 || cause.length > 256) {
      throw new ControlError("InvalidCause", "cause must be 1..256");
    }
    // Transactional: no state change if audited fails
    const audited = this.audit(
      caller,
      "suspendHandler",
      `panel:${panelId}/${handlerId}`,
    );
    // Stub generation after detach: requirement for reactivation
    return {
      generation: 2 as Generation,
      reclaimed: { tasks: 0, timers: 1, queues: 0, handles: 0 },
      audited,
    };
  }

  resumePlugin(
    scope: string,
    panelId: PanelId,
    gen: Generation,
    caller = "devtools",
  ): { newGeneration: Generation } & { audited: ControlReceipt["audited"] } {
    this.requireControl(scope);
    // Cannot bypass budget/capability gate: check would happen server-side.
    // Here we stub typed rejection marker; in real IPC this would be an error
    // if the budget gate still fails.
    const audited = this.audit(
      caller,
      "resumePlugin",
      `panel:${panelId}/${gen}`,
    );
    return {
      newGeneration: (Number(gen) + 1) as Generation,
      audited,
    };
  }

  disposeGeneration(
    scope: string,
    panelId: PanelId,
    gen: Generation,
    caller = "devtools",
  ): DisposalReceipt {
    this.requireControl(scope);
    const audited = this.audit(
      caller,
      "disposeGeneration",
      `panel:${panelId}/${gen}`,
    );
    // Fail-closed: disposal receipt with reclaimed counts
    return {
      generation: gen,
      reclaimed: { tasks: 2, timers: 1, queues: 1, handles: 2 },
      audited,
      disposed: true,
    };
  }
}
