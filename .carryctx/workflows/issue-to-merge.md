# Issue-to-merge workflow

## 1. Define the work

1. Create or confirm a GitHub Issue with outcome, acceptance criteria, protocol
   impact, privacy/security risk, repository impact, and documentation needs.
2. Create a CarryCtx task linked to the Issue. Assign its team, required role,
   owner, dependencies, and exact file scopes.
3. Check team context and scope conflicts. Split `bitty`, `bitty-devtools`, and
   `bitty-docs` work into linked tasks with explicit ordering.

## 2. Prepare execution

1. Start a named session bound to the task and adopt the assigned persona.
2. Read AGENTS, relevant rules, protocol contracts, canonical docs, prior
   decisions, and threat/risk records before editing.
3. After the first repository commit, create an isolated CarryCtx worktree and
   task branch. Record the branch and worktree in the task handoff.
4. If the repository is unborn, remain in the shared checkout. Work only in an
   explicit non-overlapping initialization scope; branch, commit, and pull
   request stages begin only after the initial commit exists and is authorized.

## 3. Implement and verify

1. Keep changes inside scope and record progress, decisions, risks, and blockers
   as they arise.
2. Preserve the protocol ownership boundary and synchronize public behavior,
   compatibility, privacy, and security changes with `bitty-docs`.
3. Run local checks equivalent to CI: formatting, language, links, protocol
   fixtures, negative security, privacy, accessibility, build, and hygiene as
   applicable.
4. Checkpoint at a meaningful boundary with changed files, target/protocol
   revisions, exact evidence, residual risks, and remaining dependencies.

## 4. Commit and request review

1. When explicitly authorized, create focused commits on the task branch and
   reference the Issue and CarryCtx task.
2. Open a pull request describing scope, protocol compatibility, authority and
   privacy effects, evidence, documentation, dependencies, and merge ordering.
3. Move the CarryCtx task to review and end the implementer session cleanly.
4. A separate reviewer inspects the diff, reruns relevant checks, records
   findings, and confirms CI. Privacy-sensitive work also requires the assigned
   privacy/security reviewer.

## 5. Merge and close

1. Resolve findings and ensure linked core and documentation pull requests are
   ready in the recorded order.
2. Merge only with required approval, passing CI, synchronized canonical docs,
   and explicit merge authority.
3. Record the merged revision, protocol compatibility evidence, release notes
   if applicable, and a final CarryCtx checkpoint.
4. Complete the CarryCtx task and close the GitHub Issue only after docs,
   migrations, compatibility notes, and follow-up ownership are current.
