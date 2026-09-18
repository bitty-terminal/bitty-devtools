# Framer fuzz-smoke corpus

Checked-in benign seeds for CTX-0074, issue
`bitty-terminal/bitty-devtools#124`, design CTX-0070 PX-0320/PX-0321.

## Targets

- T1 `Framer.pushBytes` in TypeScript (`src/transport.ts`) and Rust
  (`crates/devtools-client/src/transport.rs`): split, coalesced, and
  adversarial-length inputs.
- T2 encode/decode round-trip in both languages.
- T3 `chunkText`/`chunk_text` boundary parity on multibyte splits.
- T4 `IpcTransport` 1 MiB chunking plus the inbound `failFraming` model on
  mock bytes only. Live sockets, peer credentials, and wall-clock
  rate-limit timing stay out of scope.

## Layout

- `framer-seeds/vectors.json`: the shared differential oracle. Both suites
  assert the same accept/reject dispositions, frame bytes, chunk splits, and
  `manifestVersion`. Large vectors are described by size and fill byte, then
  built in memory by the tests; they are never stored on disk.
- `framer-seeds/*.bin`: tiny benign payloads (empty, hello, emoji, CJK,
  combining mark) consumed by both suites.
- `crates/devtools-client/tests/fixtures/fuzz/framer-seeds/`: byte-identical
  Rust-side mirror. CI rejects drift with `diff -r`; mirrors move together
  behind a `manifestVersion` bump, never by silent divergence.
- Generated corpora, if any, belong under gitignored `recording/fuzz/` and
  are never committed.

## Budgets

- Local smoke: 60 s per target, 256 MiB resident cap, single-threaded,
  fully deterministic (fixed sizes and splits, no randomness).
- CI smoke: 5 min total, 1 GiB, single-threaded (`--test-threads=1`),
  pinned engines (Bun 1.4.2, Rust 1.98.1), `--locked`/`--offline` with no
  `bunx`, `cargo-install`, or runtime installs.

## Core property

P0 fail-closed with zero partial state: an oversize declaration or an
over-buffer push emits zero frames, clears the buffer (`isEmpty` true,
`buffered_len` 0), leaves queue and drop counters unchanged, and the next
valid push decodes cleanly. Truncated input emits zero frames while the tail
stays retained and bounded.
