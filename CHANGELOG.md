# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to no released version yet.

## [Unreleased]

### Added

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

- **Governance scaffolding**: MIT [LICENSE](./LICENSE), contribution guide
  ([CONTRIBUTING.md](./CONTRIBUTING.md)) with the Bitty delivery lifecycle and
  Conventional Commits expectation, security policy
  ([SECURITY.md](./SECURITY.md)) with private vulnerability reporting, Keep a
  Changelog entries, commitlint configuration
  ([commitlint.config.ts](./commitlint.config.ts)), and markdownlint-cli2
  configuration ([.markdownlint-cli2.jsonc](./.markdownlint-cli2.jsonc)).
