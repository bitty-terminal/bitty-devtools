# Security and privacy rules

1. Treat IPC peers, protocol payloads, terminal text, traces, captures, files,
   plugins, projects, and imported diagnostics as untrusted.
2. Authenticate the peer and enforce per-operation scope. Inspect access does
   not imply trace or control access, and connection grants no authority.
3. Label terminal output as untrusted observation data and keep it separate
   from instructions, policy, filesystem authority, and network authority.
4. Minimize collection by default. Input is opt-in; sensitive fields are typed
   and redacted; local artifacts use user-only permissions; exports show a
   preview before transmission.
5. Bound parsing, nesting, frame size, queues, retention, rendering, images,
   decompression, and request rates. Malformed input must fail safely.
6. Never commit traces, dumps, recordings, local databases, credentials,
   environment data, or target-specific secrets.
7. Pin dependencies and actions, review supply-chain changes, and keep
   pull-request workflows read-only with no secrets for untrusted forks.
8. A changed trust boundary requires threat/risk documentation, negative tests,
   and independent privacy/security review before merge.
