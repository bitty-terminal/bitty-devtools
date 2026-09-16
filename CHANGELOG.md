# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to no released version yet.

## [Unreleased]

### Added

- **Test-automation drivers (CTX-0024, candidate)**: typed, fail-closed client
  bindings in `src/automation.ts` for `bitty.debug/synthesizeInput`,
  `bitty.debug/captureFrame`, and `bitty.debug/frameHash` — the headless
  input/frame drivers that replace manual visual acceptance for GUI, mouse,
  and split integration testing. Bounded keyboard `keyDown`/`keyUp` and mouse
  `clickTrajectory`/`dragTrajectory` builders (`64` points, `30 s` declared
  duration) are validated before dispatch; per-call bounds are `64` events,
  `32 KiB` request/response, `16 KiB` paste, and `64 MiB` digest RGBA geometry,
  with `pixels` capture gated on explicit opt-in. Each call requires the debug
  scope plus the terminal capability scope (`debug.control` + `terminal.input`
  or `debug.trace` + `terminal.inspect`) and a consent-issued bearer;
  connection alone grants nothing. An unregistered method maps to a typed
  `UnknownMethod`, a `pixels` response that smuggles a payload is rejected, and
  no live data is fabricated. Verified against the `bitty` dispatcher
  `crates/bitty-ipc/src/devtools.rs` (CTX-0188/CTX-0244); the accepted
  `devtools-rfc` does not yet name these methods (naming gap reported).

- **Live introspection bindings (CTX-0023 / #41)**: typed devtools client
  bindings for the CTX-0159 read-only RPCs `bitty.debug/getGridText`,
  `bitty.debug/getInputRing`, `bitty.debug/getModifiers`, and
  `bitty.debug/getFocus`. `DevtoolsClient.getGridText({ rows?, cols? })`,
  `getInputRing({ limit? })`, `getModifiers()`, and `getFocus()` dispatch over
  the connected `IpcTransport`, validate optional filters client-side to the
  server bounds (rows/cols `64`/`256`, limit `64`), and parse strictly against
  the live server envelope (fail-closed on missing, mistyped, unknown, or
  extra fields; bounded `lines`/`events`). Input `kind`/`label`/`button` are
  bounded to the server's emitted `truncate_chars` shape (`cap + "..."`:
  `19`/`67`/`19`), not the pre-ellipsis cap. Read-only `debug.inspect`; the
  four methods are added to the inspect scope allowlist. "Unknown field"
  rejection is enforced as an explicit version-guarded v1.0 policy per the
  issue's strict-envelope requirement.

- **Diagnostics client phase 2 (CTX-0012)**: advanced tracing, control
  surfaces, and real IPC socket/pipe peer-creds integration against the live
  Bitty runtime. Reuses Panel Runtime and 14×4 compat matrix and extends
  phase 1; bounded and `forbid(unsafe_code)`; strict TypeScript with no `any`.
  Includes headless-testable `auth` (Unix `SO_PEERCRED` / Windows pipe ACL,
  `0700`/`0600`, per-action re-verify, `BITTY_SOCKET` advisory, child token
  `60s` bounded `64`) and `transport` (length-prefixed `256 KiB` frames,
  `1 MiB` devtools logical, `RC-9` `100/s` `200` burst `16` conn, `RC-10`
  `256 KiB` chunk, `Framer` `512 KiB` bound, `RateLimiter` deterministic,
  `StdioTransportStub` + `IpcTransport` with `forwardTo` pipe simulation);
  advanced `tracing` (filtering by kinds/owners `32`, coalescing `budget`,
  structured attributable events, retention `4 MiB`/`5 min`/`4` traces,
  GC `gcExpiredTraces`, chunked `256 KiB` export `0600` preview==export);
  advanced `control` (pause/resume, generation exhaustion guard
  `MAX_SAFE_INTEGER-1024`, transactional audit log `256` bounded,
  `validateGeneration`, `listAuditLog`); client `DevtoolsClient` now
  integrates `IpcTransport` (`connectWithTransport`, `connectLive` with
  `XDG_RUNTIME_DIR` socket `0700`/`0600`, `isIpcConnected`,
  per-privileged peer re-verify). TypeScript `62` tests and Rust
  `37` tests pass; `just check` green.

- **Diagnostics client phase 1 (CTX-0011)**: human-facing inspection,
  tracing, and control surfaces for local debugging over the accepted Panel
  Runtime and 14×4 compat matrix. Reuses Panel Runtime and compat matrix;
  no core protocol ownership; bounded (`64` / `1024` / `256 KiB` / `8192` /
  `2 MiB`, `8 KiB` payload, `32` / `8 KiB` batch, `1 MiB` frame,
  `256 KiB` chunk) and `forbid(unsafe_code)`. Includes TypeScript
  `DevtoolsClient` (`src/`) and Rust `bitty-devtools-client`
  (`crates/devtools-client`) with scope matrix (`debug.inspect` default,
  `debug.trace` opt-in, `debug.control` audited) and versioned debug
  protocol `1.0`.

- **Toolchain pin (CTX-0046)**: pin `packageManager` to `bun@1.4.2` in
  `package.json`, matching the workspace toolchain. `bun.lock` is unchanged
  (`bun install --frozen-lockfile` passes). CI still installs Bun `1.4.0`
  via `bun-version` (drift noted; workflow untouched by this slice).

- **Governance scaffolding**: MIT [LICENSE](./LICENSE), contribution guide
  ([CONTRIBUTING.md](./CONTRIBUTING.md)) with the Bitty delivery lifecycle and
  Conventional Commits expectation, security policy
  ([SECURITY.md](./SECURITY.md)) with private vulnerability reporting, Keep a
  Changelog entries, commitlint configuration
  ([commitlint.config.ts](./commitlint.config.ts)), and markdownlint-cli2
  configuration ([.markdownlint-cli2.jsonc](./.markdownlint-cli2.jsonc)).
