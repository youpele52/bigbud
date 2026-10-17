# Local root checks — 12 October 2026

## Result and scope

**Local root checks PASS; parent acceptance complete.** The authorized baseline format/test repairs are independently reviewed and accepted. Root format, lint, all nine typecheck tasks, and the completed default `bun run test` pass. The one parent-authorized default-root retry passed without changing either previously timed-out server file or its deadlines. The earlier failures below remain historical evidence, not the current result. Native-platform qualification remains separate from this acceptance.

Working branch: `plan/terminal-rust-gpu-reliability`; HEAD: `93e43aa7492c77550d778e9f82448fdc90bd1217`. No commit, push, staging, branch/worktree change, dependency change, production-code change, account/configuration change, or native provider installation was performed by this verification task. Existing dirty work was preserved. Test-created temporary fixtures are separate from user accounts, repositories, and databases.

All 149 approved API source paths match `implementation-source-v3.json` (manifest SHA-256 `bc597a79929143aefe74c0552d292bd9302efa78d4af55e6e55084e5c6157dd9`). All five WSL authored source/test paths match the version 2 ownership ledger. The index diff is unchanged. Rust sources were not edited by this task; this pass did not repeat Cargo checks. Previous native-platform evidence remains separate: **Windows/WSL and Windows x64/ARM64 are still unqualified**. Default skipped native/service tests are not native acceptance evidence.

## Tooling discovered

- Bun workspace with `bun.lock`, declared `bun@1.3.9`; local runtime Bun 1.3.14 and Node 25.2.1, macOS, 10 logical CPUs.
- Formatter: `bun fmt` → oxfmt, `.oxfmtrc.json`; read-only `bun fmt:check`.
- Lint: `bun lint` → oxlint using `.oxlintrc.json`, then `scripts/check-test-file-length.ts`. Warnings are not configured as errors.
- Typecheck: `bun typecheck` → Turbo `typecheck`, nine uncached tasks.
- Tests: **`bun run test`** → Turbo `test` → workspace Vitest 4.1.5, with dependency builds. Never ran Bun's native test runner. Server files are sequential with 60-second test/hook budgets; shared tests use default file parallelism.
- Read installed Turbo 2.11.5's `docs/README.md`; no Turbo commands/configuration were changed. Existing root scripts were used. Commands were run sequentially: format, lint, typecheck, focused diagnostics, root tests.

## Minimal repairs and evidence

### Repository instructions formatting

Initial `bun fmt:check` found only `AGENTS.md`. `bun fmt` inserted one blank line before the managed block's closing marker; whitespace-normalized instruction text is identical. `CLAUDE.md` is an existing symlink to `AGENTS.md`, not a second changed file. No managed-block directive was edited.

**Tool interaction:** Turbo 2.11.5 rewrites its managed block during invocation and removes that blank line again. Formatting is therefore reapplied after the last Turbo check. A subsequent Turbo invocation can recreate this formatting failure; no configuration/dependency workaround was made under the whitespace-only authorization.

### Saturation model fixture

`packages/shared/src/terminalOwner/cleanup.model.fixture.ts`: aggregate child-bound violations into one assertion per snapshot instead of creating four assertions per child. Every child is still canonically encoded after every checked transition; all effects, identity-length, outcome-byte and record-byte bounds remain checked with offending-child diagnostics. No transition, count, state/order, grant, replay, reservation, or permission coverage was removed.

- Root reproduction: `cleanup.model.test.ts`, pending=false, exceeded its existing 15-second test budget; root run took 47.847 seconds and aborted downstream tasks.
- CPU profile before repair: 2,244/4,256 samples in Vitest/Chai assertion paths, 938 in canonical encoding. Assertion bookkeeping was the largest measured cost.
- Same two focused files before/after: 14 tests passed; duration 4.95 → 2.48 seconds, process CPU user time 6.77 → 4.39 seconds. Original 15-second saturation timeout unchanged.
- Subsequent root runs passed all three saturation-model tests.

### Bounded authentication test budget

`packages/shared/src/terminalOwner/cleanup.auth.test.ts`: only the 33/64-PTY parameterized case uses the existing saturation model's 15-second test budget. The full 64-PTY case measured 5,766 ms under root load against the previous 5-second budget, versus 377 ms isolated. Profiling found canonical validation, cloning, and actual model operations dominant here, not assertion overhead. The selected budget provides approximately 2.6× the measured loaded duration without changing production behavior.

Credential deadlines, authentication steps, all PTYs, all allowed/denied permissions, revocation, mutation and immutable-inventory assertions are unchanged. No global timeout or worker setting changed. Subsequent root runs passed all 11 authentication tests and all 359 shared tests.

### Greeting row expectation

`apps/web/src/components/settings/GeneralSettingsPanel.test.tsx`: include the already-committed greeting-name row in the exact General row ordering and check its accessible input label. Existing section ordering, terminal controls, reset/validation and no-update assertions are preserved. No greeting component was changed.

Focused before: one failed / one passed; after: two passed. Subsequent root web runs: 438 files / 2,602 tests passed.

### Durable remote PTY restart fixture

The first full downstream server run revealed another baseline fixture failure: `remoteAgentOwners.restart.test.ts` mocked SSH command construction but not the folder probe added by the committed terminal-folder workflow. The nonexistent fixture command failed before durable PTY recovery.

`apps/server/src/remote-agent/remoteAgentOwners.restart.test.ts`: mock the SSH process boundary with the existing `Manager.remote.test.ts` folder-probe response shape, scoped to the recovery test. Assert the returned cwd, both probes and their SSH target/command. Existing old-generation binding, create/attach counts, no-local-spawn, no replacement and no-signal assertions remain intact.

Focused before: one failed / one passed. After, together with `Manager.remote.test.ts`: two files / five tests passed. The next root run passed this recovery test.

All four materially edited test/fixture files remain below 400 lines. No approved API or WSL source was changed.

## Earlier completed root runs and historical blocker

1. `test-before.log`: root failed saturation pending=false; 47.847 seconds. Authentication passed in this reproduction.
2. `test-repair-1.log`: saturation passed; root failed 64-PTY authentication (5,766 ms against 5,000 ms); 47.084 seconds.
3. `test-repair-2.log`: shared and web passed; completed server suite found only the stale remote-PTY restart fixture failure. Root: 8/9 tasks successful, 21m55.193s. Server: 1,003 files / 4,366 tests passed, one failed, 43 files / 99 tests skipped.
4. `test-final.log`: restart fixture and all earlier repaired cases passed. Root: 8/9 tasks successful, 25m27.788s; **exit 1**. Server: 1,002 files passed, two failed suites, 43 files skipped; 4,364 tests passed, one failed, 101 skipped. Failures:
   - `ProviderService.routing.cliProxy.test.ts`, `ProviderServiceLive provider execution targets`: hook timeout at 60,000 ms.
   - `GitCore.service.diffAndHistory.test.ts`, first commit-context case: test timeout at 60,000 ms.
5. Both files passed **unchanged** immediately afterward: two files / 23 tests, 6.22 seconds (`transient-server-isolated.log`). No timeout increase, skip, assertion removal, or speculative code fix was applied to them.

The earlier `test-final.log` run's other workspaces passed:

| Workspace  | Files passed | Tests passed | Tests skipped |
| ---------- | -----------: | -----------: | ------------: |
| contracts  |           29 |          191 |             0 |
| scripts    |           23 |          128 |             0 |
| desktop    |           74 |          431 |             4 |
| mobile-web |           41 |          212 |             0 |
| shared     |           47 |          359 |             0 |
| web        |          438 |        2,602 |             0 |

Machine load during these earlier runs was substantial despite no other agent test run being launched: initial root reproduction load average 18.95, after its parallel phase 49.01; after `test-final.log`, 26.43/46.84/51.51. This is evidence of load-sensitive behavior, not proof of either timeout's exact root cause. Both server cases were green in the preceding full root run and green in immediate isolation. The parent authorized exactly one further full default-root retry; its completed result is recorded below. The isolated result was never substituted for full-root acceptance.

## Logs and reruns

All logs, CPU profiles, entry hashes/status, preservation check and final ownership manifest live under:

`/private/var/folders/2l/n21yzwk92050bbzprv854q_w0000gn/T/opencode/local-root-checks-2026-10-12/`

Exact focused commands:

```sh
bun run --cwd packages/shared test src/terminalOwner/cleanup.auth.test.ts src/terminalOwner/cleanup.model.test.ts
bun run --cwd apps/web test src/components/settings/GeneralSettingsPanel.test.tsx
bun run --cwd apps/server vitest run src/remote-agent/remoteAgentOwners.restart.test.ts src/terminal/Layers/Manager.remote.test.ts
bun run --cwd apps/server vitest run src/provider/Layers/ProviderService.routing.cliProxy.test.ts src/git/Layers/GitCore.service.diffAndHistory.test.ts
```

Root lint before the retry: exit 0, 34 warnings / zero errors, no test-file policy violations (`lint-repair-3.log`, repeated in `lint-final.log`). Typecheck: all nine tasks passed, zero cached (`typecheck-repair-3.log`); tested source is unchanged since that pass. Root formatting and read-only format check are reapplied after the retry's last Turbo invocation. The parent subsequently accepted the independently reviewed repairs and verified the completed results below.

| Evidence                        | SHA-256                                                            |
| ------------------------------- | ------------------------------------------------------------------ |
| `lint-repair-3.log`             | `a3140ec7f1bd7217fb826e632029dac3a7b0ad34eb999353ce65d9e47131440a` |
| `typecheck-repair-3.log`        | `eb85c95e678982163415c49b26614901693db842c742a16c7fdfb23ef7af15f3` |
| `test-repair-2.log`             | `958a2592bf8f0a56e4d09464119aa692236cdb7006a4ac506a57e44623a02351` |
| `test-final.log`                | `a9fdb5ce2dfa2801ea15de191db981ff6d1a96aebc04536ebf7e2ebe7e459804` |
| `restart-after.log`             | `79f3fd5acd9a2ec633c863e4fb7f962397965caebdc4bb583e61e06b7509d2a9` |
| `transient-server-isolated.log` | `b50b55bdac5b447551a7d72c1983c4ce68ac951e3187d816307a74e7d4bd1607` |

## Completed default-root retry — version 2

The parent authorized one default `bun run test` with no peer agent test jobs, no speculative source repairs and no test/dependency/Turbo configuration changes. This was the only additional full-root attempt. Neither remaining server file nor either 60-second deadline was edited. No environment, worker, concurrency, cache or reporter override was used; `/usr/bin/time -lp` wrapped the existing command solely to record process timing.

The host was still busy, so this was **not** described as a quiet or controlled-load experiment. Actual command-start load averages were 37.15/31.52/39.13 on 10 logical CPUs; end averages were 19.71/26.81/37.62. UTC start/end: `2026-10-12T10:49:12.764971+00:00` / `2026-10-12T11:06:15.255891+00:00`. Start/end resource snapshots and top-process CPU usage were captured once each; no load polling, sleeping or stopping user processes was performed. This passing run does not establish the exact root cause of the historical timeouts.

**Actual result: exit 0, 9/9 tasks successful, 17m2.247s Turbo elapsed; 1,022.485 seconds measured wall time.** Seven test tasks executed with cache bypass; the two cache hits were existing contracts/web dependency builds, not cached test results. All workspaces in the table above passed again. Server: **1,004 files / 4,367 tests passed**, 43 files / 99 tests skipped. Combined Vitest results: **1,656 files / 8,290 tests passed**, 44 files / 103 tests skipped; no failing tests or suites.

Both previously timed-out files passed unchanged in this full root run:

- `GitCore.service.diffAndHistory.test.ts`: all 13 tests, 2,340 ms.
- `ProviderService.routing.cliProxy.test.ts`: all 10 tests, 1,552 ms.

All repaired cases also passed: cleanup authentication 11 tests, saturation model three tests, General settings two tests, and durable remote-owner restart two tests. Existing platform/native/service skips remain explicit; **Windows and other previously outstanding native-platform qualification gaps are not closed by this local root pass**.

After the last Turbo invocation, root `bun fmt` and `bun fmt:check` restore/verify the single AGENTS whitespace line, and root lint is repeated. No test source changed since the passing typecheck. Final owned-file hashes, unchanged API149/WSL5 checks, unchanged two server files, index/HEAD/branch preservation and final command evidence are frozen in `final-manifest-v2.json`; the original `final-manifest.json` (`b0df604635fd9a71bd96eeb70b87308b2438fa82abf6f10516c3e69642e949c9`) remains immutable historical evidence.

| Version 2 evidence                     | SHA-256                                                            |
| -------------------------------------- | ------------------------------------------------------------------ |
| `test-default-rerun-v2.log`            | `98cb6d236168aaf7e126db439068340b53431f3e2eb3e226ca8a101d5e12309b` |
| `test-default-rerun-v2.resources.json` | `1753843d774b64b9c5a36f02e1d54692894a348c25acf1d2fcba81288fde5598` |

## Parent acceptance — 12 October 2026

Independent code review (`ses_ed2c65644ffea1GON19xJp6I2C`) returned **Scoped GREEN** for all four repaired test/fixture files and the whitespace-only instruction change, finding no must-fix issue or material assertion weakening. No production source changed.

The parent independently verified `final-manifest-v2.json` SHA-256 **`ad995c6ab19f5a94bbac22690c0c59ed9f10950d3ca9dba59e221c41167d3340`**, all six owned-file hashes, all 38 evidence-file hashes, all 149 approved API paths, all five WSL paths and both unchanged server test files, with zero drift. Branch, HEAD and index match the entry state. Raw root output confirms all nine tasks successful and both previously timed-out files passing.

**Accepted: local implementation, independent reviews and repository checks are GREEN.** Windows/WSL execution and other unexecuted native-platform variants remain unqualified. No staging, commit, push or new feature implementation is implied.

This documentation-only acceptance annotation follows the frozen manifest. Its ledger checksum describes the pre-acceptance evidence; the immutable manifest and reviewed source remain unchanged.
