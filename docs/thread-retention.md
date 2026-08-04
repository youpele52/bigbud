# Thread retention operations

bigbud can automatically remove inactive, unpinned threads after the configured retention period. `Never` disables scheduled retention. A finite policy is server-authorized state: changing `settings.json` directly cannot enable or shorten retention. Finite user changes require the retention policy-change challenge to be consumed, and unauthorized or malformed disk changes are replaced with the last server-authorized policy.

## Rollout semantics

- Upgraded installations that already contained user threads when the retention migration ran are rollout-protected and receive an explicit `Never` policy.
- Data-empty installations receive the automatic `7 days` policy.
- Scheduled execution of that automatic policy remains staged behind `BIGBUD_INTERNAL_THREAD_RETENTION_AUTOMATIC_ROLLOUT=1`. The internal flag enables scheduled selection only; purge recovery still runs, and manual retention and explicit policy changes remain governed by their consent challenges.
- The migration records whether an installation was existing or data-empty. Later edits to `settings.json` cannot change that classification or opt a protected installation into finite retention.
- An authorized policy and its rollout source survive restarts. Missing, malformed, pre-start, and watched finite settings edits do not override that state.

## Emergency disable

Set `BIGBUD_DISABLE_THREAD_RETENTION=1` on the server to prevent finite policy changes and automatic or manual retention execution. This is an operational kill switch; it does not rewrite the saved policy. Remove the variable only after the underlying issue is resolved and the saved policy has been reviewed.

## Storage and recovery

Retention deletes application records and associated resources. SQLite normally places deleted database pages on its reusable free-page list. The database file may therefore remain the same size while SQLite reuses that space for later writes. bigbud does **not** run `VACUUM` as part of retention because it requires additional disk space and disruptive database rewriting.

Retention deletion has no per-thread undo. Recovery is backup-only: stop bigbud, restore a consistent backup of the SQLite database and any associated state directories, and then restart. Restoring only selected rows or only filesystem resources is unsupported and can produce inconsistent state. Validate backups and restore procedures before enabling a finite policy.
