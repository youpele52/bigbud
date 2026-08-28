# Desktop Delivery Supervisor Authority

**Status:** Accepted

**Date:** 27 August, 2026

## Context

At the time of this decision, the repository contained a bounded Rust
orchestration-delivery supervisor and a versioned protobuf protocol, but the
packaged desktop runtime did not launch or use it. The TypeScript server
streamed canonical orchestration events directly to web consumers, and the web
client owned serialized event application, replay, bounded recovery, and
canonical ownership reconciliation.

Treating the Rust executable as a prototype does not satisfy the intended
product boundary. It must ship and run in the packaged desktop application,
remain provider-neutral, and improve delivery reliability without becoming a
second source of orchestration truth.

## Decision

The Rust `bigbud-desktop-supervisor` is the delivery authority for attached
orchestration consumers in supported packaged desktop sessions.

The TypeScript server remains the canonical domain authority. It owns event
creation, canonical ordering and persistence, replay queries, authorization,
provider sessions, product state, and user-visible lifecycle state. It spawns
and supervises the Rust process because it already owns the canonical event
stream. Electron owns native artifact build, signing, packaging, resolution,
and passing the binary path to the server. Electron does not relay supervisor
frames through main-process IPC.

The initial shipped surface is packaged Electron on every supported desktop
target. Development may opt into an explicitly resolved local binary.
Standalone server installations retain the TypeScript delivery path until they
have an equivalent supported binary-distribution lifecycle.

## Delivery semantics

1. Each supervisor-managed WebSocket subscription attaches as one delivery
   consumer with a stable consumer identity and a monotonic generation.
2. The server sends canonical event batches to Rust. Rust is the only path that
   may return those batches for delivery to that consumer.
3. The web client applies each batch through its existing serialized event and
   recovery queue.
4. The web client acknowledges only after every event is applied and canonical
   ownership reconciliation completes.
5. The server forwards that application acknowledgement to Rust. A socket
   write, transport receipt, or partial application is not sufficient.
6. Rust advances the acknowledged sequence only for an exact, complete,
   generation-matched batch. Duplicate identities are deterministic and
   idempotent; conflicting identities fail the session.

## Recovery hierarchy

Rust authority must survive recoverable faults. Recovery proceeds in this
order:

1. Detect an acknowledgement timeout, process exit, broken frame, or heartbeat
   failure and stop new delivery for the affected consumer.
2. Restart the sidecar with capped exponential backoff and jitter, then require
   a compatible handshake before any operation.
3. Reattach with a higher consumer generation and the last verified
   application-acknowledged sequence.
4. Replay canonical events through Rust from that sequence. If continuity is
   uncertain or bounded retention cannot satisfy replay, run canonical bounded
   recovery before resuming live delivery.
5. Keep Rust authoritative after successful recovery; do not bypass it during
   reconnect and do not switch paths back and forth.

Only after a bounded retry and time budget is exhausted may the server enter
controlled fallback. It fences and terminates the failed supervisor generation,
establishes the last verified application cursor, performs bounded recovery if
needed, and resumes through the TypeScript path. That session remains on the
fallback path until reconnect or reload creates a new session. Rust and
TypeScript never deliver concurrently.

## Rollout

Development and CI first compare supervisor output against the direct path
without exposing duplicate batches to the consumer. The first enabled packaged
release uses authoritative Rust delivery behind a rollback gate. The gate is
selected before a session attaches and cannot change routing mid-session except
through controlled fallback.

The gate may default on only after codec compatibility, packaged artifact,
application-acknowledgement, reconnect/replay, crash-loop, and cross-platform
smoke gates pass. Shadow comparison is a validation stage, not the final
production architecture.

## Consequences

- Rust becomes responsible for safety-critical delivery state, so process and
  protocol failures must be observable, bounded, and exhaustively tested.
- TypeScript needs a focused framed-protobuf client and supervisor lifecycle
  manager, but orchestration domain logic and persistence do not move to Rust.
- The WebSocket contract needs delivery batch identity, generation, and an
  application-acknowledgement operation.
- Packaged releases must include, sign, verify, and smoke-test one more native
  executable on macOS, Windows, and Linux.
- Emergency fallback preserves availability without weakening normal Rust
  authority or allowing ambiguous double delivery.

## Implementation

The production integration is implemented in the shared worktree:

- `apps/server/src/desktop-supervisor/` owns the framed-protobuf owner client,
  process singleton, routing, generations, recovery budget, shadow checks, and
  terminal fenced fallback.
- `apps/web/src/routes/-__root.logic.tsx` applies delivery envelopes through a
  serialized queue and sends the application ACK only after canonical
  ownership reconciliation completes.
- `apps/desktop/src/env/pathResolver.platform.ts` and
  `apps/desktop/src/backend/backendManager.ts` resolve and pass the packaged
  binary directly to the TypeScript server.
- `scripts/lib/desktop-artifact/` builds, stages, verifies, and smokes the
  native binary and emits a SHA-256 manifest plus CycloneDX SBOM.
- The CI and release desktop matrices run final-package supervisor discovery,
  evidence verification, handshake, timeout recovery, clean shutdown, and
  orphan-process smoke coverage on their native runners.

The local implementation does not establish that macOS signing/notarization,
Windows package signing, or the Linux release artifact gates passed. Those
remain external release-matrix evidence and must not be inferred from local
validation.
