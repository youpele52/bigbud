# Selected-distro WSL terminal follow-up — 2026-10-12

## Scope and baseline

Local follow-up on `plan/terminal-rust-gpu-reliability`, starting at `93e43aa7492c77550d778e9f82448fdc90bd1217`. No staging, commits, pushes, branch switches, worktrees, remote CI, distro installations or distro/configuration changes were performed. Parent/user confirmed repairs to existing **manual WSL terminals**, not a general WSL provider/workspace/Git/filesystem target. Local/SSH behavior and concurrent OpenCode, Rust, release and timeline edits were left to their existing owners.

The supplied research is an earlier snapshot. Commit `93e43aa749` already implemented distro listing/selection, process Home capture, identity pinning, Windows-path translation, PTY routing, snapshot metadata, command isolation and WSL file-link/drop guards. Its intentional Home policy is the selected distro-default user's **process `HOME`**, captured alongside username/UID inside that distro. This follow-up does not change that policy to NSS account-home lookup or add a specific-account selector.

Environment: macOS, Bun 1.3.14, Node 25.2.1, Vitest 4.1.5, repository `bun.lock`. Native Windows/WSL/ConPTY is unavailable on this host. Required clarifier delegation was attempted but rejected by the subagent depth limit; the parent's completed scope clarification and direct repository/research exploration were used instead.

## Reproduced defects and repairs

1. **Fallback renewed the resolution budget.** The existing test advanced the clock to 9 seconds, then expected Home to receive another 10 seconds. A new regression also showed a Home result arriving after the original deadline being accepted. The resolver now keeps one immutable 10-second wall-clock deadline across installed-distro discovery, identity capture, translation, cwd validation, context mapping and same-identity Home fallback. The fallback at 9 seconds receives only 1 second; late output fails closed. Confirmed cwd failures may still fall back, but timeouts cannot create or renew that opportunity.
2. **Malformed input paths escaped via fallback.** Input checks rejected only NUL, while Linux output checks rejected C0/DEL controls and paths longer than 4096 characters. Newline/escape-containing inaccessible input paths could succeed at Home and preserve raw malformed `requestedCwd` in fallback metadata. Shared input/output validation now rejects empty, control-containing and overlong paths before their guest path probes, including worktree and known project-path environment values. Expanded Home-relative paths are checked again; returned Linux paths must still be absolute. Normal missing-folder fallback retains the same identity and clears project environment/worktree context.
3. **Corrupt UTF-16 selection crashed instead of failing closed.** An unpaired surrogate passed `isWslDistributionName`, then `encodeURIComponent` threw `URIError` in `resolveManualTerminalTarget`. The shared name validator now rejects unpaired surrogates while allowing valid non-BMP Unicode names. Corrupt persisted selections use the existing invalid WSL sentinel, rather than crashing or silently launching locally.

Only two runtime modules changed: `apps/server/src/terminal/Layers/Manager.wsl.ts` and `packages/shared/src/terminalExecutionTarget.ts`. Regression tests changed in `Manager.wsl.test.ts`, `terminalExecutionTarget.test.ts` and `terminal.store.wsl.test.ts`. Research/report headers now explicitly mark historical implementation claims; `microsoft-wsl.md` received formatting only. No provider, contract, RPC, PTY, UI component or process-runner source was modified.

## Before/after evidence

- Existing focused WSL baseline: **8 files / 48 tests passed**.
- Resolver regressions before repair: **6 failures / 18 passes**. Exact evidence included `expected 10000 to be 1000`, a late Home promise resolving instead of rejecting, and malformed cwd fallback preserving newline/escape data.
- Unicode regressions before repair: shared validator **3 failures**, web persisted-selection **2 failures**; the latter threw `URIError: URI malformed`.
- Version 1 expanded focused verification: **18 files / 130 tests passed** (server 77, shared 32, contracts 2, web 19). Its final post-format source regression rerun passed **59 tests**. These are pre-correction results, not version 2 qualification.
- Version 1 picker and real-viewport browser integration: **2 files / 8 tests passed**, using already-installed Chromium. Browser success is not native WSL qualification; these browser tests were not repeated after the server-only version 2 correction.

## Functional-review correction (version 2)

Independent functional review `ses_ed2a78650ffeOGMNCL8ADkxfqD` found one remaining P2: worktree/known project-path environment validation still ran only after cwd success. A missing cwd could return successful Home fallback before those raw context values were validated. Prior security approval covered version 1 only; updated functional/security review is pending in the parent.

The correction reuses `validatedPath` to validate raw cwd, any provided non-null worktree path (including rejecting a present empty string), and values for the existing four known project-path environment keys **before discovery or any guest process invocation**. Validation remains within the original immutable resolution deadline. Arbitrary custom environment text is not subjected to path validation. Expanded/translated Linux paths retain their later validation and absolute-output requirement. Valid missing-cwd fallback still uses the same captured identity and clears worktree/environment context. No other runtime source was changed for version 2.

- Before correction: the new matrix produced **10 failed / 27 passed** resolver tests. Five missing-cwd cases resolved at Home instead of rejecting; five cwd-success cases invoked probes before rejecting. The post-fix matrix covers newline, ESC, NUL, overlong and empty values across worktree/all four path-env fields with missing and successful cwd, plus valid fallback and absent/null worktree context.
- After correction: resolver **39 passed**; repeated expanded focused verification **18 files / 143 tests passed** (server 90, shared 32, contracts 2, web 19). This includes the original deadline, Home/identity, Unicode, local/SSH and command/file-safety regressions.
- Owned source lint: **0 warnings / 0 errors**. Scoped formatting and diff checks passed. Largest authored file is now `Manager.wsl.test.ts`, **385 lines**; resolver is 185 lines.
- Root `bun lint` completed successfully as an integration snapshot, with **34 non-owned warnings** and no test-file policy violations. Root typecheck/full tests/browser tests were not repeated during this correction, to avoid concurrent API validation load. The parent owns final integration gates. The earlier root formatting/typecheck failures below are historical snapshots, not a permanent WSL failure claim.

Exact before/after logs and version 2 ownership hashes are in `/private/var/folders/2l/n21yzwk92050bbzprv854q_w0000gn/T/opencode/`: `wsl-v2-before.log`, `wsl-v2-after.log`, `wsl-v2-focused.log`, `wsl-v2-root-lint.log`, and `wsl-followup-v2-ownership-2026-10-12.md`. Source is frozen for the parent to resume independent reviews; native Windows/WSL qualification remains outstanding.

Re-run focused checks with:

```sh
bun run --cwd apps/server vitest run \
  src/terminal/Layers/Manager.wsl.test.ts \
  src/terminal/Layers/Manager.wsl.invocation.test.ts \
  src/terminal/Layers/Manager.wsl.process.test.ts \
  src/terminal/Layers/Manager.wsl.session.test.ts \
  src/terminal/Layers/NodePTY.wsl.test.ts \
  src/project/Layers/ProjectSetupScriptRunner.wsl.test.ts \
  src/utils/processRunner.direct.test.ts \
  src/ws/wsRpcHandlers.terminalTargets.test.ts \
  src/terminal/Layers/Manager.cwd.test.ts \
  src/terminal/Layers/Manager.remote.test.ts \
  src/terminal/Layers/Manager.startup.test.ts \
  src/project/Layers/ProjectSetupScriptRunner.terminal.test.ts
bun run --cwd packages/shared vitest run src/terminalExecutionTarget.test.ts src/terminalCommand.test.ts
bun run --cwd packages/contracts vitest run src/workspace/terminal.wsl.test.ts
bun run --cwd apps/web vitest run \
  src/stores/terminal/terminal.store.wsl.test.ts \
  src/lib/terminalLaunchBinding.wslCommand.test.ts \
  src/components/terminal/TerminalViewport.wslFiles.test.ts
bun run --cwd apps/web test:browser \
  src/components/terminal/TerminalTargetPicker.browser.tsx \
  src/components/terminal/TerminalTargetPicker.integration.browser.tsx
```

Version 1 scoped `bun fmt -- <owned paths>` passed. Its `bun lint` exited 0 with 33 warnings outside WSL-owned files; its length check reported no policy violations. All five authored source/test files were below 400 lines (version 1 maximum 302). `git diff --check` passed. See the version 2 results above for the corrected source.

Root checks are **not all green**: the first combined typecheck invocation exceeded the tool's 120-second timeout; a subsequent completed `bun typecheck` reported 8 successful packages and server errors exclusively in concurrently edited `ProviderService.publication.test.ts` (missing Effect `Scope`, invalid event-type arguments). Read-only `bun fmt:check` found 24 unformatted paths at that moment: `AGENTS.md` plus concurrent provider/OpenCode documentation/code; none were WSL-owned. Those paths were not reformatted or repaired by this task. The parent must re-run final root checks after concurrent implementation stabilizes and perform independent reviews. Full `bun run test` was not repeated here to avoid concurrent load; the parent's unrelated saturation/greeting test findings were not modified.

## Independent version 2 reviews — 12 October 2026

The parent recomputed all ten working-file SHA256 values against `wsl-followup-v2-ownership-2026-10-12.md`; all matched before re-review. Independent functional review (`ses_ed2a78650ffeOGMNCL8ADkxfqD`) and incremental security review (`ses_ed2a7863dffebIWoSQyyZTNVCC`) both returned **scoped GREEN**, with no remaining must-fix in the approved manual-terminal scope. The context-validation bypass is closed before any process invocation, including missing-cwd/Home-fallback cases. The reviewers retained the native-platform and root-check limitations rather than treating source approval as completion.

The frozen version 2 runtime/test sources are unchanged. This parent-added review record is a documentation-only change after that freeze; its earlier ledger hash identifies the evidence reviewed, not the current document. Final root checks must be rerun after the concurrent API implementation stabilizes. Native Windows/WSL/ConPTY remains unqualified.

## Native Windows verification still required

Current Microsoft guidance was checked through Context7 `/microsoftdocs/wsl`: names-only installed listing, explicit distro/user invocation, `--exec` bypassing the default Linux shell, and `--terminate` stopping the whole distro. Official references: [basic commands](https://learn.microsoft.com/en-us/windows/wsl/basic-commands), [release-note CLI help](https://learn.microsoft.com/en-us/windows/wsl/release-notes#build-18305), [WSL configuration](https://learn.microsoft.com/en-us/windows/wsl/wsl-config), [file/environment interoperability](https://learn.microsoft.com/en-us/windows/wsl/filesystems). Exact CLI/argument behavior must still be checked against the supported host's `wsl.exe --help` and `wsl.exe --version`.

With the user's permission to start an **existing** selected distro, native acceptance should cover:

- Two registered distros with different configured default users/Homes, including root or a nonstandard Home; discovery names/encoding and explicit canonical selection.
- Requested cwd success and inaccessible-cwd Home fallback in the exact selected distro/user; no Windows Home/default-distro substitution, worktree/setup context cleared on fallback.
- Windows paths containing spaces, quotes and metacharacters, guest translation and ConPTY argument serialization, without cmd-shell interpretation.
- Slow startup/Home probing, bounded output and cancellation: one overall resolution deadline, no late-result spawn and no destructive distro-wide cleanup. Killing the Windows wrapper **does not prove** the guest stopped.
- Existing running terminals unchanged when picker preferences change; explicit restart identity captured anew; automatic project/setup/`!` commands retain their workspace target and never write into a fallback or mismatched WSL terminal.
- WSL guest file links/drops rejected before host filesystem APIs; local/SSH remain unchanged.

Do not install fixtures, change default distro/accounts/configuration, unregister, shut down or terminate a distro merely to run these checks. This follow-up does not qualify OpenCode HTTP registration or other Windows providers.
