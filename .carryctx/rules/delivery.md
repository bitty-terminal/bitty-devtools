# Delivery rules

1. Begin with a GitHub Issue that states outcome, acceptance criteria, trust
   boundaries, affected repositories, and documentation impact.
2. Represent the work as a CarryCtx task with a team, required role,
   dependencies, explicit scopes, and a named owner.
3. Bind a named session before editing and record progress, blockers, risks,
   decisions, handoffs, and checkpoints durably.
4. After the first commit, create an isolated task worktree and branch. Do not
   share a checkout for parallel implementation.
5. In an unborn repository, initialization may use the shared checkout only
   when scopes are non-overlapping and local CI-equivalent checks are available.
6. Link protocol work in `bitty`, client work here, and canonical docs work in
   `bitty-docs` with explicit dependency and merge ordering.
7. Commits are focused and traceable. Pull requests include protocol versions,
   privacy/security impact, exact evidence, documentation, and residual risks.
8. A separate reviewer verifies the diff and CI before merge. Implementers stop
   at review and never self-accept.
9. After merge, synchronize docs, record the revision and checkpoint, complete
   the task, and close the Issue. Never mutate remotes without explicit authority.
