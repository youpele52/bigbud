# OpenCode V2 live-send diagnosis and backend instance lock (gap closure Phase 2)

## Acceptance boundary

**Code green: YES (TypeScript; Rust unchanged). Implementation/Plan green: NO. Live confirmation: pending Phase 3 (user-operated).**

Plan: [2026-10-15 gap-closure plan](../plans/2026-10-15-opencode-v2-gap-closure-plan.md), Phase 2 items 2.1–2.4, gate G2.

Validated tree: `433025807` (Phase 0 ledger commit on top of `c859532da`) plus the uncommitted Phase 2 changes listed below. The orchestrator records the final SHA when committing. No retail OpenCode binary ran, the user's daemon and `~/.config/opencode` / `~/.local/share/opencode` were not touched, and no backend ran against `~/.bigbud`. The only backends started used an isolated `BIGBUD_HOME` under the job's temporary directory with every provider disabled, and only those PIDs were signalled.

This ledger proves a cause and fix at unit and fixture level. Whether this cause produced the October 14 live failures is confirmed only by Phase 3.

## Hypotheses

| ID  | Hypothesis                                                                                                                                                                                                                                                                                                          | Test                                                                                                               | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Confidence that it explains the live symptom                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| H1  | A thread-tool callback that is dispatched and then rejects is added to `V2ActiveExecutions.uncertain` and never removed. `session.coding.busyCount()` stays at least 1, `settleV2RuntimeReservation` returns early forever, and every send fails at `Runtime.send.ts` with "prior physical admission remains owned" | `Execution.owners.test.ts` (2 new cases), `Runtime.settlement.hold.test.ts` (7 cases), and a pre-fix probe (below) | **Reproduced and fixed.** Before the fix, with the native session drained and one failed dispatched callback, four consecutive sends were rejected with the exact live message `V2 prior physical admission remains owned; no new turn.`; removing only the leaked entry admitted the next send. Any post-dispatch rejection takes this path: the attempt-5 guard-cycle `RangeError`, and also an ordinary canonical refusal (`V2 canonical tool refused (<status>)`), an abort, or the 10-second orchestration timeout | Medium-high. It reproduces the exact message and permanence. The live trigger (which callback failed during attempt 6) is unrecorded; Phase 3 hold-reason lines will show `coding-busy` if this recurs |
| H2  | `finalPublication` stays pending, or `finalEvents` are retained                                                                                                                                                                                                                                                     | Classifier cases `final-publication-pending` and `final-events` in `Runtime.activation.settlement.test.ts`         | Not reproduced as a permanent hold: both release as soon as the condition clears. Now distinguishable by hold reason                                                                                                                                                                                                                                                                                                                                                                                                    | Low. Open until Phase 3                                                                                                                                                                                |
| H3  | Stale `pendingInteractions`                                                                                                                                                                                                                                                                                         | Classifier case `pending-interactions`                                                                             | Not reproduced. Now distinguishable by hold reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Low. Open until Phase 3                                                                                                                                                                                |
| H4  | Unresolved journal rows written by a second backend sharing `state.sqlite`                                                                                                                                                                                                                                          | Existing safety case `journal` now asserts `unresolved-journal`; the instance lock (2.1) prevents the precondition | Not reproduced. The precondition is now refused at startup. Observation at validation time: the user's machine was running two bigbud backends from the main checkout (PID 77200, `--base-dir ~/.bigbud --dev-url … --port 3773`, and Electron PID 35908 via `--bootstrap-fd`); whether both resolve to the same state directory was not inspected                                                                                                                                                                      | Low-medium as a contributing factor. Eliminated once the lock ships                                                                                                                                    |

### Root cause and fix (H1)

`V2ActiveExecutions.run` adds a controller to `uncertain` when a dispatched execution rejects, and no code path ever removed it. That is correct "never manufacture idle" behavior with no release path. The fix adds a proof-only release that mirrors `V2ActivationGate.settle`:

- `dispatch(controller, run, receiptKey)` records the canonical receipt identity. Uncertain entries carry `{ controller, receiptKey, failedSequence }`.
- `reconcile(controller, evidence)` removes an uncertain entry only when `nativeDrained` holds **and** either `receiptDurable` or `interruptAcknowledged` holds. It never touches active work and is never timer-based.
- `reconcileV2BridgeExecutions` (in `Orchestration.bridge.activation.ts`) gathers the evidence:
  - an exact-session `session.active` read;
  - `V2ThreadReceipts.durableState(key)`, an authoritative read of the durable receipt. `absent` means no reservation was written, so the canonical request was never issued. `reserved` means durable semantic uncertainty that is never resent and still counts in `unsettledCount` and reboot evidence. `completed` means settled;
  - `interruptAcknowledgedSequence`, set only after native `session.interrupt` succeeds and compared against the failure's sequence. An acknowledgement that came before the failure is not proof.
  - Unreadable receipts and failed drain reads keep the entry held.
- `settleV2RuntimeReservation` calls `owner.coding.reconcile()` before observing `busy()`, then re-runs its `validate()` fence. All other fences and the order of checks are unchanged.

## Red → green evidence

Red run on the unmodified production code (tests written first): `bun run --cwd apps/server vitest run src/provider/Layers/OpencodeV2/Execution.owners.test.ts src/provider/Layers/OpencodeV2/Runtime.settlement.hold.test.ts` exited 1 with **8 failed | 2 passed (10)**. Failure lines:

```text
TypeError: owners.uncertainEntries is not a function
TypeError: owners.reconcile is not a function
AssertionError: expected undefined to be 'coding-busy' // Object.is equality
TypeError: nextV2SettlementSequence is not a function
AssertionError: expected { state: 'error', …(1) } to match object { reason: StringContaining{…} }
```

Pre-fix probe (temporary file, deleted after the run): a drained native session plus one failed dispatched callback (`RangeError`) made four consecutive `send` calls reject with `V2 prior physical admission remains owned; no new turn.`; after the leaked entry was removed, the next send was admitted. The probe passed (1/1) on the pre-fix code.

Green: the same two files pass **11/11** after the fix, including the drain-failure case added during review. The send rejection now reads `V2 prior physical admission remains owned (hold: coding-busy); no new turn.`

## Settlement hold diagnostics (2.2)

- `Runtime.activation.hold.ts`: the typed `V2SettlementHoldReason` union (the plan's 12 reasons), the `v2SettlementBusyReason` classifier (same predicate as the original `busy()`), redacted counts, and a settlement-scope `AsyncLocalStorage`.
  - `callbacks` covers the post-drain "reservation replaced" recheck. That check was kept from the original code, but the `validate()` immediately before it makes it unreachable today.
- `settleV2RuntimeReservation` returns the hold reason, or `undefined` when settled or nothing is held. Every reason except `callbacks` has a test (`Runtime.settlement.safety.test.ts`, `Runtime.activation.settlement.test.ts`, `Runtime.settlement.hold.test.ts`).
- `repairV2RetainedReservation` puts the last reason in the deduplicated 30-second status (`… remains unconfirmed (hold: <reason>) …`). It logs one redacted line per reason change containing the thread id, native session id, reason, counts and gate operation states, with operation keys reduced to 12-character SHA-256 prefixes. `Runtime.send.ts` logs and names the reason on rejection.
- `captureV2AdmissionOwner` logs its existing parenthesised reason. `assertV2RequestContext` logs only pathname and intent for rejections that happen inside settlement; its behavior is unchanged.
- `V2ActivationGate.snapshot()` returns `{ closed, epoch, operations: [{ key, state, physicalSettled }] }`, with no tokens, stamps, proofs or job identities. The redaction test is in `PluginSetup.activation.gate.test.ts`.

## Guard-cycle regression guard (2.4)

`NativeCompatibility.runtime.guard.test.ts` already covered the expired gate through `captureV2OperationAuthority`, and covered revoked consent and the aborted signal only through `proof.assertCurrent()`. Assertions added:

- proof validation alone calls the operation guard zero times;
- `captureV2OperationAuthority().assertCurrent()` rejects revoked consent and an aborted operation signal.

`RebootRecovery.publication.test.ts` already rejects revoked authority for archive. The production fix (`NativeCompatibility.runtime.ts`) is untouched.

## Backend instance lock (2.1)

`apps/server/src/startup/stateDirLock.ts` keeps `<stateDir>/backend.lock` containing `{ format, pid, startedAt, port, hostname, acquiredAt, nonce }`. Default behavior is **refuse**, with no opt-out environment variable.

- **Create:** an exclusive create with complete content (temp file plus hard link, the content-carrying equivalent of `O_EXCL`; falls back to `wx` where hard links are unsupported). Readers never see a partial record.
- **Live owner:** startup fails with `Another bigbud backend (pid N, port P) owns <stateDir>; stop it or use a different BIGBUD_HOME.`
- **Dead owner:** the owner counts as dead on ESRCH, or when its PID now belongs to a process with a different `ps lstart` token (PID reuse). It is removed under an exclusive `backend.lock.takeover` mutex and replaced by a fresh exclusive create. I used this instead of the plan's "temp + rename" because rename-over is non-exclusive: it can overwrite a lock that a concurrent starter just created.
- **Fails closed** (refuses) when:
  - the start time is unobtainable (Windows has no `ps`, so PID reuse is undetectable there and a reused PID keeps refusing until the lock is deleted);
  - the record has no start time;
  - the owner is on another host;
  - the lock file is unreadable. The message names the file and says to delete it if no backend is running.
- **Release:** on scope close, and only while the file still carries this owner's nonce, so a stale handle never deletes a successor's lock.
- **Wiring:** `server.ts` `makeServerLayer` adds `Layer.provide(StateDirLockLive)`, which is built after observability and before `HttpServerLive` and every persistence layer, and released after both close.
  - **Deviation from the plan:** the plan named `serverRuntimeStartup.bootstrap.ts` and `serverLifecycleEvents.ts`. The first holds only the welcome/project bootstrap, which runs after persistence. The second is a welcome/ready event pub/sub with no shutdown hook. Neither can order the lock before persistence or release it.
- **Shared helper:** `processStartToken` moved to `apps/server/src/utils/processStartToken.ts`, and `remoteAgentController.ts` now reuses it.
- **Not covered:** CLI maintenance commands in `cli.ts` (recovery, compaction, purge) open the database without the lock. They are outside this item and noted as a follow-up.
- **Developer docs:** `docs/development/scripts.md` now explains that port offsets do not separate data and that concurrent instances need distinct `BIGBUD_HOME` values. The website's end-user guide (`apps/marketing/src/components/page-specific/docs/_docs-content.md`) covers no dev flow; the redundant root getting-started document was later retired.

**Live verification** used a fresh `BIGBUD_HOME` under the job's temporary directory, with every provider disabled in the seeded `settings.json`.

- The `bun dev:server` route the plan asked for cannot start in this environment. `apps/server` `dev` runs `bun run src/bin.ts`, which exits immediately with `No such built-in module: node:sqlite` under Bun 1.3.14, because `provider/Layers/Cursor/Provider.usageLimits.credentials.ts` imports it statically. That import comes from commit `bbb65462ca`, which predates this series. I used the built entry instead: `bun run --cwd apps/server build` (exit 0; `qualifiedRecords: 0`, `generatorSourceDigest: 3321f844dc958e2aed158d5afc062371b61db3f09f6c62dcf23a1f6807c34a31`; the generator closure is unchanged), then `node apps/server/dist/bin.mjs` started several times:

| Step | Action                               | Observed                                                                                                                                                                                                              |
| ---- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Backend A, port 46173                | Lock `{"pid":51516,"startedAt":"Thu_Oct_15_03:10:04_2026","port":46173,…}`                                                                                                                                            |
| 2    | Backend B, same home, port 46174     | `StateDirLockError: Another bigbud backend (pid 51516, port 46173) owns …/lockcheck-home/userdata; stop it or use a different BIGBUD_HOME.`; `bigbud server exit { code: 1 }`; port 46174 never bound; lock unchanged |
| 3    | SIGTERM A                            | A exited; `backend.lock` removed                                                                                                                                                                                      |
| 4    | Backend C (port 46175), then SIGKILL | Stale lock left with pid 53698                                                                                                                                                                                        |
| 5    | Backend D, port 46176                | Stale lock replaced (pid 54613), no takeover/temp leftovers; SIGTERM released it                                                                                                                                      |

Unit tests in `stateDirLock.test.ts` (13): fresh, live refusal, dead owner (ESRCH and PID reuse), three fail-closed cases, unreadable lock, same-process second acquisition, 12 concurrent starters with and without a stale owner (exactly one winner, no leftovers; repeated 6 times without a failure), and stale release that preserves a successor.

## Command table

All commands ran sequentially from the worktree root on the final tree.

| #   | Command                                                                                                                                                                                                                                                                                                                                                                                                        | Exit | Duration | Result                                                                                                                                                                                                                              |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `bun run --cwd apps/server vitest run src/provider/Layers/OpencodeV2/Runtime.settlement.test.ts src/provider/Layers/OpencodeV2/Runtime.settlement.poll.test.ts src/provider/Layers/OpencodeV2/Runtime.settlement.safety.test.ts src/provider/Layers/OpencodeV2/Runtime.activation.settlement.test.ts src/provider/Layers/OpencodeV2/Execution.owners.test.ts src/startup/stateDirLock.test.ts` (plan G2 suite) | 0    | 9 s      | 6 files / 42 tests passed                                                                                                                                                                                                           |
| 2   | `bun run --cwd apps/server vitest run src/provider/Layers/OpencodeV2/Runtime.settlement.hold.test.ts src/provider/Layers/OpencodeV2/PluginSetup.activation.gate.test.ts src/provider/Layers/OpencodeV2/NativeCompatibility.runtime.guard.test.ts src/provider/Layers/OpencodeV2/RebootRecovery.publication.test.ts src/startup/serverRuntimeStartup.test.ts`                                                   | 0    | 7 s      | 5 files / 28 tests passed                                                                                                                                                                                                           |
| 3   | `bun run --cwd apps/server vitest run src/provider/Layers/OpencodeV2`                                                                                                                                                                                                                                                                                                                                          | 0    | 307 s    | 218 passed / 37 skipped files (255); 913 passed / 50 skipped tests (963); 0 failed. The 50 skips are 47 native approval-gated tests plus 3 win32/linux platform tests (unchanged from Phase 0)                                      |
| 4   | `bun fmt`                                                                                                                                                                                                                                                                                                                                                                                                      | 0    | 1 s      | formatted                                                                                                                                                                                                                           |
| 5   | `bun lint`                                                                                                                                                                                                                                                                                                                                                                                                     | 0    | 1 s      | 0 errors, 63 warnings (unchanged; none in changed files); test-file-length 1,854 files, 0 violations                                                                                                                                |
| 6   | `bun typecheck`                                                                                                                                                                                                                                                                                                                                                                                                | 0    | 18 s     | 9/9 tasks                                                                                                                                                                                                                           |
| 7   | `bun fmt:check`                                                                                                                                                                                                                                                                                                                                                                                                | 0    | 2 s      | 5,720 files formatted                                                                                                                                                                                                               |
| 8   | `bun run test`                                                                                                                                                                                                                                                                                                                                                                                                 | 0    | 991 s    | 9/9 tasks. Server 1,112 passed / 55 skipped files, 4,828 passed / 116 skipped tests. Web 468/2,893, desktop 74+1 skipped files and 431 passed / 4 skipped tests, shared 48/360, mobile-web 41/212, contracts 32/195, scripts 24/131 |
| 9   | `bun run --cwd apps/server build`                                                                                                                                                                                                                                                                                                                                                                              | 0    | n/a      | manifest and native-qualification checks pass (`qualifiedRecords: 0`), `dist/bin.mjs` written                                                                                                                                       |

An earlier full `bun run test` (exit 0, 997 s) overlapped the last review edit to `Orchestration.bridge.activation.ts`. Run 8 above repeats it on the final tree.

The 9 `bigbud-remote-agent` supervisor socket-path tests remain the pre-existing environmental failure recorded in the Phase 0 ledger. No Rust code changed in Phase 2, so Cargo was not rerun.

## Files changed

New:

- `apps/server/src/startup/stateDirLock.ts` (252), `stateDirLock.test.ts` (201)
- `apps/server/src/utils/processStartToken.ts` (18), extracted from `remoteAgentController.ts` (33)
- `apps/server/src/provider/Layers/OpencodeV2/Runtime.activation.hold.ts` (49), `Runtime.settlement.log.ts` (10), `Runtime.settlement.hold.test.ts` (180)

Modified (`apps/server/src/provider/Layers/OpencodeV2/` unless noted):

- Production: `Execution.owners.ts` (87), `Orchestration.bridge.activation.ts` (141), `Orchestration.bridge.ts` (363), `Orchestration.bridge.invoke.ts` (125), `Orchestration.receipts.ts` (94), `PluginSetup.activation.gate.ts` (240), `Runtime.activation.ts` (179), `Runtime.settlement.ts` (134), `Runtime.send.ts` (195), `Runtime.replies.ts` (131), `Runtime.admission.owner.ts` (59), `Client.guard.ts` (167), `Runtime.types.ts` (162), `apps/server/src/server.ts` (376)
- Tests: `Execution.owners.test.ts` (110), `Runtime.activation.settlement.test.ts` (97), `Runtime.settlement.test.ts` (62), `Runtime.settlement.safety.test.ts` (130), `PluginSetup.activation.gate.test.ts` (107), `NativeCompatibility.runtime.guard.test.ts` (54)
- Docs: `docs/development/scripts.md`, and this ledger

Every code file is at most 400 lines. `Runtime.ts` (397 lines) was not touched.

## Remaining for Phase 3 and follow-up

- Live confirmation of the H1 cause, via the hold-reason status and log lines, is Phase 3 (user-operated). If the hold reason is not `coding-busy`, return to H2–H4 with that evidence.
- Before Phase 3, the user must keep exactly one backend per state directory. With this change, whichever of the two currently running main-checkout backends starts second will refuse if both share a state directory. Desktop's response to a refused backend (exit code 1) was not exercised.
- The `bun dev:server` / `bun run --cwd apps/server dev` break under Bun (`node:sqlite`) predates this series and is unrelated; it is out of scope.
- CLI maintenance commands do not take the backend lock (follow-up).
- Review debt: self-review only. Independent top-level reviews are still required at G4.

## Independent review fixes (Leg 7, 2026-10-15)

### Start token is now environment-independent (HIGH)

The token in the lock record and in the remote-agent controller identity came from `ps -o lstart=` under the caller's own `TZ`/`LC_*`. The same process therefore had different tokens under different environments (orchestrator check: `Thu Oct 15 05:47:29 2026` locally, `03:47:29` under `TZ=UTC`, `Do. 15 Okt.` under `LC_ALL=de_DE.UTF-8`). A second backend started under another environment would have classified a live owner as "PID reused" and displaced its lock.

- `apps/server/src/utils/processStartToken.ts` now emits versioned tokens (prefix `start-v2:`). On Linux the token is `/proc/<pid>/stat` field 22 (start ticks since boot) plus `/proc/sys/kernel/random/boot_id`. On other POSIX systems it is `ps -o lstart=` run with a fixed environment (`PATH` kept, `LC_ALL=C`, `LANG=C`, `TZ=UTC`).
- `compareProcessStartToken(recorded, current)` returns `same`, `different` or `unknown`. Only `different` (two comparable tokens of one scheme that differ) proves PID reuse. Legacy tokens (no prefix, for example `Thu_Oct_15_03:10:04_2026` in the step-1 row above), `pid:` placeholders, missing tokens and scheme mismatches are `unknown`.
- `classifyStateDirLockOwner` returns `live`, `dead` or `foreign-host`. A lock written by an older build therefore **fails closed**: it is refused while its PID is alive and replaced only when the PID is genuinely gone (ESRCH).
- `isRemoteAgentControllerAlive` uses the same comparison. A live PID with a legacy or placeholder token counts as alive (fail closed). A reservation owned by a pre-fix controller whose PID was reused stays unreclaimable until that PID exits.
- Real (non-injected) test: `processStartToken.test.ts` reads the token for the test process from two child processes, one under `TZ=UTC LC_ALL=C` and one under `TZ=Asia/Tokyo LC_ALL=de_DE.UTF-8`, and asserts they are equal. `remoteAgentController.test.ts` uses a real spawned process to cover a matching token, a differing comparable token, legacy/placeholder tokens and an exited PID.

### Lock refusal names a foreign host; atomic clearing (LOW)

- A record written on another host now gets its own message: `The bigbud backend lock <path> was written on host "<h>" (pid N, port P), not this host "<h2>", so its owner cannot be checked. If no backend uses <stateDir> (for example after a host rename), delete the lock; otherwise use a different BIGBUD_HOME.`
- `unlinkIfUnchanged` (used for stale owners, orphaned takeovers and release) renames the file to a private `<name>.<random>.stale` name, re-reads it, and unlinks it only if it is still the expected record. If a lost race captured a successor's file, it is restored with an exclusive `link` (an `EEXIST` means a newer owner already exists, which is kept).

### Receipt evidence requires no in-flight canonical handler (MEDIUM)

Before this fix, `receiptDurable` was true for any successful receipt read, including `reserved` and `absent`. After the 10 s `AbortSignal.timeout` in `Execution.orchestration.ts`, the bigbud-side handler (for example `create_thread`) can still be running in this same server process: the HTTP fiber is interrupted on client abort, but only after its uninterruptible regions finish. Once the native session drained, the uncertain entry could be released and the next send admitted while that effect was still in flight.

- New `apps/server/src/orchestration-tools/threadToolInvocationFlights.ts` is an in-process ledger keyed by invocation id. The V2 caller opens a dispatch before `fetch`. The `/api/internal/thread-tools` route enters the invocation right after decoding the body, before any effectful handler, and leaves it through `Effect.ensuring` when the handler fiber has ended (success, failure or interruption).
- A dispatch that settled before the route entered it is **fenced**: if the request arrives later, the route answers 409 and runs nothing. Both sides run on one JavaScript thread, so each transition is atomic. Fences are bounded by count (1024, oldest first); no timer is involved.
- `reconcileV2BridgeExecutions` now sets `receiptDurable` only for a `completed` receipt, or for `reserved`/`absent` while `isThreadToolInvocationInFlight(v2OrchestrationInvocationId(receiptKey))` is false. The invocation id is derived from the receipt key by the same function `prepareV2OrchestrationRequest` uses.
- Assumption (stated in code): the canonical endpoint is this server's own loopback port (`prepareV2Orchestration` passes the server port). A handler wrapping a non-Effect promise that ignores interruption could outlive its fiber. The ledger tracks the fiber, which is the strongest in-process signal available.
- Tests:
  - `Runtime.settlement.hold.test.ts` "H1 in-flight evidence" uses the real ledger. A `reserved` receipt with its handler in flight stays held as `coding-busy`, and releases only after the handler leaves. A `reserved` receipt with the handler finished releases. `absent` releases. A terminal (`completed`) receipt releases.
  - `threadToolInvocationFlights.test.ts` covers the ledger itself.
  - `http.threadTools.invocationFlight.test.ts` covers the route: an abandoned invocation gets 409 without running the dispatcher, and a blocked handler stays in flight until it ends.

### Settlement diagnostics use the server logger (LOW)

`logV2SettlementDiagnostic` previously ran `Effect.runFork` on the default runtime, which ignored the server's logger and log level. `makeV2RuntimeAdapter` now binds its services (`Effect.services()`), and the helper uses `Effect.runForkWith(services)`. `Runtime.settlement.log.test.ts` shows that a bound logger receives the line and that a bound `MinimumLogLevel` of `Error` suppresses it.
