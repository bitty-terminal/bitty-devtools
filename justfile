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

# Validate a commit message against commitlint.config.ts.
# Versions are pinned in package.json / bun.lock; run `bun install` first.
commit-check message:
    bunx --bun commitlint --edit {{message}}

# Run the same logical gates as CI. All recipes are read-only.
check:
    just fmt-check
    just lint
    just type-check
    just cargo-check
