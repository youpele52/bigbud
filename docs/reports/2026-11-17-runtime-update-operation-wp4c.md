# Runtime update operation, consent and setup authority (M3 WP-4C)

**Date:** 17 November 2026
**Plan:** [Remote completion plan](../plans/2026-11-17-remote-completion-plan.md), M3 WP-4C
(decisions 7 and 9; D9/D10 in the
[remote agent plan](../plans/2026-11-13-remote-agent-manual-install-plan.md))
**Status:** Implemented with focused tests. Not committed. The service is a library plus RPCs.
It is not added to the remote backend's layers yet, so on a real backend the RPCs answer
`unavailable` and the handshake still reports `runtimeUpdates: false`. WP-4D adds it once it
supplies a graph source, the archive store root and the drain inspector.

## What a user can rely on

- **One update at a time.** A remote backend runs at most one update operation. If a second
  laptop asks for the same version, it joins the running operation and both see the same
  operation id and progress. If it asks for a different version, it gets back the running
  operation marked `conflict`. No second updater starts.
- **Updates survive restarts.** Each step is saved to the backend database (migration 174).
  After a restart, an update that was still `pending` or `staging` picks up where it stopped.
  An update that was already staged stays staged.
- **Asking to update is not permission to interrupt.** A request with `interrupt: true` only
  records that the user wants an interrupting update. Before anything is stopped, the user must
  confirm the exact list of affected work (turns, pending approvals and so on). That
  confirmation applies to that one operation and that one list, and can be used once. If the
  list changes, the confirmation goes stale and the user has to confirm the new list.
- **Only the laptop can update.** Update requests are accepted only over the authenticated
  client socket that the SSH-relayed laptop uses. The local desktop backend refuses them as
  `unauthorized`. Paired phones cannot reach the update RPCs at all, because they are not part
  of the mobile RPC group.

## States

`pending → staging → staged → awaiting-drain ⇄ deferred → activating → activated`, with `failed`
and `cancelled` as the other end states. An update can be cancelled at any point before
`activating`. Cancelling or failing during staging releases the archive store reservation.

WP-4C runs `pending → staging → staged` and cancellation. Moving to `awaiting-drain` and
beyond, and actually stopping work, belong to WP-4D.

## RPCs (setup authority required)

`server.requestRemoteRuntimeUpdate`, `server.getRemoteRuntimeUpdateStatus` (returns the
affected work and its digest), `server.consentRemoteRuntimeUpdateInterruption` (operation id
plus digest) and `server.cancelRemoteRuntimeUpdate`.

## Notes for WP-4D

- Add `makeRemoteRuntimeUpdateLive(deps)` to the remote backend layers. You supply
  `openStore` (root from `runtimeArchiveStoreRoot`, plus the backend's mutable roots),
  `graphSource`, `affectedWork` (Rust terminals must not appear in it), `assertOwner` and the
  `activation` hook (`onStaged` and `onResume`).
- Do all drain and activation work inside `withSingleFlight`. Change states only through
  `advance`, which enforces the state table. Call `consumeInterruptionConsent` right before
  interrupting work; it fails with `consent-required`, `consent-stale` or `consent-reused`.
- When `advance` moves a staged operation to `failed` or `cancelled`, release its archive key
  inside `withSingleFlight`. Startup also releases the key of the most recent settled operation
  as a fallback.
- Pass running versions as `inUse` when pruning (see the WP-4B report).
