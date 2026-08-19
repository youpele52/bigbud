# Automatic thread cleanup

bigbud's server owns local thread cleanup. It can automatically clean up inactive threads after 1, 2, 3, 7, 14, 30, or 90 days; `Never` disables automatic cleanup. The server checks the selected policy daily. Manual cleanup uses its own selected finite period and runs immediately after confirmation.

Cleanup selects eligible root thread subtrees. Deleting a root deletes its descendants with it. A subtree is skipped if it is pinned or active, and newer activity in a descendant keeps its root from qualifying for time-based cleanup. A finite policy is server-authorized state: changing `settings.json` directly cannot enable or shorten cleanup. Finite user changes require the policy-change challenge to be consumed, and unauthorized or malformed disk changes are replaced with the last server-authorized policy.

## Rollout semantics

- Upgraded installations that already contained user threads when the retention migration ran are rollout-protected and receive an explicit `Never` policy.
- Data-empty installations receive the automatic `7 days` policy.
- Selecting a finite policy enables the daily automatic cleanup schedule. Manual cleanup and explicit policy changes remain governed by their consent challenges.
- The migration records whether an installation was existing or data-empty. Later edits to `settings.json` cannot change that classification or opt a protected installation into finite retention.
- An authorized policy and its rollout source survive restarts. Missing, malformed, pre-start, and watched finite settings edits do not override that state.

## Emergency disable

Set `BIGBUD_DISABLE_THREAD_RETENTION=1` on the server to prevent finite policy changes and automatic or manual retention execution. This is an operational kill switch; it does not rewrite the saved policy. Remove the variable only after the underlying issue is resolved and the saved policy has been reviewed.

## Storage and recovery

Cleanup removes deleted thread subtrees from bigbud's local projections, canonical event history, and associated bigbud-managed resources, such as attachments, checkpoints, logs, and managed worktrees. Canonical cleanup runs only after a replacement projection baseline is verified; deferred roots can be retried with the bounded `canonical-thread-cleanup` maintenance command. Provider-remote conversations remain out of scope. SQLite normally places deleted database pages on its reusable free-page list. The database file may therefore remain the same size while SQLite reuses that space for later writes. bigbud does **not** run `VACUUM` as part of cleanup because it requires additional disk space and disruptive database rewriting.

Cleanup has no in-app per-thread undo. Recovery is backup-only: stop bigbud, restore a consistent backup of the SQLite database and any associated state directories, and then restart. Restoring only selected rows or only filesystem resources is unsupported and can produce inconsistent state. Validate backups and restore procedures before enabling a finite policy.
