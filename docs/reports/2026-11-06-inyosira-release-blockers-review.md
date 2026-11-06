# Inyosira release blockers review — 6 November

## Decision

Code acceptance is complete; cross-platform release qualification is incomplete. The [qualification report](2026-11-06-inyosira-packaged-qualification.md), including its final F1/F2 rerun, records 174 passing tests across 54 files, without skips. The [Fable review](2026-11-06-inyosira-fable-final-review.md) accepts the code, with F1/F2 subsequently fixed. No unresolved organiser defect is established by these reports.

The fresh unsigned macOS ARM64 packaged backend passed actual engagement, disconnect/reconnect and two-minute canonical snooze expiry. Linux x64 passed emulated sidecar and common packaged server-resource checks. Neither establishes full desktop, installer or signing qualification.

## Ranked blockers

1. **Missing native execution evidence.** Windows x64/ARM64 have compile checks only. Intel macOS lacked a local runtime. Linux Electron/AppImage/deb execution remains open. These are qualification gaps, not demonstrated product defects.
2. **Incomplete standalone artifact set.** The prepack verifier actually failed at a missing foreign-platform workspace agent; `release-assets/` was absent. All five workspace-agent/supervisor pairs must be assembled before the [complete-set verifier](../../apps/server/scripts/verifyWorkspaceAgentPackage.ts) can pass. Host-only rebuilds cannot close this gap.
3. **Unexecuted release and production-scale gates.** Signing/notarization and the release workflow remain unexecuted. Activation on an isolated copy of the real large database remains unmeasured; synthetic scale results do not close that evidence gap.

The current [release desktop matrix](../../.github/workflows/release-desktop-build.yml) contains four desktop targets. Windows ARM64 is a separate server-sidecar job in [release.yml](../../.github/workflows/release.yml), not an ARM64 desktop installer lane. Existing packaged verifiers do not perform the report's real two-client/deadline backend checks.

## One recommended next step

Run one **non-publishing Windows x64 packaged qualification** on a disposable native Windows runner. This addresses a platform with no runtime evidence and exercises the actual installer.

Prerequisites: freeze a source snapshot containing final F1/F2, identify it by hashes, use an isolated checkout, and provide existing build prerequisites and a disposable Windows account with no installed bigbud or real userdata. Preserve the heavily dirty shared checkout. Obtain authorization for this execution scope; any commit or push requires separate fresh approval. Repository/workspace-wide checks also require separate approval.

The following commands are supported by the existing Windows packaging sources. Run from the isolated repository root, sequentially, stopping on any nonzero exit code:

```powershell
node scripts/build-desktop-artifact.ts --platform win --target nsis --arch x64 --build-version 0.0.0-preview.1 --output-dir release --verbose
node scripts/verify-packaged-workspace-agent.ts release win x64 release-publish
bun run scripts/verify-packaged-desktop-supervisor.ts release win
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/nsis-update-smoke.ps1 -ReleaseDir release
```

The [artifact builder](../../scripts/lib/desktop-artifact/build.ts) invokes electron-builder with `--publish never` and builds the desktop/server dependency graph unless skipped. The [NSIS smoke](../../scripts/nsis-update-smoke.ps1) installs, updates and uninstalls bigbud and can close a held helper; run it only in that disposable environment.

After those commands, repeat the qualification report's isolated packaged-backend startup, two-client engagement/disconnect/reconnect and two-minute deadline checks on Windows. The temporary harnesses are retained under `/tmp/inyosira-packaged-qualification.2XHqVl`; their Windows paths and invocation must be validated before execution. No ready-to-run Windows harness command is claimed here.

Observable pass criteria:

- All commands exit zero, with logs and source/artifact hashes retained.
- Packaged organiser activation/proposal, workspace handshake/cleanup, supervisor recovery and system-monitor smoke pass.
- Installer update closes the held helper and succeeds; cleanup completes.
- Packaged backend HTTP/status becomes healthy with one organiser child using its packaged path.
- Independent engagement leases survive disconnect/reconnect correctly.
- Snooze remains Later until its deadline, then commits exactly one move to Needs you, with zero pending operations and zero provider sessions/turns.
- Shutdown is bounded and leaves no qualification-owned children.

Passing this step closes the Windows x64 evidence slice only. Other platform, complete-set, signing and large-database gates remain open.

Do not dispatch `release.yml` as a dry run: it has broad preflight checks, signing/notarization steps through its reusable build, and a final GitHub Release publication job. It has no dry-run input. Main-branch CI is non-publishing but its desktop matrix requires a main push and broad quality checks; a pull request alone does not run that matrix.

## Review scope

Read-only product review. No product source edits, builds, tests, broad checks, live userdata access, workflow dispatch, staging, commits or pushes. Only this separate report was added, with focused formatting and local-link validation.

## Follow-up — GitHub Actions qualification prepared

At the user's subsequent request, a separate [Windows qualification workflow](../../.github/workflows/inyosira-windows-qualification.yml) and [portable packaged-backend harness](../../scripts/verify-packaged-inyosira-windows.ts) were added. This supersedes the temporary Windows harness preparation instructions above. Native Windows execution is still pending; local workflow validation does not qualify the platform.

The manually triggered workflow uses a disposable GitHub-hosted `windows-2022` runner, checks out the exact dispatched SHA, and refuses an existing bigbud installation. It runs focused organiser Rust unit/process fixtures, builds unsigned NSIS output, runs the existing packaged verifiers, executes engagement/reconnect and full two-minute canonical deadline checks, and exercises installer update/cleanup. The backend uses bundled Electron Node with an isolated temporary profile and an explicit packaged supervisor path, matching desktop configuration. Provider credentials and inherited bigbud settings are excluded.

The harness verifies exactly one applied native snooze operation, one canonical revision increment, zero prepared operations, zero provider sessions/turns, and one native organiser child at the packaged path. Windows parent termination uses `TerminateProcess`; the evidence checks bounded termination and native EOF cleanup, and does not claim POSIX graceful shutdown. Forced fallback cleanup fails qualification.

Repository permissions are `contents: read`; there are no release/tag/push or signing steps. The build uses the existing `--publish never` path. Logs, source SHA, runtime JSON, artifact digests, sidecars and the unsigned installer are retained as Actions artifacts for 14 days. Workflow/job/step timeouts bound failure paths.

Local validation passed: explicit-path formatting and lint, the configured scripts package typecheck, seven focused harness tests, actionlint (including ShellCheck) for this workflow, explicit file-length checks (all below 400), and local document links. The scripts typecheck emitted only existing informational TS44 suggestions in `serverRuntimeDependencies` files. No Windows build/installer/runtime run, broad checks, commit, push or workflow dispatch was performed locally.

Before execution, the final migration sources and these qualification files must exist together on an approved pushed GitHub ref. Select **Inyosira Windows x64 qualification (no publish)** in Actions and dispatch that intended ref. For a new manually triggered workflow, [GitHub requires its definition on the default branch](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow) before dispatch is available. Commit/push and any broad validation still require their own fresh approval under AGENTS.md. A passing run qualifies only this unsigned Windows x64 slice; the other ranked gaps remain.
