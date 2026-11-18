# P8 peer orchestration contracts and persistence (WP-8A), 2026-11-18

Scope: M6 WP-8A from `docs/plans/2026-11-17-remote-completion-plan.md` (Phase 8 of
`docs/plans/2026-11-13-remote-agent-manual-install-plan.md`). Schema, migration, repositories and a
pure state machine only. No endpoints, sockets or transport.

## What landed

- `packages/contracts/src/server/remotePeer.ts`: peer grant (coordinator authority and key
  fingerprint, worker authority, allowed actions `delegate | status | follow | cancel`, permission
  ceiling, expiry, revocation), dispatch identity (`dispatchId`, namespaced
  `peer:<coordinator authorityId>:<dispatchId>` command id, coordinator thread, request key, worker
  target), dispatch states and the legal-transition enum, a bounded result summary (8192 characters,
  at most 8 attachment descriptors) and error codes.
- Migration 175 `PeerOrchestration`: `peer_grants` (worker side) and `peer_dispatches`
  (coordinator side).
- `PeerGrantRepository` / `PeerGrantRepositoryLive` and `PeerDispatchRepository` /
  `PeerDispatchRepositoryLive` in `apps/server/src/persistence/{Services,Layers}`.
- `apps/server/src/peer-orchestration/peerDispatch.transition.ts` (pure event-driven transitions)
  and `peerPermission.narrowing.ts` (ceiling checks, intersection, worker-side grant admission).

## Dispatch state table

| from           | event            | to             |
| -------------- | ---------------- | -------------- |
| pending        | send-started     | sent-uncertain |
| pending        | rejected         | failed         |
| pending        | cancel-requested | cancelled      |
| sent-uncertain | worker-accepted  | accepted       |
| sent-uncertain | rejected         | failed         |
| sent-uncertain | cancel-requested | cancel-pending |
| accepted       | follow-started   | following      |
| accepted       | child-completed  | completed      |
| accepted       | child-failed     | failed         |
| accepted       | cancel-requested | cancel-pending |
| following      | child-completed  | completed      |
| following      | child-failed     | failed         |
| following      | cancel-requested | cancel-pending |
| cancel-pending | cancel-confirmed | cancelled      |
| cancel-pending | child-completed  | completed      |
| cancel-pending | child-failed     | failed         |

Everything else is illegal: nothing re-enters `pending` or `sent-uncertain`, `cancel-pending` only
leaves to a terminal state, and terminal states are final. A repeated send stays `sent-uncertain`
(`recordSendRetry`) with the same command id.

## Persistence guarantees

- `peer_dispatches`: primary key `dispatch_id`, unique `command_id`, unique
  `(coordinator_thread_id, request_key)`, unique `(worker_authority_id, child_thread_id)`. A CHECK
  ties `command_id` to `'peer:' || coordinator_authority_id || ':' || dispatch_id`. CHECKs also
  require cancel intent for cancel states, a child for accepted/following/completed, a result for
  completed, an error for failed and zero send attempts while pending. A partial index serves
  restart resume (`listUnsettled`).
- `insert` joins an existing row for the same coordinator thread and request key when the worker
  target matches (`joined: true`); any other collision is `PeerDispatchConflict`.
- `transition` applies the pure table, then compare-and-sets on the current state; illegal events
  fail with `PeerDispatchIllegalTransition`. The first child id and first cancel time are kept.
- `peer_grants`: at most one unrevoked grant per coordinator authority (partial unique index);
  `issue` revokes the previous one in the same transaction and refuses a ceiling wider than the
  worker's local ceiling. Revocation is idempotent and keeps the first time.

## Checks

- `bunx oxfmt` / `bunx oxlint` on the 15 changed paths: clean.
- `bun run --cwd packages/contracts typecheck` and `bun run --cwd apps/server typecheck`: pass.
- Focused vitest: contracts `remotePeer.test.ts`; server `peerDispatch.transition.test.ts`
  (all 64 state and event pairs plus table/enum equality), `peerPermission.narrowing.test.ts`,
  `175_PeerOrchestration.test.ts`, `PeerDispatches.test.ts`, plus the 174 and downgrade-guard
  migration tests.
- Mutation sanity: letting `cancel-pending` resume following, dropping the request-key uniqueness
  and skipping provider narrowing each failed the suite; all restored.

## Notes for WP-8B to WP-8E

- **8B (worker peer socket):** admit each request with `evaluatePeerGrant` against
  `findActiveForCoordinator`; reply with `PeerError` codes. Use the namespaced command id as the
  orchestration `commandId` for the child-creating command so command receipts make a repeated
  delegate return the same child. Clamp requested permissions to the grant ceiling, never widen.
  Truncate summaries to `PEER_RESULT_SUMMARY_MAX_CHARS` and set `truncated`.
- **8C (SSH transport):** the grant binds `coordinatorKeyFingerprint`; the forced command should
  pass the authenticated key fingerprint to the socket so a rotated or foreign key reads as
  `authority-mismatch`.
- **8D (coordinator):** insert `pending`, transition `send-started` before writing to the wire,
  and on restart walk `listUnsettled`: `sent-uncertain` probes `status` and re-sends the same
  identity, never a fresh dispatch id. Persist `cancel-requested` before contacting the worker and
  show `cancel-pending` during partitions. Compute permissions with `intersectPeerPermissions`
  (caller and grant ceiling).
- **8E (tool and UX):** `delegate_to_host` derives the request key from the tool invocation id so
  retries join; without an active grant return the typed `grant-missing` unavailable result.
  Revoke through `PeerGrantRepository.revoke`, independently of deleting a saved connection.
