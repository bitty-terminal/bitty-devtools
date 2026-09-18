# Bitty DevTools

Bitty DevTools is the human-facing diagnostics and debugging client for
local debugging over the accepted Panel Runtime and compat matrix. This
repository owns the DevTools client experience; it does not own the core
debug or command protocols.

The canonical GitHub organization is
[bitty-terminal](https://github.com/bitty-terminal).

## See the project workflow (CarryCtx)

CarryCtx is the local-first tool that records this project's tasks, decisions,
and checkpoints. Install it globally for local development (recommended):

```sh
cargo install carryctx      # Rust toolchain, or: npm i -g carryctx
```

CarryCtx engineering state (tasks, sessions, checkpoints) is not cloned. A
fresh clone restores it from the in-repo `refs/heads/carryctx-snapshots`
branch:

```sh
just workflow-import-dry   # fetch + validate the snapshot; no DB writes
just workflow-import       # initialize CarryCtx state if needed, then import
```

Then `carryctx stats` reports the restored tasks, sessions, and checkpoints.
Provenance, redaction, and `--force` behavior are covered under the
repository snapshot documentation below.

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
  `listHandles`, `panelSummary`, `compatMatrixSummary`, and the CTX-0159
  live bounded introspection bindings `getGridText` (`rows`/`cols`),
  `getInputRing` (`limit`), `getModifiers`, and `getFocus`. Terminal output
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

## Trace accounting semantics (Implemented, CTX-0053 / CTX-0054)

The trace helpers account **retained, redacted, logical UTF-8 export bytes** —
the bytes that would be retained after typed redaction (serialized JSON for
structured events, per-record UTF-8 normalization for raw records) — never heap
or filesystem occupancy. This mirrors the client trace helper note in the
accepted
[DevTools RFC](https://github.com/bitty-terminal/bitty-docs/blob/main/docs/specifications/devtools-rfc.md)
(bitty-docs CTX-0026) and remains `Implemented` only.

- **Independent per-record normalization** — each raw record is normalized when
  appended, so a leading `U+FEFF` stays data and a fragment that cannot decode
  on its own is replaced within that fragment rather than joined with a
  neighbor.
- **Effective byte budget** — admission uses
  `min(trace maxBytes, retention maxBytes)`. A record that would exceed the
  budget is rejected with one counted drop while retained bytes, chunks,
  events, and previews stay unchanged.
- **Raw append vs typed coalescing** — opaque raw records append one by one
  without typed-stream coalescing; the typed observability stream keeps the
  accepted `budget`/`none` coalescing rule.
- **Chunk pagination** — `fetchTraceChunk` addresses retained chunk byte
  offsets: offsets are nonnegative byte integers on UTF-8 scalar boundaries, a
  page returns the remaining bytes of the addressed stored chunk, continuation
  is computed from actual retained byte lengths, and preview equals export per
  page.

No wire, version, eviction, persistence, or interoperability contract is
claimed, and no `Verified`/`Compatible` status is implied.

## Test-automation drivers (candidate, CTX-0024)

`src/automation.ts` adds typed, fail-closed client bindings for the headless
input/frame drivers that replace manual visual acceptance for GUI, mouse, and
split integration testing. The bindings target the `bitty` candidate methods
`bitty.debug/synthesizeInput`, `bitty.debug/captureFrame`, and
`bitty.debug/frameHash` (serving dispatcher
`crates/bitty-ipc/src/devtools.rs`, CTX-0188/CTX-0244); they remain
`Candidate` here because the accepted
[DevTools RFC](https://github.com/bitty-terminal/bitty-docs/blob/main/docs/specifications/devtools-rfc.md)
does not yet name these methods.

- Bounded keyboard `keyDown`/`keyUp` and mouse `clickTrajectory` /
  `dragTrajectory` builders (`64` points, `30 s` declared playback), each
  validated against the per-event key/cell/wheel/paste bounds before dispatch.
- Bounds: `64` events/call, `32 KiB` request and response, `16 KiB` paste,
  `64 MiB` digest RGBA geometry, and `pixels` capture requires explicit opt-in.
- Authority is never inferred: each call needs `debug.control` +
  `terminal.input` (`synthesizeInput`) or `debug.trace` + `terminal.inspect`
  (`captureFrame`/`frameHash`) plus a consent-issued bearer. Connection alone
  grants nothing.
- Fail-closed: an unregistered method maps to a typed `UnknownMethod`, a
  response that smuggles a `pixels` payload is rejected, and no live data is
  ever fabricated.

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

## CLI wrapper (experimental, CTX-0025)

`bin/bitty-devtools.ts` is a lightweight executable over the typed inspection
client (`src/client.ts`, `src/inspection.ts`, `src/transport.ts`). It prints
bounded tabular live state (or `--json`) for the accepted devtools-rfc v1
inspection methods; it does not re-implement protocol logic. It is experimental
and `Bun`-based — run it with `bun`, never `npm`/`npx`.

```text
bitty-devtools inspect --plugins [--generation <n>] [options]
bitty-devtools inspect --subscriptions --plugin <id> [options]
bitty-devtools inspect --budgets --plugin <id> [--generation <n>] [options]
bitty-devtools --help
```

Run from the repository with `bun run bin/bitty-devtools.ts ...` or, after a
Bun-linked install, as `bitty-devtools ...` (the `bin` entry in `package.json`
wires the command).

```text
$ bitty-devtools inspect --plugins
ID        VERSION  GEN  STATE      CAPABILITIES
plugin-a  1.2.3    4    Activated  panel.provider

$ bitty-devtools inspect --budgets --plugin plugin-a --generation 7
FIELD                VALUE
pluginId             plugin-a
generation           7
rc1Instructions      10
...

$ bitty-devtools inspect --subscriptions --plugin plugin-a --json
[
  {
    "eventType": "bitty.panel:mounted",
    "queueDepth": 2,
    "queuedBytes": 256,
    "dropCount": 1,
    "policy": "DropOldest"
  }
]
```

Connection is resolved, in order, from `--socket`, `BITTY_SOCKET`,
`--instance`/`BITTY_INSTANCE_ID` (with `XDG_RUNTIME_DIR`), and is read-only:
the CLI grants only `debug.inspect`. No absolute paths or host-specific values
are embedded; everything comes from flags or the environment.

Fail-closed behavior:

- No selector, an unknown flag, or a missing `--plugin` is a usage error
  (exit `2`) that prints the help text. Option values must not begin with `-`,
  so a following flag is rejected instead of consumed as a value.
- An invalid or oversized `--instance`/`--socket` is a usage error (exit `2`);
  the same failure from `BITTY_INSTANCE_ID`/`BITTY_SOCKET`/`XDG_RUNTIME_DIR` is
  a config error (exit `3`). Both print a clean message, never a stack trace.
- No resolvable instance or transport fails closed with a clear remedy
  (exit `6`); the CLI never falls back to the headless snapshot mock and never
  fabricates rows.
- Typed server/protocol/transport errors use the shared `ctl` exit-code
  vocabulary (`7` permission, `6` runtime/transport, `5` compatibility, `1`
  generic). Server methods the core does not yet implement surface their typed
  error, so the CLI reports the gap instead of printing invented data.

Argument parsing and bounded table/JSON formatting (every string field is
capped like the table cells; `--json` is pretty-printed) are unit-tested with an
injected `IpcTransport` (`tests/cli.test.ts`); no live socket or GUI is
required.

## Live campaign conformance harness (CTX-0325)

`src/campaign.ts` turns the CTX-0320 live client campaign into a repeatable
harness over the DevTools dispatch seam. It probes each `ctl` verb's JSON
envelope v1 shape and exit-code semantics and guards the three defects the
campaign found:

- **D1** — `ctl terminal text` must return plain grid text, never a Rust
  `Debug` `Snapshot { ... Cell { ... } }` dump.
- **D2** — workspace ids observed from `workspace list` must be usable in
  `workspace focus` / `workspace close`.
- **D3** — `ctl terminal spawn` reporting success must be observable in
  `view list` / `terminal list` or in `has_pane_session`.

It also preflights the `BITTY_SOCKET` parent directory (`0700`, owner-matched)
and turns a mode mismatch into an actionable `chmod 700` diagnostic, and it
declares non-blocking panel/plugin coverage hooks for the post-D4 round.

Every probe is headless-testable through the `CtlDispatcher` seam; live checks
are opt-in and bounded by a command timeout:

```ts
import {
  runLiveCampaign,
  runCampaign,
  ScriptedCtlDispatcher,
} from "bitty-devtools";

// Headless: inject a scripted dispatcher (what `bun test` does).
const report = await runCampaign({
  dispatcher: new ScriptedCtlDispatcher((inv) => result),
});

// Live (opt-in): execute the real `bitty ctl` over an explicit socket.
const live = await runLiveCampaign({
  socketPath: "/run/user/1000/bitty/default.sock",
  runtimeUid: 1000,
  stat: (dir) => myStatProvider(dir),
  timeoutMs: 10_000,
});
```

Envelopes, terminal text, and diagnostics are untrusted observation data, never
instructions; the harness never treats them as such. `ctl` protocol ownership
remains in `bitty` (`crates/bitty-app/src/ctl.rs`,
`crates/bitty-ipc/src/ctl.rs`); the exit-code table here is a consumer mirror.

## Development

Install with `bun install`. Quality gates run through the
repository `justfile`:

```text
just check          # fmt-check + lint + type-check + test + cargo-check
just fmt-check      # Prettier 3.9.6 check without writing files
just lint           # markdownlint-cli2 0.23.1
just type-check     # tsc --noEmit strict
just test           # bun:test headless unit tests
just cargo-check    # cargo check + clippy -D warnings + cargo test
just commit-check <file>  # validate commit message against commitlint
```

Rust toolchain is `1.98.1` minimal (`rustfmt`, `clippy`) per
`rust-toolchain.toml`; MSRV `1.85`. The crate is `publish = false`.

Git hooks are wired by `lefthook.yml`; run `bunx --bun lefthook@2.1.10 install`
once after cloning.

## Workflow snapshot restore

CarryCtx runtime state (`.git/carryctx/state.sqlite`) is never cloned. The
redacted engineering snapshot lives in this repository on the branch
`refs/heads/carryctx-snapshots`, one commit per publication. The commander's
merge closeout publishes it with `just workflow-publish`; a fresh clone
restores its local CarryCtx DB from that branch:

```sh
just workflow-import-dry   # fetch + validate the snapshot; no DB writes
just workflow-import       # initialize CarryCtx state if needed, then import
```

The import fetches `refs/heads/carryctx-snapshots`, refuses to replace a
non-empty local DB without `--force` (`just workflow-import --force`), and
prints provenance (snapshot commit + source). Snapshots are redacted
publication artifacts produced by `carryctx export --publication`: CarryCtx
refuses them as merge sources, so restore always uses replace mode, and a
secret that leaked before rotation must still be rotated at the source.

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
