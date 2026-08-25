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

No build toolchain is wired up yet. When toolchain scaffolding lands, quality
gates will run through the repository `justfile` (formatting, linting,
Markdown hygiene, and tests) rather than through ad-hoc commands, following
the Bitty workspace toolchain policy. Until then, keep Markdown changes
consistent with [.markdownlint-cli2.jsonc](./.markdownlint-cli2.jsonc).

## Committing

Commits follow [Conventional Commits](https://www.conventionalcommits.org/).
Commit messages are validated with commitlint against
[commitlint.config.ts](./commitlint.config.ts):

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

## Security

Report vulnerabilities privately as described in
[SECURITY.md](./SECURITY.md). Do not open public issues for security
vulnerabilities.
