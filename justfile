# bitty-devtools quality commands

# Version pins live here only (one place per pin).
prettier_version := "3.9.6"
markdownlint_version := "0.23.1"

# Lint every Markdown file selected by .markdownlint-cli2.jsonc.
lint:
    bunx --bun markdownlint-cli2@{{markdownlint_version}}

# Check formatting without changing files.
fmt-check:
    bunx --bun prettier@{{prettier_version}} --check . --ignore-unknown

# Rust gates for the diagnostics client (bounded, forbid unsafe).
cargo-check:
    cargo fmt --check
    cargo check --workspace --all-targets --locked
    cargo clippy --workspace --all-targets --locked -- -D warnings
    cargo test --workspace --all-targets --locked

# TypeScript type check (strict, no any).
type-check:
    bunx --bun tsc -p tsconfig.json --noEmit

# TypeScript unit tests (bun:test, headless; no live socket or GUI).
test:
    bun test

# Validate a commit message against commitlint.config.ts.
# Versions are pinned in package.json / bun.lock; run `bun install` first.
commit-check message:
    bunx --bun commitlint --edit {{message}}

# Run the same logical gates as CI. All recipes are read-only.
check:
    just fmt-check
    just lint
    just type-check
    just test
    just cargo-check

# Publish a redacted CarryCtx snapshot inside this repo (commander merge
# closeout only; never a git hook). `carryctx export --publication` redacts the
# bundle, stamps manifest.redacted, and commits one snapshot to the fixed ref
# `refs/heads/carryctx-snapshots`; the target pushes that branch only when the
# local ref advanced (native carryctx commits one snapshot per export, so a
# re-run publishes again rather than no-opping). Canonical closeout runs from
# the primary checkout on branch main
# (`cd "$BITTY_WORKSPACE/bitty-devtools" && just workflow-publish`); a detached
# or feature worktree records that branch as the snapshot source. Dry run
# validates the export and writes neither the ref nor the remote.
workflow-publish *args:
    bash scripts/workflow-publish.sh {{args}}

workflow-publish-dry *args:
    bash scripts/workflow-publish.sh --dry-run {{args}}

# Restore the local CarryCtx DB from the in-repo snapshot branch
# `refs/heads/carryctx-snapshots` (fresh-clone recipe). Refuses to replace a
# non-empty local DB without --force, e.g. `just workflow-import --force`.
workflow-import *args:
    bash scripts/workflow-import.sh {{args}}

workflow-import-dry *args:
    bash scripts/workflow-import.sh --dry-run {{args}}
