/**
 * bitty-devtools phase 2 diagnostics client — public surface.
 *
 * Re-exports the human-facing diagnostics client for local debugging over
 * the accepted Panel Runtime and compat matrix. Consumes the versioned debug
 * protocol (devtools-rfc OQ-019, performance budgets OQ-001); does not own it.
 * Keep bounded, forbid unsafe (TypeScript strict, no any/unsafe), scope-checked.
 *
 * Phase 2 adds: advanced tracing with filtering/retention/GC, control surfaces
 * with audit log and generation guards, a bounded transport fixture, and a
 * Linux-only endpoint-attested live inspection path.
 */

export * from "./bounds.js";
export * from "./redaction.js";
export * from "./panel-runtime.js";
export * from "./compat-matrix.js";
export * from "./protocol.js";
export * from "./auth.js";
export * from "./transport.js";
export * from "./queue.js";
export * from "./campaign.js";
export * from "./inspection.js";
export * from "./control.js";
export * from "./automation.js";
export * from "./client.js";
