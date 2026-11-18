# Remote multi-client: second approval answer reached the provider (2026-11-17)

Found by the WP-3D acceptance test `approval_answered_once_second_gets_already_resolved`
(`apps/server/src/server.remote.multiClient.test.ts`).

## Finding

Two laptops connected to the same remote backend both show the same pending approval. Laptop A
answers it and the provider resolves the request. Laptop B then answers the same request with a new
command ID.

Before the fix, the decider accepted B's `thread.approval.respond` without checking whether the
request was still open. B got a success reply, a second `thread.approval-response-requested` event
was committed, and the provider reactor forwarded a second answer to the provider. The provider then
rejected it as stale, and the thread got a `provider.approval.respond.failed` activity saying
"Provider callback state does not survive app restarts or recovered sessions. Restart the turn to
continue." That guidance is wrong here, because the turn was fine and another client had already
answered.

A same-ID resend was already safe, because the command receipt deduplicates it.

## Fix

`apps/server/src/orchestration/deciderThreads.turn.session.ts`: `thread.approval.respond` is now
refused with `OrchestrationCommandInvariantError` ("Approval request X was already resolved.") when
the latest `approval.requested` or `approval.resolved` activity for that request ID is
`approval.resolved`. The refusal is persisted as a rejected receipt as usual, and the client gets
the message through `OrchestrationDispatchCommandError`.

The check only acts on positive evidence. Requests with no activity, or whose latest lifecycle
activity is `approval.requested`, behave as before. That covers retries after transient
`provider.approval.respond.failed` failures.

## Residual gaps

- **In-flight window.** The in-memory read model doesn't record `thread.approval-response-requested`.
  If B answers after A's answer is committed but before the provider's `approval.resolved` activity
  is ingested, B is still accepted and forwarded, and the provider's stale-request rejection is the
  only guard (as covered by `ProviderCommandReactor.duplicateResponses.test.ts`). Closing this
  needs read-model state for answered-but-unresolved requests.
- **Untyped refusal.** The refusal has no `OrchestrationDispatchCommandError.code`. A typed code
  such as `approval_already_resolved` would need a contracts change so clients can render it
  without matching message text.
