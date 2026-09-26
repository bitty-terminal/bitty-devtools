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
  surfaces, and a Linux-only endpoint-attested Unix-socket inspection adapter.
  The adapter verifies the socket path, parent directory, endpoint ownership,
  and modes before dialing, but does not authenticate a connected peer; live
  sessions are therefore inspect-only. Windows named-pipe and macOS live
  adapters are not implemented and fail closed. The client also retains a
  headless transport/authentication fixture for caller-supplied values and
  deterministic tests, not OS connectivity. Reuses Panel Runtime and the
  14×4 compat matrix; bounded and `forbid(unsafe_code)` in Rust, strict
  TypeScript with no `any`. `BITTY_SOCKET` and `BITTY_INSTANCE_ID` select a
  bounded path but are not credentials or identity. Advanced tracing and
  control remain simulation/test surfaces until a server-backed trace receipt
  and connected-identity control contract exist.

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
  `package.json`, matching the workspace toolchain. `bun.lock` is synchronized
  with the declared dependencies; `bun install --frozen-lockfile --dry-run`
  passes.
- **CI Bun version (CTX-0047)**: pin CI to Bun `1.4.2` and use
  `bun install --frozen-lockfile` in the quality and platform jobs.

- **Governance scaffolding**: MIT [LICENSE](./LICENSE), contribution guide
  ([CONTRIBUTING.md](./CONTRIBUTING.md)) with the Bitty delivery lifecycle and
  Conventional Commits expectation, security policy
  ([SECURITY.md](./SECURITY.md)) with private vulnerability reporting, Keep a
  Changelog entries, commitlint configuration
  ([commitlint.config.ts](./commitlint.config.ts)), and markdownlint-cli2
  configuration ([.markdownlint-cli2.jsonc](./.markdownlint-cli2.jsonc)).

### Changed

- **Trace accounting semantics documentation (CTX-0075, docs-only)**: README
  now records the trace-helper semantics already implemented by CTX-0053/#117
  and CTX-0054/#119 and clarified in `bitty-terminal-docs`
  `specifications/devtools-rfc.md` (CTX-0026): retained redacted logical UTF-8
  export-byte accounting (not heap/filesystem occupancy), independent
  per-record normalization with a leading `U+FEFF` preserved as data, effective
  `min(trace maxBytes, retention maxBytes)` rejection with one counted drop and
  unchanged retained state, opaque raw append distinct from typed stream
  coalescing, and `fetchTraceChunk` pagination on retained UTF-8 byte offsets.
  No code behavior changed.

### Fixed

- **Platform, version, and quality contracts (CTX-0080 / #141)**: the live
  inspection path is now described as the code implements it. The live adapter
  is Linux-only and attests the endpoint (socket path, parent directory,
  ownership, and modes) before dialing; it does not authenticate a connected
  peer, so live sessions stay inspect-only and `authenticated: false` is
  reported. Windows and macOS return an explicit unsupported result and never
  reach endpoint access. Unsupported live protocol versions and methods are
  rejected with typed fail-closed errors before socket I/O, owned by
  `src/protocol-boundary.ts` (live request admission only; `src/protocol.ts`
  decoding stays with CTX-0079). `BITTY_SOCKET` and `BITTY_INSTANCE_ID` remain
  bounded path selectors and are never credentials or identity, and no runtime
  UID environment variable is read. CodeQL activates the checked-in
  `.github/codeql/codeql-config.yml` for the combined `javascript-typescript,
actions` analysis and adds a separate Rust analysis with
  `build-mode: autobuild`; the combined job keeps its exact name because branch
  protection on `main` requires the status context
  `Analyze (javascript-typescript, actions)`, now mirrored in
  `.github/required-status-checks.txt` and asserted by
  `tests/platform-contract.test.ts`. CI installs locked dependencies before the
  quality and platform jobs, runs the offline platform contract on Linux, macOS,
  and Windows, and pins the actionlint image by digest; Dependabot covers the
  Cargo workspace. The `workflow-import` fixture suite derives its per-test
  deadline from the fixture spawn budget, because Bun's 5 s per-test default is
  shorter than one fixture run and so reported correct runs as timeouts under
  load; `tests/workflow-import-budget.test.ts` fails if the two budgets cross
  again. No `Verified` or `Compatible` platform status is claimed, and no
  interoperability, release, or distribution claim is made.
