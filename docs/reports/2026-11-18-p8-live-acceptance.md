# P8 (M6) peer orchestration live acceptance

**Date:** 18 November 2026, 08:14–09:00 UTC
**Plan:** [Remote completion plan](../plans/2026-11-17-remote-completion-plan.md), M6 (Phase 8 of the
[manual install plan](../plans/2026-11-13-remote-agent-manual-install-plan.md))
**Related:** [WP-8A contracts](peer-orchestration-contracts-2026-11-18.md),
[WP-8B/8C transport](peer-worker-endpoint-transport-2026-11-18.md),
[WP-8D/8E dispatch and pairing](2026-11-18-peer-coordinator-dispatch-and-pairing.md),
[M2/M3 live acceptance](2026-11-18-m2-m3-live-acceptance.md) (Lima recipe)
**Source under test:** `git archive` of `31ad97c358` (the working tree was not used). No product
code was patched.

**Verdict: M6 is not accepted.** Pairing, delegation to two workers, fault recovery, restart,
cancel, revoke, host-key pinning, the forced command and laptop-free completion all behaved as
designed. However, four defects were found (F-P8-1 to F-P8-4). Two of them (F-P8-1 and F-P8-3) can
leave a dispatch unsettled forever, and F-P8-2 stops a restarted worker from accepting any
delegation.

## Environment

- **Host:** macOS with Lima 2.3.0 and OrbStack.
- **VMs:** three disposable Lima VMs, `bb-p8-coord`, `bb-p8-w1` and `bb-p8-w2`. Each was vz, Ubuntu
  22.04 arm64, 2 CPUs, 2 GiB of memory, an 8 GiB disk and `mounts: []`, with every port forward
  ignored.
  - They shared the Lima `user-v2` network: C was `192.168.104.4`, W1 `192.168.104.1` and W2
    `192.168.104.3`.
  - Each had one account, `bbp8`, with lingering on.
- **Builds:** everything came from the snapshot. Signing used a throwaway Ed25519 fixture key,
  `dev-fixture-p8`, whose private key was never archived.
  - Server bundle: `bunx tsdown` with both configs.
  - Graph `0.1.613-dev.p8a`: archive sha256 `91d2ba27…266a0af3`, buildDigest `c2aa2069…30c85167`.
  - Musl agent `0.3.3-p8.31ad97c3581d`: sha256 `78bf4b5d…6c38f368`, built in a disposable
    `node:24.13.1-bookworm --rm` container.
  - All hashes are in `logs/artifact-hashes.txt`.
- **Deployment:** on each VM, `bigbud backend setup … --confirm-fresh-setup` and then
  `backend start` (the M1 direct recipe). No host-side laptop backend was used.
- **Clients:** one-shot drivers run on each VM as the backend account. They used the private client
  socket and client token, which is the surface the SSH client relay uses. Each driver exited after
  its call.
- **Provider:** a fake Codex app-server (`tools/drv/fakeCodex.mjs`), derived from the M2/M3 fake.
  - `SLOW:<s>` produces long turns.
  - `PEERTOOL:<base64>` makes the coordinator's fake issue real `item/tool/call` requests
    (namespace `bigbud_orchestration`) for `delegate_to_host`, `peer_dispatch_status` and
    `peer_dispatch_cancel`. Each tool call therefore went through the production Codex
    dynamic-tool path with a stable invocation id.
- **Fault injection:**
  - `iptables` drops on C, in either direction.
  - Killing the coordinator's `ssh`.
  - A watcher on W1 that SIGKILLs the forced-command helper and drops W1→C SSH replies as soon as a
    new child row or child turn appears (`tools/w-cut*.sh`).

## Harness deviations (no product change)

| Id  | Why                                                                                                                        | What                                                                                                                                                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| H-1 | The worker picks `DEFAULT_MODEL_BY_PROVIDER.codex` (`gpt-6.1-sol`), which the first fake catalog lacked                    | `gpt-6.1-sol` added to the fake `model/list`; worker backends restarted                                                                                                                                      |
| W-1 | F-P8-2: after that restart, W1 refused all delegation (`workspace-unavailable`)                                            | One harmless `thread.session.stop` on an existing W1 child thread hydrated that thread and installed its project, so W1 accepted again (`live/28-W1-hydrate-workaround.log`). W2 needed nothing (see F-P8-2) |
| H-2 | The coordinator's background learning sessions replay the transcript, so the fake re-ran old `PEERTOOL` payloads (see O-2) | The fake runs each payload once (`~/p8/peertool-done`). Three extra dispatches created this way (`faad0a27`, `1cc6a38f`, `dbc5a1cc`) are harness artefacts and are not counted                               |

## Results

| #   | Check                                                                    | Result                       | Key evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------ | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Pairing: key, host-key scan, pin only after explicit confirmation, grant | **PASS**                     | `ensure-key` created `peer_ed25519` (0600 in a 0700 directory) and reused it on a second call. The scanned ed25519 fingerprints equal `ssh-keygen -lf` on each worker. `save` without `confirmPin` and with `confirmPin:false` was refused, and 0 rows were saved. With `confirmPin:true` the state was `awaiting-grant` and the exact grant command was shown. `bigbud peer grant` on each worker wrote one `restrict,command=` line, and `peer list` shows the grant. `record-grant` made the state `active` (`live/11`–`14`)                                                                                                                                                                                                                |
| 2   | `delegate_to_host` to both workers; one delivery per dispatch            | **PASS** (after H-1 and W-1) | One coordinator turn made two tool calls: `0b4248f0` to W1 and `6e4f0405` to W2. Both went `following`, then `completed` about 16 s later, with one `Delegated task …` message each and one `peer-result:` message-sent event each. Each worker has one child row, one `thread.created` and one turn start per dispatch (`live/30`). The first attempt exposed F-P8-1 (`live/20`–`23`)                                                                                                                                                                                                                                                                                                                                                         |
| 3a  | Partition before acceptance; `dispatch-unknown` re-send                  | **PASS**                     | C→W1 port 22 was dropped. The tool returned `sent-uncertain` and probed for 52 s with `send_attempts=1`, and W1 had no row. After the heal, the dispatch went `following` with `send_attempts=2` (the same id re-sent after `dispatch-unknown`), then `completed`. W1 has one child and the thread has one delivery (`live/31`)                                                                                                                                                                                                                                                                                                                                                                                                                |
| 3b  | Reply lost after acceptance; status-only recovery                        | **PASS**                     | The helper was killed and replies were dropped right after the child's turn started. The tool returned `sent-uncertain`, then `following` with `send_attempts=1` (no re-send), then `completed`. One child, one delivery (`live/33`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 3b′ | Same, with the cut between child creation and turn start                 | **FAIL (F-P8-3)**            | `ad157516`: the worker recorded the child and dispatched `thread.create`, but never `thread.turn.start`. The status probe found the child, and the coordinator followed it (`send_attempts=1`, correctly no second child). The child never started and was reported `running` for good, so the dispatch never settled. It was only failed (`dispatch-unknown`) 10 minutes later, when the grant was re-issued (`live/32`, `live/65`)                                                                                                                                                                                                                                                                                                           |
| 3c  | Partition during follow                                                  | **PASS**                     | During the follow, C→W2 was dropped and the follow `ssh` was killed. The child finished during the partition. After the heal, the dispatch was `completed` with one delivery (`live/34`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 3   | Never two children for one dispatch (all runs)                           | **PASS**                     | W1 has 11 child rows for 11 dispatches, and W2 has 10 for 10. No peer command id has more than one `thread.created` or turn start. No dispatch has more than one delivered message (`live/95`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 4   | `systemctl --user restart` the coordinator mid-follow                    | **PASS**                     | The restart came with two dispatches `following` (MainPID 3916 became 6584). The log shows `peer dispatch followers resumed {resumed: 4}`. `14c96ad4` and `eecbec8d` completed, with one delivery each; the second delivery was queued behind the first (`thread.prompt-queued`) and flushed once (`live/40`)                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 5   | Cancel during a partition                                                | **PASS**                     | During the follow, C→W2 was dropped. `peer_dispatch_cancel` returned `cancel-pending`, and the state stayed `cancel-pending` for 30 s. W2 recorded no cancel. After the heal, W2 recorded the cancel at 08:45:12.129, the fake got `turn/interrupt`, the turn ended `interrupted`, and the dispatch went to `cancelled` with one delivery (`live/51`)                                                                                                                                                                                                                                                                                                                                                                                          |
| 6   | Revoke                                                                   | **PASS** (F-P8-4 noted)      | The coordinator revoke made W1 `revoked` and kept the host, pin and grant id; the revoke command was shown. `delegate_to_host host=w1` returned `grant-missing`, and a delegate without a host went to W2. `delete-connection` with unsettled W1 tasks was refused (`pairing-busy`). `bigbud peer revoke` on W1 removed the authorized_keys line, and SSH with the peer key got `Permission denied (publickey)`. The coordinator recorded an `authentication-refused` setup error and its followers stopped. On W1, the client listed the child and showed its detail, and `thread.session.stop` interrupted it. After a re-grant, `delete-connection` removed W1 once it had nothing unsettled, and W1's grant was untouched (`live/60`–`66`) |
| 7   | Host key mismatch                                                        | **PASS**                     | W2's ed25519 host key was replaced. The delegate returned `setupError: host-identity-mismatch`, with the state `sent-uncertain`. sshd logged exactly two pre-auth closes from C (the new dispatch and the existing W2 follower) and nothing more for 60 s. After a re-scan and a confirmed save, the dispatch resumed: `send_attempts=2`, then `completed` with one child (`live/70`, `live/72`)                                                                                                                                                                                                                                                                                                                                               |
| 8   | The peer credential cannot reach client RPC or `/ws`                     | **PASS**                     | Every attempt used only the peer key. An arbitrary command (`id; cat client-token`) produced no output, because the forced command ran instead. A PTY was refused. A unix-socket forward to `remote-backend.sock` was reset when used, and a TCP forward carried no data. `sftp` produced nothing. A `/ws` upgrade got no response. `/api/remote-backend/handshake` and `/api/remote-backend/peer-grants` returned 404. Forged `Authorization` and `x-bigbud-peer-grant` headers were dropped, and the request ran under the real grant, as did the control request (`live/82`)                                                                                                                                                                |
| 9   | Close the laptop: delegation completes alone                             | **PASS**                     | No host backend was used. The driver (the only client) exited right after the delegate, and `ss -x` showed 0 client connections on `remote-backend.sock` throughout. `ff7f1f72` (W1) and `45d8e221` (W2) completed after about 46 s and were delivered once each (`live/90`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## Findings (read-only diagnosis)

- **F-P8-1 (high): a child whose first turn fails to start is reported `running` forever.**
  - On the worker, the first turn failed (`thread.turn-start-failed`). The session went from
    `error` to `stopped`, and no `latestTurn` exists.
  - `resolveThreadWorkflowStatus` then yields `idle` (`orchestration/ThreadWorkflowStatus.logic.ts:239-277`).
    `childState` falls through to `running` (`peer-orchestration/peerWorker.status.ts:73`).
  - Consequences:
    - The coordinator follows `7d541a8f` forever.
    - A cancel stays `cancel-pending` forever, because the worker records intent and there is
      nothing to interrupt.
    - The W2 saved connection can never be deleted (`pairing-busy`).
  - `af791a04` settled only because its probe landed while the session was briefly `error`.
  - Realistic triggers: a missing model, provider or credentials on the worker.
  - Repro: delegate to a worker whose provider rejects the model (`live/20`–`23`).
- **F-P8-2 (blocking, not P8-only): after a restart, a backend cannot create threads in an idle
  project, so a restarted worker refuses every delegation and every new grant.**
  - The engine read model starts as the startup operational window
    (`orchestration/Layers/OrchestrationEngine.ts:138-141`). That window includes only projects that
    have a starting, running or pending thread (`ProjectionOperationalStateQuery.sql.ts:100-120`).
  - `thread.create` hydrates only the new thread id, not its project
    (`OrchestrationEngine.prepareCommandState.ts:30-39`).
  - Effects on W1 after the restart:
    - `peerWorker.delegate.ts:95-105` returns `workspace-unavailable` (3 dispatches failed).
    - `peerGrantOwnerRoute.ts:78-80` makes `bigbud peer grant` return `exceeds-ceiling`.
    - A plain client `thread.create` fails with "Project … does not exist".
  - W2 kept working after its restarts, which is consistent with its stuck F-P8-1 child keeping that
    project in the window.
  - Any command that hydrates a thread of the project (W-1) clears the condition until the next
    restart.
  - Repro: restart a worker whose project has only settled threads, then delegate
    (`live/25`–`28`).
- **F-P8-3 (high): the worker's delegate is not atomic, and nothing repairs a half-created child.**
  - `runPeerDelegate` claims the `peer_children` row, then dispatches `thread.create`, then
    `thread.turn.start`, in the request fiber (`peerWorker.delegate.ts:113-167`).
  - When the peer channel dies between those steps, the turn start is lost.
  - `status`/`follow` only read (`peerWorker.status.ts`). A status reply that names the child moves
    the coordinator to `following` without a re-send, which is correct for duplicate safety.
  - The stored commands are never completed, so (with F-P8-1) the dispatch hangs until the grant
    changes.
  - Likely fixes:
    - Run the two dispatches uninterruptibly.
    - Or have `status`/`follow` re-dispatch the byte-identical stored commands, which the command
      receipts deduplicate.
  - Repro: `tools/w-cut.sh` (cut on the new `peer_children` row) (`live/32`).
- **F-P8-4 (medium): failures after acceptance are not delivered to the coordinator thread.**
  - A final refusal after acceptance (for example `dispatch-unknown` after a re-grant, or grant
    problems) settles the row `failed` through `move(… "child-failed")` without calling `settle`
    or delivering (`orchestration-tools/peerDispatch.follow.ts:275-284`).
  - Accepted dispatches `ad157516` and `07c020af` ended `failed` with no message in the thread
    (`live/95`). Only the status tool shows the outcome.
- **O-1:** the worker child always uses `DEFAULT_MODEL_BY_PROVIDER[provider]` when the request has
  no model. It ignores the worker project's `defaultModelSelection` (`peerWorker.delegate.ts:107-110`).
- **O-2:** the coordinator's internal learning sessions are offered the peer tools.
  - Under the replaying fake they created three real worker children, with `approval-required`
    narrowing applied.
  - Whether a real model would do this was not verified, but delegation from background sessions
    is probably unintended.
- **O-3:** a schema-invalid `server.peerPairing` payload (a missing or false `confirmPin`) is refused
  as a `Die` defect rather than a typed `PeerPairingError`. It is still refused, and nothing is
  saved.
- **O-4:** `delegate_to_host` to a revoked host, while another pairing is active, returns
  `grant-missing` without `unavailable: true` (`peerDispatch.delegate.ts:72-77`). The M6 checklist
  says "unavailable".
- **O-5:** a re-grant turns every earlier child into `dispatch-unknown`, so they become failed
  (documented). That includes a child already stopped on the worker, whose real outcome
  (interrupted) is lost to the coordinator.
- **O-6:** each worker restart appends a server `project.created __chats__` event (as M2/M3 O-6).

## Repro steps

1. Run `git archive 31ad97c358`, clone `node_modules` with `cp -cR`, and in `apps/server` run
   `bunx tsdown && bunx tsdown -c tsdown.clientRelay.config.ts`. Then run
   `bun run remote-backend-graph --target aarch64-unknown-linux-gnu --dist apps/server/dist --output <dir> --key-file <ed25519> --key-id dev-fixture-p8 --version 0.1.613-dev.p8a --node-archive node-v24.13.1-linux-arm64.tar.xz`.
2. Build the musl agent in `node:24.13.1-bookworm --rm` (`--tmpfs /target:exec`), then sign a
   schema-1 manifest whose `bundledPath` is `/home/bbp8/install/bigbud-remote-agent`.
3. Create three Lima VMs from `tools/bb-p8-*.yaml` (`networks: [{lima: user-v2}]`). Add `bbp8`
   with lingering on each, extract the graph to `~/runtime/backend`, then run
   `bbcli backend setup …` and `backend start`.
4. Run `p8.mjs setup-codex` everywhere, create a project at `~/work/proj` on each worker, and
   create a project and thread `ct` on C.
5. Pair through `p8.mjs pairing` (`ensure-key`, `scan-host-key`, `save` with `confirmPin:true`),
   then run `bigbud peer grant` on each worker, then `record-grant`.
6. Run `p8.mjs peer-tool ct '[{"tool":"delegate_to_host","arguments":{…}}]'`. Fault scripts are in
   `tools/`, and the exact commands are at the top of each `live/*.log`.

## What remains for the user

- Fix F-P8-1 to F-P8-4. Then re-run 3b′ (`tools/w-cut.sh`), the restarted-worker delegate (F-P8-2)
  without W-1, and a delegate whose child fails to start.
- Decide whether learning or other internal sessions should see the peer tools (O-2).
- Not covered:
  - The Settings > Peer hosts UI.
  - Two physical laptops, or a laptop backend through relay leases.
  - Approval waits on the worker (`waiting`).
  - Grant expiry (`--expires-days`).
  - Republishing `remote-peer.sock` after a worker restart (it was observed to work, but not
    asserted).
  - x86_64 and a real VPS.

## Evidence and teardown

- **Evidence:** `/tmp/bigbud-p8-20261118T081448Z/` was archived as
  `~/DevWorld/bigbud-evidence/tmp-bigbud-evidence-20261118-p8-live.tar.zst`, with a `.sha256` file.
  - It contains `logs/` (builds, artifact hashes), `live/` (one log per step, `INVALID-*`, and in
    `vm/` the peer table dumps, fake-provider logs, user journals and sshd logs per VM), `tools/`
    and `artifacts/` (provenance, agent manifest, the fixture public key and the coordinator's peer
    public key).
  - It holds no private keys or tokens. It was scanned for the three client tokens (0 hits) and
    for private-key blocks.
- **INVALID (voided and redone):**
  - The first agent build (a noexec tmpfs).
  - The first check-5 attempt: a long-lived fake process ran the pre-H-2 code, so no dispatch was
    made.
  - The first check-7 re-pin (the driver extracted several keys).
  - The first check-8 pass (stdin closed before the reply, and a stale forward socket).
  - The first check-3b monitor (the driver read the wrong row). Its live effect is the F-P8-3
    evidence.
- **Teardown:** see the final section of `logs/teardown.txt`. The VMs `bb-p8-coord`, `bb-p8-w1` and
  `bb-p8-w2` were deleted, and `/tmp/bigbud-p8-*` was removed. No other VM or container was touched.
