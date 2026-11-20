# M2 and M3 live acceptance (deployment, multiple clients, safe runtime updates)

**Date:** 18 November 2026, 05:46–07:02 UTC
**Plan:** [Remote completion plan](../plans/2026-11-17-remote-completion-plan.md), M2 (WP-3A to WP-3D) and
M3 (WP-4A to WP-4D) live checklists
**Related:** [WP-3A deployment](2026-11-17-wp-3a-backend-deployment-relay-profiles.md),
[setup adoption](2026-11-17-remote-backend-setup-adoption.md),
[multi-client approval](2026-11-17-remote-multi-client-approval-answer.md),
[WP-4C operation](2026-11-17-runtime-update-operation-wp4c.md),
[WP-4D activation](2026-11-18-runtime-update-activation-wp4d.md),
[workspace-mode reservation](workspace-mode-reservation-2026-11-17.md),
[M1 live acceptance](2026-11-17-m1-live-systemd-acceptance.md) (Lima recipe)
**Source under test:** `git archive` of `55bb012f73` (the working tree was not used). Three later
commits (`9342412b8f`, `d8beeded52`, `ec4572ff2c`) landed during the run. None of them touches the
files named in the findings below, so the findings still apply to HEAD.

**Verdict: M2 is accepted with one blocking finding; M3 is not accepted.**

- **M2.** Deployment, retry, adoption, the hash pin, relay leases, multiple clients and relay
  binding all pass. F-M2-1 stands: the laptop runs setup over SSH with an empty local environment.
  It broke deployment from the macOS laptop in this harness, and it breaks hosts that need
  `ssh-agent`.
- **M3.** On an unmodified build, no runtime update can activate on a managed backend. There are
  three blocking causes (F-M3-1, F-M3-3 and F-M3-4), and a fourth (F-M3-2) stops ordinary updates
  for good after any provider turn.
  - With three small validator-only patches (D-1 to D-3, below), every M3 row was exercised live,
    and the drain, consent, disk gate, downgrade refusal, trial, rollback, restore and manual
    recovery logic all behaved as documented.
  - A PASS marked † means "PASS only with those deviations".

## Environment

- **Host:** macOS with Lima 2.3.0 and OrbStack. One disposable VM, `bb-m23`: vz, Ubuntu 22.04.5
  arm64, systemd 249, 2 CPUs, 4 GiB of memory, a 16 GiB disk and `mounts: []`. Guest SSH was
  forwarded to `127.0.0.1:60223` and every other port forward was ignored.
- **VM accounts:** all have lingering on, and the validator's SSH key is in `authorized_keys`.

  | Account  | Used for                                                      |
  | -------- | ------------------------------------------------------------- |
  | `bbsvc`  | macOS laptop: D5 refusal and reservation; workspace-mode rows |
  | `bbm2b`  | M2: adoption, retry and multiple clients                      |
  | `bbdiag` | F-M2-1 diagnosis                                              |
  | `bbm3`   | M3 on graphs p (D-1 only)                                     |
  | `bbm3b`  | M3 on graphs q (D-1 and D-2)                                  |
  | `bbm3c`  | M3 on graphs r (D-1, D-2 and D-3)                             |

- **Builds:** everything was built from the snapshot and signed with one throwaway Ed25519
  fixture key, `dev-fixture-m23`, whose private key was never archived.
  - Server bundle: `bunx tsdown` with both configs. The clean snapshot passed the loader policy,
    so no pin was changed.
  - Graph X, `0.1.613-dev.m23a`: archive sha256 `444468fa…f75d422`, buildDigest `e9a1925f…20d2e`,
    8,058 files.
  - Musl agent `0.3.3-m23.9178a4939cc7` (protocol 1.8), sha256 `3449d521…31cb5ff`. It was built in a
    disposable `node:24.13.1-bookworm --rm` container with rustup 1.95.0.
  - Every graph and manifest hash is in `logs/artifact-hashes.txt` in the evidence archive.
- **Laptop backends:**
  - **macOS (laptop A):** the snapshot `dist/bin.mjs --mode web` with a scratch `--base-dir` and
    `HOME`. An `ssh` wrapper in `PATH` pinned a harness `-F` config and `known_hosts`. The wrapper
    was needed because the server merges the login-shell `PATH` ahead of the process `PATH`
    (`utils/os-jank.ts:41`), so a stand-in `SHELL` was also set. Two early calls that reached the
    system `ssh` are voided (INVALID).
  - **Linux laptops (L1 to L5):** after F-M2-1, deployment was driven from a disposable OrbStack
    container, `node:24.13.1-bookworm`, running graph X's own server in `--mode web`. The container
    reached the VM at `host.docker.internal:60223`, and its root `~/.ssh` held the harness key and
    `known_hosts`.
- **Provider:** a fake Codex app-server (`tools/fakeCodex2.mjs`), derived from the WP-6A measurement
  fake. `SLOW:<s>` makes long turns, `APPROVAL` sends `item/commandExecution/requestApproval` and
  waits for the answer, and `turn/interrupt` is honoured. No real credentials were used.
- **Clients:**
  - M2 ran through real relay leases opened by the laptop backend:
    `server.openRemoteBackendRelay`, then `/ws` on the lease's loopback URL with its local
    credential.
  - M3 ran on the host as the backend account, over the private client socket and client token.
    That is the same surface the relay helper uses (`clientRelay.remote.ts`), and the same
    setup-authority class.

## Validator-only deviations (snapshot copies, never the repo)

| Id  | Why                                                                                                                     | Change (validator graphs only)                                                                                                                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H-1 | F-M2-1 plus harness `known_hosts` isolation made macOS-driven deployment impossible without editing the user's `~/.ssh` | Laptop role in a Linux container from M2 check 2 on                                                                                                                                                                 |
| D-1 | F-M3-1: the managed backend never sees `BIGBUD_REMOTE_BACKEND_GRAPH_DIR` or `BIGBUD_REMOTE_AGENT_INSTALL_SOURCE_PATH`   | `RemoteRuntimeUpdate.remote.ts` and `runtimeUpdate.graphSource.ts` read both from `~/.bigbud/m23-dev-update-env.json`, with a per-version graph directory (`logs/deviation-D1.diff`)                                |
| D-2 | F-M3-3: `systemctl --user` from the backend has no bus                                                                  | The unit exec passes `XDG_RUNTIME_DIR=/run/user/<uid>` and `DBUS_SESSION_BUS_ADDRESS`, as `localSupervisorService.references.manager.ts:18` already does (`logs/deviation-D2-*.diff`)                               |
| D-3 | F-M3-4: the restart request kills its own `systemctl` child                                                             | `restart()` ignores an `execFile` rejection whose signal is `SIGTERM` (`logs/deviation-D3-*.diff`)                                                                                                                  |
| T   | Test graphs for M3 rows 9 and 11                                                                                        | Never-ready: a post-build edit holds `signalCommandReady` (`yield* never`). Unbootable: `process.exit(3)` at the top of `bin.mjs`. Package versions were bumped to 0.1.614, 0.1.615 and 0.1.616 to give an ordering |

## Results

### M2 checks

| #   | Check                                                                        | Result                     | Key evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ---------------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | D5: an unapproved host is refused before any remote command                  | **PASS**                   | `approval-required` on macOS laptop A (bbsvc) and container L1 (bbm2b). Only the read-only registry probe ran                                                                                                                                                                                                                                                                                                                                                                                                           |
| 1   | `setupRemoteBackend` with `enableBoot: false`: unit disabled, profile listed | **FAIL on macOS (F-M2-1)** | macOS laptop: `setup-failed` within 4.8 s on two accounts. The `backend setup` SSH call never reached the harness `ssh`, because it ran with `env={HOME:/home/<remote>, LANG}`                                                                                                                                                                                                                                                                                                                                          |
| 1   | Same, from a Linux laptop                                                    | **PASS**                   | Fresh setup through a saved-project approval: bbm3, bbm3b, bbm3c. Adoption: bbm2b. The backend unit is `disabled` and `active`. `listRemoteBackendRelayProfiles` reports `available` with `rb-<authority>`. Two leases opened, and the handshake through each matched the pinned authority and installation fingerprint                                                                                                                                                                                                 |
| 1a  | Adoption of existing managed-agent state                                     | **PASS**                   | Managed agent installed and connected by the laptop, with a laptop terminal (shell 26218 and `sleep` 26234) on bbm2b. After deployment: supervisor PID 23668 unchanged, the shell and `sleep` still running, both laptop pins (`connection:` and `terminal:`) still in the registry, and `setup-admit-<rid>` added. The Rust unit stayed `inactive`, because the backend proxies to the adopted supervisor                                                                                                              |
| 2   | Kill the laptop backend during setup, then retry with the same `requestId`   | **PASS**                   | `kill -9` of the laptop 1.5 s after the setup SSH started. The remote setup ended with the session, before the claim, so it wrote no `account-authority-v1` and no `setup-complete-v1`. The same-rid retry completed in 48 s and wrote one `setup-complete-v1` with that `requestId`. Another same-rid call returned the stored profile in 2 ms with no remote call. The same rid with another `enableBoot` gave `conflict`, and a new rid for the same host gave `conflict` ("already has a deployed backend profile") |
| 3a  | `hash-mismatch` keeps the previous install                                   | **PASS**                   | A fresh laptop L2 with a corrupted provenance pin. The host was approved through the managed-build probe (the second D5 path). Result `hash-mismatch`. The `backend-graphs` listing, the `complete` sha256 and the `du` were byte-identical before and after. The remote stage script with a wrong pin exits 65 and removes only its staging directory                                                                                                                                                                  |
| 3b  | `curl` blocked on the VM: laptop-upload fallback                             | **PARTIAL**                | With an iptables owner-match REJECT on 443 for the account, `fetch-url` exits 75, which is the fallback trigger. The laptop-upload path (`fetch-stdin`) carried every deployment here. The end-to-end release flow (curl fails, then the laptop uploads) cannot be driven with a dev graph: local sources have no `archiveUrl` (`deployment.source.ts:104-109`, `deployment.fetch.ts:139`), and the release source needs a published GitHub release                                                                     |
| 4a  | Two clients: the same command id gives one receipt                           | **PASS**                   | Clients A and B on separate leases sent one `thread.create` at the same time. Both got `{sequence:3}`, the outcome was `accepted`, a different payload under that id was refused with `command_id_conflict`, and there was one `thread.created` event                                                                                                                                                                                                                                                                   |
| 4b  | One approval answer; the second gets "already resolved"                      | **PASS**                   | A real fake-provider approval. B saw the pending request, A accepted it, the provider resolved it, and B's answer was refused with "Approval request … was already resolved." There was one `thread.approval-response-requested` and no `respond.failed` activity                                                                                                                                                                                                                                                       |
| 4c  | A fresh client's snapshot plus tail equals live                              | **PASS**                   | Client C on a third lease. Live sequences 1–24 had no gaps. The tail after snapshot sequence 21 equalled the live suffix (3 events), and the folded titles equal live and the final summaries                                                                                                                                                                                                                                                                                                                           |
| 5   | Window binding at the RPC and handshake level                                | **PASS (RPC level only)**  | Through the lease, the handshake authority equals the pinned profile. Lease A refuses lease B's credential (401) and a missing credential (401). A foreign `Origin` is refused for HTTP (403) and for the WebSocket upgrade. `http://127.0.0.1:<port>` is accepted. Not covered: the renderer `?backend=` window, backend-scoped storage and the packaged `bigbud://app` origin                                                                                                                                         |

### M3 checks (WP-4D live checklist)

| #   | Check                                                                                      | Result                                      | Key evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------ | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Handshake `runtimeUpdates: true`                                                           | **PASS**                                    | HEAD graph X (through the relay and on the host), p1, q1 and r1                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| —   | `local-graph` update on an unmodified HEAD backend                                         | **FAIL (F-M3-1)**                           | The operation failed: "Local-graph updates need BIGBUD*REMOTE_BACKEND_GRAPH_DIR on the backend host." A `release` request failed with "Backend graph release … is unavailable". The managed process environment holds only `HOME`, `PATH`, `LANG` and `BIGBUD*\*` service variables                                                                                                                                                                                                                               |
| —   | Activation on graphs with D-1 only                                                         | **FAIL (F-M3-3)**                           | `failed`: "Activation failed before the restart; the previous runtime keeps running. … Failed to connect to bus: $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined". The old runtime stayed up and `runtime-update/` was empty                                                                                                                                                                                                                                                                           |
| —   | Activation on graphs with D-1 and D-2                                                      | **FAIL (F-M3-4), 2 of 2**                   | The unit did restart, but on the old config. Run 1 left the operation `activating`, and the next start settled it as "Activation stopped before the runtime switched". Run 2 recorded "Command failed: systemctl … restart" with empty stderr. `config-v1` and the receipt were rewritten (pointed, then restored) at the same second as the restart                                                                                                                                                              |
| 2   | Deferred update during a long turn; activates after                                        | **FAIL (F-M3-2) / PASS† with a workaround** | `deferred`, listing the turn, while it ran (on p1, q1 and r1). After the turn completed, it stayed `deferred` for over 6 minutes, because each idle provider session is listed as `other: <thread>#provider`. After an operator `systemctl --user restart` of the backend unit, the persisted operation resumed and was `activated` on r1 to r2: `backendVersion` 0.1.614, `runtime-update/` empty, archive pointer active `0.1.614-dev.m23r2@…` with `previous: null` (documented gap), message counts unchanged |
| 3   | A pending approval blocks the update                                                       | **PASS**                                    | q1: `deferred` with a `turn`, `approval` and `other` item. The approval stayed pending and answerable for about 60 s and across 3 or more retries. After the answer, the fake got `accept` and the turn completed. The operation then stayed deferred (F-M3-2) and was cancelled                                                                                                                                                                                                                                  |
| 4   | Interrupting update with consent; the turn interrupted, not replayed; queued prompts flush | **PASS†**                                   | r2 to r5: a `SLOW:150` turn plus a queued prompt (`thread.prompt-queued`, seq 64). The digest was confirmed. One `thread.turn-interrupt-requested` (seq 79) and `turn-settled interrupted` (seq 82). There is no second copy of the interrupted user message. `thread.queued-prompts-flushed`, then the queued turn started at 06:47:02.693, right after activation, and completed                                                                                                                                |
| 5   | Stale consent gives `consent-stale`                                                        | **PASS**                                    | q1: digest D1 read, then a new turn on t2, then consent with D1. The RPC failed with `consent-stale` ("The affected work changed; review it and confirm again."). The operation stayed `deferred` with consent `none`, and the fake received 0 interrupts                                                                                                                                                                                                                                                         |
| 6   | The Rust terminal PID is unchanged across the update                                       | **PASS†**                                   | Shell 86003 (start tick 334665, cgroup `bigbud-rust-<auth>.service`) and the Rust MainPID 83497 were unchanged across 2 activations, 2 rollbacks, a 6-crash loop and the manual recovery                                                                                                                                                                                                                                                                                                                          |
| 7   | A full disk is refused before any outage                                                   | **PASS**                                    | q1, with `fallocate` leaving 150 MiB. `failed`: "Not enough disk space to update safely: 275 MiB needed (… reserve 256 MiB), 150 MiB available. Nothing was stopped; free space and retry." MainPID 75046 unchanged, handshake 200                                                                                                                                                                                                                                                                                |
| 8   | Downgrade refused                                                                          | **PASS**                                    | On r5 (0.1.614), a request for `0.1.613-dev.m23r1` failed: "Downgrading from 0.1.614 to 0.1.613-dev.m23r1 is refused … Nothing was stopped." MainPID unchanged (see O-4)                                                                                                                                                                                                                                                                                                                                          |
| 9   | A failed trial rolls back with acknowledged rows intact                                    | **PASS†**                                   | r5 to r3 (never ready). The trial logged the withheld readiness, the journal went `restarting` then `restore-pending` at +120 s, and the old runtime came back. `failed`: "The new runtime did not become ready in time. Rolled back to the previous runtime and database backup; no acknowledged command was lost." Every pre-update event and message was present (latest sequence 114 before; t1/t2/t3 message counts 6/2/0 before and after)                                                                  |
| 10  | An interrupted restore completes on the next start                                         | **PASS†**                                   | A second never-ready trial. During the trial the previous runtime's `node` was set to mode 000, so the rollback restart failed six times (`Permission denied`; `NRestarts=6`, `failed`) with the journal held at `restore-pending`. After mode 700, `reset-failed` and `start`, the restore ran, the operation settled with the rolled-back message, and the journal was cleared. Message counts unchanged                                                                                                        |
| 11  | Manual recovery for an unbootable graph                                                    | **PASS†**                                   | r5 to q4 (`process.exit(3)`): `status=3` six times, then start-limit `failed`, with the journal left at `restarting`. Recovery followed the WP-4D Gaps steps: write `previousConfig` and `previousReceipt` back, `reset-failed`, `start`. The old runtime rejected the trial ("not running the staged runtime"), rolled back and restored, and settled. Message counts unchanged                                                                                                                                  |
| WS  | Workspace-mode reservation, both orders, including a symlink alias                         | **PASS**                                    | A laptop SSH project on `/home/bbsvc/demo` created `1.json` (`laptop-runtime`). The remote backend's `project.create` was refused for both `demo-link` (symlink) and `demo` with the laptop-runtime message. The reverse also holds: after a remote project on `ws2` (`remote-runtime`), the laptop SSH project on `ws2-link` was refused with the remote-runtime message                                                                                                                                         |

## Findings (read-only diagnosis, no product change)

- **F-M2-1 (blocking for agent or passphrase-key users; blocked macOS deployment here): the
  remote command environment replaces the local `ssh` process environment.**
  - `runDeploymentSsh` passes the whole `DeploymentRemoteCommand`, `env` included, as the
    `runBoundedProcess` options (`apps/server/src/remote-backend/deployment.ssh.ts:98`).
    `runBoundedProcess` then spawns `ssh` with `env: options.env` (`:42`).
  - For `backend setup` and `start`, that env is `backendEnv(home) = {HOME: <remote home>, LANG}`
    (`deployment.remoteSetup.ts:148`, `:185`). The local `ssh` therefore runs with no `PATH`, no
    `SSH_AUTH_SOCK` and a foreign `HOME`. The remote env is already encoded into the remote command
    by `buildSshCommandInvocation`, so it needs no local copy.
  - Proof: `logs`/`live/F-M2-1-proof.log` spawns `/usr/bin/env` through `runBoundedProcess` with
    the same options and prints only `HOME=/home/bbsvc` and `LANG=C.UTF-8`.
  - Consequences: keys held only in `ssh-agent`, which includes every passphrase key (bigbud
    requires those to be loaded in the agent), cannot authenticate the setup and start steps. The
    earlier probe, staging and upload steps work, because they carry no `env`. A `ProxyCommand`
    that needs `PATH` breaks too. Setup then reports a generic `setup-failed`.
- **F-M3-1 (blocking for dev and CI updates): runtime-update inputs never reach the managed
  backend.**
  - The launcher clears the environment and sets only `HOME`, `PATH`, `LANG` and the `BIGBUD_*`
    service variables (`crates/bigbud-remote-agent/src/backend_service/config.rs:304-318`).
  - So `local-graph` updates always fail at `runtimeUpdate.graphSource.ts:73-74`.
  - `makeRemoteAgentInstallSourceLoader()` (`Layers/RemoteRuntimeUpdate.remote.ts:89`) reads
    `process.env`. It always falls back to the GitHub "latest" install source, so
    `BIGBUD_REMOTE_AGENT_INSTALL_SOURCE_PATH` cannot apply.
  - `release` updates need a real GitHub release whose graph is signed by a release key. Dev
    fixture keys are not accepted on that path (`deployment.source.ts:149`, `extraKeys: {}`).
  - Net: before a signed release exists, no M3 path can be exercised on a managed backend. A
    private config file or service-config field would be needed.
- **F-M3-3 (blocking): `systemctl --user` from the backend has no user bus.**
  - `makeRuntimeUpdateServiceUnit` runs `/usr/bin/systemctl --user … restart` with the inherited,
    cleared environment (`runtimeUpdate.unit.ts:85-88`, `:130-138`).
  - Without `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS`, every activation fails before the
    restart. It does fail safely: the config is restored and there is no outage.
  - The same codebase already exports both variables for its own systemctl calls
    (`localSupervisorService.references.manager.ts:18`). The rollback `restart()` in
    `runtimeUpdate.activate.resume.ts` depends on the same call.
- **F-M3-4 (blocking once F-M3-3 is fixed): the restart request kills itself, and then the switch
  is undone.**
  - The backend unit uses `KillMode=control-group` (`backend_service/unit.rs:66`). The
    `systemctl --no-block restart` child runs inside the unit being restarted, so it can be
    SIGTERMed before `execFile` resolves.
  - `attemptRuntimeActivation` treats that as "restart request failed". It restores the previous
    config and receipt and clears the journal (`runtimeUpdate.activate.ts:130`, `:140-150`) while
    systemd is already restarting the unit. The new process therefore starts the old graph.
  - Observed 2 of 2 times. Either the operation is failed in the dying runtime, or it is left
    `activating` without a journal and the next start reports "Activation stopped before the
    runtime switched".
  - Once the restart has been requested, the code should not undo the switch. For example, run the
    restart outside the unit's cgroup (`systemd-run --user --no-block` or a transient scope), or
    treat a SIGTERM of the child after the journal is written as "requested".
- **F-M3-2 (high): ordinary updates never activate after any provider turn.**
  - The drain probe lists every `worktree_runtime_leases` row with `runtime_kind <> 'terminal'`
    (`runtimeUpdate.drain.probe.ts:44-47`). That includes the lease of an idle but live provider
    session. An automatic update therefore stays `deferred` until the backend restarts.
  - `thread.session.stop` does not end an idle session. `processSessionStopRequested` only
    interrupts an active turn and records turn control (`orchestration/Layers/
ProviderCommandReactorHandlers.session.responses.ts:146-171`). Reproduced on the unmodified HEAD
    backend (bbm2b): the fake provider was still alive 60 s or more after the stop. This is likely
    the same as WP-6A F-B10.
  - Stale rows make it worse. After a backend stop that hit `SIGKILL` (O-2), or a database restore
    from a backup taken while a provider was alive, the lease row survives without a process. The
    update stayed blocked by `t1#provider` with no provider running.
  - The provider-lease sweep runs every 5 minutes, and only for runtime rows that are not
    `starting` or `running` (`retention/threadLeaseSweep.ts:10-11`, `:32`).
  - Interrupting updates are affected only by an extra 30 s settle, and the thread is then
    reported `uncertain`.
- **O-1:** after the laptop backend was `kill -9`ed, `terminal.open` and `terminal.remoteAttach`
  for the surviving remote terminal were refused with "Previous remote input controller is live or
  unconfirmed". The shell PID survived. This was not investigated, and it is outside M2 and M3.
- **O-2:** 4 of the 9 activation and rollback stops of the backend unit hit `TimeoutStopSec=15`
  and `SIGKILL` (07:46:59, 07:51:17, 07:53:35 and 07:55:16 local in
  `live/vm-journal/uid-1005.log`). Three came after an interrupting drain with an uncertain
  provider thread, and one was the first never-ready trial runtime. Data stayed safe because of
  the offline backup, but leases are not released (F-M3-2).
- **O-3:** the desktop and web laptop backends merge the login-shell `PATH` ahead of their own
  (`utils/os-jank.ts:41`). This was a harness note only.
- **O-4:** the downgrade refusal happens only after the full graph is staged (about 15 s plus disk)
  (`runtimeUpdate.activate.ts:74`). It could be refused at request time from the manifest version.
- **O-5:** the first update records no rollback version (`previous: null`), as documented.

## Repro steps

1. `git archive 55bb012f73`; clone `node_modules` with `cp -cR`; in `apps/server` run
   `bunx tsdown && bunx tsdown -c tsdown.clientRelay.config.ts`; then run
   `bun run remote-backend-graph --target aarch64-unknown-linux-gnu --key-file <ed25519> --key-id dev-fixture-m23 --version 0.1.613-dev.m23a --node-archive <pinned node 24.13.1>`.
2. Build the musl agent in `node:24.13.1-bookworm --rm` and sign a schema-1 manifest. The
   `bundledPath` must exist at the same absolute path on the laptop and on the VM, because remote
   `backend setup` reads `bundledPath` or `url` on the host. Then write `{manifest, trustStore}` as
   the install source.
3. Lima VM (`tools`'s `bb-m23.yaml`, `mounts: []`, `ssh.localPort: 60223`); create users with
   lingering.
4. **F-M2-1:** start a laptop backend with `BIGBUD_REMOTE_BACKEND_GRAPH_DIR`,
   `…_TRUSTED_KEYS` and `BIGBUD_REMOTE_AGENT_INSTALL_SOURCE_PATH`. On a host whose key is not in
   the real user's `~/.ssh/known_hosts`, or with an agent-only key, `server.setupRemoteBackend`
   returns `setup-failed`, and no `bin.mjs backend setup` SSH reaches a `PATH`-wrapped `ssh`.
5. **F-M3-1:** on any deployed HEAD backend, call `server.requestRemoteRuntimeUpdate` with
   `{source:"local-graph"}`. The operation fails with the env message.
6. **F-M3-3 and F-M3-4:** with D-1 only, any activation fails with "Failed to connect to bus". With
   D-1 and D-2, the activation restarts the unit on the old config.
7. **F-M3-2:** run any turn on the fake provider, then request a non-interrupting update. It stays
   `deferred` with `other: <thread>#provider`. `thread.session.stop` does not change that.

## What remains for the user

- Fix F-M2-1, F-M3-1, F-M3-3, F-M3-4 and F-M3-2, then re-run M3 rows 2, 4, 6, 9, 10 and 11 without
  deviations, and M2 row 1 from a macOS laptop using an agent-held key.
- Run M2 row 3b end to end with a published, release-signed graph and `curl` blocked.
- Live UI coverage was not attempted: the `?backend=` window, backend-scoped storage, WP-4E update
  UI and the packaged `bigbud://app` origin.
- M2 "30-minute recovery" and two physical laptops were not run (two relay leases from one laptop
  backend, plus a third client, stood in).
- Native x86_64 and a real VPS were not covered.

## Evidence and teardown

- **Evidence:** `/tmp/bigbud-m23-20261118T054625Z/` was archived as
  `~/DevWorld/bigbud-evidence/tmp-bigbud-evidence-20261118-m2-m3-live.tar.zst`, with a `.sha256`
  file.
  - It contains `logs/` (builds, deviation diffs, artifact hashes, teardown), `live/` (one log per
    row, the VM journals per account, `ssh-capture`/trace and `invalid/`), `tools/` (drivers, fake
    provider, scripts) and `artifacts/` (provenance and manifest hashes only).
  - It contains no private keys or tokens. It was scanned for the laptop token and the five client
    tokens before archiving.
- **INVALID (voided and redone):**
  - Two macOS deploy attempts that used the system `ssh`.
  - One stage-script curl test that removed `sh` from `PATH`.
  - The p-series M3 account. Its runtime cannot update (F-M3-3), so it was replaced by the q and
    r series. Its rows above are kept only as F-M3-1, F-M3-2 and F-M3-3 evidence.
- **Teardown:**
  - The VM `bb-m23` was stopped and deleted (`limactl list`: no instances).
  - The container `bb-m23-laptop` was removed, and with it the in-container key copy. The build
    container ran with `--rm`.
  - The macOS laptop backend was stopped.
  - The snapshot, build directories, graph archives and fixture key under `/tmp` were deleted.
  - No other VM or container was touched.

## Fixes and re-run

**Date:** 18 November 2026, 07:25–08:10 UTC. **Source under test:** `git archive` of `3235c1c7a9`
plus the uncommitted fixes below (snapshot, not the working tree). **No product patches:** the
only edits to built graphs are the two test graphs (never-ready `d`/`d2`, unbootable `e`/`e2`).

### Root causes and fixes

| Finding | Root cause                                                                                                                                                                                                                                                                                                                                                                                                                     | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-M2-1  | Confirmed (unit test fails on the old code: the local `ssh` saw no `SSH_AUTH_SOCK`). `runDeploymentSsh` passed the remote command's `env` as the local spawn env.                                                                                                                                                                                                                                                              | `sshCommand.ts` names the shared local-client policy (`sshClientProcessEnv()`: the server's own env, the same env every other SSH flow already spawns `ssh` with). `deployment.ssh.ts` keeps `command.env` for the remote command only and spawns `ssh` with `localEnv: sshClientProcessEnv()`.                                                                                                                                                                                                                                                             |
| F-M3-1  | Confirmed (live: "need … update inputs"). The launcher clears the environment, so dev variables can never arrive.                                                                                                                                                                                                                                                                                                              | Owner-private `~/.bigbud/backend-services/<authority>/runtime-update-dev-inputs-v1` (mobile inputs-file pattern), written once by `bigbud backend update-inputs set --authority --graph-versions-dir [--trusted-keys] [--install-source]`, read per `local-graph` request (`<dir>/<version>/`). Release updates ignore it. One release rule for laptop and backend (`developmentOverrides.ts`): refused when `BIGBUD_DESKTOP_PACKAGED=1` or the bundle carries `bigbudReleaseTag`; the release graph workflow now stamps that tag before bundling.          |
| F-M3-3  | Confirmed (D-2 evidence; live: activation now reaches systemd).                                                                                                                                                                                                                                                                                                                                                                | `userSystemdBus.ts` holds the validated `/run/user/<uid>` bus preamble, now shared by `localSupervisorService.references.manager.ts` and the update restart.                                                                                                                                                                                                                                                                                                                                                                                                |
| F-M3-4  | Confirmed (D-3 evidence; the `systemctl` child sits in the cgroup being stopped).                                                                                                                                                                                                                                                                                                                                              | The restart is requested from a transient user unit (`systemd-run --user --no-block --collect`, outside the backend cgroup; returns once queued). Exit status ≠ 0 means nothing was queued (`RuntimeUnitRestartRefused`), so only then is config restored. A killed or timed-out requester is `unconfirmed` and treated as requested. After any request the runtime never restores: it waits 60 s, repeats the idempotent request up to 5 times, then logs; the next start's trial decides. Shared by activation and rollback (`runtimeUpdate.restart.ts`). |
| F-M3-2  | Confirmed, three parts: (1) the probe listed provider leases, which follow a live session, not work; (2) `processSessionStopRequested` only interrupted; (3) **new:** `ProviderSessionRuntimeRepositoryLive` was only `Layer.provide`d to the session directory, so ingestion's `Effect.serviceOption` got `None` and the startup reconcile of stale `running` rows never ran in production (reproduced live after a SIGKILL). | (1) The drain probe excludes `provider` leases (running turns stay blocking via the read model and admissions). (2) `thread.session.stop` on an idle session stops the live provider session and projects it `stopped`; an active turn is still only interrupted. (3) `server.providerLayers.ts` exports the repository (`provideMerge`), guarded by a type-level test that fails without it.                                                                                                                                                               |
| O-4     | The refusal ran at activation.                                                                                                                                                                                                                                                                                                                                                                                                 | `request` refuses a known downgrade (`runningVersion` dep) before staging; activation still re-checks the manifest.                                                                                                                                                                                                                                                                                                                                                                                                                                         |

### Observations not fixed

- **O-1, root cause confirmed, not changed.** `node:24.13.1-bookworm` has no `/etc/machine-id`, so the
  laptop's controller scope is `unknown`, and `isRemoteAgentControllerAlive` fails closed for every
  foreign controller. A real fix needs a machine-identity fallback design, because a boot-id scope
  would stay stuck after a reboot.
- **O-2, reproduced and narrowed, root cause not confirmed.** 9 of the 13 stops driven by an update
  hit `TimeoutStopSec=15`. Fresh or idle runtimes stopped in under 0.1 s, including with an idle
  provider session, a gate that was closed at start and then reopened, a staging failure under the
  lock, and a SIGTERM to the whole cgroup.
  - A Node report taken from a stuck runtime 3 s into its stop showed an idle JS thread and an idle
    loop, with the HTTP listener still open. A scope finalizer is waiting asynchronously.
  - It is not a provider stop (that is bounded at 3 s), and not the `--proxy` child.
  - Data stayed safe, and stale leases are now reconciled at startup.
- **O-6 (new).** Every runtime that starts after a database restore appends a server
  `project.created __chats__` event (sequences 199, 200 and 201). These are not client commands, and
  the acknowledged rows are intact.

### Live re-run (unpatched)

Laptop: macOS host, snapshot `dist/bin.mjs --mode web`, `SSH_AUTH_SOCK` = a dedicated `ssh-agent`
holding a passphrase key (unusable without the agent: `Permission denied (publickey)`). Harness-only
isolation: an `ssh` wrapper adding `-F` (pinned `known_hosts`, so `~/.ssh` was untouched) and a
stand-in `SHELL`. VM `bbfix`: Lima vz, Ubuntu 22.04 arm64, systemd 249. Musl agent
`0.3.3-fix.3235c1c7a940` built in `node:24.13.1-bookworm --rm`; all graphs signed with fixture key
`dev-fixture-fix`.

| #      | Check                                  | Result   | Key evidence                                                                                                                                                                                                                                                                                       |
| ------ | -------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M2-1   | macOS setup, `enableBoot: false`       | **PASS** | D5 refusal before approval, then `started` in 57 s. Unit `disabled`/`active`, profile `available`, lease handshake 200 with the pinned authority (401 without credential). Every setup/start `ssh` ran with `SSH_AUTH_SOCK` = the agent socket and the real `PATH`                                 |
| —      | F-M3-1 inputs                          | **PASS** | Without inputs: clear failure naming `bigbud backend update-inputs set`. CLI wrote the 0600 file; a second `set` refused ("already exists")                                                                                                                                                        |
| 2      | Deferred during a turn, then activates | **PASS** | `deferred` listing only `t1#turn` (no `#provider`). Activated about 6 s after the turn ended, no operator restart; systemd logged the transient `systemctl … restart` unit; `backendVersion` 0.1.614; `runtime-update/` empty                                                                      |
| 4      | Interrupting update with consent       | **PASS** | Redone on t2 (the first try raced: the fake read `SLOW:45` from t1's history). Consent at 07:59:24, one `turn/interrupt` at 07:59:25.950, turn `interrupted` 3 ms later (not uncertain), restart 07:59:26, queued prompt's turn started in the new runtime at 07:59:44.951; each user message once |
| 6      | Rust terminal survives                 | **PASS** | Shell 8643 and Rust MainPID 7103 unchanged across 4 activations, 3 rollbacks, two 6-crash loops and manual recovery; reattached with the same PID and accepted input                                                                                                                               |
| 9      | Failed trial rolls back                | **PASS** | Never-ready d2: rollback after the 120 s trial, `failed` "…Rolled back to the previous runtime and database backup…"; events 1–198 and message counts (47/41/3) unchanged (199 = O-6)                                                                                                              |
| 10     | Interrupted restore completes          | **PASS** | Previous node mode 000 during the trial: 6 × `Permission denied`, start-limit `failed`, journal `restore-pending`. After mode 700, `reset-failed`, `start`: restore ran, operation settled with the rollback message, journal cleared, counts unchanged                                            |
| 11     | Unbootable runtime, manual recovery    | **PASS** | e2: `status=3` six times, journal `restarting`. WP-4D manual recovery, then the old runtime refused the trial ("not running the staged runtime"), rolled back and settled; handshake 200, counts unchanged                                                                                         |
| F-M3-2 | Stale lease and idle stop              | **PASS** | Before the composition fix: after SIGKILL, t2 stayed `running` with its lease and no process. With the fix: `stale provider runtime rows marked stopped at startup {stoppedCount: 1}`, lease gone. `thread.session.stop` on idle t3: provider process exited, lease removed, session `stopped`     |
| O-4    | Downgrade before staging               | **PASS** | `request 0.1.600` refused immediately ("Downgrading from 0.1.615 … Nothing was stopped"), nothing staged                                                                                                                                                                                           |

### Checks

- `bunx oxfmt`/`oxfmt --check`/`oxlint` on the 32 changed TS files (explicit list): clean. All
  changed files ≤ 400 lines. `bun run --cwd apps/server typecheck`: clean.
- Focused Vitest: 24 files, 96 tests passed (new: `deployment.ssh`, `runtimeUpdate.restart`,
  `runtimeUpdate.devInputs`, `runtimeUpdate.drain.probe`, `ProviderCommandReactor.sessionStop`,
  `server.providerLayers`, plus a request-time downgrade case and a workflow-stamp case).
- Mutations: the old local ssh env, a restart classifier without the signal case, and dropping the
  repository export each made a test or the typecheck fail.
- No Rust code changed, so no Rust checks were needed.

### Evidence and teardown

`~/DevWorld/bigbud-evidence/tmp-bigbud-evidence-20261118-m2-m3-fixes-rerun.tar.zst` (`.sha256`
beside it): live logs per check, VM journals, the fake-provider log, the ssh-wrapper trace, the O-2
bisection and stop diagnostics, the fixes diff, graph manifests and provenance, the fixture public
key and the harness tools. It was scanned for the laptop token, the SSH passphrase, private keys and
credentials before archiving. The VM `bbfix` was deleted, the laptop backend and `ssh-agent` were
stopped, and the run directories under `/tmp` were removed. No other VM or container was touched.
