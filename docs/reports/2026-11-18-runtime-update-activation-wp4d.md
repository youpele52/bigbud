# Runtime update drain, disk gate, backup and activation (M3 WP-4D)

**Date:** 18 November 2026
**Plan:** [Remote completion plan](../plans/2026-11-17-remote-completion-plan.md), M3 WP-4D
(decision 9; D9/D10 and the migration disk gate in the
[remote agent plan](../plans/2026-11-13-remote-agent-manual-install-plan.md))
**Builds on:** [WP-4C operation](2026-11-17-runtime-update-operation-wp4c.md) and
[WP-4B archive store](2026-11-17-runtime-archive-store-wp4b.md)
**Status:** Implemented with focused tests. Not committed. Not yet run on a real VPS.

## What a user can rely on

- **Remote backends now advertise updates.** The handshake reports `runtimeUpdates: true` on a
  remote backend. Local desktop backends do not compose the service and still report `false`.
- **Busy work defers an ordinary update.** A running turn, a pending approval or a pending
  user-input request puts the update in `deferred`. Nothing is stopped and command admission
  stays open. The update retries by itself every 15 seconds and goes ahead once the backend is
  idle.
- **Interrupting needs separate consent.** If you confirmed the exact affected-work list, the
  update closes admission, uses your consent once, interrupts each affected turn once through
  the normal interrupt command and waits up to 30 seconds. Turns it never replays. A turn that
  does not settle in time is reported as uncertain, and the next runtime marks it interrupted
  through its normal startup recovery. If the work changed after you confirmed, the consent is
  stale, nothing is interrupted and you are asked to confirm again.
- **Terminals survive.** Terminals run in the separate Rust unit. They are never part of the
  affected work, and only the backend unit is restarted, so terminal processes keep their PIDs.
- **Refusals come before any outage.** A downgrade, a missing or mismatched staged runtime, a
  backend that is not running as its managed account service, and too little disk space each
  fail the update while the current runtime keeps serving. Admission is never closed for them.
- **Rollback keeps every acknowledged command.** Before the restart, the database is backed up
  offline with `VACUUM INTO` while admission is closed. If the new runtime fails its trial
  before admitting any command, the previous runtime and that backup come back. Nothing that
  was acknowledged before the update is lost, and nothing the trial runtime wrote survives.

## Sequence

1. **Before drain:** refuse a downgrade, check that the staged receipt matches the archive entry
   and that this process runs inside `bigbud-backend-<authority>.service`, and check the disk
   budget.
2. **Drain:** described above. While admission is closed, public commands get a retryable
   `overloaded` response ("retry with the same command ID"). The scheduler skips ticks and
   manual triggers. Queued prompts stay durable and are not flushed. Provider-internal commands
   keep flowing so in-flight turns can settle.
3. **Under the maintenance lock:** check the disk budget again, then `advance → activating`.
4. Take the offline backup at `<stateDir>/runtime-update/backup-<op>.sqlite`. It is written
   to a temporary file, then renamed and fsynced.
5. Write the journal `<stateDir>/runtime-update/activation-v1.json` with phase `restarting`. It
   holds the previous config and receipt, the backup path and any uncertain turns.
6. Point the private service config at the staged graph. Only the node, entry and receipt pins
   change, and the receipt is written before the config. Then run
   `systemctl --user --no-block restart bigbud-backend-<authority>.service`. The unit's
   ExecStart is the fenced Rust launcher, which revalidates the config, the receipt and the
   whole graph before Node starts.
7. **New runtime:** admission starts closed because the journal exists. Queued-prompt recovery
   and the scheduler are held. The trial passes when the process runs the staged entry, startup
   reports command readiness within 120 seconds and `PRAGMA quick_check` returns ok. On
   success: commit the archive pointer (new active, old previous), `advance → activated`, prune
   unused versions with the running version passed as `inUse`, clear the journal, then reopen
   admission. Reopening releases the held queued prompts.

## Rollback rules

- **Trial failed and nothing admitted:** the journal moves to `rollback`, the previous config
  and receipt are restored, the journal moves to `restore-pending` and the unit restarts. On
  the next start, before the database opens and under the state-directory lock, the backup
  replaces the database. This copies to a temporary file, removes the WAL and SHM files,
  renames over the database and fsyncs. The old runtime then settles the operation as `failed`
  with the reason, releases the staged archive, clears the journal and reopens admission.
- **Restore interrupted:** every restore step can repeat, and the journal stays
  `restore-pending` until the restore has finished, so the next start simply repeats it.
- **Activation stopped before the restart** (the operation is `activating` with no journal):
  the operation is settled as failed with "the previous runtime is unchanged".
- **Restart request failed:** still in the old runtime with admission closed, the config is
  restored and the operation fails.
- **Commands were already admitted:** the update is never rolled back automatically. It fails
  with a message asking for an explicit restore.
- Every move to `failed` releases the operation's archive reservation (WP-4C contract).

## Files

New files, all under `apps/server/src/`:

- `command-admission/RuntimeMaintenanceGate.ts`
- In `remote-backend/`:
  - `runtimeUpdate.{drain,drain.probe,disk,backup,journal,unit,graphSource}.ts`
  - `runtimeUpdate.activate{,.context,.resume}.ts`
  - `Layers/RemoteRuntimeUpdate.remote.ts`

The graph source reuses WP-3A's `makeDeploymentGraphSourceResolver`. The backup reuses
`execute` from `DatabaseCompaction.vacuum.ts`.

Edited files:

| File                                                          | Change                                                         |
| ------------------------------------------------------------- | -------------------------------------------------------------- |
| `ws/wsRpcContext.ts`                                          | Public admission goes through the gate                         |
| `SchedulerReactor.ts`                                         | Pauses ticks and manual triggers                               |
| `OrchestrationEngine{,.commandProcessing,.lifecycleFlush}.ts` | Holds lifecycle and startup queued-prompt flushes; reopen hook |
| `clientRoutes.ts`                                             | Handshake capability                                           |
| `server.ts`                                                   | Two composition lines; `server.remote.ts` is unchanged         |

## Tests and checks

Tests:

- `busy_turn_defers_automatic_update`
- `pending_approval_blocks_automatic`
- `interrupting_update_settles_or_reports_uncertain`
- `disk_full_refused_before_outage`
- `downgrade_refused_before_outage`
- `failed_trial_rolls_back_without_ack_loss`: three backend starts over one SQLite file
- `interrupted_restore_recovers`
- `rust_terminal_pid_unchanged`: a real `sleep` stand-in, plus the exact systemd argv
- disk budget arithmetic
- `runtime_on_trial_holds_queued_prompts_until_admission_reopens`: real engine
- the handshake capability, with and without the service

Mutation checks: nine mutations each made a test fail. They covered:

- the automatic pre-check
- the admitted-command rollback guard
- the pre-drain disk check
- the restart unit name
- the gate's initially-closed state
- the restore rename
- a replayed interrupt
- interrupting without consent
- the engine's queued-prompt hold
- the downgrade refusal

Checks:

- Explicit-path oxfmt and oxlint on 26 files are clean.
- `apps/server` typecheck is clean for these files. The only remaining errors are in another
  lane's in-progress `provider-provisioning/` files.
- Existing suites were rerun one file at a time: scheduler, engine queue recovery, client
  routes, remote multi-client, and the WP-4C operation and consent tests.

## Gaps

- **A runtime that cannot start Node is not rolled back automatically.** This covers a crash
  before the trial, and a crash between the receipt and config renames. The unit retries up to
  its start limit and the journal stays `restarting`. To recover:
  1. Write `previousConfig` and `previousReceipt` from the journal back to
     `~/.bigbud/backend-services/<authority>/{config-v1,artifact-receipt}`.
  2. Run `systemctl --user reset-failed` and then `start` on the backend unit.

  The old runtime then fails the trial check (it is not the staged entry), rolls back and
  restores the backup automatically.

- **`laptop-upload` updates report "not available yet".**
- **The first update records no rollback version in the archive store.** The graph that setup
  installed is not in the store, so the pointer's `previous` is empty.
- **Cancelling waits while a drain attempt holds the lock.** This can take up to about 90
  seconds.
- **The composition is not tested on a real remote boot.** The production wiring is checked by
  the typecheck and a route-level handshake test only.
- **Linux behaviour is not verified yet.** These paths still need the live run below: systemd,
  `/proc/self/cgroup`, `tar` modes and `VACUUM INTO` on the VPS.

## Live checklist (M3, on the VPS)

1. **Deploy and handshake.** Deploy this build with the laptop deployment and start the
   backend unit. The handshake reports `runtimeUpdates: true`.
2. **Deferred update.** Start a long turn, then request an update with `interrupt: false`. The
   status is `deferred` and lists the turn. Let the turn finish. The update activates, clients
   reconnect and `backendVersion` is the new version. `runtime-update/` is empty and the
   archive pointer's active entry is the new key.
3. **Approval blocks.** Leave a turn waiting on an approval. The update stays `deferred` until
   you answer it, and the approval wait survives intact.
4. **Interrupting update.** Request with `interrupt: true` and read the affected work and its
   digest. Confirm the consent. The turn shows as interrupted and is not replayed. Queued
   prompts stay queued, then flush after activation.
5. **Stale consent.** Confirm consent, then start another turn before activation. The response
   is `consent-stale` and nothing is interrupted. Confirm again.
6. **Terminal survives.** Open a terminal and note its PID with `pgrep -f`. Update. The PID is
   unchanged and the session continues.
7. **Disk full.** Fill the disk below the budget (for example with `fallocate`) and request an
   update. It fails with "Not enough disk space … Nothing was stopped", and there is no
   outage.
8. **Downgrade refused.** Request an older version. It fails with "Downgrading … is refused",
   and there is no outage.
9. **Failed trial rolls back.** Use a dev `local-graph` build whose startup never reaches
   command readiness. The previous version comes back, messages acknowledged before the update
   are all present, and the operation is `failed` with a message that says it rolled back.
10. **Interrupted restore.** Stop the unit while the journal is `restore-pending`, then start it.
    The restore completes and the operation settles.
11. **Unbootable runtime.** Use a graph whose Node exits at once. Check that the manual recovery
    in Gaps works.
