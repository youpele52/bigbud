# Local Authority And Remote Workspace Agent Boundary

**Status:** Accepted; extended by the unified workspace watcher implementation

**Date:** 22 August, 2026

## Decision

bigbud keeps product authority in the local TypeScript server. Providers,
provider credentials and sessions, threads, messages, approvals, orchestration
events, and canonical SQLite state never move to the Rust remote workspace
agent.

The agent is a provider-neutral systems backend. It may execute bounded
workspace filesystem, search, Git, process, PTY, watch, and platform operations
on the SSH host, but it does not interpret provider protocols or own bigbud
domain state. The initial TypeScript integration is a transport-neutral
`WorkspaceRuntime` façade composed from focused capability contracts.

The existing direct-SSH implementation remains the bootstrap and fallback path
until an agent operation has been accepted and the relevant parity and
reliability gates have passed. A transport interruption is not cancellation.
After acceptance, the local server reports the agent's known, expired, or
unknown outcome instead of silently retrying through direct SSH.

## Security and confinement

- File and search APIs receive a validated workspace-root handle and
  workspace-relative paths. They reject NUL bytes, absolute paths, lexical
  traversal, and symlink-assisted escapes according to the remote platform's
  path semantics.
- Unrestricted shell execution is a separate capability and is never treated
  as root-confined file access.
- The agent uses the existing verified OpenSSH target and credentials. It does
  not replace host-key checking, forward local provider credentials, or expose
  an inbound network listener.
- Temporary remote operation metadata and unacknowledged output are delivery
  state only. They are bounded, user-owned, and disposable; they are not a
  remote project, thread, message, or provider database.
- Diagnostics and rollout measurements omit file contents, command input and
  output, environment secrets, paths where practical, and provider
  credentials.

## Initial capability and retry classification

| Capability                                                       | Initial classification                                          | Disconnect behavior                                                                      |
| ---------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Text preview, directory listing, filename search, content search | Retryable read                                                  | Reconnect may retry or resume within explicit bounds; no mutation is inferred.           |
| File writes                                                      | Idempotency requires an operation identity and expected version | Not routed through the agent until atomicity, replay, and uncertain outcomes are tested. |
| Git reads                                                        | Retryable read                                                  | Reconnect may retry after capability negotiation.                                        |
| Git mutations, commits, pushes, checkouts, worktree changes      | Non-repeatable or operation-specific mutation                   | Never automatically rerun after an ambiguous acceptance.                                 |
| Process spawn and PTY input                                      | Deduplicated spawn or streaming attachment                      | Require stable operation/input sequences before agent routing.                           |
| Watch events                                                     | Lossy invalidation stream                                       | Gaps or reconnects require `RESCAN_REQUIRED`; events are not canonical state.            |

The initial local runtime contracts preserve the existing public workspace
inputs, outputs, bounds, and typed errors. They deliberately do not add a
remote transport type to WebSocket handlers or provider adapters.

## Connection states

The eventual agent lifecycle exposes these user-facing states:

`unavailable`, `installing`, `connecting`, `ready`, `reconnecting`,
`degraded`, `authentication required`, `incompatible`, and `failed`.

Phase 1 does not change UI state or attempt installation. It proves that local
read surfaces can use the same narrow runtime boundary that a later remote
backend will implement.

## Consequences

This kept the first implementation small and reversible. Workspace watching is
now the first shared local/remote systems slice: one ephemeral local agent and
managed remote agents use the protocol-neutral `bigbud-workspace-watch` crate.
TypeScript still owns authorization, supervision, routing, and product state;
the change does not move local files, search, Git, processes, or PTYs into Rust.
