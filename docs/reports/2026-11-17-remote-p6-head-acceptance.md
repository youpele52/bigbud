# Remote P6 acceptance on dev HEAD — 17 November 2026

## Result

Every P6 persistent-terminal row passes live on `dev` at `26aa117e12`, except one. The open item
is the live proof that an intentional managed-service stop exits 0 under real systemd. It is
blocked because no signed Linux backend graph exists for HEAD; the graph producer is being built
(remote completion plan, milestone M1).

Earlier frozen-snapshot results (corr2, corr3) are superseded by these runs on the code that will
ship.

## Artifacts

- Source: `git archive 26aa117e12` snapshot (never the working tree).
- Server dist `838ad9db…a980`, built from the snapshot; protocol 1.8.
- Agent `fc1eb955…a2a3`: static aarch64, rebuilt because HEAD moved protocol 1.7 → 1.8;
  `--check` reports `0.3.3-p6.aef91321dcbe`, protocol 1.8.
- Fixture-signed install source `f420a530…` (fresh fixture key, never a release key).

## Rows

| Row                                                   | Result  | Notes                                                                                                                     |
| ----------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------- |
| S1 Stop tree                                          | PASS    | Whole process tree of the stopped terminal ended; siblings and supervisor untouched                                       |
| S2 input and reattach                                 | PASS    | Same PIDs after backend SIGKILL/TERM; no duplicates; refused outage input never delivered later; ambiguous write ran once |
| S3 warm attach                                        | PASS    | No stale success; every caller within 15 s including queued callers                                                       |
| S4 H1 same-boot crash                                 | PASS    | Failed install retired; managed restart ready in 4.86 s with a new epoch                                                  |
| S4 H2 real prior boot (Lima VM)                       | PASS    | New `boot_id`; managed restart ready in 4.66 s through the prior-boot-dead branch                                         |
| Restart status after backend restart                  | PASS    | Status and same-request retry return the same ready result; closes F-P6C-MR-STATUS-READMODEL                              |
| S5 regression                                         | PASS    | Discovery, detach, outage ticks, TERM/KILL, memory bound, replay gaps                                                     |
| P6-7 diagnostics                                      | PASS    | Honest `unreadable` and `partial-or-unknown` states; no relaunch                                                          |
| P6-4b 8 MiB log rotation                              | PASS    | Byte-exact rotation boundary; supervisor and PTY unaffected                                                               |
| P6-4c ProcessRequest                                  | PASS    | 1 MiB drain, reattach and cancel                                                                                          |
| Linux-client headless rows P6-0/1/2/3/5 (+P6-4, P6-6) | PASS    | Linux ARM64 client in a disposable container                                                                              |
| Electron Quit/relaunch on Linux                       | PASS    | Quit in 85 ms; remote output continued while down; relaunch attached the same PID and resource                            |
| Exit 0 on intentional systemd stop                    | Blocked | Needs a HEAD Linux backend graph; covered by focused tests only                                                           |

Full detail: §47–§49 of `/tmp/bigbud-remote-validation-current-report.md`. Evidence archives are in
`~/DevWorld/bigbud-evidence/` (`…-p6-head`, `…-p6-head2`, `…-p6-linuxclient`).

## Qualifications

- Linux runs are ARM64. Native x86_64 and Windows are not covered.
- The Electron proof uses an unpackaged development build with Chromium's sandbox disabled inside
  the container.
- Native ledger atomicity is covered by focused tests only; legacy no-digest owners were checked
  read-only; the fixture suppresses the agent-detection probe.

## Findings for follow-up

- **Supervisor SIGTERM.** Without a signal handler the supervisor dies outright and a job-control
  child can be orphaned to PID 1. Fix in progress (remote completion plan WP-0A).
- **Copilot runtime while disabled.** At desktop startup `server.copilotRuntime` was called with
  Copilot disabled (`apps/server/src/ws/wsRpcHandlers.copilotRuntime.ts:12-16` has no enabled
  check). Afterwards a 221 MB `~/.cache/copilot/pkg/linux-arm64/1.0.105` with world-writable (0777)
  directories appeared. The causal link is inferred, not proven. Investigation and fix in progress.
- **Pre-existing failing test.** `apps/server/src/startup/ownershipShutdown.runServer.test.ts`
  fails on clean HEAD too; unrelated to this work.
