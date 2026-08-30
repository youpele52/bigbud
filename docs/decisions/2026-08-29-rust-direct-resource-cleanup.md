# Rust Direct Resource Cleanup Executor

## Status

Accepted and implemented.

## Decision

Normal deletion of six plain managed resource kinds uses a dedicated,
short-lived `bigbud-remote-agent --resource-cleanup` process. The kinds are
thread attachments, provider logs, terminal history, project memory, project
notes, and project kanban data.

TypeScript remains the canonical authority. It owns deletion eligibility,
runtime teardown, SQLite, immutable plans and proof snapshots, retries, and
product outcomes. Rust receives only a bounded, already-authorized page and
returns a typed result for each resource. Managed worktrees, checkpoints,
canonical history, and legacy purge recovery remain TypeScript-owned.

There is no TypeScript filesystem fallback for these six kinds. On the packaged
matrix (macOS arm64/x64, Linux x64, and Windows x64), a missing or incompatible
agent prevents canonical finalization. Other architectures fail closed.

## Invariants

- A deletion-request event atomically creates a durable intent.
- Operation and finalize-command identities derive from that intent's event ID.
- The immutable resource plan is stored before finalization.
- Execution requires the expected accepted command payload digest and committed
  deletion event to be copied into an immutable proof snapshot.
- Canonical thread-history pruning happens only after the proof snapshot.
- Pages contain at most 256 resources, never exceed the encoded 1 MiB frame
  limit, persist exact request bytes/deadlines, and execute serially.
- A TypeScript lease and executor-side operating-system lock exclude concurrent
  attempts; ambiguous attempts retain their operation, digest, identities, and
  quarantine names.
- The executor never deliberately follows links, junctions, or reparse points,
  and refuses detected filesystem boundaries and unsupported entries.
- Unix final mutations are descriptor-relative. Windows quarantines through
  `SetFileInformationByHandle`, opens children relative to verified handles,
  and marks verified handles for deletion with `FileDispositionInfoEx`;
  pathnames never authorize the final resource rename or removal.

## Authority Profile

Cleanup mode advertises only `resource.cleanup` version 1. It opens no socket,
uses no remote journal, accepts only hello, root-bootstrap, cleanup,
keep-alive, and cleanup-cancellation frames, and exits when stdin closes or its
bounded idle timeout expires. Managed roots are opened and identity-checked
before resources may reference their opaque process-local handles.

## Threat Model

Stable identities prevent known replacement objects from being removed and
quarantine identity is checked before irreversible mutation. This does not
claim protection against a malicious same-user process continuously racing
final directory-entry mutations.

## Consequences

Deletion can remain canonically successful while external cleanup is durably
retryable. Shipping deletion support now requires matching server and native
agent artifacts plus native matrix tests. Linux arm64 remains unsupported until
it has a packaged local artifact and equivalent native evidence.
