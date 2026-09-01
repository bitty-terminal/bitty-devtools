# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to no released version yet.

## [Unreleased]

### Added

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
