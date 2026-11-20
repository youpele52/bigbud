# x86_64 VPS acceptance (real host, Debian 13)

**Date:** 19 November 2026, 11:05–12:25 UTC
**Source under test:** `git archive` of `dev` HEAD `1b1a72e6c6` (tree in `logs/head.txt`). The
working tree was not used for any build except the X-1 fix check below.
**Related:** [P6 head acceptance](2026-11-17-remote-p6-head-acceptance.md),
[M1 live systemd](2026-11-17-m1-live-systemd-acceptance.md),
[M2/M3 live](2026-11-18-m2-m3-live-acceptance.md),
[measurements](2026-11-18-remote-backend-measurements.md),
[P8 live](2026-11-18-p8-live-acceptance.md),
[mobile increment 7](2026-11-18-mobile-increment-7-live-acceptance.md),
[D-1/D-2/D-3](2026-11-19-d1-eviction-wedge-and-d2-d3-live.md),
[unit-only re-run](2026-11-18-unit-only-fixes-live-rerun.md).

**Verdict:** the remote backend works on a real x86_64 host. Every row that a single unprivileged
account can run passes: M1 managed backend under systemd 257, P6 persistent terminals, M2
deployment from a macOS laptop over SSH and multiple clients, M3 safe updates, the 1/4/8-session
measurement (no D-1 wedge), D-2/D-3/D-4 deletes, eviction, mobile native composition with an
x86_64 gateway, and P8 with this VPS as the worker. One small defect was found and fixed (X-1:
`~/.bigbud` created group-writable under the Debian 13 default umask). Boot autostart is
**pending the user's reboot**.

## Environment

- **Host:** the user's x86_64 VPS (Debian 13, 2 vCPU, 3.8 GiB). Kernel 6.12 (Debian), systemd
  257, no swap, about 1 GiB already used by the owner's services. One dedicated unprivileged
  account `bbtest`: lingering on, no sudo, session umask **0002** (Debian 13 user-private-group
  default). No `sqlite3` binary, so the harness used a small Python `sqlite3` shim
  (`tools/vps/bin/sqlite3`).
- **Single account:** every case that previously used a fresh Lima account used a fresh
  _instance_ instead: `bbreset` stops and removes every bigbud unit and all bigbud state of the
  account, then `bbinstall` + `bbsetup` (`backend setup … --confirm-fresh-setup`, `backend start`).
- **Network rules kept:** no listener reachable from outside. The only listeners were the
  backend's UNIX sockets and the mobile gateway on `127.0.0.1:47390`. All access was over SSH.
- **Builds** (all from the snapshot, signed with a throwaway Ed25519 fixture key
  `dev-fixture-x86`, private key deleted, never archived; hashes in `logs/artifact-hashes.txt`):

| Artifact                       | What                                                                                                            | sha256 (prefix)     |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------- |
| Graph **a** `0.1.613-dev.x86a` | HEAD, `x86_64-unknown-linux-gnu`, producer passed unmodified                                                    | `bb80c809…` archive |
| Graph **b** `0.1.614-dev.x86b` | HEAD with package version 0.1.614 (M3 target)                                                                   | `d63cc59e…`         |
| Graph **d** `0.1.615-dev.x86d` | M3 never-ready test graph (`logs/test-graph-d-never-ready.diff`)                                                | `9b8774a6…`         |
| Graph **e** `0.1.613-dev.x86e` | a + sweep logged as a warning `{evicted, resident}` (observability only, `logs/test-graph-e-eviction-log.diff`) | see log             |
| Graph **c** `0.1.613-dev.x86c` | HEAD, `aarch64-unknown-linux-gnu`, for the P8 coordinator VM                                                    | see log             |
| Agent `0.3.3-x86.1b1a72e6c66c` | `x86_64-unknown-linux-musl`, static-pie, protocol 1.8                                                           | `4c87bf11…`         |
| Mobile gateway                 | `x86_64-unknown-linux-musl`                                                                                     | `868eaa49…`         |
| Mobile assets `0.1.0-x86`      | plain `VITE_MOBILE_BASE=/mobile/` build, packaged unmodified                                                    | `7afa54fc…`         |

The x86_64 agent and gateway were built in a disposable `node:24.13.1-bookworm` container under
`--platform linux/amd64` (rustup 1.95.0); the aarch64 coordinator agent in the same image natively.
Graph builds ran on the macOS host (`bun run remote-backend-graph --target …`).

- **Provider:** the validator fake Codex (`tools/vps/drv/fakeCodex.mjs`) and the measurement
  tool's own fake. No credentials exist for `bbtest`: real provider conformance is **not tested**.

## Results

| Area      | Row                                                            | Result                  | Evidence (`live/`)                                                                                                                                                                         |
| --------- | -------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M1        | 1 Setup; status                                                | **PASS**                | `03`, `10`: exit 0, Rust Active, backend Disabled                                                                                                                                          |
| M1        | 2 Start without boot; start again; enable while running        | **PASS**                | `10`: unit `disabled`, Linger yes; "already running"; enable explains stop-first (exit 1)                                                                                                  |
| M1        | 3 `systemctl --user stop` of the backend                       | **PASS**                | `12`: 168 ms, `Result=success`, `ExecMainStatus=0`, `server exit { code: 0 }`                                                                                                              |
| M1        | 4 `kill -9` of the backend                                     | **PASS**                | `11`: `status=9/KILL`, restart counter 1, new MainPID within ~1 s                                                                                                                          |
| M1        | 5b 8 clean stop/start cycles, boot enabled                     | **PASS**                | `16`: 8 cycles in 9 s, all rc 0, `NRestarts=0`, no start-limit                                                                                                                             |
| M1        | 6 Six `kill -9` → crash-loop limit; F6 refusal; repair         | **PASS**                | `17`: "Start request repeated too quickly", NeedsRepair 6; `backend start` refused (exit 1, Rust untouched); `reset-failed` + `backend start` → Active                                     |
| M1        | 7 Rust terminal survives backend `kill -9`                     | **PASS**                | `11`: same shell PID, start time and Rust cgroup; new generation, `historyUnavailable: true`; ticks advancing                                                                              |
| M1        | 8 `backend stop` → `backend start`, 3× on one boot             | **PASS**                | `14`: stop exit 0 in 1.5–1.8 s, Rust `Stopped`, `launch.exit=143`, new Rust PID each start                                                                                                 |
| M1        | 9 SIGTERM to the Rust supervisor                               | **PASS**                | `15`: exit after 2.2 s, `ExecMainStatus=143`, `Result=success`, `launch.exit=143`, PTY reaped; backend crash restart relaunched Rust                                                       |
| M1        | 10b `terminate-user`, 10c no lingering                         | **NOT TESTED**          | needs privileges / would end the account's user manager                                                                                                                                    |
| M1        | 11 Boot autostart                                              | **PENDING user reboot** | `120`, see below                                                                                                                                                                           |
| M1        | 12a Start/stop before setup                                    | **PASS** (see X-1)      | `19`: both refuse exit 1 and create nothing on a clean account                                                                                                                             |
| M1        | 12b Edited unit file                                           | **PASS**                | `18`, `18b`: stop and (stopped) start refused "account units differ…"; restored byte-exact. `start` while running reports "already running" without validating                             |
| M1        | 12c/d Unproven Rust death                                      | **NOT TESTED**          | recovery needs a reboot; it would collide with the pending boot case                                                                                                                       |
| P6        | S1 Stop tree                                                   | **PASS**                | `13`: shell, both children and `sleep 424242` gone; supervisor untouched                                                                                                                   |
| P6        | S2 reattach after backend SIGKILL / stop                       | **PASS**                | `11`, `12`: same PID, output delivered, ticks advancing                                                                                                                                    |
| P6        | Exit 0 on intentional systemd stop                             | **PASS**                | `12` (was the open P6 item)                                                                                                                                                                |
| M2        | 0 D5 refusal before approval                                   | **PASS**                | `91`: `approval-required`, nothing created on the host                                                                                                                                     |
| M2        | 1 `setupRemoteBackend` from a **macOS** laptop to the real VPS | **PASS**                | `93`: `started` in 77 s (graph uploaded over SSH); unit `disabled`/`active` (`94`)                                                                                                         |
| M2        | 2 Same-rid idempotency; conflicts                              | **PASS**                | `95`: same rid 3 ms, no remote call; other `enableBoot` → `conflict`; new rid → "already has a deployed backend profile"                                                                   |
| M2        | Profiles, leases, binding (5)                                  | **PASS**                | `95`, `97`: profile `available`; two leases; handshake = pinned authority; 401 for the other lease's / no credential; 403 foreign Origin (HTTP and WS)                                     |
| M2        | 4a/4b/4c Multiple clients                                      | **PASS**                | `97`: one receipt for one command id; approval answered once, second "already resolved"; snapshot + tail = live                                                                            |
| M2        | 3a/3b Hash mismatch, curl-blocked fallback                     | **NOT TESTED**          | unchanged since the arm64 run; `iptables` needs root                                                                                                                                       |
| M3        | 1 Handshake `runtimeUpdates: true`                             | **PASS**                | `50`                                                                                                                                                                                       |
| M3        | F-M3-1 inputs absent → clear failure; `update-inputs set`      | **PASS**                | `50`: names `bigbud backend update-inputs set`; 0600 file; second `set` refused                                                                                                            |
| M3        | 2 Deferred during a turn, activates after                      | **PASS**                | `51`: `deferred` 11:41:17 while `SLOW:45` ran; `activated` 11:41:53 with no operator action; transient `bigbud-update-restart-…` unit; `backendVersion 0.1.614` (`53`)                     |
| M3        | 3 Pending approval blocks                                      | **PASS**                | `57`: deferred with `#turn` and `#approval` for 30+ s; answered; cancelled                                                                                                                 |
| M3        | 4 Interrupting update with consent, queued prompt flushes      | **PASS**                | `58`: one interrupt per running turn, `thread.queued-prompts-flushed`, each user message once                                                                                              |
| M3        | 5 Stale consent                                                | **PASS**                | `58`: `consent-stale`, 0 interrupts                                                                                                                                                        |
| M3        | 6 Rust terminal unchanged across updates                       | **PASS**                | `52`, `55`, `56`: shell PID and Rust MainPID unchanged across 1 activation and 2 rollbacks                                                                                                 |
| M3        | 7 Full disk refused                                            | **NOT TESTED**          | would fill the owner's shared disk                                                                                                                                                         |
| M3        | 8 Downgrade refused                                            | **PASS**                | `54`: refused at request time in 131 ms, MainPID unchanged                                                                                                                                 |
| M3        | 9 Failed trial rolls back                                      | **PASS**                | `55`: never-ready trial → `failed` "Rolled back … no acknowledged command was lost"; sequence and message counts unchanged; no `__chats__` event appended                                  |
| M3        | 10 Interrupted restore completes                               | **PASS**                | `56`: previous node mode 000 → 12 `Permission denied`, start-limit; mode 700, `reset-failed`, start → settled with the rollback message                                                    |
| M3        | 11 Unbootable graph, manual recovery                           | **NOT TESTED**          | graph built; skipped for time                                                                                                                                                              |
| M5        | 1/4/8 measurement                                              | **PASS** (completed)    | `30`, table below; external `BEGIN IMMEDIATE` succeeds afterwards                                                                                                                          |
| D         | D-1 concurrent sessions (no wedge)                             | **PASS**                | `30` (1/4/8), `22` (3 concurrent turns)                                                                                                                                                    |
| D         | D-2 cascade cleanup, D-4 project delete                        | **PASS**                | `22`: A, B, child and project gone in ~1 s, logs removed, events pruned (0 left), 0 stall messages, plans `completed=3`                                                                    |
| D         | D-3 retention (3×) and stop+2 s deletes (5×)                   | **PASS**                | `23`: 3/3 `completed` in 4.0 s; `24`: 5/5 gone in ~1.03 s                                                                                                                                  |
| D         | F-B11 deletion on linux/x64                                    | **PASS**                | `22`–`24`: Rust cleanup executor removes provider logs                                                                                                                                     |
| D         | Eviction bound and rehydration                                 | **PASS**                | `31`–`35` (graph e): sweeps every 60 s; 560 → **500** resident; rename on the oldest evicted thread (projection title updated) and a turn on the next; back to 500                         |
| D         | Eviction TTL                                                   | **NOT TESTED**          | covered on 18 November; no seam to shorten 10 min                                                                                                                                          |
| Mobile    | inputs, status, `enable --confirm-consent`                     | **PASS**                | `70`: `Proof inputs: loaded`, `granted (revision 1)`                                                                                                                                       |
| Mobile    | Native Start of the x86_64 gateway, cleanup                    | **PASS**                | `71`, `78`, `80`: child `/proc/self/fd/4 --listen 127.0.0.1:47390 …` in the Rust cgroup, ELF machine `3e 00` (x86-64); `route-unverified` (no Tailscale) then exit-confirmed, tree removed |
| Mobile    | F5 `backend stop` with a live gateway                          | **PASS**                | `80`: stop 1.8 s, Rust `Result=success`, `launch.exit=143`, gateway gone, attempt exit-confirmed                                                                                           |
| Mobile    | F3 consent cycles / stage retirement                           | **PASS**                | `87`: 6/6 cycles on a clean instance; at most 2 stages, 2 attempts; `mobile repair` retires the old stage                                                                                  |
| Mobile    | F6 uncertain → settled by supervisor exit                      | **PASS**                | `76`–`78`: `--resolve` keeps a live epoch; after stop/start `exit-recorded`, `1 removed`                                                                                                   |
| Mobile    | Authenticated `/mobile-ws` (F9), phone, Tailscale              | **NOT TESTED**          | out of scope                                                                                                                                                                               |
| P8        | Pairing: key, scan, pin only with confirmation, grant          | **PASS**                | `60`–`61`, `101`–`102`: scanned fingerprints equal the operator's known_hosts; 0 rows without `confirmPin`; grant appends one forced-command line                                          |
| P8        | Delegate to the VPS worker; one delivery                       | **PASS**                | `103`: completed in 4 s, 1 child, 1 delivery                                                                                                                                               |
| P8        | 7c Worker restart republishes `remote-peer.sock`               | **PASS**                | `104`, `105`: new inode, `srw-------`; next delegate completed                                                                                                                             |
| P8        | 3a Partition before acceptance (coordinator `iptables`)        | **PASS**                | `106`: `sent-uncertain` for 40 s, after heal `send_attempts=2`, completed, one child                                                                                                       |
| P8        | Revoke on the worker                                           | **PASS**                | `107`, `108`: `authorized_keys` byte-identical to before; next delegate `authentication-refused`, no child                                                                                 |
| Providers | Real provider conformance                                      | **NOT TESTED**          | no credentials                                                                                                                                                                             |

P8 used one disposable Lima arm64 VM (`bb-x86-coord`, 2 CPU, 2 GiB) as the coordinator; it was
deleted afterwards (with the peer private key it held).

## Measurement (M5, "4 GB / x86_64 / small DB" row)

`remoteBackendMeasure.ts` from HEAD, same flags as before (`--levels 1,4,8 --history-turns 10
--measured-turns 3 --idle-ms 10000 --latency-samples 7 --fake-provider --restart-for-readiness`),
fresh instance, 213 s total (`live/vps-ev/m5-run1/`).

| Measure                                                      | x86_64 VPS (this run)                        | arm64 Lima, 2 CPU / 4 GiB (`bba1`, 19 Nov) |
| ------------------------------------------------------------ | -------------------------------------------- | ------------------------------------------ |
| Idle RSS runtime / inclusive                                 | 219.6 / 222.8 MiB                            | 292 MiB                                    |
| Idle CPU                                                     | 1.5 %                                        | ≈1 %                                       |
| Handshake (median / p95)                                     | 2.3 / 5.7 ms                                 | 0.8 / 3.0 ms                               |
| Restart stop / → ready / total                               | 285 / 4,071 / 4,356 ms                       | 93 / 2,473 / 2,566 ms (18 Nov)             |
| 1 session: latency median; peak RSS runtime / inclusive; CPU | 1,152 ms; 392 / 544 MiB; 98 %                | 792 ms; 406 / 481 MiB                      |
| 4 sessions                                                   | 4,556 ms; 409 / 832 MiB; 97 %                | 1,896 ms; 417 / 794 MiB                    |
| 8 sessions                                                   | 9,209 ms (p95 10,610); 435 / 1,122 MiB; 99 % | 3,424 ms; 427 / 1,202 MiB                  |
| DB + WAL initial → after cleanup                             | 1.87 → 15.40 MiB                             | —                                          |

- Memory matches arm64: runtime RSS is flat in sessions (392–435 MiB); inclusive grows with the
  fake provider processes. With 8 sessions the host still had about 2.5 GiB available.
- Throughput is the limit and is lower than on the Lima VM: the backend main thread is saturated
  already at one session on this VPS's vCPUs (shared with the owner's services), and latency
  scales linearly (1.2 → 4.6 → 9.2 s for the same scripted stream).
- Journald 8 MiB; trace directory 648 KiB (≤ 40 MiB bound); backend stop 285 ms.
- "Large DB" rows and a 1 GB host were not run.

## Defects and fixes

### X-1 (fixed): `bigbud-remote-agent` creates `~/.bigbud` group-writable under umask 0002

- **Live:** on Debian 13 the account's session umask is 0002. Running the agent binary from a
  shell (`bigbud-remote-agent --version`, or any stdio session started without the product's own
  `umask 077` wrapper) created `~/.bigbud` and `~/.bigbud/agent` as **0775**
  (`live/02`, `19b`, `19c`). Every later bigbud CLI command then refused:
  "The directory '/home/bbtest/.bigbud' has mode 0775; it must be 0700 or 0755 … Run: chmod 755"
  (`live/01`). The product's managed flows (laptop install, deployment, launch scripts) already set
  `umask 077`, so the M2 deployment was not affected (`live/94`: `~/.bigbud` 0700).
- **Cause:** `AgentState::open` used `fs::create_dir_all`, which follows the umask, and then made
  only the leaf `state` directory private.
- **Fix:** `crates/bigbud-remote-agent/src/state/core.rs` (244 lines): missing ancestors are created
  with `DirBuilder::recursive(true).mode(0o700)`; existing ancestors are untouched.
- **Test:** `creates_missing_ancestors_owner_only` (new, same file). **Mutation:** with
  `create_dir_all` restored it fails ("`.bigbud` must not inherit the umask").
- **Live check:** an agent built from the working tree, run with umask 0002 on the VPS, creates
  both directories as 0700, where the HEAD agent creates 0775 (`live/110`).
- **Checks:** `cargo fmt -p bigbud-remote-agent --check` clean; `cargo clippy --locked -p
bigbud-remote-agent --all-targets -- -D warnings` clean; `state::core` tests 4/4 on macOS and in
  Linux amd64 and arm64 containers. The full crate suite in those containers has 14 failing
  `supervisor::core::reliability_tests` (signal, shutdown and PTY tests); the same 14 fail on the
  unmodified HEAD snapshot in the same container (`logs/cargo-test-*`), so they are environmental.
  On macOS, 17 journal/readiness tests fail for environmental reasons (temp-directory inventory
  bound, socket address parsing). Nothing was committed.

### Observations (not fixed)

- **O-1 (validator artefact, recorded for honesty):** adding a file to the graph's `runtime/`
  directory (a `tailscale` stand-in, since `/usr/local/bin` is not writable without root) makes
  native gateway Start fail with `native-cleanup-uncertain` (reproduced twice, `live/72`, `79`).
  Refusing a modified graph tree is reasonable; it is still reported as _uncertain_ and needs a
  `backend stop`/`start` to settle. One later failure in a consent cycle on that same tampered
  instance (`live/81`) did **not** reproduce on a clean instance (0/6, `live/87`). The cause of an
  `AggregateError` without detail in that path was not identified; its log line drops the inner
  errors, which made diagnosis impossible (an observability gap like inc-7 F8).
- **O-2:** every backend start downloads the release remote-agent manifest from GitHub and logs
  "Release manifest is signed by key 'release-2026', which this version of bigbud does not
  trust" on this dev build (`live/73`). Expected for a dev key, but it is a network call at start.
- **O-3:** `~/.bigbud/backend/worktrees` was created 0775 during the M2 deployment (inside a 0700
  `~/.bigbud`, so not reachable by others).
- **O-4:** the M2 laptop backend used the system `ssh` (login-shell PATH merge, as before) with the
  dedicated key from the target's `keyPath`; the operator's `known_hosts` was only read (mtime
  unchanged).

## Pending user action: boot autostart (M1 row 11)

Left running on the VPS for this check: one managed backend, authority `8441b1fd…`, **enabled for
boot** (`bigbud-backend-8441b1fd….service` enabled; Rust unit started by it), lingering on.
Before the reboot (`live/120`, `121`): both units Active, handshake OK, boot id `74a4507b…`.

```sh
# on the VPS, as an admin
sudo reboot
# then, from the laptop
ssh -i ~/.ssh/bigbud-test-vps -o IdentitiesOnly=yes bbtest@<vps> 'export PATH=$HOME/bbx/bin:$PATH; reboot-check'
```

PASS when: the boot id differs, both units are Active with `crash-restarts=0`, the handshake
prints the authority with `persistentTerminals: true`, and "boot journal lock/readiness errors"
is 0. Afterwards, to remove everything:

```sh
ssh … bbtest@<vps> 'export PATH=$HOME/bbx/bin:$PATH; bbreset; rm -rf ~/bbx ~/drv'
```

## Cleanup state

- **VPS:** everything else was stopped and removed. Left: `~/.bigbud`, `~/backend-data`,
  `~/runtime/backend`, `~/install`, `~/mobile` (the boot-check instance), `~/drv` (handshake
  driver) and `~/bbx/bin` (small scripts, including `reboot-check` and `bbreset`). No peer grant;
  `~/.ssh/authorized_keys` is byte-identical to before. Running: the backend (≈245 MiB RSS) and
  the Rust supervisor (≈5 MiB).
- **Disk/RAM on the VPS:** before: home 139 MiB (after staging), 54 GB free, 944 MiB used /
  2,977 MiB available. After: home ≈406 MiB, 53 GB free, 1,313 MiB used / 2,608 MiB available
  (the difference is the boot-check backend).
- **Local:** the Lima coordinator VM was deleted; the build containers ran with `--rm` and their
  Docker volumes were removed; the snapshot, builds and graph archives were deleted; the fixture
  private key was deleted. The amd64 variant of `node:24.13.1-bookworm` was pulled once for the
  cross build and is still in the local image store.

## Evidence

`~/DevWorld/bigbud-evidence/tmp-bigbud-evidence-20261119-x86-vps.tar.zst` (+ `.sha256`): `live/`
(one log per step, command at the top; `vps-ev/` per-instance journals, traces, fake-provider logs
and measurement JSON/markdown; `vm-coord/`), `logs/` (builds, hashes, test-graph diffs, cargo test
logs), `tools/` and `artifacts/` (provenance, fixture and coordinator **public** keys only). The
VPS address and host name were replaced with `<vps>`/`vps`, and the archive was scanned for private
key blocks, the laptop token and client tokens before packing.
