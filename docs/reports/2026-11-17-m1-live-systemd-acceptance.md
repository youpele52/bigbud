# M1 live systemd acceptance (aarch64)

**Date:** 17 November 2026, 22:02–22:40 UTC
**Plan:** [Remote completion plan](../plans/2026-11-17-remote-completion-plan.md), M1 live checklist
**Related:** [Backend graph producer](2026-11-17-remote-backend-graph-m1.md),
[WP-1D explicit start/stop](2026-11-17-wp-1d-explicit-start-stop-musl-launcher.md)
**Verdict:** **Not accepted.** The exit-130 fix, crash restart, crash-loop limit, Rust terminal
survival across a backend crash, supervisor SIGTERM handling and the refusals all pass. Three
blocking bugs remain:

- After any graceful stop of the Rust unit (`backend stop`, `loginctl terminate-user`, a SIGTERM),
  the backend cannot start again on the same boot.
- Boot autostart fails on reboot, in 2 of 2 attempts.
- A host without lingering cannot be set up.

## Environment and inputs

- **Host:** macOS with Lima 2.3.0. One disposable VM, `bb-m1-svc` (vz, Ubuntu 22.04.5 arm64,
  kernel 5.15.0-198, systemd 249.11). It had 2 CPUs, 3 GiB memory, a 12 GiB disk, `mounts: []`
  and every port forward ignored. Users:
  - `bbsvc` (UID 1000) with lingering enabled.
  - `bbnl` (UID 1001) without lingering.
- **Source:** `git archive` of HEAD `14ce339f8d` (tree `e9a046bc…`). The working tree was not used.
  The root `node_modules` was APFS-cloned in.
- **Backend graph:** rebuilt from that snapshot, because the supplied graph came from a dirty tree
  at `12b1d38`.
  - Build: `bunx tsdown` with both configs, then
    `bun run remote-backend-graph --target aarch64-unknown-linux-gnu … --key-id dev-fixture-20261117 --version 0.1.613-dev.m1head --node-archive <pinned node 24.13.1>`.
  - Archive sha256 `fe4f3edc…b8b1c`, manifest `7e88b009…6a401`, buildDigest `69a49530…`.
  - 8,048 files. Signed with the supplied dev fixture key and verified against the supplied
    `trust.json`.
  - **Deviation:** the clean HEAD bundle was refused by the loader policy. It was built only after
    one pin was changed in the snapshot copy of the policy (finding F7).
- **Rust agent:** built from the same snapshot in a disposable `node:24.13.1-bookworm` container
  with rustup 1.95.0 (`cargo build --locked --release`, target `aarch64-unknown-linux-musl`).
  - Version `0.3.3-m1.46b993732741`, protocol 1.8.
  - Stripped static binary, sha256 `72a3e0ac…f3d9`, 3,150,232 bytes.
  - Its manifest was signed with the same fixture key (`dev-fixture-20261117`). No release key was
    used.
- **CLI:** the graph's own `runtime/node server/bin.mjs`, run as each account, with a clean
  environment and that account's `XDG_RUNTIME_DIR`.
- **Driver:** an adaptation of the P7 account-service PTY driver. It uses the public UDS
  handshake, WebSocket RPC, `terminal.open`/`write`/`snapshot` and a subscription. It starts no
  providers and reads no database.

## Results

| #   | Check                                                 | Result                     | Key evidence                                                                                                                                                                                                                                                                                                             |
| --- | ----------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `backend setup … --confirm-fresh-setup`; status       | **PASS**                   | Exit 0, authority `4df85a6a…`. Status: Rust Active, backend Disabled, crash-restarts 0. Setup already starts the Rust unit                                                                                                                                                                                               |
| 2   | `backend start` without boot startup                  | **PASS**                   | `is-enabled` stays `disabled` and Linger stays `yes`. Backend active; handshake `persistentTerminals: true`. That the backend starts Rust itself was shown after reboot 1 (Rust inactive, then active as PID 2367)                                                                                                       |
| 3   | Exit-130 fix: `systemctl --user stop` of the backend  | **PASS**                   | With user-manager debug logging: `Main process exited, code=exited, status=0/SUCCESS (success)`, `Deactivated successfully`, NRestarts 0. The server logs `exit { code: 0 }`                                                                                                                                             |
| 4   | `kill -9` of the backend main PID                     | **PASS**                   | `code=killed, status=9/KILL`, `Result 'signal'`, restarted after about 1.2 s. NRestarts 0→1; handshake OK 4 s after the kill                                                                                                                                                                                             |
| 5   | Six clean stop/start cycles in 300 s                  | **PASS (as specified)**    | 6 cycles in 62 s (stop, then `bigbud backend start`); all stops exited 0, no start limit hit. See 5b                                                                                                                                                                                                                     |
| 5b  | Same, with boot startup enabled and plain `systemctl` | **FAIL (finding F5)**      | The 6th start was refused: `Result=start-limit-hit`                                                                                                                                                                                                                                                                      |
| 6   | Six `kill -9` in 300 s                                | **PASS**                   | After the 6th: `Start request repeated too quickly`, ActiveState=failed. Status reports `NeedsRepair; crash-restarts=6`, and its text names `systemctl --user reset-failed …`                                                                                                                                            |
| 7   | Rust terminal survives a backend `kill -9`            | **PASS**                   | Shell PID 6923 kept the same PID, start time and Rust-unit cgroup. A fresh client reattached with a new generation and `historyUnavailable: true`. A new output marker was delivered, ticks kept advancing (43→50), and job-control children kept running                                                                |
| 8   | `backend stop`, then `backend start`                  | **FAIL (F1, F2)**          | Both units become inactive, and config and data are kept. But Rust exits 143, so its unit is `failed` and the CLI reports failure. The next `backend start` crash-loops to the start limit. Only a reboot recovered                                                                                                      |
| 9   | SIGTERM to the Rust supervisor (WP-0A)                | **PASS** (exposes F1)      | `received signal 15; draining owned work`; exit 143 after 2.3 s. Socket removed; the shell, its job-control children and `sleep 424242` were reaped. No bbsvc process was reparented to PID 1. No `launch.exit` was written                                                                                              |
| 10a | Lingering on: PAM logout                              | **PASS** (supporting only) | After a `login -f` session ended, the same terminal PID and output marker remained. The P7 run had already proved this                                                                                                                                                                                                   |
| 10b | Lingering on: `loginctl terminate-user`               | **FAIL** (expectation)     | systemd stopped `user@1000.service` despite lingering: backend exit 0, Rust exit 143, terminal gone. The following `backend start` crash-loops (F1)                                                                                                                                                                      |
| 10c | Lingering off (second user, real `login` session)     | **FAIL (F3)**              | Setup fails with the generic CLI error and leaves partial state (no `setup-complete-v1`). Start also fails. Status does print the lingering remediation                                                                                                                                                                  |
| 11  | Enable, reboot, then disable-boot, reboot, start      | **FAIL (F4)**              | Enable works (symlink in `default.target.wants`). After a real reboot the backend autostarts, but Rust fails with `managed launch is already owned` and the backend ends at start-limit (2 of 2 reboots). Disable-boot and a reboot: no autostart (PASS); then `backend start` works; client token and receipt unchanged |
| 12a | Start/stop before setup                               | **PASS**                   | All refuse with exit 1 and create nothing                                                                                                                                                                                                                                                                                |
| 12b | Start/stop after editing a unit file                  | **PASS**                   | The native command refuses both: `account units differ from the private launch configuration`. Running units untouched; restored byte-exact                                                                                                                                                                              |

Untested: x86_64 (no native x64 host); provider turns (none were running, so "no turns replayed"
was not exercised); a real VPS.

## Findings (read-only diagnosis, no product change)

- **F1 (blocking): a graceful Rust stop leaves no death evidence, so the backend cannot restart on
  the same boot.**
  - WP-0A exits the process directly from the signal thread
    (`crates/bigbud-remote-agent/src/supervisor/signals.rs:239` →
    `supervisor/control.rs:133`). That skips `LaunchGuard::run`, which writes the `launch.exit`
    receipt only after the supervisor returns (`backend_service/launch.rs:88-95`).
  - The backend's restart observation then reports `unknown`: the lock is free, there is no
    `launch.exit`, and it is the same boot (`remoteAgentSupervisorLiveness.ts:39-52`). It throws
    "The old supervisor has no verified live or dead identity" at
    `remoteAgentRestart.runtime.ts:255-256`.
  - The phase-`stopping` reservation has already been recorded (`:227-233`). Later attempts fail
    with `write EPIPE` / `remote agent proxy failed` until the start limit is hit.
  - The documented repair (`reset-failed` + start Rust) fails with
    `managed launch evidence is ambiguous`. Only a reboot recovered (`prior-boot-dead`).
  - Triggers: `backend stop`, `terminate-user`, and SIGTERM to the supervisor.
- **F2: the Rust unit is marked `failed` after every graceful stop.** The supervisor exits 143,
  but the Rust unit has no `SuccessExitStatus=143` (`backend_service/unit.rs:62`). As a result:
  - The `backend stop` settle check sees NeedsRepair and returns an error
    (`explicit.rs:101-112`), so the CLI exits 1 after a successful stop.
  - Status tells the user to repair, and the suggested direct `systemctl --user start` of the
    Rust unit cannot succeed (F1).
- **F3: a host without lingering cannot use explicit start.** `start-rust` refuses anything except
  `Prerequisites::Ready` (`backend_service/cli.rs:108-110`). But explicit start accepts
  `MissingLinger` (`explicit.rs:49-52`), and WP-1D documents that start works without lingering.
  Setup (which starts Rust) and backend reconciliation therefore both fail. The TS CLI hides the
  cause (`apps/server/src/cli/cli.backend.ts:14`).
- **F4 (blocking): boot autostart fails, 2 of 2 times.**
  - About 5 s after the backend starts at boot, its replacement launch starts the Rust unit. The
    unit's non-blocking `flock` fails with "managed launch is already owned"
    (`backend_service/launch.files.rs:35`). The unit has `Restart=no`.
  - The backend then fails with "Replacement readiness was not verified (unavailable)"
    (`remoteAgentRestart.runtime.ts:307`) and loops to the start limit.
  - A manual `backend start` or `enable` shortly after a reboot worked (2 of 2), so this is
    specific to boot timing.
  - The lock holder was not identified; a 50 ms fd watcher on a later same-boot attempt saw
    nothing. Candidate: concurrent boot reconcilers that briefly `flock` the same lock (for
    example `remoteAgentSupervisorLiveness.ts:36-37`), racing with Rust's `LOCK_NB`.
- **F5: clean restarts use up the crash budget once boot startup is enabled.** `StartLimitBurst=6`
  in 300 s (`unit.rs:57`) counts every start. When the unit is disabled it is garbage-collected
  while inactive, which resets the counter. `bigbud backend start` also resets it, through
  `daemon-reload` (`explicit.rs:65`).
- **F6: start bypasses the crash-loop limit.** Verified: a direct `systemctl --user start` of a
  start-limited unit is refused, while `daemon-reload` followed by a start succeeds. So
  `backend start` restarts a NeedsRepair backend without `reset-failed`.
- **F7: the loader-policy pin does not match a clean HEAD build.**
  `scripts/build-remote-backend-graph.policy.data.ts:53` pins the Claude agent SDK region hash from
  the dirty-tree build. In a clean HEAD build that region differs only by rolldown renaming
  (`posix$2` → `posix$1`), so the producer refuses clean HEAD. Region hashes are sensitive to
  bundle-wide identifier renaming.
- **Minor:**
  - `backend start` and `enable` fail with `state_directory_in_use` while the backend is running
    (`cli.backend.operations.ts:139`). The failure is safe but not idempotent and gives no reason.
  - `systemctl show` after a clean stop returns default values, because the disabled unit is
    garbage-collected. The exit status in row 3 was therefore taken from the manager's debug log.

## Repro steps

1. Run `git archive HEAD` into a fresh directory, APFS-clone the root `node_modules`, and copy the
   workspace `node_modules` for server, contracts, shared, effect-acp and scripts.
2. Run `(cd apps/server && bunx tsdown && bunx tsdown -c tsdown.clientRelay.config.ts)`, then
   `bun run remote-backend-graph` with the arguments listed under Environment and inputs.
3. Build the musl agent with `BIGBUD_AGENT_BUILD_VERSION` and `BIGBUD_AGENT_BUILD_DIGEST` set, then
   sign a schema-1 manifest whose `bundledPath` is the in-VM agent path.
4. Create a Lima VM with `mounts: []` and add a user with `loginctl enable-linger`.
5. As that user, extract the graph to `~/runtime/backend` and put the metadata in `~/install`
   (mode 0600; directories 0700).
6. As that user, with a clean environment and `XDG_RUNTIME_DIR=/run/user/<uid>`, run
   `node server/bin.mjs backend setup …`. Then run `backend start`.
7. Run `backend stop`, then `backend start`: F1 and F2 reproduce.
8. Run `backend enable --confirm-startup`, then `limactl stop && limactl start`: F4 reproduces.

Evidence: `/tmp/bigbud-m1-live-20261117T220256Z/` (PROVENANCE.txt, logs/, live/, tools/, vm/),
archived as `~/DevWorld/bigbud-evidence/tmp-bigbud-evidence-20261117-m1-live.tar.zst`.
INVALID (driver errors, voided and redone):

- The first agent build was missing `protocol/`.
- The first graph build used a symlinked `node_modules`.
- One post-reboot observation used a nested 30 s handshake retry, so it ran far past its 60-check
  budget.

## Fixes and re-run (18 November 2026)

**Verdict after fixes:** every failing row now passes on a fresh VM, except the systemd behaviour
in row 10b (`terminate-user` stops a lingering user manager), which is expected and documented.

### What changed

- **F1 (two causes, both confirmed).**
  - The supervisor's exit seam (`supervisor/control.rs`) now calls an exit-receipt hook that
    `LaunchGuard::run` installs (`backend_service/launch.rs`). A settled signal drain writes
    `launch.exit` = `143` and an accepted restart writes `0`, under the held lock and after the
    reservation recheck. An unsettled exit (`1`) writes nothing, so liveness stays `unknown` and
    the unit needs repair.
  - The re-run then exposed a second cause. The boot reconciler keyed its restart reservation by
    boot only (`account-boot:<target>:<boot>:<generation>`), so the second replacement on one boot
    replayed the finished first one and failed with `write EPIPE`. The key now includes the dead
    predecessor's epoch, and an unfinished replacement resumes under its existing key
    (`accountBootRequestId`). New reservations drop finished history (`ready` rows, and `failed`
    rows from earlier boots), so the registry's 64-reservation budget is not exhausted over time.
  - The status repair text no longer says to start the Rust unit directly, which replays a spent
    reservation. It now says: `reset-failed` both units, then run `bigbud backend start`. If the
    old supervisor's death is still unproven, reboot.
- **F2.** The Rust unit has `SuccessExitStatus=143`, so a clean stop is `Stopped` and
  `backend stop` exits 0. A crash, `SIGKILL` or exit 1 still leaves it `NeedsRepair`, and the stop
  is then reported as incomplete.
- **F3.** `start-rust` accepts `MissingLinger`, the same as explicit start. It prints the
  lingering remediation to stderr, and status and explicit start print it as well.
- **F4 (mechanism confirmed live).**
  - The backend's readiness probe (`observe_supervisor`) takes `flock -n -x` on `launch.lock` as
    soon as `systemctl start` returns. The Rust launcher's non-blocking lock then lost the race.
  - The launcher now waits up to 3 s for such a probe to release the lock. It polls every 10 ms
    and waits only on `EWOULDBLOCK`. A real owner holds the lock for its whole lifetime, so it is
    still refused once the bound passes.
  - The fixed agent logged `managed launch lock was briefly held by an observer; acquired after
10 ms` on 6 of about 16 launches during the re-run, during setup and an autostart. With the
    old code, each of those launches would have exited with "managed launch is already owned".
  - The contention was not seen during the three re-run reboots themselves, so the boot-time
    attribution is inferred from that mechanism.
- **F5.**
  - systemd 249 has no start limit that counts only failures, but `reset-failed` is its
    documented way to clear the start counter. The backend unit therefore has
    `ExecStopPost=-/bin/sh -c 'case $$SERVICE_RESULT in success) exec /usr/bin/systemctl --user --no-ask-password reset-failed $$1;; esac' sh %n`.
  - Only a clean stop clears the counter. Crashes and failed starts keep counting toward
    `StartLimitBurst=6` in 300 s.
  - The backend's unit-reference parser accepts exactly this line, for the backend role only.
- **F6.** `backend start` refuses when either unit is `NeedsRepair` and points to status for the
  repair steps. It reloads the manager only when a unit is not loaded or `NeedDaemonReload=yes`.
  `start-rust` follows the same rule for the Rust unit.
- **F7.**
  - Loader-region hashes now cover a canonical text (`scripts/build-remote-backend-graph.regionHash.ts`).
    Each rolldown `$<n>` binding name that is declared in the file is renumbered by its first
    appearance in the region.
  - The following keep their exact bytes: property keys, shorthand keys, export names, labels,
    strings and undeclared globals.
  - This is a consistent renaming of bindings only. What a free name binds to was never pinned,
    because it lives outside the region.
  - The M1 clean-HEAD build (`posix$1`, raw `4e935102…`) and the current build (`posix$2`, raw
    `462278c7…`) now give the same digest, `1e2e54a3…`.
  - Four pins changed. Each one's raw region hash equals the previously reviewed pin, so the code
    is byte-identical to what was reviewed.
  - A clean `git archive` build plus these changes passed the producer unmodified.
- **Minor.**
  - `backend start` while the backend runs reports "already running" (exit 0).
  - `backend enable` while it runs explains that its preflight needs the state directory, and
    says to stop the backend first.
  - The CLI adds the native launcher's own `Caused by:` refusal lines, or a per-action in-use
    message. Its own messages, which can contain account paths, stay private.
- **Compatibility.** Both unit texts changed while keeping their `v1` headers. Units staged by an
  earlier build are refused as `account units differ`, so those accounts need setup again.

### Re-run (Lima `bb-m1-fix`, same recipe; graph and agent from `git archive` HEAD `fe47046736` plus only these changes)

| #       | Check                                                         | Result   | Key evidence                                                                                                                                                      |
| ------- | ------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | Setup (linger)                                                | **PASS** | Exit 0; Rust Active                                                                                                                                               |
| 2       | Start without boot startup; start again; enable while running | **PASS** | Unit `disabled`, `Linger=yes`; second start "already running" (exit 0); enable explains stop-first (exit 1)                                                       |
| 3       | `systemctl --user stop` of the backend                        | **PASS** | `server exit { code: 0 }`, `Stopped`                                                                                                                              |
| 4       | `kill -9` of the backend                                      | **PASS** | `status=9/KILL`, restart counter 1, handshake after 1 s                                                                                                           |
| 5b      | 8 clean `systemctl` stop/start cycles in 23 s, boot enabled   | **PASS** | All rc 0, `NRestarts=0`, no `start-limit-hit`                                                                                                                     |
| 6       | Six `kill -9` → crash-loop limit                              | **PASS** | `Start request repeated too quickly`, NeedsRepair, crash-restarts=6                                                                                               |
| 6 + F6  | `backend start` on NeedsRepair; documented repair             | **PASS** | Start refused, exit 1, unit untouched; after `reset-failed` both + `backend start`, Active                                                                        |
| 7       | Rust terminal survives a backend `kill -9`                    | **PASS** | Same shell PID, start time and Rust cgroup; reattach `historyUnavailable: true`                                                                                   |
| 8       | `backend stop` → `backend start`, three times on one boot     | **PASS** | Stop exit 0, Rust `Stopped`, `launch.exit=143`; each start relaunched Rust under a new PID                                                                        |
| 9       | `SIGTERM` to Rust; restart by backend crash, then stop/start  | **PASS** | Exit 143, `Result=success`, `launch.exit=143`, PTY reaped; both restart paths relaunched Rust                                                                     |
| 10b     | `loginctl terminate-user` (linger)                            | **PASS** | Units stopped cleanly, `launch.exit=143`. The user manager stays down (systemd); once it starts again, boot autostart replaced Rust with no errors                |
| 10c     | No lingering (real `login` session)                           | **PASS** | Setup exit 0 with `setup-complete-v1`; start prints remediation; logout stops both units (143); after a new login, start works                                    |
| 11      | Boot autostart, enabled                                       | **PASS** | 3 of 3 reboots: backend and Rust active, handshake within 1 s, no lock or readiness errors                                                                        |
| 12c/12d | Unproven Rust death (`SIGKILL`)                               | **PASS** | No receipt; Rust NeedsRepair; stop exit 1; start refused; after `reset-failed`, the backend refuses ("no verified … identity") until start limit; reboot recovers |

The VM was deleted afterwards. Containers were run with `--rm`, and their volumes were removed.
Evidence: `/tmp/bigbud-m1-fix-20261117T230500Z/`, archived as
`~/DevWorld/bigbud-evidence/tmp-bigbud-evidence-20261118-m1-fix.tar.zst` with a `.sha256` file.
The archive contains no private key.
