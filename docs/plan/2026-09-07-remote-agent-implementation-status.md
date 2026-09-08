# Remote Agent Implementation Status

**Date:** 7 September, 2026
**Status:** In progress
**Owner:** bigbud implementation team
**Baseline:** `v0.2.205` (`461b7865cd28bb2570d9f580405fa53daee7b51f`)
**Candidate:** `v0.2.207` (`1d02e44cd090cc0e2bce25a2cca1a88442e4873e`)

## Summary

This document records the current state of the remote-agent upgrade work. It separates
completed implementation from partial work and remaining validation so another engineer
can resume without reconstructing the investigation.

The original production symptom is the failed `0.2.205 -> 0.2.207` upgrade. The old
agent rejects `--prepare-supervisor` with exit code 11 when stale journal acceptances
are present, even when no live work remains. Shared-state takeover is unsafe because
independent legacy stdio processes can still write the old state.

## Related Work

- [Isolated update plan](2026-09-07-remote-agent-isolated-update-plan.md)
- [Corrective plan](2026-09-07-remote-agent-corrective-plan.md)
- [Legacy upgrade investigation](remote-agent-0.2.205-upgrade.md)
- No issue, note, or Kanban identifier was supplied.

## Problem

An in-place upgrade assumes that the new supervisor can safely take over the legacy
supervisor's state directory. That assumption is false for `0.2.205`:

- Restart recovery can leave unmatched journal acceptances persisted after work is
  expired in memory.
- The new preparation check interprets those records as active work and returns code 11.
- `0.2.205` does not support `--prepare-supervisor`; unknown CLI arguments enter a
  stateful stdio path and can rotate the legacy epoch.
- Independent legacy stdio launchers do not honor the application activation lock.

## Goals

- Stage a verified candidate without starting its supervisor.
- Keep existing legacy sessions on their original runtime.
- Activate a candidate only on a deliberate fresh connection.
- Use isolated runtime state for each agent generation.
- Prevent duplicate execution after reconnects, retries, restarts, or lost responses.
- Retain two healthy agent builds plus builds referenced by live or uncertain work.
- Quarantine binary failures without treating network or authentication failures as binary
  failures.
- Provide explicit current, pending, fallback, and failure state to the UI.

## Non-Goals

- Automatically taking over or killing a live legacy supervisor.
- Deleting or rewriting legacy journals to force an upgrade.
- Importing unknown legacy sessions into the new runtime.
- Accessing the affected VPSs without explicit authorization.
- Publishing a new release as part of this local implementation task.

## Current State

### Complete

- Staged installation uses immutable, verified build paths and does not start the
  candidate supervisor. Main entry points are `remoteAgentInstall.ts`,
  `remoteAgentInstallManager.ts`, and `remoteAgentInstall.stage.ts`.
- Fresh admission starts an isolated runtime and verifies readiness before ordinary work.
  The production path is in `remoteAgentAdmission.ts`, `remoteAgentRuntime.launch.ts`,
  and `ws/wsRemoteAgentAdmission.ts`.
- Existing process, PTY, workspace, shell, watch, and Git routes carry generation-aware
  runtime bindings through `remoteAgentConnectionPool.ts`, `remoteAgentLifecycle.ts`,
  `remoteAgentProcessClient.ts`, `remoteAgentPtyClient.ts`, and
  `WorkspaceRuntime.remote.ts`.
- Admission promotion, connection selection, fallback, and registry updates use validated
  CAS transitions in `remoteAgentAdmission.ts` and
  `remoteAgentInstall.registry.transitions.ts`.
- Durable owner records, replay fences, terminal evidence, output gaps, and input sequence
  tracking protect against duplicate accepted work. The persistence boundary is
  `Migrations/111_RemoteAgentRuntimeBindings.ts`,
  `Migrations/112_RemoteAgentReplayFence.ts`, and
  `RemoteAgentRuntimeBindings.ts`.
- Git mutation IDs propagate through direct and stacked Git paths, including PR preparation
  identity and sub-operation identities. The main routes are `GitCore.ts`,
  `GitCore.execution.ts`, `remoteAgentGit.mutations.ts`, and
  `GitManager.runStackedAction.ts`.
- Managed and direct/custom Git execution paths are separated.
- Legacy compatibility is restricted to recognized legacy evidence; lookalike identities
  are rejected by `remoteAgentCompatibility.ts` and `remoteAgentLegacyBinding.ts`.
- Transport/authentication failures are separated from invalid candidate checks.
- Prepared process, PTY, workspace, and Git reservations can reclaim only when the owning
  controller is proven dead and the work is still in the prepared, unsent state. The
  controller and recovery boundary is `remoteAgentController.ts`, `remoteAgentOwners.ts`,
  `remoteAgentOwnedProcess.ts`, `remoteAgentOwnedPty.ts`,
  `remoteAgentWorkspaceMutation.ts`, and `remoteAgentGit.action.ts`.
- Activation pins and durable-reference checks are wired through the default admission
  binding; uncertain references remain pinned. See `remoteAgentAdmission.references.ts`
  and `remoteAgentAdmission.finish.ts`.
- MCP request identities are type-sensitive, and Copilot session filesystem sequences are
  persisted or fail closed when replay identity cannot be proven. Relevant files are
  `remoteWorkspaceMcpBridge.template.ts`, `orchestrationMcpBridge.template.ts`,
  `remoteWorkspaceSessionFsBridge.handler.ts`, and
  `remoteWorkspaceSessionFsBridge.sequence.ts`.
- UI state includes explicit admission outcome, selected build, pending state, fallback,
  and bounded failure details.
- Changed source and test files were audited against the 400-line limit.

### Partial or conservative by design

- Generic MCP providers do not universally expose an originating invocation identity across
  provider retries and bridge restarts. The bridge supports ordinary first calls and fails
  closed when replay identity cannot be proven; automatic exactly-once retry across an
  unsupported provider boundary is not claimed.
- Copilot filesystem mutation retries after an ambiguous handler recreation fail closed
  rather than risk a duplicate write. Ordinary first calls remain supported.
- Linux integration evidence is available for aarch64 fixtures. x86_64 validation has not
  been completed.
- Focused browser tests pass, but the full browser E2E suite has not been certified.
- Source-built fixtures are not proof that published release artifacts have the expected
  provenance.
- No live VPS upgrade has been performed.

### Repository state

- The local branch is ahead of `origin/main` by one local commit, `545301f8ee`.
- That commit contains plan documentation and `.gitignore` changes and has not been pushed.
- The implementation itself remains in a large unstaged worktree change set spanning
  server, web, contracts, and Rust journal/supervisor tests.
- No new release tag or published artifact was created for these implementation changes.
- Plan documents in this directory are documentation and must not be included in a code
  commit unless explicitly requested.

## Implementation Map

Use this map before changing code. The original upgrade bug is fixed by coexistence, not
by making `--prepare-supervisor` safer.

| Concern                         | Primary implementation                                                                                                  | Required invariant                                                                                                |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Artifact staging                | `remoteAgentInstall.ts`, `remoteAgentInstallManager.ts`, `remoteAgentInstall.stage.ts`                                  | Download/check without starting a candidate supervisor or changing legacy state.                                  |
| Runtime selection               | `remoteAgentAdmission.ts`, `remoteAgentRuntime.ts`, `remoteAgentRuntime.launch.ts`                                      | A deliberate fresh connection selects one isolated runtime before work admission.                                 |
| Registry durability             | `remoteAgentInstall.registry.ts`, `.store.ts`, `.transitions.ts`, `remoteAgentAdmission.references.ts`, `Migrations.ts` | CAS, bounded metadata, two healthy builds, active/uncertain pins, safe cleanup.                                   |
| Connection generations          | `remoteAgentConnectionPool.ts`, `remoteAgentConnection.identity.ts`, `remoteAgentLifecycle.ts`                          | Reconnects stay on the original generation; they do not consume pending updates.                                  |
| Process/PTY/workspace ownership | `remoteAgentOwnedProcess.ts`, `remoteAgentOwnedPty.ts`, `remoteAgentWorkspaceMutation.ts`, `remoteAgentOwners.ts`       | Resolve the durable owner before creating a new remote resource; ambiguous work is never replayed.                |
| Controller recovery             | `remoteAgentController.ts`, `remoteAgentControl.ts`, `remoteAgentOwners.ts`                                             | Reclaim only proven-dead, prepared, unsent reservations. Never reclaim sent or uncertain work.                    |
| Git routing                     | `GitCore.ts`, `GitCore.execution.ts`, `remoteAgentGit.ts`, `remoteAgentGit.action.ts`, `GitManager.runStackedAction.ts` | Managed actions retain one generation route; direct/custom SSH execution remains usable without managed bindings. |
| Provider/tool identity          | `toolTransport.ts`, `http.threadTools.remoteWorkspace.ts`, provider bridge files, MCP templates                         | First calls work; retries require a real originating identity or fail closed before dispatch.                     |
| UI and RPC                      | `wsRemoteAgentAdmission.ts`, `SidebarRemoteAgentStatus.tsx`, install/project dialogs                                    | Show staged/current/fallback/outcome explicitly; never infer fallback only from version strings.                  |
| Legacy Rust boundary            | `crates/bigbud-remote-agent/src/operations/journal/*`, `supervisor/prepare.rs`                                          | Preserve read-only journal safety; do not reintroduce shared-state takeover.                                      |

## Next-Agent Handoff

1. Read this document, `2026-09-07-remote-agent-corrective-plan.md`, and
   `remote-agent-0.2.205-upgrade.md` before touching code.
2. Do not use `git reset`, `git checkout`, or broad cleanup. The worktree is intentionally
   dirty and contains the implementation under review.
3. Treat `545301f8ee` as an existing local commit. Do not amend it or push it without an
   explicit request. Do not stage any file under `docs/plan/` for a code commit.
4. Inspect `git status --short --branch`, `git diff --stat`, and the untracked remote-agent
   files before editing.
5. Run the focused suites first:

   ```sh
   bun run --cwd apps/server vitest run \
     src/remote-agent/remoteAgentUpgrade.production.linux.test.ts \
     src/remote-agent/remoteAgentUpgrade.public.linux.test.ts \
     src/remote-agent/remoteAgentUpgrade.legacy.linux.test.ts \
     src/remote-agent/remoteAgentInstall.registry.linux.test.ts \
     src/remote-agent/remoteAgentInstall.cleanup.linux.test.ts \
     src/remote-agent/remoteAgentRuntime.launch.linux.test.ts \
     src/remote-workspace-bridge/remoteWorkspaceMcpBridge.identity.test.ts
   ```

6. If Docker fixtures are available, run the same suite with
   `BIGBUD_TEST_LINUX_DOCKER=1` and the saved fixture directory. Do not replace these
   tests with macOS-only mocks.
7. Run `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test`; never run `bun test`.
   If Rust code changes, also run the three required Cargo checks from `AGENTS.md`.
8. Before declaring completion, perform a read-only review against the acceptance criteria
   below. A passing unit suite alone is insufficient.

## Main Tasks

### Task 1: Staged activation and fallback

Status: **Complete in code; Linux x86_64 and live deployment validation remain.**

Keep the legacy runtime serving existing work, stage the candidate without startup, and
activate it only from a deliberate fresh connection using isolated state.

### Task 2: Durable generation routing

Status: **Complete for the implemented managed paths; provider boundary coverage remains.**

Restore owner bindings before creating resources, preserve runtime selection across server
restart, and reject ambiguous retries instead of resubmitting work.

### Task 3: Provider and tool invocation identity

Status: **Partial and intentionally fail-closed where SDK identity is unavailable.**

Verify MCP, Copilot, HTTP tool, shell, workspace, and provider integrations. Preserve
ordinary calls while requiring a stable identity for replayable mutations. Resolve whether
each provider can supply a stable retry identity; otherwise keep the documented fail-closed
boundary and expose a clear error. Do not replace this with content-based deduplication.
The remaining question is validation of each supported provider's real retry/restart path,
not enabling random IDs.

### Task 4: Healthy-build retention and cleanup

Status: **Complete for tested registry paths; continued-load validation remains.**

Retain two healthy builds plus live and uncertain references, release completed activation
pins, reconcile dead launches, and never delete a build needed by recovery.

### Task 5: Verification and release readiness

Status: **In progress.**

Run the complete aarch64 legacy matrix again after the latest changes, add x86_64 coverage
when available, run focused browser coverage, complete an independent review, and decide
whether the implementation is ready for a separately authorized release.

## Risks And Decision Gates

- Do not replace isolation with journal deletion or shared-state takeover.
- Do not turn an unknown provider retry into a new random invocation ID.
- Do not reclaim a prepared owner unless controller death and pre-dispatch state are both
  proven.
- Do not release a build pin while a durable owner, connection, or uncertain outcome still
  references it.
- Do not call the implementation production-ready until the failed successive-build Linux
  scenario and the original stale/retention-expired legacy scenarios pass together.

## Testing And Validation

Evidence already recorded:

- `bun fmt` passed.
- `bun lint` passed with existing warnings.
- `bun typecheck` passed across nine packages.
- `bun run test` completed with 2,848 server tests passed and 31 skipped in the latest
  local run.
- Focused provider, Git, admission, owner, and MCP tests passed.
- Rust formatting, locked Clippy, and workspace tests passed in the prior validation pass.
- Network-disabled Linux aarch64 fixture runs previously passed the core legacy isolation
  matrix; rerun after the latest owner/provider changes.
- `git diff --check` passed.

The corrective plan also records a broader run of **5,636 tests passed / 35 skipped** and a
network-disabled Docker aarch64 run of **21 tests passed with zero skips**. Treat those as
historical evidence from the corrective pass; rerun after any further source change. The
Docker fixtures are source-built from the legacy and candidate commits and do not certify
published release artifact authenticity.

Required remaining checks:

- Re-run the Linux aarch64 production upgrade matrix after the latest changes.
- Run Linux x86_64 fixtures if an available runner exists.
- Run focused browser tests for same-version fallback, remount, and pending activation.
- Diagnose and run the full browser suite when the RouterProvider/Ping harness is available.
- Perform final read-only review against the corrective plan and actual exit-11 symptom.
- Do not run `bun test`; use `bun run test`.

The full browser suite and x86_64 Linux suite are not currently completion gates because
they were not available in the last pass, but they remain recommended before release.

## Acceptance Criteria

- The original `0.2.205 -> 0.2.207` stale-journal upgrade succeeds through the production
  staging and fresh-admission path without modifying the legacy runtime state.
- Existing legacy work completes exactly once while the candidate is staged and activated.
- A candidate failure falls back before accepting work, without replaying accepted work.
- Two healthy builds remain available and cleanup preserves all active or uncertain routes.
- Provider and Copilot first calls work, while ambiguous retries fail closed unless a stable
  originating identity exists.
- Direct/custom Git execution continues to work without managed owner services.
- All required repository checks pass and all remaining platform gaps are documented.
- No code is released or deployed without explicit user authorization.

## Resume Decision

The code is suitable for continued local review and test iteration. It is **not yet a
release approval** because the final independent review after the latest provider/controller
changes is incomplete, x86_64 and live-VPS validation are absent, and provider SDK retry
identity must remain explicitly fail-closed where the SDK cannot provide it.

## Open Questions

- Which supported provider SDKs guarantee a stable originating invocation identity across
  retries and process restarts?
- When will a Linux x86_64 runner and a live test VPS be available for final validation?
- Should the conservative fail-closed behavior for provider retries remain the supported
  contract, or should provider integrations be extended before release?
