# Bitty DevTools

Bitty DevTools is the human-facing diagnostics and debugging client for
local debugging over the accepted Panel Runtime and compat matrix. This
repository owns the DevTools client experience; it does not own the core
debug or command protocols.

The canonical GitHub organization is
[bitty-terminal](https://github.com/bitty-terminal).

## Ownership boundary

This repository owns the DevTools client experience, including scoped
inspection, tracing, and control surfaces for local debugging. It does not
own the core debug or command protocols, terminal runtime behavior, or
normative public architecture.

Core protocol contracts belong to
[Bitty core](https://github.com/bitty-terminal/bitty) (`bitty-runtime`,
`bitty-ui`). Canonical architecture, security, compatibility, and public
behavior belong to
[bitty-docs](https://github.com/bitty-terminal/bitty-docs) (accepted
[DevTools RFC](https://github.com/bitty-terminal/bitty-docs/blob/main/docs/specifications/devtools-rfc.md)
OQ-019 and Performance Budgets OQ-001). Any future protocol change requires
coordinated, explicitly ordered work in each owning repository.

Any DevTools implementation consumes an explicitly versioned stable protocol
(`1.0` today, JSONL framing, 1 MiB inbound, 256 KiB chunk). It does not link
private core types or inspect process memory as an implicit API.

## Implemented phase 1 (CTX-0011)

Phase 1 is an experimental diagnostics client for local debugging
(`Implemented` at `21aca98` + CTX-0011, not yet `Verified`/`Compatible`,
no compatibility promise). It is bounded, `forbid(unsafe_code)` in Rust,
and strict TypeScript with no `any`.

- **Reuse Panel Runtime** — `PanelId`, `ViewId`, `TerminalId`,
  `WorkspaceId`, `Generation`, `PanelState`, `PanelType`, `EventTopic`,
  `BoundedPayload`, `Overlay` (4+1), `CommandRegistry` grammar, and
  bounded queues `64` / `1024` / `256 KiB` / `8192` / `2 MiB` plus
  `DropOldest` default mirror `bitty-runtime` `PanelRegistry` PR-1..PR-12
  and `bitty-ui` `panel.rs` verbatim. No PTY fd, GPU object, or window
  handle is held.

- **Reuse compat matrix** — 14 surfaces (`shell`, `tmux`, `nvim`, `fzf`,
  `htop`, `ssh`, `alt-screen`, `mouse`, `resize`, `OSC`, `clipboard`,
  `Kitty`, `IME`, `DPI`) across 4 terminals (`ghostty`, `kitty`,
  `wezterm`, `alacritty`) mirror `bitty-compat-lab` `matrix.rs`
  `14 × 4`, bounded corpus `≤8 KiB` / `≤4096` actions, deterministic
  `state_hash`, `<16 KiB` JSON artifact, headless without `winit`/`wgpu`.

- **Inspection (debug.inspect, default)** — read-only, scope-checked,
  `listPlugins`, `getPlugin`, `listSubscriptions`, `getBudgets`,
  `getQueueSnapshot`, `getSnapshot` (8 KiB truncated redacted preview),
  `listHandles`, `panelSummary`, `compatMatrixSummary`. Terminal output
  is untrusted observation data, never instructions.

- **Tracing (debug.trace, opt-in)** — per-consumer bounded queues with
  coalescing, batch `32` / `8 KiB`, chunk `256 KiB` to user-only storage
  (`0600` conceptual), `startTrace` / `stopTrace` / `streamEvents` /
  `fetchTraceChunk`, minimization by default, typed redaction, preview
  equals export byte-for-byte, `DropOldest` default, `DropNewest`
  alternative.

- **Control (debug.control, audited)** — `suspendHandler`,
  `resumePlugin`, `disposeGeneration`, each audited with caller identity,
  generation-owned, cannot bypass capability or budget gates, fail-closed
  transactional, affects only owning generation.

- **Client composition** — `DevtoolsClient` owns connection lifecycle
  (zero scopes on connect, `grantScope` / `revokeScope` per operation),
  bounded parsing/rendering/queues/traces/retention, `AbortSignal`
  cancellation, resource budgets, and `compatMatrixJson` bounded artifact.

No TCP listener, no ambient credential, no allow-all capability. Security
corpus `devtools-rfc` controls (P0-AC-013..026, T-09..T-11) are preserved
and tested with negative scope matrix tests.

## Implemented phase 2 (CTX-0012)

Phase 2 extends phase 1 with advanced tracing, control surfaces, and real
IPC socket/pipe peer-creds integration against the live Bitty runtime.
It remains experimental (no `Verified`/`Compatible` promise), bounded,
`forbid(unsafe_code)` in Rust, strict TypeScript with no `any`, and reuses
Panel Runtime + 14×4 compat matrix verbatim without new budget families.

- **Real IPC transport (live runtime)** — Unix socket under
  `$XDG_RUNTIME_DIR/bitty` mode `0700`/`0600` or Windows named pipe with
  current-user ACL, no TCP listener by default, peer credentials via
  `SO_PEERCRED` / `LOCAL_PEERCRED` / `GetNamedPipeClientProcessId`
  (headless-verified via `verifyPeerUid`, `verifyUnixEndpoint`,
  `verifyWindowsPipe`), re-checked per privileged action, `BITTY_SOCKET` /
  `BITTY_INSTANCE_ID` advisory only, `RC-9` `100/s` `200` burst `1 MiB`
  `16` conn (shed newest), `RC-10` `256 KiB` chunk, length-prefixed
  `256 KiB` frames + `1 MiB` devtools logical chunked at `256 KiB`,
  `Framer` bound `512 KiB`, `RateLimiter` deterministic via `nowMs`,
  headless `StdioTransportStub` / `IpcTransport` with `forwardTo` pipe
  simulation and `PeerCredentials` / `ChildToken` (`60s` TTL, `64` bound,
  PTY-fd only, never env).

- **Advanced tracing (debug.trace, opt-in)** — structured attributable
  events (`StructuredTraceEvent` with `sequence`, `owner`, `generation`),
  filtering by `kinds`/`owners` (bounded `32`), coalescing `budget` vs
  `none`, retention `4 MiB` / `5 min` / `4` traces, GC
  `gcExpiredTraces(nowMs)`, `startTraceWithFilter` with deterministic
  `wallClockMs`, export to `0600` spool with `preview==export`
  byte-for-byte, `DropOldest`/`DropNewest`, deterministic
  `streamFilteredEvents`.

- **Advanced control (debug.control, audited)** — `pauseHandler`,
  `resumePlugin` with generation exhaustion guard
  (`MAX_SAFE_INTEGER-1024`), `validateGeneration`, transactional audit log
  bounded `256` (`listAuditLog`, `clearAuditLog`), per-generation
  ownership, `0600` spool mode, never widens sibling authority, no
  capability/budget bypass.

- **Client integration** — `DevtoolsClient` now wraps `IpcTransport`
  (`connectWithTransport`, `connectLive(runtimeUid, peer, xdgDir,
instanceId)`, `isIpcConnected`, `getSocketPath`,
  `transportOutgoingLen`), re-verifies peer per `grantScope`,
  `revokeScope`, `startTrace`, `stopTrace`, `suspendHandler` etc.,
  exposes phase 2 tracing/control helpers
  (`startTraceWithFilter`, `streamFilteredEvents`,
  `appendStructuredEvent`, `getTraceRetention`, `gcExpiredTraces`,
  `exportTracePreview`, `pauseHandler`, `validateGeneration`,
  `listAuditLog`).

Rust counterpart at `crates/devtools-client` mirrors the same contracts:
`auth` (`PeerCredentials`, `verify_unix_endpoint`, `ChildTokenStore`),
`transport` (`Frame`, `Framer`, `RateLimiter`, `StdioTransportStub`,
`IpcTransport`), advanced `tracing` (`TraceFilter`, `TraceRetention`,
`TracingClient` with `gc_expired`), advanced `control`
(`ControlClient` with audit log). `cargo check` / `clippy -D warnings` /
`cargo test` `37` tests pass; `just check` green; `bun test` `62` tests
pass. No `unsafe`, no PTY/GPU/window handle, no TCP, no ambient credential.

## Usage (local, human-facing)

```ts
import { DevtoolsClient } from "bitty-devtools";
import { peerCredentials } from "bitty-devtools";
import { IpcTransport } from "bitty-devtools";

const client = new DevtoolsClient({ version: "1.0" });
client.connect();
client.grantScope("debug.inspect");

client.setPanelSnapshot({
  generation: 1 as never,
  panels: [],
  panelsPerWorkspace: new Map(),
  totalPanels: 0,
  topics: [],
  overlays: [],
  config: {
    maxPanelsPerWorkspace: 16,
    maxPanelsPerWindow: 32,
    maxTopicsTotal: 256,
    maxSubscriptionsPerPanel: 32,
  },
});

console.log(client.panelSummary());
console.log(client.compatMatrixSummary());

// Tracing is opt-in
client.grantScope("debug.trace");
const trace = client.startTrace({ maxBytes: 512 * 1024, includeInput: false });
client.appendToTrace(trace.traceId, "instrumentation record");
console.log(client.stopTrace(trace.traceId));

// Phase 2: live runtime via peer-creds (Unix socket 0600, no TCP)
const peer = peerCredentials(1000, 1000, 42);
const live = new IpcTransport({
  runtimeUid: 1000,
  socketPath: "/run/user/1000/bitty/default.sock",
  peer,
});
const liveClient = new DevtoolsClient();
liveClient.connectWithTransport(live);
liveClient.grantScope("debug.trace");
const filtered = liveClient.startTraceWithFilter(
  { filter: { kinds: ["bitty.panel:mounted"] }, maxBytes: 1024 * 1024 },
  Date.now(),
);
liveClient.appendStructuredEvent(filtered.traceId, {
  sequence: 0,
  owner: "panel-1",
  kind: "bitty.panel:mounted",
  payload: "{}",
  generation: 1,
  wallClockMs: Date.now(),
});
console.log(liveClient.exportTracePreview(filtered.traceId));
console.log(liveClient.gcExpiredTraces(Date.now() + 6 * 60 * 1000));

// Control requires explicit elevation and is audited
client.grantScope("debug.control");
client.suspendHandler(1 as never, "handler-1", "diagnosis", "tester");
console.log(client.listAuditLog());
```

Rust equivalent lives at `crates/devtools-client` (`forbid(unsafe_code)`,
`cargo check` / `cargo clippy -D warnings` clean, 37 tests).

## Development

Install with `bun install`. Quality gates run through the
repository `justfile`:

```text
just check          # fmt-check + lint + type-check + cargo-check
just fmt-check      # Prettier 3.9.6 check without writing files
just lint           # markdownlint-cli2 0.23.1
just type-check     # tsc --noEmit strict
just cargo-check    # cargo check + clippy -D warnings + cargo test
just commit-check <file>  # validate commit message against commitlint
```

Rust toolchain is `1.97.1` minimal (`rustfmt`, `clippy`) per
`rust-toolchain.toml`; MSRV `1.85`. The crate is `publish = false`.

Git hooks are wired by `lefthook.yml`; run `bunx --bun lefthook@2.1.10 install`
once after cloning.

## Documentation authority

Repository-local material explains contribution and ownership boundaries but
does not duplicate normative specifications. The current project-wide
technical record remains
[bitty-docs](https://github.com/bitty-terminal/bitty-docs).

## Current status

Phase 2 extends phase 1 with live IPC and advanced tracing/control as
experimental evidence for
[DevTools RFC](https://github.com/bitty-terminal/bitty-docs/blob/main/docs/specifications/devtools-rfc.md)
(OQ-019), [IPC and Agent RFC](https://github.com/bitty-terminal/bitty-docs/blob/main/docs/specifications/ipc-agent-rfc.md)
(OQ-018), and budgets OQ-001. No installation procedure, supported API,
compatibility guarantee, release, or distributable artifact is claimed until
independent review and `Verified` lifecycle.
