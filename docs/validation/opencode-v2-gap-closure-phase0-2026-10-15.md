# OpenCode V2 gap closure — Phase 0 (stabilize and commit)

## Acceptance boundary

**Code green: YES (macOS; Cargo condition below). Implementation/Plan green: NO.**

Plan: [2026-10-15 gap-closure plan](../plans/2026-10-15-opencode-v2-gap-closure-plan.md), Phase 0 items 0.1–0.5, gate G0.

Validated tree: **`c859532da`** on branch `opencode-v2/gap-closure`, worktree `.claude/worktrees/opencode-v2-gap-closure`, clean (0 porcelain entries) before and after every command. Phase 0.5 needed no source fixes. This ledger is the only uncommitted file, and the orchestrator records the final SHA when committing it.

No bigbud backend was started, no retail OpenCode binary ran, the user's daemon and `~/.config/opencode` / `~/.local/share/opencode` were not touched, and nothing was pushed.

## Commit series (Phase 0.4)

| SHA         | Group                                                           | Notes                                                                                                                                                   |
| ----------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `4f03c1898` | Pre-series base                                                 | Gap-closure plan commit                                                                                                                                 |
| `7f864b2e9` | 1. Effect RPC ownership repair                                  | 47 files; `wsRpcContext.ts`, `wsRpcClient.ts` and `wsRpcClient.types.ts` were split by hunk, with the Effect hunks in this commit                       |
| `1be054778` | 2. ChatGPT plan integration and Meta Muse planning docs         | Docs only                                                                                                                                               |
| `bacf76b84` | 3. Desktop/mobile/build-script tweaks                           | 6 files; verified on a clean detached checkout: typecheck 9/9, ws ownership/config diagnostics 17/17, web rpc + config recovery 118/118, build.copy 3/3 |
| `c859532da` | 4. OpenCode V2 thread tools, setup, recovery, Windows inspector | 484 files, including the Phase 0.1–0.3 edits                                                                                                            |

## Phase 0.1–0.3 changes

- **0.1:** `Development.shared.test.ts` and `Development.provider.diagnostics.test.ts` now expect `status: "warning"` for mocked unqualified `2.0.24`. The message must contain `OPENCODE_UNQUALIFIED_RUNTIME_WARNING`, and all models must be `available`. The `auth`, `runtimeUpdateRecommended: "2.0.26"` and HTTP-500 phase assertions are kept. Failed snapshots must not contain the advisory, which separates the two warning states. The new `Development.provider.qualified.test.ts` mocks the registry like `NativeCompatibility.runtime.qualified.test.ts` and pushes `syntheticV2QualificationRecord("2.0.24")` with the host `platform`/`arch`, so it also matches on Linux CI. It asserts `"ready"` and the plain connected message. With an empty registry, the same test failed (`warning`), which proves the mock decides the result.
- **0.2:** Removed the unused `oxlint-disable-next-line preserve-caught-error` from `NativeCompatibility.policy.ts`. The thrown message is a fixed string with no credentials, and no `cause` is attached.
- **0.3:** See "Turbo finding".

### A2 evidence (tests change, not the gate)

- 10-14 plan §1a: runtime-only proof "reports `unqualified` with an amber semantic-risk warning". The user chose "Runtime checks + warning" over "Require qualification first".
- `Development.provider.ts` sets `status: "warning"` when the runtime is a shared canonical 2.x candidate with no registry evidence, and appends the advisory to "Connected to your native OpenCode service.".
- `NativeCompatibility.status.ts` `v2NativeReadyNotice` returns `severity: "warning"` for `unqualified`.
- Conclusion: the six failing tests encoded the pre-amendment expectation. The gate is unchanged.

### Turbo finding (0.3)

`bun fmt:check` failed only on `AGENTS.md`. Turbo 2.11.5 re-emits its managed block without the blank line that oxfmt requires before `<!-- END:turborepo-agent-rules -->`. The bundled `docs/reference/configuration.mdx` and `docs/guides/ai.mdx` document the root-only `"agentGuidance": false` opt-out. Opting out keeps the existing block. Added it to root `turbo.json` and ran `bun fmt`. After a later Turbo invocation (`bun typecheck`), `bun fmt:check` exited 0 and the block kept its blank line. The `.oxfmtrc.json` fallback was not needed.

## Phase 0.5 command table (sequential, worktree root, `c859532da`)

| #   | Command                                                                                                           | Exit | Duration | Result                                                                                                                                                                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------- | ---- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `bun fmt:check`                                                                                                   | 0    | 2 s      | 5,713 files formatted                                                                                                                                                                                                                                |
| 2   | `bun lint`                                                                                                        | 0    | <1 s     | 0 errors, 63 warnings (64 before 0.2); test-file-length: 1,852 files scanned, 9 warning files, 0 violations                                                                                                                                          |
| 3   | `bun typecheck`                                                                                                   | 0    | 19 s     | 9/9 tasks                                                                                                                                                                                                                                            |
| 4a  | `bun run test` (first run)                                                                                        | 1    | 1,048 s  | 8/9 tasks; server 1 failed / 1,109 passed / 55 skipped files, 3 failed / 4,797 passed / 116 skipped tests, 1 unhandled error (`ThreadShellRunner.test.ts`, see triage)                                                                               |
| 4b  | `bun run --cwd apps/server vitest run src/shell/Layers/ThreadShellRunner.test.ts --retry 0`                       | 0    | ~3 s     | 3/3 passed (environmental rerun)                                                                                                                                                                                                                     |
| 4c  | `bun run test` (full rerun)                                                                                       | 0    | 993 s    | 9/9 tasks. Server 1,110 passed / 55 skipped files, 4,800 passed / 116 skipped tests. Web 468 files / 2,893 tests; desktop 74+1 skipped files, 431 passed / 4 skipped; shared 48/360; mobile-web 41/212; contracts 32/195; scripts 24/131; all passed |
| 5   | `cargo fmt --all --check`                                                                                         | 0    | <1 s     | clean                                                                                                                                                                                                                                                |
| 6   | `cargo clippy --locked --workspace --all-targets -- -D warnings`                                                  | 0    | 5 s      | no warnings                                                                                                                                                                                                                                          |
| 7a  | `cargo test --locked --workspace` (worktree path)                                                                 | 101  | 13 s     | `bigbud-remote-agent` lib: 116 passed / 9 failed (`supervisor::core::reliability_tests`); 180 passed across binaries before cargo stopped                                                                                                            |
| 7b  | same, on a byte copy of `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, `crates/`, `protocol/` at a short path | 0    | 17 s     | 241 passed / 0 failed                                                                                                                                                                                                                                |
| 7c  | same, on pre-series `4f03c1898` (scratch detached worktree, since removed)                                        | 101  | 16 s     | 114 passed / 9 failed: the same 9 tests, same panic                                                                                                                                                                                                  |

Logs (external): `/Users/youpele/.claude/jobs/332f2aea/tmp/{p05-fmt,p05-lint,p05-tc,root-test,root-test-2,p05-cfmt,p05-clippy,p05-ctest,p05-ctest-shortpath,p05-ctest-4f03}.log`.

### Server OpenCode V2 totals (`src/provider/Layers/OpencodeV2`, from run 4a)

254 files: 217 passed, 37 skipped. 948 tests: 898 passed, 50 skipped, 0 failed. Of the 50 skips, 47 come from the 37 `*.native*` files. Those are expected without an approval record (`SharedService.native.isolation.fixture.ts` `approvals = []`). The other 3 are platform gated: `Development.security.test.ts` and `SharedService.packaging.test.ts` run only on win32, and `RebootRecovery.host.linux.test.ts` runs only on Linux. The plan's earlier "1,048 pass / 286 files" figure used a different selection; the focused V2 directory run on this tree gives the totals above.

## Failure triage

| Failure                                                                                                                                            | Class                                                             | Evidence                                                                                                                                                                                                                                                                                                                                                                          | Disposition                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `apps/server/src/shell/Layers/ThreadShellRunner.test.ts`: 3 tests and 1 unhandled rejection, `posix_spawnp failed`                                 | (c) environmental                                                 | Passed 3/3 in an isolated `--retry 0` rerun and in the full root rerun 4c. The series changed nothing under `apps/server/src/shell` or `src/terminal` (`git diff --stat 4f03c1898 HEAD` is empty). This is PTY spawn pressure from the long sequential server run, not a V2 regression                                                                                            | Recorded; no change                                                  |
| `crates/bigbud-remote-agent` `supervisor::core::reliability_tests` (9 tests): panic `supervisor socket unavailable` at `reliability.fixture.rs:34` | (b) pre-existing and unrelated; environment: worktree path length | `temp_root` places `supervisor.sock` under `<repo>/target/pty-<pid>-<nanos>/`. In this worktree that path is 125 bytes, over macOS's 104-byte `sockaddr_un` limit; in the main checkout it is about 83 bytes. The same 9 tests fail identically on pre-series `4f03c1898` (7c) and pass at a short path with this commit's crates (7b). The series did not touch `src/supervisor` | Recorded as unrelated; no change (fixture change would expand scope) |

No failure in the Effect RPC (group 1) or misc (group 3) commits.

## Gate G0

- `bun fmt:check`, `bun lint`, `bun typecheck` and full root `bun run test` exit 0 on `c859532da` (4c).
- `cargo fmt` and `cargo clippy` exit 0. `cargo test` exits 0 for this commit's Rust sources at a canonical short path. At the worktree path it fails only on the pre-existing socket-path-length tests (b). Expected: exit 0 from the main checkout path.
- Code green: **YES** (with the Cargo path condition above). Implementation/Plan green: **NO**. Phases 1–4 remain.
- Review debt: self-review only; independent top-level reviews are still required at G4.
