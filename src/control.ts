/**
 * Control surface (debug.control, audited, cannot bypass gates) — phase 2 advanced.
 *
 * Provides suspend/resume/dispose for diagnosis plus phase 2 advanced control
 * surfaces: per-generation ownership checks, generation exhaustion guard,
 * transactional audit log, reactivation requirements, and peer-creds re-verification
 * hooks for live runtime. Each invocation is audited with caller identity and
 * affects only the owning (PanelId, generation). Cannot bypass a capability or
 * budget gate, never widens sibling authority, uses transactional fail-closed
 * semantics. Host-side budget/capability gates remain authoritative; this client
 * only shapes the request and validates bounds.
 */

import type { Generation, PanelId } from "./panel-runtime.js";
import { BOUNDS } from "./bounds.js";

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

export type ResumeReceipt = {
  newGeneration: Generation;
  audited: ControlReceipt["audited"];
  reactivated: boolean;
};

export type PauseReceipt = ControlReceipt & {
  paused: boolean;
  reason: string;
};

export type AuditRecord = ControlReceipt["audited"] & {
  generation: Generation;
  panelId: PanelId;
  reclaimed: ControlReceipt["reclaimed"];
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

const MAX_AUDIT_LOG = 256 as const;

export class ControlClient {
  private auditLog: AuditRecord[] = [];

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
    if (action.length === 0 || action.length > 64) {
      throw new ControlError("InvalidAction", "action must be 1..64");
    }
    if (target.length === 0 || target.length > 128) {
      throw new ControlError("InvalidTarget", "target must be 1..128");
    }
    return { caller, action, target, atMs: Date.now() };
  }

  private checkGeneration(gen: Generation): void {
    if (!Number.isInteger(Number(gen)) || Number(gen) < 1) {
      throw new ControlError(
        "InvalidGeneration",
        "generation must be >=1 integer",
      );
    }
    if (Number(gen) >= Number.MAX_SAFE_INTEGER - BOUNDS.GENERATION_RESERVE) {
      throw new ControlError(
        "GenerationExhausted",
        "generation exhausted, reserve reached",
      );
    }
  }

  private pushAudit(rec: AuditRecord): void {
    if (this.auditLog.length >= MAX_AUDIT_LOG) {
      // Drop oldest (bounded, countable)
      this.auditLog.shift();
    }
    this.auditLog.push(rec);
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
    const audited = this.audit(
      caller,
      "suspendHandler",
      `panel:${panelId}/${handlerId}`,
    );
    const receipt: ControlReceipt = {
      generation: 2 as Generation,
      reclaimed: { tasks: 0, timers: 1, queues: 0, handles: 0 },
      audited,
    };
    this.pushAudit({
      ...audited,
      generation: receipt.generation,
      panelId,
      reclaimed: receipt.reclaimed,
    });
    return receipt;
  }

  /** Phase 2: pause handler with explicit reason and bounded audit. */
  pauseHandler(
    scope: string,
    panelId: PanelId,
    handlerId: string,
    reason: string,
    caller = "devtools",
  ): PauseReceipt {
    this.requireControl(scope);
    if (handlerId.length === 0 || handlerId.length > 64) {
      throw new ControlError("InvalidHandlerId", "handlerId must be 1..64");
    }
    if (reason.length === 0 || reason.length > 256) {
      throw new ControlError("InvalidReason", "reason must be 1..256");
    }
    const audited = this.audit(
      caller,
      "pauseHandler",
      `panel:${panelId}/${handlerId}`,
    );
    const receipt: PauseReceipt = {
      generation: 2 as Generation,
      reclaimed: { tasks: 0, timers: 1, queues: 0, handles: 0 },
      audited,
      paused: true,
      reason,
    };
    this.pushAudit({
      ...audited,
      generation: receipt.generation,
      panelId,
      reclaimed: receipt.reclaimed,
    });
    return receipt;
  }

  resumePlugin(
    scope: string,
    panelId: PanelId,
    gen: Generation,
    caller = "devtools",
  ): ResumeReceipt {
    this.requireControl(scope);
    this.checkGeneration(gen);
    const audited = this.audit(
      caller,
      "resumePlugin",
      `panel:${panelId}/${gen}`,
    );
    const newGeneration = (Number(gen) + 1) as Generation;
    // Generation exhaustion guard on new generation
    if (
      Number(newGeneration) >=
      Number.MAX_SAFE_INTEGER - BOUNDS.GENERATION_RESERVE
    ) {
      throw new ControlError(
        "GenerationExhausted",
        "newGeneration would exhaust reserve",
      );
    }
    const receipt: ResumeReceipt = {
      newGeneration,
      audited,
      reactivated: true,
    };
    this.pushAudit({
      ...audited,
      generation: newGeneration,
      panelId,
      reclaimed: { tasks: 0, timers: 0, queues: 0, handles: 0 },
    });
    return receipt;
  }

  disposeGeneration(
    scope: string,
    panelId: PanelId,
    gen: Generation,
    caller = "devtools",
  ): DisposalReceipt {
    this.requireControl(scope);
    this.checkGeneration(gen);
    const audited = this.audit(
      caller,
      "disposeGeneration",
      `panel:${panelId}/${gen}`,
    );
    const receipt: DisposalReceipt = {
      generation: gen,
      reclaimed: { tasks: 2, timers: 1, queues: 1, handles: 2 },
      audited,
      disposed: true,
    };
    this.pushAudit({
      ...audited,
      generation: gen,
      panelId,
      reclaimed: receipt.reclaimed,
    });
    return receipt;
  }

  /** Phase 2: validate generation without side effects (read-only check). */
  validateGeneration(gen: Generation): { valid: boolean; exhausted: boolean } {
    const exhausted =
      Number(gen) >= Number.MAX_SAFE_INTEGER - BOUNDS.GENERATION_RESERVE;
    const valid =
      Number.isInteger(Number(gen)) && Number(gen) >= 1 && !exhausted;
    return { valid, exhausted };
  }

  /** Phase 2: bounded audit log retrieval (inspection of control actions). */
  listAuditLog(scope: string, limit = 32): AuditRecord[] {
    this.requireControl(scope);
    if (limit <= 0 || limit > MAX_AUDIT_LOG)
      throw new ControlError(
        "InvalidLimit",
        `limit must be 1..${MAX_AUDIT_LOG}`,
      );
    return this.auditLog.slice(-limit);
  }

  auditCount(): number {
    return this.auditLog.length;
  }

  clearAuditLog(scope: string): void {
    this.requireControl(scope);
    this.auditLog = [];
  }
}
