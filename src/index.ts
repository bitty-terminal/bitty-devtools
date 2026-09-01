/**
 * bitty-devtools phase 1 diagnostics client — public surface.
 *
 * Re-exports the human-facing diagnostics client for local debugging over
 * the accepted Panel Runtime and compat matrix. Consumes the versioned debug
 * protocol (devtools-rfc OQ-019, performance budgets OQ-001); does not own it.
 * Keep bounded, forbid unsafe (TypeScript strict, no any/unsafe), scope-checked.
 */

export * from "./bounds.js";
export * from "./redaction.js";
export * from "./panel-runtime.js";
export * from "./compat-matrix.js";
export * from "./protocol.js";
export * from "./inspection.js";
export * from "./tracing.js";
export * from "./control.js";
export * from "./client.js";
