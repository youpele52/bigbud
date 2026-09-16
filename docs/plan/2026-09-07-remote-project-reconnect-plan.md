# Remote project Reconnect with remote-service restart

**Date:** 7 September, 2026  
**Status:** Ready for implementation — revalidate the implementation baseline before editing  
**Owner:** implementing agent  
**Created:** 2026-09-07 17:52:08 SAST (UTC+02:00)  
**Last modified:** 2026-09-07 17:52:08 SAST (UTC+02:00)  
**Project root:** `/Users/youpele/DevWorld/bigbud`  
**Inspected branch / commit:** `main` / `1d02e44cd090cc0e2bce25a2cca1a88442e4873e`  
**Planning permissions:** Write this document only. No application implementation, tests, formatting, staging, commits, remote access, or changes to unrelated work were authorized or performed for this planning task.

## Summary

Add **Reconnect** as the first item in an SSH remote project's context menu. Despite the short UI label, this is an explicit service restart: stop and relaunch the selected bigbud remote server process, interrupt the turns and terminals it manages, and reconnect the application to the replacement. It is not merely SSH transport recovery.

Keep every saved project setting unchanged. Reuse existing SSH authentication; prompt for a password only when a password-authenticated target actually needs authentication. Preserve existing SSH-key/passphrase behavior. Do not expire working authentication just to force a prompt.

The user explicitly selected this disruptive operation rather than a tunnel-only reconnect. It does not authorize restarting the host OS, sshd, the local application server, or unrelated processes. Runtime sharing determines impact: other projects using the same selected remote service can be interrupted, but other bigbud runtimes on the host must not be stopped.

## Related Work

- Source: user request and subsequent clarification in this conversation. No issue, note, or Kanban identifiers supplied; none invented.
- [Remote-agent isolated updates](2026-09-07-remote-agent-isolated-update-plan.md): generation-pinned runtime and fresh-admission boundaries. Reconnect must not silently become pending-update activation.
- [Remote-agent corrective work](2026-09-07-remote-agent-corrective-plan.md): durable owners, replay fences, and proven-death reconciliation. This plan adds a separate deliberate restart path; it does not relax ordinary recovery guarantees.
- [Accepted native boundary](../decisions/2026-08-22-rust-remote-workspace-agent-boundary.md): local TypeScript/SQLite authority; remote Rust process/PTY/workspace execution.
- Instructions inspected: root `AGENTS.md`, `crates/AGENTS.md`, and `_plan-authoring-guide--do-not-delete.md`. No nested `AGENTS.md` was found beneath the TypeScript or docs areas.

## Problem

The current project context menu provides Rename project, Edit SSH configuration, Copy Project Path, and Remove project, but no direct recovery operation that replaces the remote service while preserving the project.

Existing connection operations do not implement the requested behavior:

- Closing an SSH proxy/pool entry disconnects transport, not the remote supervisor.
- Fresh admission may reuse a healthy runtime or select a pending update; it does not necessarily stop any process.
- Supervisor preparation returns success for a matching live binary and guards against taking over active work.
- Managed launch intentionally refuses to overwrite existing launch intent, epoch, journal, and socket state. Recovery proxies are forbidden from restarting their bound runtime.

Consequently, adding a menu item that calls `pool.close()`, `verifyExecutionTarget`, or `connectRemoteAgent` alone would be incorrect. The restart needs a dedicated, narrowly authorized lifecycle path with explicit interruption and outcome handling.

## Goals

1. Show **Reconnect** first for SSH remote projects; leave local and built-in project menus unchanged.
2. Stop and relaunch the exact selected bigbud remote service even when it is healthy; reconnect only after verifying the replacement.
3. Preserve project IDs, names, paths, execution targets, SSH settings, model defaults, scripts, thread history, worktree references, and UI preferences.
4. Interrupt only work managed by that service, with factual turn/terminal status and no automatic redispatch of interrupted mutations or turns.
5. Reuse valid authentication, resume the same operation after necessary credential entry, and allow cancellation before destructive work without stopping the service.
6. Handle shared runtimes, duplicate requests, in-flight work, stale clients, process death, response loss, and partial restart failure predictably.

### Settled decisions

- Label and placement: **Reconnect**, first item.
- Meaning: stop/relaunch bigbud's remote service and interrupt its managed work, then reconnect.
- Password: authenticate as needed, not on every click. No password prompt for key-authenticated targets; retain existing key-unlock behavior.
- Settings: preserve all saved configuration; do not remove/recreate/reconfigure the project.
- Baseline: planning now, implementation later. The dirty worktree is a revalidation requirement, not an unresolved product decision or a blocker to saving this plan.

### UI recommendation, not an additional user mandate

Use one existing-style confirmation before the destructive phase because the label alone sounds transport-only. Suggested description: “Reconnect restarts the bigbud remote service and interrupts the turns and terminals it manages, including other projects using this service. Saved project settings are kept.” Buttons: Cancel and Reconnect. Do not add a mode selector, second restart action, or additional settings. This is the recommended implementation default; wording can follow existing dialog conventions without reopening the settled operation policy.

## Non-Goals

- Host reboot, sshd restart, local server/Electron restart, host-wide process killing, or termination of unrelated runtimes/processes.
- Reinstallation, silent upgrade, activation of a staged build, new remote-platform support, or a new compatibility matrix.
- Project deletion/recreation, settings changes, journal deletion/repair, provider credential changes, or automatic turn/PTY/mutation replay.
- Transparent continuity of interrupted turns or terminals. Preserve saved history/settings, not a promise that live processes survive this explicitly disruptive action.
- Reworking ordinary transport reconnect or completing unrelated dirty-worktree tasks.

## Current State

### Verified repository findings

Paths below are relative to the repository root. Line references describe the inspected worktree and must be refreshed if that work changes.

| Concern                     | Evidence and reuse target                                                                                                                                                                                                                                                                     |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Menu                        | `apps/web/src/components/sidebar/Sidebar.projectActions.ts:163-203` builds the menu and dispatches actions. It resolves the workspace target, not the provider-runtime target.                                                                                                                |
| Menu contract               | `packages/contracts/src/server/ipc.ts:27-32` supports ID, label, destructive, and disabled; no explicit separator field. Preserve current removal grouping; do not expand the menu API just for another divider.                                                                              |
| SSH settings                | `Sidebar.projects.logic.ts:87-130` reconstructs the draft from saved workspace target and serializes host/user/port/auth/key path into that target. Reconnect must use the saved target unchanged, not reserialize a draft.                                                                   |
| Canonical project data      | `apps/server/src/persistence/Layers/ProjectionProjects.ts:37-77` persists targets, root, model, scripts, and identity/timestamps. `Sidebar.projectAddActions.remote.edit.ts:85-94` dispatches `project.reconfigure`; do not call this for Reconnect.                                          |
| Authentication              | `apps/server/src/ssh/sshSession.ts:93-139,162-239` checks password ControlMaster liveness and unlocks when necessary. `ControlPersist=600`; unlocking a live session returns immediately. Passwords are not project settings.                                                                 |
| Auth UI                     | `apps/web/src/hooks/useRemoteExecutionAccessGate.ts` and `.checks.ts`/`.shared.ts`, `SidebarUnlockSshKeyDialog.tsx`, and `stores/remoteAccess/remoteAccess.store.ts` own the prompt, transient secret, and pending action. The store has one global pending action.                           |
| Important gate hazard       | `useRemoteExecutionAccessGate.ts:162-170,256-267` can continue navigation while verification is pending. That optimistic continuation must not authorize destructive restart. Its unlock continuation also performs full agent verification, unsuitable when the agent itself needs recovery. |
| RPC wiring                  | `packages/contracts/src/constants/websocket.constant.ts`, `server/{server,rpc.core,rpc,ipc.nativeApi}.ts`; web `rpc/{wsRpcClient,wsRpcClient.types,wsNativeApi}.ts`; server `ws/wsRpcHandlers.gitTerminal.ts`. Reuse the registration pattern, not fresh admission's semantics.               |
| Server verification         | `ws/wsExecutionTargetVerification.ts` separates SSH verification from remote-agent health and wraps typed Effect errors. Reuse SSH-only preflight for restart so an unhealthy agent cannot block its own recovery.                                                                            |
| Lifecycle identity          | `remote-agent/remoteAgentRuntime.ts` validates immutable runtime descriptors with executable, state, socket, generation, and origin. `remoteAgentControl.ts` resolves the authenticated account's canonical control root.                                                                     |
| Sharing                     | `remoteAgentConnectionPool.ts:193-204` keys entries by target and generation. Different project paths can use the same target; different SSH spellings may reach the same account/root/socket. Match actual runtime identity, not hostname alone.                                             |
| Admission versus restart    | `remoteAgentAdmission.ts:200-359`, `wsRemoteAgentAdmission.ts`, and `remoteAgentRuntime.launch.ts` implement fresh admission and pinned proxies. Fresh admission can reuse a ready launch; pinned recovery does not restart.                                                                  |
| Restart metadata constraint | `remoteAgentInstall.registry.ts` stores one build descriptor per build ID, launch epochs, and ready admission epochs. Preserve historical admissions when publishing a replacement epoch; never rewrite them as if old operations ran in the replacement.                                     |
| Persistence/replay          | `persistence/Layers/RemoteAgentRuntimeBindings.ts:67-84,148-170` binds logical connections and forbids changing durable owners' runtime/epoch/identity. Reuse its replay fence and retain uncertain owners.                                                                                   |
| Native service              | `crates/bigbud-remote-agent/src/supervisor/core.rs` owns process, PTY, and watch handling. `supervisor/prepare.rs` contains verified socket-peer/process signaling and active-work guards, but is not a force-restart API.                                                                    |
| Native state                | `crates/bigbud-remote-agent/src/state/core.rs:31-69` opens state with a new epoch and rejects a live supervisor socket; `main.rs:134-145` starts a supervisor with the retained operation journal. Restart requires launch exclusivity, not merely this socket check.                         |
| Downstream consumers        | `remoteAgentOwnedProcess.ts`, `remoteAgentOwnedPty.ts`, `remoteAgentProcessClient.ts`, `remoteAgentPtyClient.ts`, workspace/watch clients, `workspace-runtime/Layers/WorkspaceRuntime.remote.reconnect.ts`, terminal manager, and provider adapters consume pinned resources.                 |

The remote “server” here is `bigbud-remote-agent`, not a remote copy of the canonical TypeScript/SQLite application server. Local provider runtimes can also be affected through their remote workspace operations; do not terminate local provider processes indiscriminately.

### Plan assumptions and engineering defaults

- **Reuse the selected executable and state root.** Restart means a new process epoch for the same selected runtime, not a different build or a new empty workspace state. Retain journals/logs and old owner identities. Verify with before/after build identity and retained journal tests.
- **Bound disruption by runtime identity.** The selected service's managed work is in scope even when another project uses it. Other generations and unrelated processes are out of scope. Verify with two shared projects plus a separate supervisor on the same host.
- **Fail closed on unprovable identity.** An unresponsive service can be force-stopped only if ownership/process identity is established without trusting a stale PID alone. Unsupported safe control is a factual error, never permission to send unknown CLI flags or kill by name.
- **Use current abstractions.** Existing Effect schemas, OpenSSH transport, bounded registry CAS, and native process facilities are sufficient starting points; introduce no library dependency or new package for this feature.
- **No configuration migration.** Lifecycle request/history persistence may need an additive internal migration, but project settings schemas must not change. Register any needed internal migration using the next available number, not a number assumed from this dirty baseline.

## Phases

### Phase 1: Revalidate and add the explicit restart contract

**Dependency:** none; implementation starts only in a later authorized task.

1. Record the actual implementation branch, SHA, and worktree. Read the current related plans and applicable instructions. Compare the listed modules to this baseline; integrate with existing work without reverting or overwriting it.
2. Add focused schemas in `packages/contracts/src/server/server.remoteRestart.ts` and a dedicated `server.restartRemoteAgent` RPC. Keep internal naming honest: the UI says Reconnect, the RPC restarts. Do not change `connectRemoteAgent` to become destructive.
3. Input carries a bounded stable request ID, project ID, and expected saved workspace target. Resolve the project and runtime server-side; reject deletion/reconfiguration since menu selection. Never accept a client-supplied PID, shell command, or arbitrary executable/state path.
4. Return typed lifecycle outcomes: authentication required, in progress, ready, failed, or outcome unknown; include a safe message and verified replacement identity on success. Use existing error/auth classification patterns and exclude secrets/raw shell dumps. Add status retrieval for the same request so a transport timeout does not force another restart.
5. Register schemas/methods through the contract/RPC files listed above, web NativeApi facade, and a focused server adapter `apps/server/src/ws/wsRemoteAgentRestart.ts`. Update test doubles alongside the new method.

**Exit criteria:** contract validation and RPC wiring tests distinguish this operation from install, verify, and fresh admission; no existing public operation gains destructive behavior.

### Phase 2: Implement the bounded restart coordinator and durable transitions

**Dependency:** Phase 1 contract; build with injected control/clock dependencies for deterministic tests.

1. Add `apps/server/src/remote-agent/remoteAgentRestart.ts`, splitting state transitions, persistence, and native control into `remoteAgentRestart.*.ts` as needed. Compose it through `remoteAgentServerLayer.ts` and the configured composition, not a separate unmanaged connection pool.
2. Preflight the saved SSH target using SSH-only verification. Do not require a healthy agent or valid remote project directory before restarting the service. If credentials are needed, return the existing auth mode/prompt information before stopping anything. A live retained password session is reused.
3. Resolve and pin the selected runtime/build before any stop. Persist bounded request progress tied to expected old epoch and runtime identity: `prepared -> stopping -> stopped -> starting -> ready`, with explicit failed/unknown outcomes. A duplicate ID resumes/returns that operation; it never kills the replacement. Different concurrent IDs for that runtime join the active operation rather than queue another stop.
4. Coordinate remotely at canonical control-root/runtime identity, reusing registry locks/CAS rather than a project-only mutex. Fence new admission/resource creation to the retiring epoch before stop. Integrate fresh-admission and cleanup guards so neither can race the restart. Close the check-to-dispatch window in the owning resource-admission path, not only in the UI.
5. Keep the same validated executable, runtime descriptor, and state root. Add explicit restart history linking old epoch, request ID, and replacement epoch. Extend registry validators/reducers to preserve historical admission epochs alongside the new current launch epoch. Do not overwrite old ready admissions or erase recovery pins to satisfy a validator.
6. Extend the managed launcher with a separate authorized-restart path. Only a matching restart reservation plus proven old-process death permits relaunch into retained state; ordinary `buildIsolatedRemoteAgentLaunch` and recovery proxy guards stay unchanged. Serialize across the complete stop/start boundary and retain uncertain launch intent until reconciled.
7. Verify replacement handshake, exact build identity, new epoch, and readiness diagnostic before publishing a new logical connection binding for new work. Do not consume `pending`, choose fallback builds, call install, or silently change staged-update state. Persist remote completion before local publication; if local persistence fails, retry publication for the same request, not the stop phase.
8. Keep request storage bounded. Never evict an in-progress/uncertain request to allow a duplicate destructive run; fail with a bounded capacity error instead. Reuse existing terminal-history/replay-fence patterns where applicable. Preserve old runtime ownership evidence.

**Failure semantics:** before stopping, leave the old service unchanged on preflight failure. After stop, a startup failure is “remote service stopped; reconnect failed,” not a generic no-op. On lost response, query/reconcile the same request and process identity. Never infer death from a missing response or restart again to discover whether the first attempt succeeded.

**Exit criteria:** coordinator fault tests show one stop/relaunch per operation, preserved settings/build selection, and recoverable progress across response loss and local service restart.

### Phase 3: Add verified native stop/relaunch support

**Dependency:** Phase 2 lifecycle transitions; native implementation belongs to the existing remote-agent crate.

1. Add focused modules under `crates/bigbud-remote-agent/src/supervisor/` for explicit restart control, owned-work shutdown, and tests. Reuse/extract verified-peer and process-handle code from `prepare.rs`; keep ordinary prepare's active-work refusal unchanged.
2. Expose narrowly scoped explicit control through the agent's CLI/control boundary, wired in `main.rs`/supervisor module exports. Check support through stateless identity/capability evidence before use: unknown flags can enter stateful stdio in existing historical binaries. Do not invent legacy support or run new flags as a probe.
3. Resolve the exact supervisor from its validated private socket and owned process handle. Verify UID, socket type/permissions, executable/runtime identity, and expected epoch when available. Use stable process handles for signaling where supported; stale PID reuse, symlinked state, or identity mismatch must abort without touching another process.
4. Stop accepting new work; interrupt managed processes/PTYs through owned cancellation/shutdown paths, publish terminal evidence where known, close watches/transports, and stop the supervisor. Use bounded graceful shutdown followed by force termination of verified owned resources when needed; never terminate by process name, host-wide scan, or an unrelated process group. Forced termination without completion evidence leaves mutation outcomes unknown.
5. Ensure the actual supervisor is gone and owned resources have settled or have explicit unknown/failure evidence before relaunch. Hold restart exclusivity across native shutdown and launcher replacement. Retain journals/logs and normal state security checks; never unlink a live socket or delete the journal to make startup succeed.
6. Use the inspected journal-restoration behavior as a regression target (`session/journal_restore.tests.rs`): retained old-epoch evidence must not authorize redispatch in the new epoch. New epoch is a discontinuity, not proof of cancellation or rollback of external side effects.
7. If native wire messages are necessary for owned shutdown, update the owning `protocol/remote-agent/*.proto`, Rust generation, TypeScript codec, capabilities, and golden tests together. Prefer the narrow existing control/CLI boundary for management; do not expose a new network listener or move product/domain decisions into Rust.

**Exit criteria:** real-process Linux tests prove old supervisor death, replacement readiness/new epoch, owned child interruption, and survival of unrelated processes and a separate supervisor. An identity-ambiguous or unsupported target fails safely without an automatic reinstall.

### Phase 4: Reconcile consumers without replaying interrupted work

**Dependency:** verified restart and replacement publication from Phases 2-3.

1. Extend `remoteAgentConnectionPool.ts` to invalidate all entries for the exact retired runtime/epoch, including locally known target aliases. Fence in-flight `get`/`getBound` setup and late failure callbacks. Include expected epoch in entry identity so old and new epoch-bound clients cannot collide for the same generation.
2. Keep old durable owners' runtime, epoch, resource ID, digest, and sequences immutable in `RemoteAgentRuntimeBindings.ts`. Add a new logical connection binding for replacement work; retain old owner routes and replay fences. Historical requests must report their known/unknown outcome, not resolve through the new selected connection.
3. Through existing owned-process/PTY and terminal manager shutdown paths, settle known affected terminals and active turns with an explicit remote-service-restarted/interrupted reason. Do not delete chats or history, leave turns spinning indefinitely, replay PTY input, or restart provider turns automatically. Stop only sessions/resources that depend on the retired service; local unrelated provider work stays running.
4. Re-resolve workspace clients for new reads and new actions. Recreate watches and require rescan after restart. Preserve `WorkspaceRuntime.remote.reconnect.ts` read-only retry behavior and process/PTY mutation attach safeguards; do not relax generic epoch validation in `remoteAgentLifecycle.ts`.
5. Invalidate frontend readiness/runtime summaries for affected targets, then update from authoritative operation status. Late pre-restart access checks cannot mark the target ready; attach operation/generation tokens to completion where required. Other connected clients must get invalidation through existing lifecycle/status delivery or reverify rather than retain stale readiness.

**Exit criteria:** shared-project and stale-handshake tests demonstrate correct interruption, new work reaches the replacement, and potentially accepted old work never runs twice.

### Phase 5: Add the Reconnect menu action and reuse authentication

**Dependency:** stable RPC and lifecycle outcomes from Phases 1-4.

1. Extract menu/reconnect responsibilities from `Sidebar.projectActions.ts` into focused `Sidebar.projectActions.menu.ts` and `Sidebar.projectActions.reconnect.ts` modules as appropriate. Insert Reconnect first using the existing SSH workspace-target predicate. Preserve all other items and built-in exclusions; use the existing disabled property while the operation is pending.
2. Use the recommended single confirmation described above; wire through `Sidebar.projectActions.types.ts` and existing sidebar dialog composition. No additional menu separator or context-menu contract expansion is needed. Keep one named component per new component file, default `text-sm`, and supporting copy `text-xs`.
3. Start the dedicated restart RPC with one stable request ID. On authentication-required, reuse the current password/key-unlock dialog rather than project editing. Extract shared credential submission into a focused access-gate auth module if needed: a restart pending action unlocks SSH and resumes the same restart directly, without requiring full remote-agent health verification first.
4. Preserve current key/password mode selection. Never call `unlockSshPassword` for a key-authenticated target, never deliberately close a valid ControlMaster, never persist secrets, and never bypass host-key checks. Wrong credentials stay an inline auth error with the existing retry behavior.
5. The store currently supports one pending auth action. Reject/defer another auth-requiring action with existing busy feedback rather than overwrite the first continuation. Clear secrets/pending state on pre-stop cancellation. Do not use the existing optimistic access-check timeout as permission to stop the server.
6. Show blue in-progress feedback, green only after verified readiness, amber for interrupted/uncertain recovery warnings, and red for definitive failure. A request timeout is not cancellation: retrieve the same request's status. Once stopping starts, dismissing a toast/dialog must not abort the durable server-side operation or claim it left the service unchanged.
7. Preserve sidebar selection/expansion and all saved project data. Reconnect must not dispatch `project.reconfigure`, `project.delete`, or `project.create`, serialize a new execution target, or reset unrelated remote-access state.

**Exit criteria:** browser coverage proves first-item placement, accurate disruptive description, disabled/repeated click handling, key/password behavior, cancellation, and success/failure feedback without configuration writes.

## Risks And Decision Gates

- **Shared-service impact:** interruption across projects bound to the selected service is part of the settled policy. The UI should explain that scope without claiming a complete inventory of independent clients. Do not broaden stop to all services under the account.
- **External side effects:** an interrupted Git push/write/tool call may already have taken effect. Retain and report unknown outcomes; never imply restart undoes work.
- **Process identity and shutdown races:** only verified owned processes may be signaled. Native ownership, admission fencing, and exclusive launch tests are release gates, not optional hardening.
- **Old agent support:** preserve existing non-restart usage for installed binaries without safe explicit control. Report unsupported restart safely; do not invent a legacy compatibility promise, change global compatibility policy, or silently upgrade. Validate the packaged/native control capability before presenting completion.
- **Two persistence domains:** local SQLite and remote control metadata cannot commit atomically. Use durable phase reconciliation and conservative retained references; a response-loss retry must finish the same operation.
- **Rollback:** disable/remove the new menu/RPC path if necessary, retaining additive lifecycle history and all settings/owner evidence. Before stop, abort without change. After stop, resume launch/publication for the same request; do not promise restoration of interrupted live processes or silently switch builds.
- **Observability:** log request ID, lifecycle phase, safe runtime correlation, durations, and error classification. Never log passwords, environment secrets, provider credentials, or raw shell command output. New infrastructure/metrics platforms are out of scope.
- **File length:** initial inspected sizes include `Sidebar.projectActions.ts` 397, `remoteAgentAdmission.ts` 399, access-gate hook 384, and supervisor `core.rs` 386 lines. Split by concern before materially editing; every new/edited source and test must remain <=400 lines. Do not hand-edit generated outputs.

## Testing And Validation

All commands here are for the later implementing agent. None were run for this plan.

### Required evidence by layer

| Layer              | Required cases and reuse targets                                                                                                                                                                                                                                                                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contracts/RPC      | Invalid/local/deleted/stale project; request ID validation; no raw PID/path authority; separate restart semantics; stable request/status mapping. Add `ws/wsRemoteAgentRestart.test.ts` and contract tests.                                                                                                                                                                        |
| Coordinator        | Same-ID retry, two concurrent IDs, two aliases, admission/cleanup races, auth before stop, stop/start timeout, reply loss at every phase, local persistence failure after remote ready, process-scoped coordinator restart. Add focused `remoteAgentRestart.*.test.ts`; reuse admission/registry fixtures.                                                                         |
| Native             | Healthy service is actually replaced; dead service recovery; hung service with verified ownership; stale PID/socket/symlink rejection; shutdown with accepted process/PTY work; one replacement only; retained journal; separate supervisor and unrelated process survive. Reuse `supervisor/prepare_tests.rs`, `prepare_process_race_tests.rs`, and remote runtime Linux harness. |
| Ownership          | Interrupted turns and terminals settle; old accepted mutations are never redispatched; old owner identity persists; new connection has a new epoch; watches rescan; late connections cannot restore old readiness. Extend pool/lifecycle and owned-resource tests.                                                                                                                 |
| Authentication     | Live password session reused; expired/missing session prompts; wrong password retries same operation; key targets never get password prompt; passphrase path unchanged; cancellation leaves service running; competing pending actions do not overwrite each other.                                                                                                                |
| Browser            | Reconnect first only on SSH project menu; accurate interruption copy; one action despite repeated clicks; progress/success/failure/unknown states; reload retrieves rather than repeats restart; project settings and sidebar preferences unchanged.                                                                                                                               |
| Manual integration | Two projects sharing a service plus another service on the same host; active turn and terminal; observe old PID/process identity gone and a new ready epoch; verify saved settings before/after and exercise a new read, terminal, and turn. Use disposable fixtures, not production access without separate authorization.                                                        |

### Later commands

Proposed new test filenames are marked by the restart names below; split them further as needed to satisfy the line limit.

```sh
# Focused server tests, from repository root
bun run --cwd apps/server vitest run src/remote-agent/remoteAgentRestart.test.ts src/ws/wsRemoteAgentRestart.test.ts
bun run --cwd apps/server vitest run src/remote-agent/remoteAgentLifecycle.test.ts src/remote-agent/remoteAgentConnectionPool.test.ts src/ssh/sshSession.test.ts
bun run --cwd apps/server vitest run src/remote-agent/remoteAgentAdmission.test.ts src/remote-agent/remoteAgentOwners.restart.test.ts src/remote-agent/remoteAgentRuntime.launch.linux.test.ts

# Web state and browser suite
bun run --cwd apps/web vitest run src/stores/remoteAccess/remoteAccess.store.test.ts
bun run --cwd apps/web test:browser
# Only if browser prerequisites are missing:
# bun run --cwd apps/web test:browser:install

# Required repository completion checks
bun fmt
bun lint
bun typecheck
bun run test
cargo fmt --all --check
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo test --locked --workspace
git diff --check
```

Never run `bun test`. Run actual native restart integration on Linux; macOS success with Linux-specific tests skipped is not proof. Preserve existing server test sequencing. Record exact commands, pass/fail/skip counts, environment, and any pre-existing failures. Run the required formatter only during authorized implementation and review its diff so it does not sweep unrelated dirty files into the task. Independently check all authored/materially edited source/test file lengths; the current lint length checker is not evidence for every source language.

## Acceptance Criteria

- [ ] Reconnect is the first remote SSH project menu item; local/built-in menus and existing actions retain their behavior.
- [ ] The UI describes that Reconnect restarts bigbud's remote service and interrupts its managed turns/terminals; the confirmation is a plan recommendation, not a misattributed user requirement.
- [ ] A healthy selected supervisor is stopped and relaunched with the same selected build and retained state; a new verified epoch and readiness prove success rather than a tunnel reconnect.
- [ ] Only the selected service and its owned work are interrupted, including shared-project consumers; unrelated processes/runtimes, host OS, sshd, and local application server are untouched.
- [ ] Saved project settings, IDs, history, worktree references, and UI preferences are unchanged across success, failure, cancellation, and reload.
- [ ] Existing valid authentication is reused; password is requested only as needed for password mode; key/passphrase behavior remains intact and secrets are never persisted/logged.
- [ ] Cancellation before stop does not interrupt the service; after-stop failures and unknown outcomes are reported accurately and recovered using the same request.
- [ ] Concurrent/duplicate requests and stale connections cannot cause extra restarts, cross-runtime signaling, or false readiness.
- [ ] Old accepted work is never moved/replayed into the replacement; affected turns/terminals settle with factual interruption/unknown status and watches rescan.
- [ ] Fresh admission, staging, ordinary reconnect, epoch checks, and replay fences retain their existing non-destructive semantics.
- [ ] Required checks pass, real-process Linux evidence exists, and every authored/materially edited source/test file is <=400 lines.

## Open Questions

No unresolved user/product decisions. Scope, label, placement, interruption policy, authentication policy, and saved-plan delivery are settled. Runtime identity and native capability checks are implementation safety conditions, not invitations to reopen the agreed behavior.

## Plan Validity And Handoff Notes

- The baseline is committed `main` plus substantial pre-existing modified/untracked files, not the SHA alone. It includes remote admission/control/runtime/owner modules, SQLite bindings/migrations, provider/terminal consumers, RPC contracts, and sidebar/auth state. The initial status listing for this save matched the prior investigation's listing. No unrelated work was modified by the planner.
- Revalidate the actual branch/SHA, current changes, registry validators, startup/epoch behavior, durable-owner interfaces, and auth continuation before implementation. This is the first implementation step, not a blocker to saving or using this plan.
- Toolchain evidence: root package manager `bun@1.3.9`, Node engine `^24.13.1`, Effect catalog `4.0.0-beta.43`; use the actual lockfile at implementation time. No dependency upgrade is part of this task.
- Build in order: contract and coordinator transitions -> native lifecycle -> owner/connection reconciliation -> auth/menu -> integration validation. Keep source/test extraction local to edited concerns. Do not stage, commit, push, or operate on a production remote host without separate authorization.
- Requirements review completed against the clarified behavior: Reconnect naming, real service restart, managed interruption, settings preservation, conditional password auth, plan-only permission, dirty-baseline revalidation, and later checks are mapped above.
- Execution-readiness review corrected the earlier proposal: no optimistic auth gate, no full-agent-health prerequisite, no fresh-admission substitution, no pending upgrade consumption, no same-generation/old-epoch pool collision, and no overwrite of historical admission/owner evidence.
- Independent subagent review was unavailable because this environment exposes no task/subagent launcher. No independent review or tool execution is claimed. The two planning review passes were performed directly; no remaining product clarification is required.
