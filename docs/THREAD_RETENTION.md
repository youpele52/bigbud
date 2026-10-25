# Automatic thread cleanup

bigbud's server owns local thread cleanup. It can automatically clean up inactive threads after 1, 2, 3, 7, 14, 30, or 90 days; `Never` disables automatic cleanup. The server checks the selected policy daily. Manual cleanup uses its own selected finite period and runs immediately after confirmation.

New manual previews and newly confirmed finite policies use **per-thread selection**. Choose age by creation time or last conversation activity (the latest user message, falling back to creation time). Eligible children are processed first; pinned, active, or newer children survive and are detached safely if their parent is deleted. Eligibility is rechecked before deletion, so the final result can differ from the preview.

Existing policies and runs can retain **legacy subtree selection**: deleting an eligible root also deletes its descendants, and descendant activity or protection can exclude the subtree. Migration preserves that historical selector rather than silently changing an already authorized policy. A new finite policy confirmation selects the per-thread behavior.

A finite policy is server-authorized state: changing `settings.json` directly cannot enable or shorten cleanup. Finite user changes require the policy-change challenge to be consumed, and unauthorized or malformed disk changes are replaced with the last server-authorized policy. The preview and confirmation describe the selected criterion and current exclusions; changing the automatic policy does not itself delete anything immediately.

## Rollout semantics

- Upgraded installations that already contained user threads when the retention migration ran are rollout-protected and receive an explicit `Never` policy.
- Data-empty installations receive the automatic `7 days` policy.
- Selecting a finite policy enables the daily automatic cleanup schedule. Manual cleanup and explicit policy changes remain governed by their consent challenges.
- The migration records whether an installation was existing or data-empty. Later edits to `settings.json` cannot change that classification or opt a protected installation into finite retention.
- An authorized policy and its rollout source survive restarts. Missing, malformed, pre-start, and watched finite settings edits do not override that state.

## Emergency disable

Set `BIGBUD_DISABLE_THREAD_RETENTION=1` on the server to prevent finite policy changes and automatic or manual retention execution. This is an operational kill switch; it does not rewrite the saved policy. Remove the variable only after the underlying issue is resolved and the saved policy has been reviewed.

## Storage and recovery

Cleanup removes selected threads (or legacy subtrees) from bigbud's local projections and canonical event history and cleans up verified bigbud-managed resources, such as attachments, checkpoints, logs, and managed worktrees. Project folders, source files, remote worktrees, and external worktrees are preserved; resources whose ownership cannot be verified are retained and reported rather than guessed safe to delete. Canonical cleanup runs only after a replacement projection baseline is verified; deferred roots can be retried with the bounded `canonical-thread-cleanup` maintenance command. Provider-remote conversations remain out of scope. SQLite normally places deleted database pages on its reusable free-page list. The database file may therefore remain the same size while SQLite reuses that space for later writes. bigbud does **not** run `VACUUM` as part of cleanup because it requires additional disk space and disruptive database rewriting.

Manual confirmation consumption and creation (or coalescing) of its durable run
are one SQLite transaction. The synchronous manual request executes that exact
persisted run rather than creating a second run. Manual, scheduled, startup
recovery, and queued execution share one coordinator permit. A run may select
or delete threads only while it owns the durable `active_slot`; startup resumes
that owner first, queued manual work has priority at safe handoff points, and
scheduled selection checks for that work between atomically persisted pages.
Cursor advancement plus selected items are persisted atomically with stable
deletion command IDs, so a yielded scheduled run resumes without selecting or
dispatching the same work under a new command ID.

Cleanup has no in-app per-thread undo. Recovery is backup-only: stop bigbud, restore a consistent backup of the SQLite database and any associated state directories, and then restart. Restoring only selected rows or only filesystem resources is unsupported and can produce inconsistent state. Validate backups and restore procedures before enabling a finite policy.

## Implementation references

- [Retention policy and age contracts](../packages/contracts/src/core/settings.threadRetention.ts)
- [Per-thread/legacy selector migration](../apps/server/src/persistence/Migrations/121_ThreadRetentionSelectionMode.ts)
- [Policy confirmation](../apps/server/src/retention/Layers/ThreadRetention.policy.ts)
- [User-facing confirmation and resource protections](../apps/web/src/components/settings/ThreadRetentionConfirmationContent.tsx)
