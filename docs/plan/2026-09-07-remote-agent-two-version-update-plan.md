# Remote-agent two-version updates and healthy reconnect selection

**Date:** 7 September, 2026
**Status:** Ready for implementation
**Owner:** Implementing agent; planner profile `/Users/youpele/.config/opencode/agents/planner.md`
**Created:** 2026-09-07 23:05:19 SAST (UTC+02:00; original file creation time)
**Last modified:** 2026-09-07 23:17:07 SAST (UTC+02:00)
**Project root:** `/Users/youpele/DevWorld/bigbud`
**Baseline:** `main`, `545301f8eeadd22284b2c8e1730f7dd45197cb95`, plus the existing unstaged implementation

## Summary

The clarified goal is to keep at most two remote-agent builds on the remote server, install and health-check an update without switching existing work, and select the healthy update on the next reconnection. Installation or health failure must leave the most recent usable stable version serving. Existing operations must never be executed again on another runtime.

**Current assessment: partial implementation, not completion.** The code supplies substantial isolation, durable routing, signature verification, readiness, and fallback machinery. It implements a different retention policy (two healthy builds plus references and pending builds), checks live health during fresh admission rather than immediately after installation, and does not automatically establish the discovered legacy agent as a trusted fallback.

This plan changes those product semantics while retaining the safety fixes. It supersedes conflicting prescriptions in the older isolated-update plan: staging may now launch an isolated candidate for health checks, but may not select it for user work; two healthy builds plus unlimited referenced builds is replaced by admission of updates into two reserved storage slots. Do not rewrite historical plans to imply these changes already exist.

### Confirmed decisions

The user answered the five clarification questions and confirmed the predecessor-retention example. No product decision remains open:

1. **Two builds per SSH account's bigbud installation**, shared by its projects. Never create a temporary third build to bypass capacity.
2. **Wait when both builds are needed.** Existing running or uncertain work is preserved.
3. **Prepare updates automatically with visible status**, using existing authenticated access. No Download update click is required.
4. **Start and health-check the candidate in isolation before reconnect**, while current work stays on the existing agent.
5. **Switch only on deliberate reconnect.** Automatic transport recovery never consumes the pending candidate.
6. **Retain the current build and its stable predecessor.** After reconnecting to healthy207, keep205 as fallback. When208 arrives, remove205 only once safe, then install208 while keeping207 as fallback. Merely installing207 is not permission to delete205.

Terminology in this plan is domain-specific: **serving stable agent** means the verified agent selected for user work, not the release-channel term “Stable Release” in `docs/CONTEXT.md`; **predecessor fallback** is the retained previous serving stable agent; **healthy pending agent** has passed readiness but is not yet selected; **deliberate reconnect** creates a new logical admission without migrating old operations. These definitions and the decision record stay in this one plan under the planner's write boundary.

## Related Work

- User's clarification in this conversation: maximum two saved agents; install/check candidate; use healthy candidate on next reconnection; otherwise use most recent stable predecessor; preserve existing work.
- [Isolated-update plan](2026-09-07-remote-agent-isolated-update-plan.md): reusable runtime and ownership architecture; superseded retention and preparation timing.
- [Corrective plan](2026-09-07-remote-agent-corrective-plan.md): earlier integration and provider-boundary evidence.
- [Implementation status](2026-09-07-remote-agent-implementation-status.md): historical handoff, not independent completion evidence.
- [Legacy investigation](remote-agent-0.2.205-upgrade.md): shared-state and duplicate-execution hazards remain applicable; preserve this protected document.
- [Reconnect/service restart plan](2026-09-07-remote-project-reconnect-plan.md): separate disruptive operation; do not silently repurpose it to select updates.
- [Native boundary](../decisions/2026-08-22-rust-remote-workspace-agent-boundary.md): keep product selection and durable ownership in TypeScript/SQLite.
- Notes/cards: none identified. Project note and card lookups were attempted but returned tool errors; no absence or identifiers are fabricated.

## Problem

The initial `0.2.205 -> 0.2.207` problem came from shared-state preparation interpreting stale acceptances as live work, and unsupported legacy preparation entering stateful stdio. Isolation avoids that mechanism. The remaining task is to deliver the clarified update lifecycle, not restore in-place takeover.

The present implementation can store current A, healthy fallback B, and candidate C simultaneously, then retain further live or uncertain runtimes indefinitely. This is intentional under the old plan and violates the clarified strict cap. It also tells the user an update is staged after only a stateless identity check; real startup/readiness and fallback happen later, when a fresh connection is requested.

A strict cap and preservation of existing work imply that update installation sometimes waits. If A and B are both needed, C cannot be saved remotely without either exceeding two or removing something still needed. No cleanup algorithm can remove that policy constraint. The user chose waiting with factual progress feedback. Interrupting work or weakening recovery is not authorized by this update policy.

## Goals

1. Enforce two storage slots before remote candidate bytes are written, including failed or uncertain installations and temporary candidate payloads.
2. Keep the current usable stable build while preparing one candidate. Do not delete the only usable stable build to make room.
3. Authenticate candidate bytes, start an isolated runtime, verify hello/capabilities and `agent-ready`, and record ready-for-next-reconnect without changing the selected logical connection.
4. Select the ready candidate only at the agreed reconnection boundary, after rechecking its readiness. Preserve original bindings for all existing operations, PTYs, watches, cancellations, acknowledgements, and ambiguous requests.
5. On install/health failure, retain or reconnect the most recent verified stable predecessor. Report unavailable if it cannot be verified; do not fabricate successful fallback.
6. Preserve request identity, storage reservations, health results and selection decisions across concurrent controllers, lost replies, app restart, and remote failure.
7. Automatically prepare available compatible updates with visible current, ready pending, fallback, blocked-capacity, unhealthy, and uncertain states. Retain current plus predecessor until another candidate needs an eligible slot.

### Operational definitions

- **Server scope:** the canonical agent installation root of the authenticated SSH account, shared by all target aliases and local controllers using that root. Count discovered legacy binaries there too. The app cannot guarantee a cap over unrelated users or arbitrary independent installation directories elsewhere on a host.
- **Two agents:** two distinct stored executable builds, not two metadata rows or two healthy labels. Candidate binaries, temporary uploads of a different build, quarantined binaries, and retained backups consume capacity. Avoid duplicate executable copies of the same build; do not hide extra versions by moving them outside `bin` or renaming them. Runtime journals/logs and logical connections are not extra agent builds and remain retained where needed.
- **Stable:** authenticated, compatible build with verified runtime health and successful serving promotion. An identity `--check` alone is not runtime health. Failed business commands do not mark the build unhealthy.
- **Healthy pending:** candidate has passed isolated runtime health checks but has not become the selected serving build. It does not become the stable predecessor merely by passing a probe.
- **Reconnect:** a deliberate new logical connection, backed by a stable request ID. Transport recovery of an existing connection remains original-generation recovery and never selects a pending agent.
- **Capacity unavailable:** wait before remote upload. Existing runtimes continue; no forced shutdown or implicit allowance for a third build.

## Non-Goals

- Implementation during this planning task; no staging, commits, pushes, release, production SSH or remote process actions.
- Shared-state takeover, journal repair/import, transparent import of unknown legacy PTYs, destructive rollback, or terminating active work to meet the count.
- A host reboot, sshd restart, or implementation of the separate disruptive project Reconnect feature.
- Unlimited temporary retention presented as compliance with the strict cap.
- Universal exactly-once provider retries where SDK identity is unavailable; preserve the documented fail-closed boundaries.

## Current State

All source paths below are relative to the repository root. Locations were checked against the dirty worktree, not only HEAD.

| Goal / concern             | Actual implementation and evidence                                                                                                                                                                                                                                                    | Assessment                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Maximum two                | `apps/server/src/remote-agent/remoteAgentInstall.registry.transitions.ts:310-339` retains two healthy plus pending, pins, launches, admissions and legacy builds. `remoteAgentInstall.stage.ts:23-57` reserves without a two-slot limit. Registry supports 32 build records.          | Not implemented for clarified policy.                                                                                                  |
| Automatic preparation      | `remoteAgentInstallSource.ts` resolves the configured/app-version release source; existing UI calls installation explicitly. There is no end-to-end automatic prepare-and-health coordinator.                                                                                         | Add bounded scheduling using the existing source and authenticated target access; do not introduce an unrelated latest-release policy. |
| Signed installation        | `remoteAgentInstallManager.ts:174-247` uses artifact signatures/hash checks, immutable installation, and stateless installed identity verification.                                                                                                                                   | Reuse. Installation itself does not prove runtime health.                                                                              |
| Health before reconnection | `remoteAgentAdmission.ts:66-153,266-305` launches and probes the runtime inside fresh admission. `remoteAgentInstallManager.ts:101-129` only invokes `--check`.                                                                                                                       | Timing differs from clarified goal.                                                                                                    |
| Deferred selection         | `SidebarRemoteAgentStatus.tsx:84-100` and `SidebarRemoteAgentInstallDialog.tsx:42-58` explicitly call `connectRemoteAgent`; automatic resolution does not consume pending.                                                                                                            | Mostly present for deliberate fresh connection; clarify reconnect semantics.                                                           |
| Candidate failure fallback | `remoteAgentAdmission.ts:225-245,365-392` chooses authenticated healthy predecessors and distinguishes build faults from uncertain reachability.                                                                                                                                      | Partial: occurs during admission, not update preparation.                                                                              |
| Original legacy fallback   | `remoteAgentLegacyBinding.ts:63-68` records discovered205 as staged/unauthenticated with an unknown-owner pin. Admission excludes it from healthy authenticated choices. Linux tests can explicitly install signed fixture205 separately; that is not automatic production bootstrap. | Critical integration gap for the exact205-to207 promise.                                                                               |
| Existing work              | `remoteAgentConnectionPool.ts:58-86,193-234`, owned process/PTY modules, `RemoteAgentRuntimeBindings.ts`, fixed lifecycle epochs, and terminal evidence retain original identities.                                                                                                   | Implemented foundation; preserve and rerun public-path regressions.                                                                    |
| Reconnect request replay   | `remoteAgentInstall.registry.transitions.ts:213-219` prunes old admission IDs; `remoteAgentAdmission.ts:209-231` then treats missing old IDs as fresh.                                                                                                                                | Reproduced defect: retry A after B and staging C consumes C.                                                                           |
| Stage ownership            | `remoteAgentInstall.registry.transitions.ts:104-114` expires reserved stages after five minutes without proof the installer stopped.                                                                                                                                                  | Reproduced defect: deletion tombstone becomes allowed while preparation is unresolved.                                                 |
| Legacy state isolation     | `remoteAgentInstall.ts:132-140` still validates/creates legacy `state`.                                                                                                                                                                                                               | Reproduced Linux defect: staging creates absent old state directory.                                                                   |
| Cleanup                    | `remoteAgentInstall.cleanup.ts`, `.reconcile.ts`, `.maintenance.ts` support tombstones and proven-death receipts. Existing cleanup is deferred; active supervisors prevent deletion.                                                                                                  | Reuse integrity machinery; strict capacity requires pre-install reclamation and a safe retirement path.                                |
| UI                         | `SidebarRemoteAgentStatus.tsx` presents current/pending/fallback. Request IDs live in component memory.                                                                                                                                                                               | Extend for preparation health, capacity waiting, and durable operation recovery after reload.                                          |

### Code-review evidence already obtained in this conversation

- Three temporary regressions reproduced the request-ID, stage-expiry and legacy-directory defects above. Test source/logs were retained under `/tmp/bigbud-isolation-review-*`; the temporary repository test was removed. These are not committed regression tests.
- `bun run --cwd apps/server vitest run src/remote-agent`: 296 passed, 29 skipped, one `localWorkspaceWatch.integration.test.ts` timeout. Cause was not established; do not label it pre-existing without diagnosis.
- Docker aarch64 registry, cleanup and launch suites: eight passed, three files, zero skips.
- `bun lint`, `bun typecheck`, changed source/test line-count audit and `git diff --check` passed. Typecheck completed nine tasks.
- `bun fmt:check` failed on `2026-09-07-remote-agent-implementation-status.md`. A repository-wide mutating formatter was not used for read-only review.
- Saved legacy binary and journal-seed fixtures were absent from their documented temporary location. Earlier actual-legacy matrix results remain historical. No fresh full browser, full Vitest, Rust workspace or x86_64 certification was obtained in that review.
- This planning turn re-read the relevant source. It does not claim those prior tests were rerun after new changes.

## Phases

### Phase 1: Close existing replay and staging defects

**Dependency:** baseline revalidation only. **Goal:** preserve the current safe routing foundation before adding selection behavior.

1. Add durable bounded admission-ID retirement evidence, separate from resource replay evidence. A pruned/expired reconnect request must recover its original decision or reject before selection; it must never become a new request. Keep unresolved requests, fail safely at capacity, and preserve request IDs across UI remount/reload.
2. Replace timeout-only stage release with an ownership/fencing protocol. A paused controller may not publish/install after its reservation is revoked; unless that exclusion is enforceable, retain the reservation. Include remote command lifetimes and controller death, not just local promise completion. Keep reducers pure and ensure a reconciliation plus reservation remains one valid CAS revision.
3. Remove every legacy `state_root` validation/creation from candidate installation. Preserve stateless legacy probes and raw pinned proxies. Remove or explicitly retire the unused old destructive activation helpers after auditing callers; do not reconnect the install manager to them.
4. Add permanent regressions for all three reproduced failures, including a real Linux script test and delayed-controller/cleanup race.

**Exit:** old request retries cannot consume new pending bytes; unresolved staging remains fenced from deletion; installation never depends on or creates legacy state.

### Phase 2: Introduce durable two-slot capacity and legacy fallback bootstrap

**Dependency:** Phase 1. **Goal:** no new remote build is written without capacity and a preserved stable route.

Use focused `remoteAgentUpdate.capacity.ts`, `.state.ts`, and `.inventory.ts` modules alongside the existing registry, rather than a new package. Keep remote root slot authority in the registry CAS. Register any additive SQLite update-operation migration in `Migrations.ts` using the next free number after rechecking migrations111/112 and the dirty baseline.

1. Evolve the versioned registry through a validated, backward-compatible migration. Add slot occupancy/reservations, update request IDs, preparation phase and outcome, current stable/predecessor references, and verified candidate identity/epoch. Do not overload healthy promotion order with download/probe order.
2. Count physical build presence and reservations across all controllers at the canonical account root. Legacy `current`/`previous` references resolving to the same executable do not multiply the count; separate actual copies must be reconciled explicitly. Unknown/corrupt/untracked installations cannot be silently ignored.
3. Discover/authenticate the existing205 binary in place using trusted historical artifact manifest/signature/hash metadata and matching check/live evidence. Preserve its original descriptor, socket, epoch and unknown-owner pin. Do not create a duplicate managed205 runtime merely to manufacture fallback eligibility. Authentication does not establish absence of unknown owners.
4. A known original client may continue on observed legacy continuity without claiming artifact authenticity. If trusted metadata is unavailable, show that fresh fallback is unavailable and defer any transition that depends on guaranteed fallback; never flip `authenticated` on self-report alone.
5. Before upload reserve a free slot, or reclaim an eligible obsolete build using Phase 3. Keep current stable plus candidate; after candidate promotion keep new stable plus previous stable. To prepare a later update, reserve that update and atomically withdraw only the obsolete predecessor from new fallback selection before retirement. Keep the current serving stable selected and protected throughout. Withdrawal does not release owner/recovery dependencies. Remove the older predecessor only once no such dependency remains. Installation failure still leaves the current most recent stable build; a crash between predecessor removal and candidate upload resumes the reserved update without deleting current stable.
6. With both slots pinned, persist `waiting-for-capacity` before writing candidate bytes remotely. Idempotent retries join that request. A failed/uncertain candidate continues occupying its slot until verified cleanup, never merely until a timeout.
7. Existing installations already holding more than two enter explicit capacity-noncompliant reconciliation. Block new remote uploads; preserve needed builds and retire only proven-safe excess builds. Do not claim the cap is satisfied until actual count is <=2. Unknown legacy ownership may require separate owner-led retirement.

**Exit:** concurrent aliases/installers cannot reserve a third build; exact legacy fallback is either verified in place or honestly unavailable; current serving access is unchanged.

### Phase 3: Reclaim only obsolete, provably unused managed runtimes

**Dependency:** Phase 2 schema; required before later updates can reliably reclaim slots.

1. Extend existing cleanup/reconciliation instead of adding a second cleanup owner. If a managed supervisor is still alive, treat its binary as referenced. Automatic capacity cannot depend solely on passive exit because isolated supervisors remain running after probes and connections close.
2. Implement a narrow managed-runtime retirement reservation at canonical root/generation/epoch. Extend `remoteAgentConnectionPool.ts`, owned-resource admission, registry pin acquisition and durable bindings to honor the retirement fence. Add lifetime accounting for transient workspace leases, watches and idle cached transports; dispose only unreferenced transports, never active owners. Fence new resource and connection acquisition across all cooperative controllers before checking idleness; check durable owners, in-flight creation, watches, workspaces, transport leases, connection/recovery references, and discovery references. A snapshot of local SQL alone is insufficient. An old admission retry encounters its original route or a retired-route error, never silently recreates the retired runtime.
3. Add ongoing superseded-connection reconciliation in `remoteAgentAdmission.references.ts`, invoked after durable process/PTY/write/watch disposal, after connection release, and on startup recovery. Current code attempts release only once at promotion; an owner active then can otherwise keep an idle predecessor pinned forever. Order: persist terminal/disposed owner evidence locally; reevaluate whether that connection is still selected or referenced by any controller; release only obsolete connection/admission pins while retaining the bounded retired-request evidence from Phase 1; enqueue capacity reconciliation. Unreachable controllers, uncertain owners, or another controller still selecting that logical connection retain their pins. Do not require supervisor death to release obsolete logical-connection pins, since that would deadlock the zero-reference prerequisite for idle shutdown. Native supervisor ownership remains a separate reference until verified retirement.
4. Use a supported authenticated native shutdown/control path only for a positively identified idle managed runtime. If a new capability is necessary, add it to the owning Rust/contract boundary and negotiate support statelessly. Never send unknown flags to historical binaries, invoke takeover, signal by stale PID, or kill active work. Unsupported or uncertain retirement defers the update.
5. After verified supervisor/owned-resource exit, confirm no acquisition raced retirement, publish deletion tombstone, unlink the exact verified binary, durably confirm deletion, then free the slot. Keep journals/logs and routing history. Disconnection, missing socket and timeout are not death evidence.
6. Legacy/independent unknown-owner roots are not automatically retired. Current serving selection, unresolved owner recovery and old discovery paths remain protected. The specific obsolete managed predecessor may be withdrawn from new fallback selection only by the Phase 2 replacement reservation; generic cleanup cannot remove the retained predecessor simply because it is idle. If legacy prevents further updates under the strict cap, expose that fact without promising automatic convergence.

**Exit:** a released obsolete managed runtime can free one slot without touching a live operation; uncertainty retains the slot; crash recovery cannot delete an acquired build or stop another runtime.

### Phase 4: Automatically prepare and health-check without selecting the candidate

**Dependency:** safe slot reservation; Phase 3 when reclamation is needed.

1. Add `remoteAgentUpdate.coordinator.ts` and `.scheduler.ts`, composed through `remoteAgentServerLayer.ts` and existing Effect lifetime/worker patterns. Enqueue after successful SSH authentication/initial connection, on local server startup for known targets with reusable credentials, after release-source changes, and after a slot becomes reclaimable. Use a coalesced 15-minute check for already authenticated known targets with jitter and bounded concurrency (two targets), retaining existing download retry/timeout policies. These are engineering defaults; inject clocks for tests. Do not prompt for passwords in the background or keep an otherwise-expired credential session alive solely for polling. Credential-required/offline targets wait for normal user authentication.
2. Reuse `remoteAgentInstallSource.ts` and the application's configured compatible release source; refresh its process-scoped cache deliberately on scheduled discovery, not per resource call. Automatic preparation does not mean fetching arbitrary GitHub latest versions or crossing release channels. Compare immutable artifact identity, persist one update request per account/root and build, coalesce duplicate triggers, and do not downgrade on an older manifest. Quarantined build failures do not retry forever on each poll; require changed artifact identity or explicit retry, while transient availability retries retain the same request. Expose phase/status through a focused `server.getRemoteAgentUpdateStatus` contract/RPC and the existing frontend remote-access store; after reload retrieve persisted status rather than launch another update. Split existing near-limit contracts/components by concern.
3. Extract reusable isolated launch and hello/diagnostic verification from `remoteAgentAdmission.ts` into focused `remoteAgentRuntime.health.ts` and preparation modules. Reuse existing signature checks, private paths, launch intent, inherited launch lock and bounded deadlines.
4. Run `reserved -> installing -> checking -> ready-for-reconnect` from the update coordinator. Persist each uncertain boundary. `--check` validates artifact identity; live hello plus `agent-ready` establishes runtime readiness. No workspace mutation, process, PTY or user frame is permitted during health checking.
5. Starting a health-only supervisor is now intentional. Keep the same private candidate generation for later reconnection; do not stop/restart it or create another root solely to change its role. Keep its admission gate closed to generic target resolution until reconnect commits selection.
6. On definitive install/health failure mark candidate ineligible, preserve current stable selection, verify the predecessor when establishing a new route, and publish a typed failure/fallback result. If current stable is already serving, keep it without manufacturing a new connection.
7. On SSH/auth/network uncertainty, retain the reservation/candidate identity and avoid binary quarantine. Report verification unavailable; do not claim either candidate health or predecessor availability from a timeout. Reconcile the same update request.
8. Cleanup of rejected candidates follows Phase 3 and verified deletion; immediate removal is not required for fallback, and must not be used to lose uncertain ownership. If the failed candidate cannot be safely removed, it occupies the second slot and further updates wait.

**Exit:** installation returns verified pending or a factual failed/uncertain result; existing selected connection and operations never change during preparation.

### Phase 5: Select on reconnection, preserve original work, and expose UI state

**Dependency:** ready candidate or verified predecessor from Phase 4; selection is deliberate-only as confirmed by the user.

1. Keep existing `server.connectRemoteAgent` as the deliberate admission boundary. Keep the visible Connect new session action, with supporting copy explaining that it selects the healthy update; do not add a second destructive Reconnect action. Never turn `pool.get`, health checks, credential unlock, operation attach or cancellation into selector changes. Background authentication/connection notifications may enqueue preparation only.
2. Pin the reconnect request to one ready candidate/predecessor; reverify exact epoch and health immediately before committing. A previously healthy candidate may have died while waiting. Fallback happens before any new user work; failure of accepted work never changes its recovery route.
3. Persist coherent remote selection and local binding before exposing new admission, with durable request-ID replay fences. A lost success reply reconciles the same request. Separate selected connection from existing owner bindings so old operations remain on their original runtime.
4. Automatic SSH recovery and browser/server reload restore the original logical admission. They neither allocate a new admission token nor consume pending selection. An explicitly initiated first-project connection may wait for preparation and then complete its original deliberate request after readiness; automatic preparation alone must never create that project or admit user work. Do not reuse the disruptive service-restart RPC.
5. Extend contracts and sidebar state for `installing`, `checking-health`, `ready-for-next-reconnect`, `waiting-for-capacity`, `failed-using-stable`, `verification-unavailable`, and `connected`. Show exact current/pending/predecessor versions, and explain why an update waits. Persist update/reconnect IDs through reload and recover status before retrying.
6. Keep shadcn primitives, `text-sm` and severity colors. No secrets/raw shell dumps. Project configuration, histories, terminal identities and provider retries retain existing behavior.

**Exit:** healthy candidate serves only new work admitted at the chosen reconnect boundary; failed candidate uses verified latest stable; older work stays recoverable and runs once.

### Phase 6: Validate the clarified contract end to end

**Dependency:** Phases 1-5. Reuse the production install/admission, public HTTP, SQLite owner and Docker harnesses; do not substitute reducer tests for app behavior.

1. Recreate exact205 and candidate fixtures outside the worktree from the documented commits if saved fixtures are missing. Use original legacy journal writers for fresh/unmatched/expired cases. Verify actual published artifact trust separately from source-fixture identity.
2. Add `remoteAgentUpdate.capacity.*.test.ts`, `.prepare.*.test.ts`, `.reconnect.*.test.ts` and focused native retirement tests as needed, each <=400 lines. Include physical on-disk count assertions at every phase, not only final cleanup.
3. Run independent review of capacity lock/fence ordering, legacy fallback provenance, selection versus readiness, and all owner release paths. Update this plan only with actual results.

**Exit:** acceptance matrix below passes on the current implementation; no historical green result is substituted for a changed path.

## Risks And Decision Gates

- **Strict capacity:** when both builds are required, installation waits. This is confirmed policy; do not reopen it or silently permit a temporary third build.
- **Fallback durability:** reclaiming an older fallback before uploading C leaves current stable B as C's predecessor. Keep B and its verified route throughout the transaction; never remove the last stable build.
- **Legacy access:** unknown independent205 users can prevent retiring205 indefinitely. Supporting unlimited later upgrades under a strict cap then needs separate owner coordination; process scans cannot supply missing ownership evidence.
- **Initial over-cap installations:** safe migration can be incomplete while work is live. Report noncompliance and defer updates rather than deleting recovery dependencies.
- **Health-before-selection:** the new goal requires launching a candidate for health before reconnection, superseding the old zero-candidate-process staging rule. A stateless binary check alone cannot establish supervisor readiness.
- **Platform/control:** idle retirement must be supported and verified. Lack of a safe control capability defers reclamation; it is not permission to kill by name or reinterpret legacy flags.
- **Two persistence domains:** remote control and SQLite cannot commit atomically; unresolved references must remain reserved and retry identities must remain fenced.
- **Rollback:** stop selecting a rejected candidate for new work; retain all original routes and the latest verified stable. Never revert to mutable target-only recovery or restore old discovery links over live isolated state.
- **Permissions:** this document authorizes no implementation or production actions by itself. User requested assessment and a saved plan; leave all existing code and historical documents intact.

## Testing And Validation

| Scenario                                                                              | Required evidence                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Automatic discovery, duplicate triggers and authentication                            | New compatible identity prepares automatically with visible status; polling does not select it, force a credential prompt or duplicate work.                                                                                            |
| 205 only -> install healthy207                                                        | Count <=2 throughout; check and live readiness finish before reconnect; current remains205 until reconnect; then new work uses207.                                                                                                      |
| Install207 fails or wrong identity/readiness                                          | 205 stays selected/usable; candidate ineligible; typed fallback result; no user frames to207.                                                                                                                                           |
| 207 healthy pending dies before reconnect                                             | Reconnect rechecks and uses verified205; no stale-ready success.                                                                                                                                                                        |
| 205+207 retained ->208, old205 still needed                                           | 208 is not uploaded remotely; both old routes work; waiting state survives restart.                                                                                                                                                     |
| 205+207 ->208,205 obsolete and safely retireable                                      | Retire/delete205 before any208 payload; keep207; never exceed2; failed208 leaves207 usable.                                                                                                                                             |
| Two concurrent installs / target aliases                                              | Shared root reservation permits at most2, including partial files and lost acknowledgements.                                                                                                                                            |
| Paused installer >5 minutes / stale controller resumes                                | Reservation remains protective or stale writer is enforceably fenced; zero cleanup/install overlap.                                                                                                                                     |
| Retry A after B then pending C                                                        | Same A route or explicit expired rejection; C is not selected or consumed.                                                                                                                                                              |
| Health result/selection reply lost; UI reload                                         | Same request/generation resumes; no duplicate probe runtime or unintended selection.                                                                                                                                                    |
| Legacy fresh/stale/expired journals with live process/PTy and independent stdio       | No old epoch/journal/socket/discovery mutation by candidate; old work completes once and reconnects on its original route.                                                                                                              |
| Existing >2 builds, unknown owners or malformed inventory                             | No new upload or unsafe deletion; truthful capacity-noncompliant state.                                                                                                                                                                 |
| A still active when B is selected, then A finishes, then C arrives                    | Terminal/disposal persistence triggers obsolete A connection/admission pin release with ID rejection evidence retained; C can reclaim A without another deliberate reconnect. A selected by another controller still blocks retirement. |
| Idle-retirement acquisition race / native failure / process reuse                     | New acquisition fenced; old owners preserved; ambiguous or unsupported identity never signaled.                                                                                                                                         |
| Reply loss after accepted process/write/PTy input and full app-service reconstruction | Original IDs, epochs, durable cursors and unknown outcomes preserved; one side-effect marker.                                                                                                                                           |
| Auth/network failure versus bad build                                                 | Availability uncertainty never marks artifact unhealthy or releases an occupied slot.                                                                                                                                                   |
| Actual UI reconnection                                                                | Correct versions, waiting/health/fallback messages, stable IDs across reload, no saved project changes.                                                                                                                                 |

Required implementation commands (never `bun test`):

```sh
bun run --cwd apps/server vitest run src/remote-agent
bun run --cwd apps/web test:browser
bun fmt
bun lint
bun typecheck
bun run test
cargo fmt --all --check
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo test --locked --workspace
git diff --check
```

Run real-process Linux aarch64 and x86_64 tests with isolated HOME/state and no production SSH. Reuse `BIGBUD_TEST_LINUX_DOCKER=1` and `BIGBUD_TEST_AGENT_FIXTURES` only after validating fixture existence/provenance. Keep server tests sequential. Record exact pass/fail/skip counts, physical binary counts, marker counts, architecture, fault phase and source identity. Diagnose current watcher timeout and formatting failure; do not call the full acceptance gate green while either remains unresolved. For plan-only delivery, format/check only the new document and inspect the resulting diff; do not sweep unrelated dirty files.

## Acceptance Criteria

- [ ] At most two executable builds are saved within the declared remote account/root scope at every new-update phase, including interrupted uploads and cleanup.
- [ ] A full/uncertain two-slot inventory defers installation without interrupting existing work or writing a third build.
- [ ] Legacy205 can be the verified predecessor in the actual production bootstrap path, or the operation reports unavailable and does not pretend fallback is guaranteed.
- [ ] Candidate health is checked after installation and before reconnect selection, without changing current serving access.
- [ ] Preparation is automatic with visible status; a healthy candidate is selected only on deliberate reconnect, with readiness rechecked then. Automatic recovery/reload never consumes pending.
- [ ] After207 promotion,205 remains saved as predecessor; only a later208 preparation may reclaim205, and only when safe.207 remains fallback while208 is prepared.
- [ ] Install, health or reconnect failure leaves or selects the most recent verified stable predecessor before new work; unavailable predecessors are reported honestly.
- [ ] Existing work stays generation-pinned with zero duplicate side effects, including after reply loss and app restart.
- [ ] Obsolete managed supervisors/builds retire only through fenced, verified idleness/death; unknown legacy work is preserved.
- [ ] Old update/reconnect requests cannot become new actions after pruning or reload; stale installers cannot outlive capacity reservations.
- [ ] Existing over-cap installations are either safely reconciled or explicitly reported noncompliant; no false global two-build claim.
- [ ] UI, required checks, real Linux matrix and final independent review pass; every authored/materially edited source/test file is <=400 lines.

## Open Questions

None. The five answers and the final predecessor-retention confirmation settle capacity, waiting, preparation, health timing, reconnect selection and account scope. Implementation must not ask the user to choose locks, schemas or routine engineering mechanisms. Missing fixture artifacts, uncertain ownership, authentication and absent native retirement capabilities are implementation/validation conditions with explicit wait/fail behavior, not unresolved product policy.

### Plan assumptions and validity

- The source loader's configured/app-compatible release is the automatic preparation source. Existing custom executable and direct-SSH diagnostic modes remain outside managed auto-update; Linux installation support is unchanged.
- Poll interval/concurrency above are bounded engineering defaults verified with injected clocks and load tests. No new dependency is needed; reuse Effect, existing artifact verification, OpenSSH, registry CAS and SQLite.
- Initial worktree is the large modified/untracked implementation described in Current State, plus this plan; branch is one local commit ahead of origin. Index was empty. Revalidate actual HEAD, target aliases/root ownership, migration inventory, versioned registry readers, source-loader cache, native control support and all owner consumers before implementation. Never reset or discard inherited work.
- Root `AGENTS.md`, `crates/AGENTS.md`, the plan-authoring guide, accepted native boundary and existing planning evidence apply. Repository toolchain follows actual package/lockfiles; no upgrade is part of this plan.
- Planning write scope is this Markdown file only. Source/code/tests/configuration/other documentation are unchanged. Full repository commands above are implementation gates; running the mutating root formatter during planning would exceed that scope.

### Handoff and review record

Implement in order: repair existing replay/stage defects; add capacity and in-place legacy provenance; add safe managed retirement; wire automatic preparation/health; complete deliberate selection and UI; run public-path/platform acceptance tests. Retain all generation pinning and conservative provider retry boundaries.

Requirements review maps all six settled decisions to phases and acceptance criteria. Execution-readiness review checks strict pre-upload capacity, predecessor preservation, automatic scheduling/auth behavior, readiness-before-selection, reload idempotence and physical-count validation. Independent read-only challenge by `/root/plan_reviewer`, following `/Users/youpele/.config/opencode/agents/plan-reviewer.md`, identified the superseded-connection release cycle. Phase 3 and its regression matrix were corrected; re-review returned Ready for implementation with no remaining findings or user questions. Readiness here refers to the plan, not to implementation or release approval.
