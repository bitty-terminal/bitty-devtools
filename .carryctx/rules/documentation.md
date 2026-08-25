# Documentation rules

1. Write repository documentation and user-facing diagnostic text in English.
2. Core debug and command protocol contracts belong to `bitty`; architecture,
   security, compatibility, and public behavior belong to `bitty-docs`.
3. Do not copy normative specifications into this repository or present a
   generated client type as the authoritative protocol definition.
4. Preserve accepted, candidate, normative, unimplemented, deprecated, and
   compatibility status in user-facing material.
5. Protocol, capability, panel, capture, export, privacy, and troubleshooting
   changes update affected canonical docs before task closure.
6. Cross-repository pull requests link each other and state merge ordering,
   protocol revisions, compatibility windows, and migration behavior.
7. README and AGENTS guidance must remain portable; do not add links to local or
   machine-specific filesystem paths.
8. Never claim a client, protocol, panel, test, release, or integration exists
   without current evidence.
