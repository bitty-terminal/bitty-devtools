# Contributing

Thank you for your interest in contributing to Bitty DevTools.

This repository is pre-implementation: only governance and planning
foundations exist. There is no client, protocol, panel, release, or supported
API yet. Contributions at this stage establish and maintain repository
governance, planning material, and, once initialization is authorized, the
project toolchain. See [AGENTS.md](./AGENTS.md) for repository scope,
ownership boundaries, security expectations, and agent workflow rules before
making any change.

## Development setup

Install dependencies once with `bun install`. Quality gates run through the
repository [justfile](./justfile), following the Bitty workspace toolchain
policy:

```text
just check                  # formatting check plus Markdown lint (read-only)
just fmt-check              # Prettier check without writing files
just lint                   # markdownlint-cli2 over .markdownlint-cli2.jsonc globs
just commit-check <file>    # validate a commit message against commitlint.config.ts
```

Git hooks are wired by [lefthook.yml](./lefthook.yml); run `lefthook install`
once after cloning. Commits are message-linted, and staged Markdown changes
are linted and format-checked before each commit. Continuous integration runs
`just check` and actionlint on every push and pull request. Keep Markdown
changes consistent with [.markdownlint-cli2.jsonc](./.markdownlint-cli2.jsonc).

## Committing

Commits follow [Conventional Commits](https://www.conventionalcommits.org/).
Commit messages are validated with commitlint against
[commitlint.config.ts](./commitlint.config.ts); enforcement requires the Git
hooks from the development setup above.

```text
feat(panel): add trace timeline prototype
fix(export): redact typed sensitive fields in previews
docs(readme): clarify ownership boundary
chore(governance): add security policy
```

## Delivery lifecycle

All changes follow the Bitty delivery lifecycle:

1. GitHub Issue describing outcome, acceptance criteria, trust boundaries, and
   documentation impact.
2. CarryCtx task with team, required role, dependencies, owner, and explicit
   file scopes.
3. Task branch (and isolated worktree once the initial commit exists).
4. Focused, traceable commits referencing the Issue and task.
5. Pull request with evidence, privacy/security impact, and linked work.
6. Independent review plus required CI; implementers stop at review.
7. Merge, documentation synchronization, Issue closure, and final task
   checkpoint.

Do not commit, push, or merge without explicit authorization from the owning
task. Never commit traces, captures, dumps, credentials, or machine-local
configuration.

### Branch and worktree naming

Task branches follow `ctx-XXXX/<type>-<short-slug>`: `XXXX` is the owning
CarryCtx task number, `<type>` is one of `feat|fix|chore|docs`, and
`<short-slug>` is kebab-case (for example `ctx-0031/feat-isolation-rfc`).
Worktrees live at `.worktrees/ctx-XXXX-<type>-<short-slug>`, mapping `/` to
`-`. Use one branch per task; commander housekeeping may use `cmd/<slug>`.

## Security

Report vulnerabilities privately as described in
[SECURITY.md](./SECURITY.md). Do not open public issues for security
vulnerabilities.
