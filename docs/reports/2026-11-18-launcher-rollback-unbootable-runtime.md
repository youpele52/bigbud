# Launcher rollback of a runtime that never starts (M3 WP-4D gap)

**Date:** 18 November 2026
**Closes:** the first gap in the [WP-4D activation report](2026-11-18-runtime-update-activation-wp4d.md)
(manual recovery in M3-11 of the [M2/M3 live acceptance](2026-11-18-m2-m3-live-acceptance.md))
**Status:** Implemented, unit-tested and passed live on a fresh Lima VM. Not committed.

## What a user can rely on

- **A new runtime that cannot start is rolled back without a human.** This covers Node that exits
  at once, a Node binary the launcher refuses, and anything else that fails before the trial
  passes. The previous runtime comes back, and the operation is `failed` with a reason. Every
  acknowledged command is kept.
- **A crash in the middle of the switch is repaired.** If the backend stops after it writes the
  new receipt but before it writes the config, the next start restores the previous runtime.
- **The unit does not reach its start limit first.** The rollback happens on the fourth start;
  the limit is six starts in 300 seconds.
- **The Rust terminal unit is never touched.** Terminals keep their processes.
- **Admitted work is never rolled back.** The launcher acts only while the journal is
  `restarting`. The backend removes the journal before it opens command admission.

## Design

The backend unit's ExecStart is the Rust launcher, so the launcher runs before every Node start.
The new `backend_service/rollback.rs` runs right before the existing verifier and `exec`. It reads
the backend's journal, `<backend_home>/userdata/runtime-update/activation-v1.json`.

| Journal state                                                    | Launcher action                                                                                                                                                                  |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| None, unreadable, or `restore-pending`/`restored`                | Launch as configured, and change nothing.                                                                                                                                        |
| `restarting`; config is the new runtime                          | Count this launch in `launch-attempts-v1` beside the journal, keyed by operation and receipt digest. Launches 1 to 3 go ahead. The fourth restores the previous runtime instead. |
| `restarting`; config is the previous runtime, receipt matches it | Launch as configured. The backend's existing "not the staged runtime" check rolls back.                                                                                          |
| `restarting`; config is the previous runtime, receipt is new     | The pair is half-switched, because the backend writes the receipt first and the config is the commit point. Restore the previous runtime.                                        |
| `rollback`                                                       | Finish the interrupted restore.                                                                                                                                                  |

**A restore works in this order:**

1. Stage the previous receipt as a private temporary file.
2. Run the existing verifier (`validate_role_at`: graph, Node and entry pins, authority,
   credential) on the previous pins against that file. If it fails, nothing is changed.
3. Write the journal `rollback` with the reason.
4. Rename the receipt, then replace `config-v1`. Only the five graph pins come from the journal.
   Every other field stays as it is, so a newer Rust reservation survives.
5. Write the journal `restore-pending`, clear the counter, reload the config and launch.

The previous runtime then restores the database backup and settles the operation as `failed`
through the existing rollback path. The launcher never touches the database.

**The launcher writes only after its fence passes.** The fence is `verify_service_owner`, the
exact unit's MainPID and cgroup. A manual `run … backend` can neither count launches nor restore.

**Backend changes (TypeScript):**

- On success, admission opens only after the journal is cleared. Before, a failed clear only
  logged a warning and opened admission anyway.
- The defensive "commands were already admitted" path retires the journal before admission
  reopens, and keeps the backup for the explicit restore.
- Clearing the journal also removes the launch counter.

## Files

| File                                                                     | Lines | Change                                                          |
| ------------------------------------------------------------------------ | ----- | --------------------------------------------------------------- |
| `crates/bigbud-remote-agent/src/backend_service/rollback.rs`             | 175   | New: decisions and restore                                      |
| `crates/bigbud-remote-agent/src/backend_service/rollback.files.rs`       | 163   | New: journal read and phase rewrite, counter, atomic writes     |
| `crates/bigbud-remote-agent/src/backend_service/rollback.tests.rs`       | 359   | New: 9 tests                                                    |
| `crates/bigbud-remote-agent/src/backend_service/config.rs`               | 376   | `validate_role_at` (receipt path), `encode` (backend key order) |
| `crates/bigbud-remote-agent/src/backend_service/graph.rs`                | 152   | `verify_at` (receipt path)                                      |
| `crates/bigbud-remote-agent/src/backend_service/cli.rs`                  | 335   | Calls `reconcile` before the backend verifier and `exec`        |
| `crates/bigbud-remote-agent/src/backend_service/mod.rs`                  | 73    | Module registration                                             |
| `apps/server/src/remote-backend/runtimeUpdate.journal.ts`                | 146   | Counter path, `retireRuntimeUpdateJournal`                      |
| `apps/server/src/remote-backend/runtimeUpdate.activate.resume.ts`        | 193   | Journal is cleared before admission opens                       |
| `apps/server/src/remote-backend/runtimeUpdate.activate.launcher.test.ts` | 143   | New: 3 tests                                                    |

## Tests and checks

**Rust unit tests:**

- journal parsing
- attempt counting
- bounded rollback (atomic restore)
- half-switched reconciliation
- unchanged previous pair
- verifier failure leaves config, receipt and journal byte-identical
- finishing an interrupted rollback
- other phases, a foreign previous config and a fence refusal change nothing
- config encoding round trip

**TypeScript tests:**

- `never_started_runtime_rolls_back_through_the_launcher` and
  `half_switched_pair_rolls_back_through_the_launcher`: the old runtime restores the backup,
  settles `failed` with the launcher's reason, and keeps the acknowledged rows. A row written
  after the backup is gone.
- `activation_clears_the_launch_counter_before_admission`.

**Mutations:** 6 mutations were tried, and 5 made a test fail:

- the count off by one
- no half-switch repair
- skipping the verifier
- not restoring the receipt pin
- the TS counter not cleared

The surviving mutation dropped the `backend_home` equality check. The authority check makes it
redundant.

**Checks:**

- `cargo clippy -p bigbud-remote-agent --all-targets -D warnings` is clean on the host and on
  `--target x86_64-unknown-linux-gnu`. rustfmt is clean on the changed files.
- `cargo test --lib backend_service:: -- --test-threads=1`: 71 passed on macOS and 73 passed on
  Linux (disposable `node:24.13.1-bookworm` container, non-root user).
- Explicit-path `oxfmt` and `oxlint` are clean on the 3 TS files.
- `bun run --cwd apps/server typecheck`: no errors in these files. The remaining errors are in
  other agents' in-progress files.
- Focused Vitest, 6 runtime-update files, 20 tests: 1 unidentified failure in the first run, then
  6 clean runs in a row.

## Live run

**Setup:**

- **VM:** Lima `bblr` (vz, Ubuntu 22.04 arm64, systemd 249, `mounts: []`).
- **Source:** a `git archive` of HEAD plus this task's files only.
- **Agent:** musl, built in a disposable container.
- **Graphs:** 5, signed with fixture key `dev-fixture-lr`.
- **Backend:** set up and started on the host with `backend setup` and `backend start`. Updates
  used `backend update-inputs set` dev inputs.

| Case                                                                    | Result   | Evidence                                                                                                                                                                 |
| ----------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. 0.1.613 to `e` (Node exits 3 at once)                                | **PASS** | Trial launches 1–3, each `status=3`; the fourth logs "rolled back". `failed` "…did not start after 3 launches…Rolled back…" in 31 s. 0.1.613 serves; NRestarts=3, active |
| 2. 0.1.615 to `i`, staged Node set to mode 000 after the switch         | **PASS** | The launcher refused launches 1–3 before Node (`status=1`); the fourth rolled back. Same reason; 0.1.615 serves; NRestarts=3, active                                     |
| 3. 0.1.616 (`h`) to `i`, SIGKILL between the receipt and config renames | **PASS** | `status=9/KILL`, one restart, "rolled back"; `failed` "…switch stopped between the receipt and the config…"; receipt digest equals config pin; NRestarts=1               |
| In every case                                                           | **PASS** | Rust MainPID 3519 and terminal shell 4817 unchanged; events and command receipts 3/3 unchanged; `runtime-update/` empty; unit never `failed`                             |

**Also seen:**

- Two healthy updates (to `c`, then to `h`) activated normally through the launcher. A counted
  first launch did not get in the way.
- A chmod that landed before the switch was refused by the backend's pre-switch verification
  ("Executable graph member changed…") with no outage.

**Evidence:** `~/DevWorld/bigbud-evidence/tmp-bigbud-evidence-20261118-launcher-rollback.tar.zst`,
with a `.sha256` file beside it. It holds the logs, the per-case live logs and journals, the
test-graph diffs and the harness tools. It was scanned and contains no client token and no private
key.

**Teardown:** the VM was deleted, and `/tmp/bigbud-lr-20261118` and the extracted tools were
removed.

## Gaps and notes

- **`restart=no` units are not covered.** With `Restart=no`, a crashed new runtime is not
  relaunched, so the rollback waits for the next manual start, which counts as a launch.
- **The launcher's own error text is not shown.** stderr shows only "account-service operation
  failed", because of the existing `anyhow` context in `main.rs`. The reason is still persisted
  through the journal.
- **The TS rollback still restores the whole previous config.** The launcher restores only the
  pins. Moving the TS rollback to pins only would make the two sides match.
