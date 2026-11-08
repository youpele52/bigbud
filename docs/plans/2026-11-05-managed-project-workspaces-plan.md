# Managed project workspaces and safe folder reassignment

**Date:** 5 November, 2026
**Status:** Existing implementation scoped-green; native coordinator/restart/exact-request recovery integrated with focused evidence; migration147 registered after146 with focused upgrade validation; live V2 qualification remains blocked; desktop-only picker accepted
**Owner:** Implementer
**Created / Last modified:** 2026-11-05 (local timezone)
**Repository:** /Users/youpele/DevWorld/bigbud
**Baseline:** dev at f8c6e9e37e0ec51d4d9d3cc2bedde512d70575d4; preserve the existing untracked terminal-work idle-protection plan.

## Summary

Require a project name and make its local folder optional. Allocate a persistent backing directory under the server's application data using project ID, never title. Persist explicit storage ownership. Allow renaming and local folder reassignment without replacing the project or rewriting historical content. Reuse the existing atomic project reconfiguration and provider-session replacement paths.

## Related Work

None identified; this plan records the explicit user request in the current conversation.

## Problem

`apps/web/src/components/sidebar/Sidebar.projectAddActions.ts:94-147` rejects missing paths and derives local names from paths. Desktop creation bypasses a name form and immediately creates from the folder picker (lines 188-237). Contracts allow null workspace roots, but these do not give ordinary projects a usable provider cwd. A concrete managed root must be persisted rather than adding provider-specific fallbacks.

## Goals

- Required nonempty name, optional directory, stable ID-keyed persistent local allocation, no automatic git initialization.
- Preserve explicit local-folder and remote creation.
- Explicit managed/external ownership in events, projections, snapshots, catalog, and web state; existing records default to external, never infer ownership from a path.
- Preserve project ID, threads, notes, cards, history, and historical messages on rename or reassignment.
- Empty managed workspace can switch directly; populated managed workspace requires an explicit transfer-files or switch-without-moving choice.
- Never merge, overwrite, or delete user folders. Retain and display the prior location.
- Backend busy guards and historical-worktree protection; safe session invalidation and current cwd refresh.

## Non-Goals

No provider SDK changes, git initialization, sandbox claims, remote file transfers, arbitrary repository migration, new dependencies, worktrees, or git publication. Managed directories remain ordinary host directories. Existing git/worktree controls remain repository gated.

## Current State

- `packages/contracts/src/orchestration/orchestration.project.ts:29-41` stores nullable workspaceRoot.
- `apps/server/src/orchestration/Normalizer.ts:49-95` validates explicit local paths, preserving null.
- `apps/server/src/orchestration/deciderProjects.ts:127-200` already supports revision-checked atomic project/thread reconfiguration.
- `apps/server/src/orchestration/commandInvariants.ts:178-233` contains idle/revision/worktree checks, but local folder changes need stronger pending-task and historical-worktree checks and metadata-update bypass protection.
- `apps/server/src/orchestration/Layers/OrchestrationEngine.ts:178-232` serializes command processing behind the workspace barrier.
- `apps/server/src/orchestration/Layers/ProviderCommandReactorHandlers.reconfigure.ts` stops and replaces existing idle sessions after thread execution metadata events.
- Persistence uses registered SQLite migrations and project read-model/projector/catalog/snapshot mappings.
- UI uses existing sidebar creation, project context menu, shadcn dialog/input/button primitives, and native folder picker.

## Phases

### Phase 1: Explicit storage metadata and persistent allocation

Add optional backward-compatible workspace ownership and retained previous-location metadata to project/event/projection schemas. Register the next migration and propagate metadata through SQL repositories, operational reads, snapshots/catalog and web mappers/events. Legacy projects are external unless an explicit managed record exists.

Allocate local name-only workspaces during serialized command processing, after receipt replay detection and command invariants, before committing creation events. Use `ServerConfig.stateDir`, a dedicated projects directory, and an encoded project ID segment. Idempotent directory creation must never clear an existing directory. Persist the resulting concrete path with managed ownership. Exempt the built-in Chats project. Reject missing remote directories rather than allocating remote projects locally. No git initialization.

### Phase 2: Safe local reassignment

Extend existing project.reconfigure with an optional local file-handling choice. Require explicit choice for populated managed workspaces. Keep old files untouched on switch and persist the previous location. Transfer files uses exclusive copying to an empty selected destination; retain the original as a disclosed recovery copy instead of deleting user data. The UI must explicitly describe this retention. Reject overlapping source/destination, nonempty destination, unsupported entries, and collisions. On any copy or database error, the source remains authoritative and intact; report the destination location for inspection rather than deleting uncertain files. A retry never merges partial output. No automatic source-directory deletion.

Guard reconfiguration against pending/running turns, pending starts, approvals, active tasks, and unsafe historical thread worktrees (including archived/deleted thread references). Refuse changes with an actionable stop/finish/remove-worktree message. Reject workspace-changing project.meta.update commands so they cannot bypass guards. Preserve the existing remote reconfiguration route.

### Phase 3: UI creation and editing

Use a centered creation modal matching Add remote workspace, not an inline sidebar form. Show required name and optional browse-only directory on all local creation entrypoints, including Electron. Never expose an editable/manual local path field, including in the edit dialog. Picking a folder fills the modal rather than submitting prematurely; retain folder-derived title as a convenience when no title has been entered. Submit a null workspaceRoot for name-only projects and preserve remote behavior. Web clients currently lack an authorized server-folder picker; explain this limitation rather than adding a manual path field or silently claiming browse support.

Add local edit dialog for name and folder, preserving inline rename. Display Managed by bigbud only from explicit metadata, concrete current location, retained previous location, and folder reveal when available. Show explicit Switch without moving files / Transfer files actions with clear copy-and-retain-original wording. The user endorsed this non-destructive refinement; do not label the copying operation a move. Reuse project.reconfigure and revision metadata. Keep logic outside rendering components.

### Phase 4: Session and current-state refresh

Reuse thread metadata events and the existing execution-target replacement handler to restart idle sessions against the new project cwd. Ensure stopped sessions cannot resume at the old cwd. Invalidate affected file/git/terminal/current-workspace state following successful reassignment; do not rewrite messages or historical paths. Retain project identity and historical entity associations.

### Phase 5: Focused validation and review

Add focused contract, filesystem, orchestration, and UI logic tests covering name-only/explicit/remote creation, stable retries, rename, attach/switch/transfer, collisions/errors, busy guards, worktree refusal, session cwd replacement, and identity preservation. Review every requirement and fix in-scope findings.

## Risks And Decision Gates

- Filesystem and SQLite cannot share a transaction. Retaining the original source prevents data loss across interruption and uncertain commit outcomes. Exclusive copying and refusing nonempty destinations prevent automatic merge/overwrite. Partial destinations remain visible and require inspection; no automatic deletion of user folders.
- Directory ownership cannot be derived from location; only server-generated managed creation metadata marks ownership.
- External host processes are not sandboxed or controlled. Backend guards cover app-owned execution and task state; expose errors honestly.
- Existing historical worktree references make reassignment unsafe; block rather than rewriting them.
- Revalidate any changed file over 400 lines by extracting focused concerns, not unrelated cleanup.
- No broad checks without fresh explicit user approval. No bun test. No staging, commits, pushes, or worktrees.

## Testing And Validation

Use explicit changed-file paths for `bun run oxfmt` / `bun run oxfmt --check` and `bun run oxlint`. Check lengths only for changed source/test files. Inspect affected package scripts and run configured package typechecks, not root workspace checks. Server tests use `bun run --cwd apps/server vitest run <explicit test files>`; web/contracts use the corresponding focused Vitest commands. Record exact commands and outcomes. Check plan formatting and local links. Live provider/browser verification requires available runtime; do not claim it ran if unavailable.

## Acceptance Criteria

- Every goal above has implementation and focused evidence.
- Name-only creation persists a concrete managed cwd across restart/retry and rename.
- Existing explicit and remote project flows remain compatible.
- Local edit never replaces project ID or changes historical content or entity associations.
- Populated managed folders require explicit file handling; old location stays discoverable.
- No silent overwrite/merge/deletion; failures preserve source data.
- Backend refuses unsafe active-work and worktree changes, including bypass attempts.
- Session/current workspace state refresh is verified.
- Authored source/test files are at most 400 lines and scoped checks are honestly reported.

## Open Questions

- OpenCode V2 and Muse retained native ownership cannot safely bind existing thread identity/history to another folder under the current architecture. `startSessionFresh` suppresses cursor reuse, but does not establish a safe replacement native identity. Existing native ownership rejects location conflicts and both providers are excluded from fresh transcript replay. Backend refuses reassignment before transfer or metadata commit for retained native bindings/runtime/admission records, including cold history. Rename remains supported. Keep the historical project and create a new project for a different location. This remains the current fail-closed production boundary, not plan-green. The authorized native-relocation follow-up below supersedes the initial exclusion of native ownership changes; it is not yet enabled.
- User accepts desktop-only explicit-folder picking. Browser creation/edit remains browse-only and honestly explains unsupported picking; no server-folder browser is in scope. This is an accepted limitation, not a remaining requirement gap.
- No live app visual verification or real native-provider relocation is claimed. Review coverage and execution readiness directly.

## Implementation Review And Scoped Evidence (2026-11-05)

- Migration 145 (`145_ProjectWorkspaceOwnership.ts`) persists explicit ownership and recovery location. Parallel organization work owns migration 146; its changes were preserved.
- Backend uses the serialized workspace barrier and command receipt replay before allocation/transfer, hydrates cold nondeleted project threads, checks persisted historical worktrees/native bindings/runtime admissions/activity leases plus active terminals, and refuses metadata-update folder/target bypasses. Existing generic remote reconfiguration tests remain green.
- Transfer is exclusive copying into an empty, nonoverlapping destination, never source deletion. An injected SQL-projector failure after copying proves both copies remain and the error reports original/destination recovery locations. Subsequent switches preserve the original recovery location.
- Generic ready and stopped provider sessions refresh cwd without rewriting messages; next-turn generic stale-cwd reuse starts fresh without an old resume cursor. V2 canonical Location validation retains equivalent-alias reuse rather than incorrectly restarting native ownership.
- Review outcome: Partial. Native-bound folder/target changes fail closed for OpenCode V2 and Muse, including target-only bypasses; rename succeeds. Browser-only folder picking remains unavailable. No overall implementation/plan-green claim.

Exact focused commands (all exit 0 on final relevant run; no root workspace suite):

```sh
bun run --cwd apps/server vitest run \
  src/orchestration/ProjectWorkspace.files.test.ts \
  src/orchestration/Layers/OrchestrationEngine.managedWorkspace.test.ts \
  src/orchestration/Layers/OrchestrationEngine.reconfigure.test.ts \
  src/orchestration/Normalizer.test.ts \
  src/orchestration/Layers/ProviderCommandReactor.reconfigure.test.ts \
  src/orchestration/Layers/ProviderCommandReactorSessionOps.settings.test.ts \
  src/orchestration/Layers/ProviderCommandReactorSessionOps.start.test.ts \
  src/orchestration/Layers/ProviderCommandReactorSessionOps.location.test.ts \
  src/orchestration/Layers/ProviderCommandReactorSessionOps.activeLocation.test.ts
# 9 files, 64 tests passed.
bun run --cwd packages/contracts vitest run \
  src/orchestration/orchestration.commands.projectWorkspace.test.ts \
  src/orchestration/orchestration.commands.test.ts
# 2 files, 17 tests passed.
bun run --cwd apps/web vitest run \
  src/components/sidebar/Sidebar.projectActions.menu.test.ts \
  src/stores/main/main.store.events.project.test.ts \
  src/stores/main/events.store.projects.deletion.test.ts \
  src/stores/main/helpers.lazy.store.project-catalog.test.ts
# 4 files, 27 tests passed.
bun run --cwd apps/server typecheck
# Exit 0; 59 existing Effect advisory messages, no TypeScript errors.
bun run --cwd apps/web typecheck
bun run --cwd packages/contracts typecheck
# Both exit 0.
```

Oxfmt followed by Oxlint `--report-unused-disable-directives` ran against 41 explicitly selected owned source/test paths: zero warnings/errors; each owned materially edited source/test file is at most 400 lines. The UI consistency delegate separately reports 11/11 creation/edit browser-component tests and 7/7 navigation/project-scope tests, clean scoped format/lint and web typecheck. It implemented the user's corrected centered-modal/browse-only requirement; no duplicate/live-app visual verification is claimed. Earlier test failures (noncanonical macOS temp-path assertion, expected error wording, invalid retained-worktree fixture, V2 equivalent-alias restart) were fixed and superseded by the passing runs above. No staging, commits, pushes, worktrees, or automatic user-folder deletion occurred.

## Authorized Native Relocation Follow-up (implementation-ready design)

### User decisions and hard invariants

The user authorizes closing native relocation support, conditional on necessity. Prefer an evidenced, supported context-preserving relocation operation. Where none exists, preserve project/thread IDs and all visible history, archive previous native ownership for recovery, and require explicit confirmation that a replacement native session loses provider-native context. Never replay prior transcripts into OpenCode V2 or Muse. Desktop-only folder picking is accepted.

A project MUST remain free to contain independent threads using different providers/models. Never project-lock a provider/model, rewrite unrelated thread selections, or change a dormant thread's current provider to manufacture a replacement native binding. The operation inventories all affected thread/provider bindings, not merely the currently selected provider. Existing generic creation/switching paths remain authoritative.

### Investigation evidence and unresolved qualification

- Installed `@opencode/client` 2.1.4 exposes `session.move({ sessionID, directory, delivery? }): Promise<void>` (`dist/promise/generated/types.d.ts:4438`) and a durable `session.moved` event containing the same session ID and new Location. This is a supported API candidate, unlike rewriting native storage or recreating a deterministic ID.
- Existing V2 runtime rejects conflicting retained shared binding, resume cursor and journal locations before dispatch (`Runtime.binding.shared.ts`, `Runtime.sessions.ts`). A native move therefore needs explicit verified location lineage; blindly overwriting/deleting one binding is insufficient and unsafe.
- Existing worktree relocation does not qualify this mechanism: it refuses legacy relocation for manual review. No existing feature establishes session.move context-preservation semantics.
- Muse implements durable exact-ID `session/start`, `session/resume`, and `session/read`; no supported workspace relocation operation was found in the consumed protocol. Reset must use existing reserved/bound/blocked creation machinery, not replay or SDK patching.
- Muse durable binding stores `selection_fingerprint`, not a recoverable prior model/permission configuration. For a dormant Muse binding whose thread currently selects another provider, eager recreation must not guess configuration or switch that thread. Confirmed authorized behavior: archive/reset all such bindings now and create new native context lazily on next actual Muse use, using then-current explicit selection. Preserve current provider/model. Current Muse threads may also stay stopped/fresh-on-next-use to avoid unnecessary launch. Disclose reset at transition and relevant next use; test dormant-Muse/current-other-provider and crash/retry.

### Phase N1: Minimal durable reservation and native operation journal

Reserve migration **147_ProjectWorkspaceNativeTransitions.ts** (145 belongs to this feature; 146 remains reserved for parallel idle organization work). Reuse `worktree_operations` access reservations with `branch = 'workspace-mutation'`, source/destination path identity and per-thread operation items. Existing SQL lease/admission guards and `makeWorktreeReservations` provide fencing; do not create a second generic operation framework. Extend only missing owner/provider admission coverage, coordinating any shared terminal module edits.

Add narrowly scoped per-command workspace-operation and per-thread/provider step/recovery records. Store source/destination, expected project revision, explicit reset acknowledgement, file-transfer phase, immutable complete old binding/cursor/runtime/admission snapshots, native IDs/storage identities, target identities, step kind (supported move or reset), status, error and revision. Use command ID as durable identity. Never include provider/model defaults at project scope. Recovery records are append-only and remain inspectable with original Location and affected thread/provider.

Acquiring reservation and checking app-owned leases/admissions must be one SQL transaction. This closes the terminal-open-during-transfer race: an earlier terminal admission wins and refuses transfer; a later admission fails on the durable reservation. Recheck pending tasks/approvals/turn starts/worktrees under the existing command barrier. Reserve both source and destination; do not hold a SQL transaction while calling native APIs or copying files. Existing historical-worktree refusal remains unchanged.

### Phase N2: File staging and explicit confirmation

Retain existing exclusive copy/no-overwrite/no-delete transfer. Stage files before any native mutation. Record complete-copy evidence durably before dispatching native operations. A partial/uncertain copy with no native dispatch is not silently resumed or merged: disclose both paths, retain originals and partial destination, and allow safe operation abandonment/retry into a newly selected empty destination. Reconfiguration without copy has the same durable admission reservation.

Extend project.reconfigure with explicit native-context-reset acknowledgement, independent from the file-handling choice. Edit modal explains that bigbud history stays, Muse native context resets where required, original native ownership is archived for recovery, and no transcript replay occurs. Backend, not UI, requires acknowledgement whenever the inventory contains a reset step. A refused operation performs no copy/native mutation. Preserve original recovery folder across subsequent switches.

### Phase N3: Supported OpenCode V2 move

Add a narrow optional native-relocation operation to the existing adapter/provider-service boundary, implemented through the official client `session.move`; no SDK changes or SQL edits to provider-owned storage. Acquire only the already configured owned shared service and exact native ID. Stop app-owned idle runtime handles before mutation; reject unresolved native queues/turns, uncertain creation, incompatible targets/storage or missing ownership proof.

Persist prepared/dispatched intent before calling move. Read exact native session ownership/location before dispatch. After calling move, read the same native ID and verify new Location, unchanged registration/storage/model ownership and absence of active/queued execution before marking verified. A void response alone is not success. Timeout/transport loss enters recovery-required; query the same native ID to reconcile old versus new Location, never issue create or replay as fallback.

Keep historical admission bindings immutable. Resolve effective Location through verified move lineage at native attachment/recovery validation boundaries; do not rewrite historical message paths or forge historical fingerprints. Preserve old binding snapshots. Qualify each recovery lookup/scan against lineage so it neither replays an excluded provider nor rejects valid preserved context merely because old admission evidence recorded the original folder.

V2 move is not treated as proven context preservation until protocol/native qualification confirms same ID, retained native history, correct Location and no prompt/replay/creation. If the installed native service lacks the operation or its behavior cannot be verified, fail closed and surface the exact limitation. Do not silently replace deterministic V2 native identity; any V2 reset fallback needs an explicit generation-aware identity design and confirmation, not row deletion.

### Phase N4: Muse archival/reset and atomic application commit

For every affected Muse binding, capture full old ownership/cursor/runtime/admission evidence before removing it from active lookup. Preserve historical admission rows, excluding explicitly archived incarnations from current-binding attachment/recovery queries rather than deleting evidence. Maintain per-thread/provider reset generation/tombstone so old cursor/native ID cannot reappear after restart or provider switching.

After all required V2 moves are verified and Muse reset plans are prepared, commit project/thread Location metadata, native binding active-view changes, archive links and command receipt atomically. Preserve IDs, visible history, notes/cards associations, each thread's provider/model defaults, and generic-provider behavior. No other project's bindings are changed.

For a thread currently using Muse, fresh creation may remain lazy until the next actual Muse use; then use existing exact-ID durable reservation/start in the new folder. A reserved/blocked uncertain native start remains blocked and inspectable; never mint another native ID on retry. Confirmed authorized behavior for dormant Muse bindings is lazy fresh creation using the next real user-selected Muse configuration without changing the current provider/model. Never guess historical model or permission configuration. All archived old ownership remains available for recovery, not eligible for automatic resume at the new folder.

### Phase N5: Partial failure, restart, and recovery

Keep durable reservation while any dispatched native move is unverified. Project execution/terminal admission stays fenced across process restart. Startup inspects outstanding operations before admitting work; command/outcome recovery uses the durable operation record, never repeats an uncertain native mutation or blindly clears a receipt. Offer explicit resume/reconcile recovery from the edit flow (or existing operation recovery UI if reusable), including exact thread/provider/native ID status and original/destination paths.

If only file staging occurred, safe abandonment leaves original metadata/native bindings untouched and exposes retained copies. If some native moves occurred, do not release the fence or pretend atomic rollback: query exact native sessions and finish the recorded transition or perform an explicitly journaled verified reverse move. Unknown third Location/ownership remains recovery-required with actionable error. New metadata/native active binding selection becomes visible only at the application commit boundary. Generic/current-provider refresh afterward uses existing session epoch fencing.

### Phase N6: Focused validation and acceptance

- SQL/temp-filesystem tests: atomic terminal/provider admission race, existing busy/task/worktree guards, immutable archives, copy collision/error, rollback, operation interruption, exact receipt retry, restart reconciliation, all affected bindings including cold/deleted historical owners without resurrecting deleted threads.
- V2 protocol mocks: official session.move only, exact ID before/after, unchanged context/history identity, old/new/third Location reconciliation, timeout before/after application, unsupported operation, queue refusal, historical lineage, no create/prompt/replay, canonical aliases.
- Muse mocks: explicit reset acknowledgement, complete old recovery archive, new exact-ID session in selected directory, uncertain reserve/start retry, old-cursor rejection, dormant-provider behavior without selection mutation, no replay.
- Mixed project regression: multiple threads across Codex/OpenCode V2/Muse and distinct models; every affected native owner handled; generic thread defaults and all provider/model creation options unchanged; unrelated project unaffected; IDs/history preserved.
- UI browser tests: reset notice/acknowledgement distinct from Transfer files, recovery/error presentation, browse-only modal, unchanged provider/model choices and desktop-only picker explanation.
- Exact owned-path format/lint, affected source/test lengths <=400, explicit Vitest files and configured affected-package typechecks only. Preserve migration146 and parallel terminal/idle work. No broad suite, worktrees, staging, commits or pushes.

**Live native qualification prerequisite:** existing `SharedService.native.isolation.approvals.ts` contains an empty frozen catalog. A record must come from `apps/server/scripts/assembleThreadToolNativeQualification.ts provision`, not manual insertion: approved clean macOS ARM64 environment, no host mounts/accounts/keychain, loopback-only egress, frozen read-only owned executable/hash/version, approved fixture root and controlled PATH. `BIGBUD_OPENCODE_V2_NATIVE_APPROVAL_ID` and `BIGBUD_OPENCODE_V2_NATIVE_MACHINE_ID` must match the generated record. HOME/XDG overrides alone do not qualify, including --version. No retail native session.move test can run in the current unapproved environment. Protocol mocks, SQL/restart/failure tests, component tests and typechecks can run; no live move against actual user sessions is permitted or planned.

**Current follow-up readiness:** partial native integration; dormant Muse lazy recreation is confirmed authorized. Candidate migration147 remains unregistered until reserved146 lands or is released. Direct in-memory application after145 verifies active/recovery project uniqueness and immutable recovery evidence. Native reservation covers source/destination identities, all persisted project thread items, terminal/runtime/native admissions, new-thread creation and project mutation. Exact finalization atomically commits application SQL, archives, receipt and reservation release; rollback retains admission. Inspection-only close/reopen recovery verifies exact V2 ownership/Location without resending uncertain moves or launching Muse. Muse archival preserves historical admissions and other providers' current selection/cursor, excludes archived incarnations from active scans, and rejects old native cursor reuse. V2 historical admissions remain immutable; committed continuous Location lineage is resolved separately during retained attachment, setup, recovery and projection. V2 application lineage commit is tested with rollback, exact binding revision/native/storage ownership, unchanged historical evidence and unrelated runtime preservation. The official session.move protocol helper requires durable-before-dispatch identity, exact owner/Location, empty activity/inbox, and no uncertain resend.

The generic production transfer race is independently fixed without147: the real command processor acquires an existing durable workspace-mutation access reservation before filesystem work and holds it through SQL commit and in-memory read-model refresh, releasing before domain publication. Source, destination and all persisted project thread aliases are fenced. Overlapping Git mutations respect the same reservation. Actual-engine tests inject terminal admission during copying and require the reservation at metadata commit; success, partial-copy failure and SQL rollback retain originals and safely restore admission after settlement. Interruption deliberately retains the reservation because cancellation does not prove physical exit. Failed commit observation or admission-release failure remains fenced with the durable operation ID; no folders are deleted. POSIX root and Windows drive-root overlap regressions are covered.

Latest focused validation:13 files/60 tests passed in `/tmp/bigbud-workspace-native-integration-regressions.log`; preceding generic engine/files regressions passed in `/tmp/bigbud-workspace-admission-tests3.log`. Configured server typecheck exits0 with no TS errors/warnings (`/tmp/bigbud-workspace-mutation-types5.log`). No broad repository checks. Production native saga coordination, real-engine authorized native finalization, explicit reset consent/status UI, and startup recovery routing remain unfinished; existing native-bound reconfiguration still fails closed. Live V2 qualification remains unavailable in this environment: mocks/SQLite tests do not establish real native context preservation. No native-relocation implementation changes preceded this plan. Do not label the whole feature or native follow-up green.

## Exact-request recovery integration evidence (2026-11-05)

This update supersedes the unfinished coordinator/restart/status statements above, not the native qualification gate.

- Production gateway now passes receipt persistence into the native coordinator. Terminal receipt replay/conflict checking precedes native inventory, filesystem staging, and native dispatch. Native operation failures remain retained/fenced, never converted into terminal preflight rejection.
- Narrow `getCommandOutcome` support exposes durable native operation phase, original/destination paths, error, and exact thread/provider/native-step identities when no terminal receipt exists. Startup inspection and real-engine finalization are wired. The optional service helper now has an explicit typed result/error boundary; package typechecks pass.
- Definitive native preflight refusals persist a specifically marked actionable explanation. Outcome RPC exposes only this marked workspace detail, not arbitrary internal receipt errors. Explicit consent changes get a new command ID only after definitive no-side-effect rejection; same-ID changed payloads cannot stage or reset anything.
- The edit recovery gate survives close/reopen/reload using the original request ID and JSON. It validates without replacing the request with decoder defaults, blocks replacement edits, shows status/paths/native steps, observes a lost successful response without redispatch, and offers explicit exact-request retry. Corrupt retained storage fails closed. The edit/recovery dialogs use `max-w-sm`; directory selection remains browse-only.
- Focused final server command: `bun run --cwd apps/server vitest run src/orchestration/Layers/OrchestrationEngine.commandOutcome.test.ts src/orchestration/ProjectWorkspace.nativeCoordinator.test.ts src/orchestration/Layers/OrchestrationEngine.workspaceRestart.test.ts src/command-gateway/Layers/CommandGateway.test.ts` — 4 files / 18 tests passed (`/tmp/bigbud-workspace-exact-recovery-server-final.log`). Includes restart/status, native uncertainty, immutable retry, receipt replay after success without recopy/move, changed-consent ID, and unchanged selected provider/model with dormant native owners.
- Focused web command: `bun run --cwd apps/web vitest run src/components/sidebar/Sidebar.projectEdit.recovery.test.ts src/lib/orchestrationCommandRecovery.test.ts` — 2 files / 14 tests passed (`/tmp/bigbud-workspace-exact-recovery-web-final.log`). Browser command: `bun run --cwd apps/web test:browser src/components/sidebar/SidebarProjectEditDialog.browser.tsx` — 1 file / 9 tests passed (`/tmp/bigbud-workspace-recovery-browser-tests2.log`), including reopen/status/lost-success and browse-only/consent behavior.
- `bun run --cwd apps/server typecheck` and `bun run --cwd apps/web typecheck` both exit0 (`/tmp/bigbud-workspace-exact-recovery-{server,web}-types-final.log`). Server reports existing informational Effect diagnostics; no errors/warnings. Explicit 14-file formatting/check, lint, and length validation passed; every edited source/test is below400 lines (largest338). No root-wide checks, staging, commits, pushes, or worktrees.
- Shared edits in this continuation: `apps/server/src/command-gateway/Layers/CommandGateway.ts`, `apps/server/src/orchestration/Layers/OrchestrationEngine.commandOutcome.ts`, and only the outcome helper return-type hunk in `apps/server/src/orchestration/Services/OrchestrationEngine.ts`. No new lifecycle/transaction changes to `server.ts`, engine main/commandProcessing/prepareCommandState, operational/catalog/baseline projections, or migration registry. Other edits are focused workspace recovery helpers/tests and sidebar recovery/error presentation.
- Coordination: Inyosira thread `1e03158e-10a2-4766-9df8-076f3bf47390` received exact shared seams and migration reservations. Migration145 is registered;146 remains idle-reserved and147 native-workspace-reserved/unregistered. Scheduler148 requires registry/reservation confirmation. Native tests explicitly apply147 in fixtures; this does not establish production migration availability. Live V2 context-preserving relocation remains unqualified and absent from production gateway capabilities. Prepared/uncertain native transitions remain fenced rather than silently copying again or resending uncertain moves; automatic abandonment/reverse moves are not implemented.
