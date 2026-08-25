# Bitty DevTools

Bitty DevTools is the planned home of Bitty's human-facing diagnostics and
debugging client. This repository is pre-implementation and has no initial
commit or product release.

The canonical GitHub organization is
[bitty-terminal](https://github.com/bitty-terminal).

## Ownership boundary

This repository may eventually own the DevTools client experience, including
carefully scoped inspection, tracing, and control surfaces. It does not own the
core debug or command protocols, terminal runtime behavior, or normative public
architecture.

Core protocol contracts belong to the future
[Bitty core repository](https://github.com/bitty-terminal/bitty). Canonical
architecture, security, compatibility, and public behavior belong to
[bitty-docs](https://github.com/bitty-terminal/bitty-docs). Changes that cross
those boundaries require coordinated, explicitly ordered work in each owning
repository.

Any future DevTools implementation must consume an explicitly versioned stable
protocol. It must not treat private core types, process memory, or incidental
runtime details as an API.

## Current status

Only repository governance and planning foundations exist. There is currently:

- no DevTools client or user interface;
- no diagnostics panel, trace viewer, or control surface;
- no implemented or published debug protocol;
- no installation procedure or supported API;
- no compatibility guarantee, release, or distributable artifact.

Repository contents must not be interpreted as evidence of implemented product
behavior. Future claims require working code, tests, canonical documentation,
and independent review under a scoped delivery task.

## Documentation authority

Repository-local material may explain contribution and ownership boundaries,
but it must not duplicate normative specifications. The current project-wide
technical record remains [bitty-docs](https://github.com/bitty-terminal/bitty-docs).
