# create_thread model choice: tributary provider/model chosen by the delegating thread

## 1. Metadata

- **Title:** create_thread model choice (extension of bigbud thread orchestration / delegation)
- **Status:** Ready for implementation. The user accepted the recommended defaults for OD1–OD6 on 2026-10-15 ("defaults OK"). Start only after the dead-thread recovery work is merged into `plan/terminal-rust-gpu-reliability` and fully green. Phase 5 still requires an independent review before merge.
- **Created:** 2026-10-15T19:25+02:00 (CEST). **Last modified:** 2026-10-15T19:35+02:00 (CEST). Revision 2 reworks the plan as an extension of the existing feature (see the end of §11).
- **Owner:** bigbud server/web implementation agent.
- **Project root (inspected):** `/Users/youpele/DevWorld/bigbud/.claude/worktrees/dead-thread-recovery`, branch `fix/dead-thread-recovery`, HEAD `9b49bed833dde9e76bb471aeb3858deebbf7c3fa`.
- **Implementation target:** `/Users/youpele/DevWorld/bigbud` on `plan/terminal-rust-gpu-reliability`, after it is fast-forwarded to include the dead-thread recovery work.
- **Worktree state during research:** dirty with a concurrent implementer's unrelated edits, none of which this plan touches. Modified: `apps/server/src/orchestration/deciderThreads.fork.{existing.test,logic,}.ts`, `apps/web/src/components/chat/view/ThreadForkNotice.*`, `apps/web/src/hooks/useContinueInNewThread.logic{,.test}.ts`, `docs/plans/2026-10-15-dead-thread-recovery-plan.md`, `docs/validation/dead-thread-recovery-2026-10-15.md`. Untracked: `deciderThreads.fork.heldModel.test.ts`. No research command changed any file.
- **Related work:** No bigbud note, Kanban card or issue was supplied (OQ1). Plans are listed in §1a.

## 1a. Extends

This is **not a new subsystem**. It implements Goal 11 of the existing thread orchestration / delegation feature: "During tributary creation, the trunk can specify its provider and model. If it does not, the tributary inherits the trunk's provider and model."

- **Feature plans extended:**
  - `docs/plans/2026-09-26-project-main-and-child-threads-plan.md` (trunk/tributary = parent/child delegation; Goal 11 is this work; Goal 10 keeps users able to change a tributary's model).
  - `docs/plans/2026-10-12-opencode-v2-canonical-thread-tools-plan.md` (canonical thread tools for V2; its line 70 defers "any new creation-selection API" to separate scope, which is this plan).
  - `docs/reports/providers-opencode-v2.md#consolidated-adoption-and-setup-decisions` (managed install/upgrade under `managed-thread-tools-v2`).
  - `docs/plans/2026-10-13-opencode-v2-stable-bootstrap-maintenance-plan.md` and `docs/plans/2026-10-14-opencode-v2-contract-compatibility-plan.md` (frozen bootstrap, breaking activation, qualification).
  - `docs/plans/2026-10-15-dead-thread-recovery-plan.md` (held queued prompts D17, browser-clock notices D15).
- **Existing modules extended (no parallel copies):**
  - Tools: `apps/server/src/orchestration-tools/ThreadOrchestrationTools*.ts` (create, status, origins with `stableThreadToolId`, access, participants, listThreads).
  - Dispatcher and auth: `ThreadOrchestrationToolDispatcher.ts`, `ThreadOrchestrationToolAuth.ts`.
  - HTTP route: `ws/http.threadTools*.ts`.
  - Bridges: `codexThreadDynamicTools{,.specs}.ts`, `copilotThreadOrchestrationTools.ts`, `orchestrationMcpBridge*.ts`, `PiOrchestrationBridge*.ts`, `threadOrchestrationBridge.shared.ts`, V2 `provider/Layers/OpencodeV2/Orchestration.*` (Phase 5 only).
  - Delegation persistence: `ThreadDelegationRepository` (`persistence/Services/ThreadDelegations.ts`).
  - Supervision: `ThreadWatchReactor`, `ThreadWorkflowStatus.logic.ts` (the `get_thread_status` payload), `ThreadDispatchSafety.logic.ts`, the prompt queue.
  - Agent guidance: `ProviderCommandReactorSessionOps.threadContext.ts`, `capabilities/BigbudCapabilityTracks.ts`.
  - Web: `DelegatedChildrenCard.tsx`, `helpers.delegatedChildren.store.ts`, `ThreadRecoveryNotices.tsx`, `logic/session/session.activity.logic.ts`.
- **Vocabulary and invariants kept:** trunk/tributary in user copy and parent/child in code. Delegation states `reserved → project_resolved → thread_accepted → turn_accepted | watch_armed → completed` (no new state). `watchForCompletion` semantics. `parentThread` linkage. The `delegation.child-linked` activity. The `initialDelegation` origin and provenance prompt. Stable ids via `stableThreadToolId`. Same-project/direct-child access rules. Per-action approvals. Five V2 tools until Phase 5.

## 2. Goal and definition of done

**Goal.** A trunk agent can choose the provider and model of a tributary it creates with `create_thread`. The choice is honored only if the user can use that model; otherwise the tributary inherits the trunk's model (Goal 11). A connected user gets about 10 s to pick a usable alternative. The delegation never fails and the tool never blocks because of the model choice.

**Acceptance criteria**

1. **create_thread input.** In the Codex, Copilot, MCP (Claude, Cursor, Devin, Codex-remote, ACP-remote) and Pi bridges, `create_thread` gains an optional input `modelSelection {provider, model?, subProviderID?}` and an optional output `modelChoice`. Without the input, the commands, events and results are unchanged except for the deterministic `createdAt` fix (AC9).
2. **Usable request.** The tributary is created and its first turn starts with the requested model immediately.
3. **Unusable request, client connected.** If an interactive client is connected and at least one alternative exists, the tool still returns immediately, with no provider probing. The delegated first message waits in the tributary's prompt queue for ≤ `DELEGATED_MODEL_CHOICE_HOLD_MS` (10 000 ms). The picker shows only usable models, recently used first, with the trunk's model preselected and a countdown. A pick starts the turn with the picked model; otherwise the server starts it with the trunk's model at the deadline.
4. **Unusable request, no wait.** If no client is connected, there is no alternative, or agent choice is disabled (OD4), the fallback is applied immediately with no hold.
5. **Never stuck.** A hold is never left pending. Startup resolves expired holds and reschedules unexpired ones. A periodic sweep (≤ 30 s) catches missed timers.
6. **Usable set.** It excludes providers that are disabled, not installed, in status `error`/`disabled`, unauthenticated, hidden (server-side, OD1), OpenCode V2 without native trust, retired legacy OpenCode, or unsupported for the inherited execution target. It also excludes unknown models and `requires-setup` models. The server enforces this.
7. **List tool.** A sibling tool `list_available_models` exists in the same family and bridges as AC1 (read-only, usable only, recent first).
8. **Requested vs used.** The tributary durably records requested vs used ("Requested X, used Y"). `get_thread_status` returns it; the trunk's `DelegatedChildrenCard` shows it and any pending choice.
9. **Retries.** Retrying an invocation never creates a second tributary, never re-holds, never re-decides, and never raises `OrchestrationCommandIdConflictError`.
10. **User messages and unlock.** Messages the user types into a held tributary queue behind the delegated task. The tributary stays provider-unlocked until its first turn (`threadHasStarted` is unchanged).
11. **No subsystem, no V2 change.** No new top-level folder or service is added (exceptions are justified inline), and no new event type or SQLite migration. Phases 0–4 change nothing under `provider/Layers/OpencodeV2/`, and `bun run --cwd apps/server thread-tools:manifest:check` is unchanged.
12. **Phase 5 (if approved).** V2 agents get the same capability through one ABI-2 bootstrap revision under the approved best-effort breaking activation. Pinned ABI-1 owners keep working until they are retired.
13. **Checks.** `bun fmt`, `bun lint`, `bun typecheck` and `bun run test` pass. Every added or materially edited code file is ≤ 400 lines.

## 3. Background and evidence

- **Today's create flow.** `createThreadViaOrchestration` (`ThreadOrchestrationTools.ts:27-245`) reserves a delegation and derives ids with `stableThreadToolId` (`:70-73`). It copies `callerThread.modelSelection` into `thread.create` (`:150-167`, `:159`), notifies the parent with `delegation.child-linked` (`:169`, `ThreadOrchestrationTools.origins.ts:12-56`), starts the first turn with the `initialDelegation` origin (`:170-187`, `:182`), and optionally arms a watch.
- **Tool schemas expose only title/task/projectId/watchForCompletion:**
  - Codex: `codexThreadDynamicTools.specs.ts:74-92`, `codexThreadDynamicTools.ts:169-199`.
  - Copilot: `copilotThreadOrchestrationTools.ts:153-197`.
  - MCP: `orchestrationMcpBridge.template.shared.ts:122-135`, `orchestrationMcpBridge.template.ts:107-122`, `orchestrationMcpBridge.ts:165`.
  - Pi: `PiOrchestrationBridge.template.ts:98-131`.
  - HTTP: `ws/http.threadTools.schema.ts:4-54`, `ws/http.threadTools.ts:187-235`.
  - Dispatcher: `ThreadOrchestrationToolDispatcher.ts:65-73`, `OrchestrationEngine.toolDispatcher.ts:139-151`.
- **Retry hazard (high confidence from reading; not reproduced).** A fresh `now` (`:74`) goes into stable-id commands. The payload digest excludes only `commandId` (`orchestration/commandDigest.ts:30-38`), and a digest mismatch raises `OrchestrationCommandIdConflictError` (`OrchestrationEngine.commandProcessing.ts:113-131`). A retry from `project_resolved`/`thread_accepted` therefore conflicts.
- **Pending-state precedent.** Pending approvals and user input are derived from `approval.requested`/`.resolved` activities (`ThreadWorkflowStatus.logic.ts:69-130`). They already block dispatch (`ThreadDispatchSafety.logic.ts:14-19`). A direct `thread.turn.start` on a blocked thread becomes a durable queued prompt (`deciderThreads.turn.start.ts:67-80`). Flushes require an idle, unblocked thread (`QueuedPromptPolicy.logic.ts:25-32,144-145`). The web derives the same state from activities (`apps/web/src/logic/session/session.activity.logic.ts`). Forks record lineage as activities (`orchestration.fork.ts:43-46`).
- **Thread model update.** `thread.meta-updated` applies `modelSelection` (`projectorThreadLifecycle.ts:339`). `thread.turn-start-requested` takes the session provider from `thread.modelSelection` (`projector.ts:113-130`), so the model update must precede the turn events.
- **Provider status.** `ProviderRegistry.getProviders` (`provider/Services/ProviderRegistry.ts:13-42`) returns snapshots with `enabled`, `installed`, `status`, `auth`, `models[].availability` and `supportsLocalRuntimeRemoteWorkspace` (`contracts/src/server/server.providers.ts:45-57,171-209`). Related helpers: `hasOpencodeV2NativeTrust` (`shared/src/opencodeNativeTrust.ts:2-9`), `isRetiredProvider` (`shared/providerLifecycle`), `resolveSelectableModel` (`shared/src/model/model.ts:70-101`).
- **Client-only data.** `hiddenComposerProviders` lives in client localStorage (`contracts/src/core/settings.ts:133`), and so does recency (`web/src/models/recentlyUsedModels.ts:7-20`).
- **Presence already tracked.** `DesktopSupervisorDelivery` keeps a `sessions` map of open consumers (`desktop-supervisor/desktopSupervisorDelivery.ts:58,86-111`). Every web/desktop domain-event subscription opens one (`ws/wsOrchestrationDelivery.ts:24-34`). The mobile route bypasses it (`ws/ws.mobile.ts:230-240`).
- **Composition.** The engine layer that installs the dispatcher has no `ProviderRegistry` (`server.ts:148-152`). `ws/wsRpcContext.ts:95-119` already holds `ProviderRegistry`, `ServerSettingsService`, `ProjectionThreadRepository` and `DesktopSupervisorDelivery`.
- **Delegation result storage.** The delegation row's `resultJson` is written only by the create flow (`ThreadOrchestrationTools.ts:204,230`), and replay keys on `state`, not `resultJson` (`:105`).
- **OpenCode V2.** Tool schemas are frozen in `Orchestration.plugin.specs.ts:1-111` (ABI `bigbud.thread.bootstrap.v1`). The generator hashes that file and includes `types.ts`/`specs.ts` in every handler closure (`apps/server/scripts/generateThreadToolImplementationManifest.ts:9-15`). Handler v1 rejects unknown keys (`Orchestration.implementation.v1.ts:8-29`); the boundary allowlist is at `Orchestration.implementation.boundary.ts:72-101`; compatibility binds the schema digest (`Orchestration.compatibility.ts:15-27`). `build` runs `thread-tools:manifest:check` (`apps/server/package.json:19`).

## 4. Plan assumptions (verify at phase start)

- A1. `getProviders` reads cached snapshots and never probes. Verify in `provider/Layers/ProviderRegistry*`. `refresh` is never called on the tool path.
- A2. `auth.status: "unknown"` counts as usable; only `unauthenticated` is excluded.
- A3. Snapshot `models` already include custom models.
- A4. Activities on a tributary the user never opened still reach the web store, so `syncDelegatedChildSummaries` can derive the pending choice. Verify against `stores/main/helpers.lazy*.ts`. If they do not, add a minimal apply-path for the two activity kinds on unloaded child shells.
- A5. `wsRpcContext` is built once per server. If it is built per connection, install the model sources from one layer in `server.ts` instead.
- A6. A fresh tributary's activities are not capped away before resolution, and new activity kinds render nowhere unexpectedly. Check the activity rendering in the web work log and hide these two kinds there, because the notice renders them instead.

## 5. Scope

**In scope:**

- New optional inputs/outputs on `create_thread` and `get_thread_status`.
- The sibling tool `list_available_models`.
- The usable-model rules and ranking.
- Hold, resolution and sweep built on existing queue, dispatch-safety, activity and watch-reactor mechanisms.
- The retry fix.
- Settings (OD1, OD4).
- The web picker, notice and card row.
- Bridges, descriptions, thread context and capability track.
- Phase 5 V2 (gated).

**Out of scope:** an agent-selected `options` (OD5); a per-provider agent allow-list; model choice for `send_thread_message`, forks or branches; legacy OpenCode tools; trunk/tributary sidebar views and caps (other goals of the main/child plan); the parent-card picker after a reload during the window (accepted limitation).

**Unchanged:**

- `create_thread` without `modelSelection`.
- `threadHasStarted`.
- D17 `queueHold`.
- Delegation state literals: `turn_accepted` keeps meaning "the initial message was durably admitted (started or queued)", exactly like `send_thread_message`.
- Watch-completion semantics: a held tributary is never `workflow_complete`.
- V2 ABI-1 bytes, handlers and manifests.

## 6. Design decisions (each extends an existing mechanism)

- **D1 Lenient request, strict result.** The transport field is `modelSelection: Schema.optional(Schema.Unknown)`, parsed to `RequestedModelSelection` `{provider ≤64, model? ≤256, subProviderID? ≤128}` (trimmed). The strict `ModelSelection` would make an unknown provider fail decoding, violating "never fail". Malformed input gives the reason `invalid-request` and the fallback. A request equal to the trunk's provider+model reuses the trunk's full selection; any other choice uses provider defaults (OD5).
- **D2 Decide once, in the delegation row.** Extends `ThreadDelegationRepository`. Right after `reserve`, the decision is written to the existing `resultJson` via `storeResult({resultJson: {modelDecision}})`. A retry reads it back and never recomputes; the final `storeResult` keeps `modelDecision` in the full result. Every derived command uses `delegation.createdAt`. `thread.create` carries `used` (immediate) or the trunk's model (hold), and is identical across retries. There is no migration.
- **D3 The hold reuses the prompt queue and the approval-style dispatch block.**
  - The delegated first message (same text, same `initialDelegation` origin) is queued as an ordinary queued prompt.
  - A pending choice is an activity pair on the tributary, `delegation.model-choice-requested` and `delegation.model-choice-resolved`, keyed by `choiceId`. This is the same pattern as `approval.requested`/`.resolved`.
  - `isThreadTurnDispatchBlocked` treats an unresolved choice exactly like a pending approval. Auto-dispatch, manual flush and direct user turn starts therefore queue behind it through existing code, and the lifecycle flush sends them after the first turn.
  - A new projection field, an event type and a migration were rejected: these mechanisms already provide durability, ordering, web delivery and dispatch semantics.
  - `queueHold` is not used, because it means "manual send only" (D17).
  - One addition is unavoidable: two commands in the existing thread command family. Hold and resolve must be atomic so that the first resolution wins; composing existing commands would race the pick against the timer and could strand a hold after a crash.
- **D4 The server timer is authoritative.** Resolution commands are serialized; the first wins and later ones decide `[]`. The client countdown is display-only and uses the browser-clock rule from dead-thread D15.
- **D5 Presence extends `DesktopSupervisorDelivery`.** It gains `hasOpenConsumer()` (any open, non-closed session) and `retainExternalConsumer()` (a scoped counter used by the mobile route). There is no new presence service; per-thread viewing is unknowable and the tributary was just created. A false positive costs at most 10 s.
- **D6 Discovery is a sibling tool in the same family.** `list_available_models` is one more action in `ThreadToolRequest` and the dispatcher, exposed by the same bridges and the same capability catalog. The create result also carries up to 10 `suggestions`. Considered and rejected as hosts: `list_threads` (threads, not models), and the capability catalog / `CapabilityCatalog.dynamic.ts` (static how-to guides, not live data). Tool descriptions and thread context were rejected because they are stale for the session and frozen in V2.
- **D7 Recency is server-derived.** `ProjectionThreadRepository` gains `listRecentModelSelections({limit: 200})`, deduplicated by provider+model+subProviderID.
- **D8 Supervision extends `ThreadWatchReactor`.** It already supervises parent/child delegations from domain events. The hold timer and sweep go into `ThreadWatchReactor.modelChoice.ts`, with no new reactor.
- **D9 Model sources sit beside the tools.** The pure rules live in `ThreadOrchestrationTools.modelChoice.ts`. Runtime inputs (providers, settings, recency, presence) reach the dispatcher through `setThreadToolModelSources`, which lives in `ThreadOrchestrationToolDispatcher.ts` (same pattern as `setThreadOrchestrationToolDispatcher`) and is installed from `wsRpcContext.ts`, where all four services already exist. Justification: the engine layer cannot depend on provider layers. If no sources are installed, the reason is `catalog-unavailable` and the fallback is used.
- **D10 V2 is staged last** (Phase 5). A schema change there is a breaking bootstrap activation, so one activation carries both the create extension and the list tool.

## 7. Implementation steps

### Phase 0 — Rebase gate (no code)

1. Confirm the target branch contains `9b49bed83` plus the concurrent fork/notice fixes, then re-read every citation in §3 and §7.
2. Record the line counts of files near the limit: `ThreadOrchestrationTools.ts` (365), `copilotThreadOrchestrationTools.ts` (396), `ws/http.threadTools.ts` (394), `orchestration.commands.client.ts` (395), `orchestration.commands.internal.ts` (225), `ThreadWorkflowStatus.logic.ts` (313). Split by concern before adding to any file that would pass 400.

**Gate:** citations valid.

### Phase 1 — Delegation domain extension (contracts, decider, dispatch safety, status). Ships dark.

1. **Contracts.** Add `packages/contracts/src/orchestration/orchestration.delegationModelChoice.ts`, beside `orchestration.fork.ts` (which hosts fork activity kinds), and a subpath export. It is a dot-notation module because `orchestration.thread.ts` (396) and `orchestration.commands.client.ts` (395) cannot absorb it. Contents:
   - `DELEGATED_MODEL_CHOICE_HOLD_MS = 10_000`.
   - Activity kinds `DELEGATION_MODEL_CHOICE_REQUESTED_ACTIVITY_KIND` / `..._RESOLVED_...`.
   - `RequestedModelSelection`.
   - `ModelChoiceUnusableReason` (`invalid-request|unknown-provider|provider-disabled|provider-not-installed|provider-unavailable|provider-unauthenticated|provider-hidden|provider-untrusted|provider-retired|unsupported-execution-target|unknown-model|model-requires-setup|agent-choice-disabled|catalog-unavailable`).
   - `ModelChoiceOption {selection: ModelSelection, label, providerLabel, lastUsedAt, isFallback}` (≤100).
   - Payloads: `DelegationModelChoiceRequested {choiceId, delegationId, requested, fallback, reason, options, deadlineAt, heldMessageId}` and `DelegationModelChoiceResolved {choiceId, requested, fallback, reason, used, outcome: requested|fallback|user-picked, resolvedBy: server|user|timeout|no-client|no-alternatives|disabled|restart-sweep, cancelled?}`.
   - Commands: internal `thread.delegation.model-choice.hold {commandId, threadId, message:{messageId, text, originSegments}, runtimeMode, interactionMode, requestedActivity, createdAt}` and `thread.delegation.model-choice.expire {commandId, threadId, choiceId, resolvedBy: timeout|restart-sweep, createdAt}`; client `thread.delegation.model-choice.pick {commandId, threadId, choiceId, modelSelection, createdAt}`.
   - Add only union lines to the command files. No new event types. Schema only.
2. **Decider.** Add `orchestration/deciderThreads.delegationModelChoice.ts` (+ `.logic.ts`), a dot-notation sibling of `deciderThreads.fork.ts`, routed from `deciderThreads.ts`. Add the commands to `decider.opencodePolicy.ts` `RUNTIME_COMMANDS`.
   - **hold:** requires no `latestTurn` and no existing choice. It emits the existing `thread.prompt-queued` (via `makeQueuedPromptEvent`, `modelSelection` = fallback) and the existing `thread.activity-appended` (requested), atomically.
   - **expire/pick:** require an unresolved requested activity with an equal `choiceId`, else `[]`. Pick also requires `modelSelection` ∈ `options` (else an invariant error); the `isFallback` option gives outcome `fallback`. Both emit the existing `thread.activity-appended` (resolved) and `thread.meta-updated {modelSelection: used}`. If the held prompt is still queued and the thread is not archived or deleting, they also emit `thread.queued-prompts-flushed` plus turn-start events built with `queuedPromptToTurnStartCommand` (with `modelSelection` = used). Those events come from `decideThreadTurnStartCommand` on a read-model copy that already contains the resolved activity, so its own block does not apply.
   - **Archived thread, or prompt removed by the user:** resolution is recorded with `cancelled: true` and nothing is sent.
3. **Dispatch safety.** In `ThreadDispatchSafety.logic.ts` and `ThreadWorkflowStatus.logic.ts`, add `derivePendingDelegatedModelChoice(activities)` next to `derivePendingApprovals`. A pending choice blocks dispatch and maps the workflow status to `connecting` (agent active). The status snapshot (the `get_thread_status` payload) gains `modelChoice {status, requested, used, reason, outcome, resolvedBy}`.

**Gate:** Phase 1 tests green; nothing dispatches the new commands yet.

### Phase 2 — Runtime extension of the create flow (same release as Phase 3)

1. **Settings** (existing `ServerSettings` + `settings.serverPatch.ts`):
   - Add `delegatedThreadModelChoice: "agent"|"parent"`, default `"agent"` (OD4).
   - OD1: move `hiddenComposerProviders` from client to server settings, with a one-time web migration in `hooks/useSettings*` (non-empty local value and empty server value → patch the server, then drop the local key). `ComposerProvidersSettingsSection.tsx` writes through the patch.
   - Add the toggle "Let agents choose models for delegated threads" to the existing agent-related settings section.
2. **Presence (D5).** Extend `DesktopSupervisorDeliveryShape` (`desktopSupervisorDelivery.types.ts`, implementation in `desktopSupervisorDelivery.ts`) with `hasOpenConsumer()` and `retainExternalConsumer(): () => void`. Wrap the mobile stream at `ws.mobile.ts:236` with acquire/release.
3. **Model rules (D9).** `orchestration-tools/ThreadOrchestrationTools.modelChoice.ts` (pure):
   - `parseRequestedModelSelection`.
   - `listUsableModels` (AC6; remote targets require `supportsLocalRuntimeRemoteWorkspace === true`; first confirm that flag's meaning at `Codex/Adapter.session.ts:84` and `Claude/Adapter.session.ts:153`).
   - `resolveRequested` (`resolveSelectableModel`; with provider only, the most recent usable model of that provider, else its first usable model).
   - `rankOptions` (recent first, then snapshot order; the fallback is always present and flagged).
   - `decideModelChoice` (usable → immediate `requested`; unusable → hold if a client is connected and an alternative exists, else immediate fallback with `no-client`, `no-alternatives` or `disabled`).

   Add `setThreadToolModelSources({getProviders, getSettings, listRecent, hasInteractiveClient})` to `ThreadOrchestrationToolDispatcher.ts`, installed with a finalizer in `ws/wsRpcContext.ts` (A5). Add `ProjectionThreadRepository.listRecentModelSelections` (D7).

4. **create_thread.**
   - Move the create flow to `ThreadOrchestrationTools.createThread.ts` (re-exported; needed for the 400-line limit). Use `delegation.createdAt` everywhere (fixes the §3 hazard).
   - Without `modelSelection`: the existing flow.
   - With it: run D2, then `thread.create` (model per D2) and `notifyDelegationLinked`, whose `delegation.child-linked` payload gains an optional `modelChoice` summary (requested, status).
     - Immediate outcome: append the resolved activity (stable id), then the existing `thread.turn.start` with `used`.
     - Hold: dispatch `thread.delegation.model-choice.hold` (`choiceId = stableThreadToolId("model-choice", identity)`, command id `stableThreadToolId("command", identity + ":model-choice-hold")`, `deadlineAt = delegation.createdAt + holdMs`).
   - Delegation states and the watch flow are unchanged. The result and the replay output gain `modelChoice` (+ `suggestions` when the request was unusable).
   - The HTTP handler moves to `ws/http.threadTools.createThread.ts`. Add `modelSelection: Schema.optional(Schema.Unknown)` to `ThreadToolRequest`; the dispatcher's `createThread` input gains `modelSelection?: unknown`.
5. **Supervision (D8).** `orchestration/Layers/ThreadWatchReactor.modelChoice.ts` (+ `.logic.ts`), started from the existing `ThreadWatchReactor`:
   - On a requested activity, schedule an expire fiber (`FiberMap` keyed by `choiceId`, delay `clamp(deadlineAt − now, 0, holdMs)`, command id `model-choice-expire:<choiceId>`); interrupt it on resolved.
   - At start and every 30 s, sweep with `ProjectionThreadActivityRepository.listByKindSince(requestedKind, now − 1 h)`, add `ensureThreadState(id, "operational")`, and skip already-resolved choices. Expired holds get `restart-sweep`; the rest are scheduled.
   - Retry a failed dispatch 3× with backoff, then log. Drop deleted threads.
6. **List tool.** `ThreadOrchestrationTools.listAvailableModels.ts`. Add the `list_available_models` action to `ThreadToolRequest` (reuse `limit`: default 50, max 200) and `listAvailableModels` to the dispatcher, with an HTTP branch. It returns `{parentModel, agentModelChoice, models:[{provider, providerLabel, model, name, subProviderID?, lastUsedAt, isParentModel}], hasMore}`, with an empty list when the setting is `"parent"`.

**Gate:** Phase 2 tests green; manifest check unchanged.

### Phase 3 — Web extension (same release as Phase 2)

1. **Derivation.** Add `derivePendingDelegatedModelChoice` and `deriveDelegatedModelChoiceRecord` next to `derivePendingApprovals` in `logic/session/session.activity.logic.ts` (split into `session.activity.modelChoice.logic.ts` if needed). `syncDelegatedChildSummaries` mirrors the tributary's choice status into the trunk's `delegatedChildren` item, and `applyDelegationLinkedActivity` reads the optional `modelChoice` summary. Hide the two kinds from the work log (A6).
2. **Tributary notice.** `components/chat/view/ThreadModelChoiceNotice.tsx` (+ `.logic.ts`), rendered by `ThreadRecoveryNotices.tsx` and reusing `ThreadRecoveryNotice.clock.ts` keyed by `choiceId`.
   - Pending: blue, `role="status"`, announced once. Copy: "Requested {X} isn't available ({reason}). Choose a model — using {trunk model} in {n}s." It shows the first 12 options (with "Show all"), each a `text-sm` button, with the fallback highlighted and a "Use {trunk model} now" action. Buttons are disabled while the pick is in flight.
   - Resolved: a persistent line. Green "Using requested model {X}"; green "You chose {Y} (requested {X} unavailable)"; amber "Requested {X} unavailable ({reason}); used {Y}". Secondary text is `text-xs`; the layout is touch-friendly on mobile web.
3. **Trunk card.** `DelegatedChildrenCard.tsx` shows a pending row ("Choose model · {n}s") that opens the same picker (OD3), and the resolved model per child.
4. **Composer.** No change; server-side blocking already queues sends. Verify the queued item is visible.

**Release gate (2+3):** browser tests and the manual check (§8.4).

### Phase 4 — Tool surface in the non-V2 bridges

1. In `threadOrchestrationBridge.shared.ts` (it already holds the family's descriptions and bridge helpers), add `CREATE_THREAD_TOOL_PARAMETERS` (existing properties + `modelSelection`), `LIST_AVAILABLE_MODELS_PARAMETERS`, `LIST_AVAILABLE_MODELS_TOOL_DESCRIPTION`, and an updated `CREATE_THREAD_TOOL_DESCRIPTION`. Bridges use these instead of duplicated inline schemas.
2. Extend the existing specs and templates:
   - Codex: `codexThreadDynamicTools.specs.ts` and the cases in `codexThreadDynamicTools.ts` (raw `modelSelection` pass-through).
   - Copilot: split the thread tools into `copilotThreadOrchestrationTools.threads.ts` first.
   - MCP: `orchestrationMcpBridge.template.shared.ts` embeds the JSON schema; add the case and pass-through in `orchestrationMcpBridge.template.ts`; add the allowed name in `orchestrationMcpBridge.ts:165`.
   - Pi: `PiOrchestrationBridge.template.ts`, as a TypeBox mirror.
3. In `ProviderCommandReactorSessionOps.threadContext.ts:61-70`, add model-choice lines gated by `supportsDelegatedModelChoice` (false for `opencodeV2` until Phase 5), and add `list_available_models` to the MCP-suffix sentence. In `BigbudCapabilityTracks.ts`, extend the `thread.create` track's workflow and add a `thread.models.list` track.
4. Sessions started before the upgrade keep their old schemas until restart; this is harmless because the fields are optional.

**Gate:** bridge tests green; manifest check unchanged.

### Phase 5 — OpenCode V2 ABI-2 (OD2 accepted; separate release after P4; independent review before merge)

1. Never edit `Orchestration.plugin.specs.ts`, `.implementation.types.ts`, `.implementation.v1.ts` or `.implementation.v2.ts`; they are in the frozen closures.
2. Add `Orchestration.plugin.specs.v2.ts` (`bigbud.thread.bootstrap.v2`):
   - Five tools byte-identical except `create_thread`, which gains `modelSelection`.
   - A sixth tool for `list_available_models`, whose name is fixed in the review.
3. Add `Orchestration.implementation.types.v3.ts` and `.implementation.v3.ts` (frozen), and a `v3` closure in the generator with its own `schemaDigest`. Regenerate; the v1/v2 entries must be byte-identical.
4. Keep the current descriptor as legacy N2 in `Orchestration.compatibility.legacy.ts`; the new descriptor targets ABI-2/v3. In `boundary.ts`, add `modelSelection` and the list mapping. Readiness checks the per-ABI tool set (5 or 6). Add the list action to `Execution.orchestration.ts`. `plugin.ts` emits the v2 specs.
5. Activate per stable-bootstrap §4 (automatic best-effort, no native restart) under the existing `managed-thread-tools-v2` trust. Set `supportsDelegatedModelChoice` from the owner's ABI. Qualify per contract-compatibility §1a.

## 8. Validation plan

Never `bun test`. Run from the repository root.

1. **Phase 1:**
   - `bun run --cwd packages/contracts vitest run src/orchestration/orchestration.delegationModelChoice.test.ts`.
   - `bun run --cwd apps/server vitest run src/orchestration/deciderThreads.delegationModelChoice.test.ts src/orchestration/ThreadDispatchSafety.logic.test.ts src/orchestration/ThreadWorkflowStatus.logic.test.ts`. Covers: hold → pick → turn with the picked model; expire; double resolution is a no-op; wrong `choiceId`; pick outside options rejected; user `thread.turn.start` and `message.submit` during a hold are queued; archived or removed prompt → cancelled; `meta-updated` precedes turn-start.
   - Regressions: `bun run --cwd apps/server vitest run src/orchestration/deciderThreads.turn.queue.test.ts src/orchestration/deciderThreads.turn.start.dispatchSafety.test.ts src/orchestration/deciderThreads.fork.test.ts`.
2. **Phase 2:** `bun run --cwd apps/server vitest run src/orchestration-tools/ThreadOrchestrationTools.modelChoice.test.ts src/orchestration-tools/ThreadOrchestrationTools.createThread.test.ts src/orchestration-tools/ThreadOrchestrationTools.createThread.modelChoice.test.ts src/orchestration-tools/ThreadOrchestrationTools.listAvailableModels.test.ts src/orchestration-tools/ThreadOrchestrationTools.restart.test.ts src/orchestration-tools/ThreadOrchestrationTools.getThreadStatus.test.ts src/orchestration/Layers/ThreadWatchReactor.modelChoice.test.ts src/desktop-supervisor/desktopSupervisorDelivery.test.ts src/ws/http.threadTools.test.ts src/ws/serverSettings.test.ts`. Covers:
   - Every AC6 reason.
   - Provider-only, unknown and malformed requests.
   - No client, no alternatives, setting `"parent"`, missing sources.
   - Retry from `thread_accepted`: no conflict and the stored decision is reused.
   - Restart sweep for past and future deadlines.
   - The tool path never calls `refresh` (spy).
   - Without `modelSelection`, the commands equal today's except `createdAt`.
3. **Phase 3:**
   - `bun run --cwd apps/web vitest run src/logic/session/session.activity.logic.test.ts src/components/chat/view/ThreadModelChoiceNotice.logic.test.ts src/stores/main/helpers.delegatedChildren.store.test.ts src/hooks/useSettings.storage.test.ts`.
   - `bun run --cwd apps/web test:browser src/components/chat/view/ThreadModelChoiceNotice.browser.tsx src/components/chat/agents/DelegatedChildrenCard.browser.tsx` (countdown, pick, tones, accessibility, mobile viewport). Install first if needed with `bun run --cwd apps/web test:browser:install`.
4. **Manual check (P2+P3, `bun dev`):**
   - The trunk requests (a) a usable model, (b) a hidden provider, (c) an unauthenticated provider, (d) an unknown model. Check the picker, a pick, a timeout and the notices in both the tributary and the trunk card.
   - With all clients closed, (b) falls back with no wait.
   - Kill the server within 10 s and restart: the tributary starts with the fallback.
   - A message typed into a held tributary is queued and sent after the first turn.
5. **Phase 4:** `bun run --cwd apps/server vitest run src/orchestration-tools/codexThreadDynamicTools.test.ts src/orchestration-tools/copilotThreadOrchestrationTools.test.ts src/orchestration-tools/orchestrationMcpBridge.test.ts src/orchestration-tools/orchestrationMcpBridge.allowedTools.test.ts src/orchestration-tools/PiOrchestrationBridge.test.ts src/orchestration-tools/mcpInvocationIdentity.integration.test.ts src/capabilities/CapabilityCatalog.test.ts`, then `bun run --cwd apps/server thread-tools:manifest:check`.
6. **Phase 5:**
   - The manifest check (v1/v2 unchanged, v3 added) and `bun run --cwd apps/server thread-tools:native-qualification:check`.
   - `bun run --cwd apps/server vitest run src/provider/Layers/OpencodeV2/Orchestration.implementation.test.ts src/provider/Layers/OpencodeV2/Orchestration.implementation.boundary.test.ts src/provider/Layers/OpencodeV2/Orchestration.plugin.contract.test.ts src/provider/Layers/OpencodeV2/Orchestration.production.generations.test.ts`. Show an A (ABI-1) owner continuing while a new B owner uses v3. A skipped native suite is not evidence.
7. **Every phase:** `bun fmt`, `bun lint`, `bun typecheck`, `bun run test`; `wc -l` for every edited source file.

## 9. Risks, rollout and rollback

- **Prompt-injected cost escalation.** Only usable models can be chosen. The choice is visible in the tributary notice, the trunk card and `get_thread_status`. Setting `"parent"` disables agent choice. Agent `options` are not accepted (OD5).
- **Stuck hold.** Timer + 30 s sweep + startup sweep; idempotent resolution; delay clamped to `holdMs`.
- **Presence false positive.** Costs at most 10 s.
- **OD1 cross-device change.** Hiding a provider becomes global; the migration preserves the current list.
- **Downgrade.** No new event types are persisted; only activities with new kinds and two new command types. After a downgrade, a still-held prompt stays queued (no auto-send, user can send), which is safe. The primary rollback lever is setting `"parent"`. Phase 4 can be reverted on its own.
- **V2.** One breaking activation with the accepted cross-client race. A bootstrap rollback is another activation.
- **Rollout:** P1 (dark) → P2+P3 (one release) → P4 (switch-on) → P5 (separate release after independent review).

## 10. Plan validity

Valid for `fix/dead-thread-recovery@9b49bed83` plus the WIP listed in §1. Revalidate if the fast-forward changes `ThreadOrchestrationTools.ts`, `ThreadDispatchSafety.logic.ts`, `QueuedPromptPolicy.logic.ts`, `ThreadWatchReactor*`, `desktopSupervisorDelivery*`, the V2 orchestration files, the `ServerProvider`/settings schemas, the stable-bootstrap or compatibility policies, or the main/child-threads plan's Goal 10/11. Also revalidate if the V2 callback timeout (10 s, `Execution.orchestration.ts:94`) changes. No external web facts were used.

## 11. Handoff notes

**Order:** Phase 0 → 1 → 2+3 (one release) → 4 → 5 (gated).

**Settled; do not reopen:**

- Optional provider/model on `create_thread`, reusing `ModelSelection`.
- Trunk's model as the fallback; the delegation never fails because of the model choice.
- Usable-only picker, recent first, about 10 s; trunk's model when there is no pick.
- The tool never blocks; only the tributary's first turn waits.
- No client means an immediate fallback.
- Agents can list usable models.
- Requested vs used is recorded and returned by `get_thread_status`.
- `threadHasStarted` is unchanged.
- This work extends the existing thread orchestration feature (§1a).

D1–D10 change only with evidence.

**Settled decisions (accepted by the user on 2026-10-15; the recommended defaults below apply):**

- **OD1 (material):** Move `hiddenComposerProviders` to server settings so the server can honor "hidden" with no client. Default: yes, with a one-time browser migration.
- **OD2 (material):** Ship V2 as Phase 5 with one breaking ABI-2 activation (extended `create_thread` + list tool). Default: yes, as a separate release after P4 and an independent review; until then V2 agents keep today's behavior.
- **OD3:** Show the countdown/picker in the trunk's `DelegatedChildrenCard`. Default: yes.
- **OD4:** Kill switch `delegatedThreadModelChoice`, default `"agent"`; no per-provider allow-list in v1. Default: yes.
- **OD5:** Agents cannot set model `options`. Default: yes.
- **OD6:** "Connected" means any open delivery consumer (desktop, web, mobile web), not per-thread viewing. Default: yes.
- **OQ1:** Link a bigbud note, Kanban card or issue if one exists.

**Accepted after the coordinator review (2026-10-15; documented, no code change):**

- **Retry idempotency over freshness.** A retried `create_thread` reuses the decision stored in the delegation row's `resultJson`, even if settings, provider health or the connected clients changed in between. Re-deciding would make retries non-deterministic (AC9).
- **What the agent learns.** `list_available_models` and the tool result tell the agent which providers and models are usable now and which were used recently. They never expose credentials, tokens, paths or settings values.
- **Runtime-mode guardrail parity.** Providers still differ in how their runtime-mode guardrails apply to delegated threads. This predates this feature and stays a separate follow-up.

**Follow-up (2026-10-15):** mobile-web picker plus the `thread.delegation.model-choice.pick` mobile command allowlist entry. Until then a mobile client does not count as connected (D-16).

**Remaining blockers:** none for the plan. All six decisions above were accepted by the user on 2026-10-15 with the recommended defaults; treat them as settled. OQ1: no note, card or issue is linked.

**Review notes.** Clarifier, plan-reviewer and debugging subagents were unavailable, so the planner performed those roles. Pass 1 (coverage) mapped the settled decisions, Goal 11 of the main/child plan and every constraint to D1–D10, the steps and AC1–AC13. Pass 2 (execution readiness) checked files near the limit, the frozen V2 closure, the composition boundary, dormant-thread sweeps, the order of model update before turn start, retry determinism and the commands.

**Revision 2 (extension rework).** Per user direction, every piece now lives in the existing feature:

- The separate `modelChoice` projection field, the new event types and migration 129 are gone. The pending choice is an approval-style activity pair. The hold is the existing prompt queue plus the dispatch-safety block.
- The decision is stored in the delegation row's existing `resultJson`.
- Presence extends `DesktopSupervisorDelivery`; the timer and sweep extend `ThreadWatchReactor`.
- The model rules and list tool are `ThreadOrchestrationTools.modelChoice.ts` and `ThreadOrchestrationTools.listAvailableModels.ts`. The shared schemas live in `threadOrchestrationBridge.shared.ts`.
- The linked activity, the `get_thread_status` payload, `DelegatedChildrenCard`, the thread context and the capability catalog are extended rather than paralleled.
- The only new pieces are two commands in the existing thread command family (needed for atomic first-wins resolution) and one contracts schema module (because the existing files are at the 400-line limit).

## 12. Deviations (implementation, 2026-10-15)

Recorded by the implementer against `plan/terminal-rust-gpu-reliability@6a6e27052`. None changes a settled user-facing decision.

- **D-1 (2026-10-15) One shared derivation.** `derivePendingDelegatedModelChoice` / `deriveDelegatedModelChoiceRecord` live once in `packages/shared/src/delegatedModelChoice.ts` (subpath `@bigbud/shared/delegatedModelChoice`, the `threadFork` precedent) and are used by the decider, `ThreadDispatchSafety`, `ThreadWorkflowStatus` and the web, instead of two copies next to each `derivePendingApprovals`.
- **D-2 (2026-10-15) Resolution loads full thread history (A6, server side).** The startup operational window loads no activities for idle threads, so after a restart the pending choice would be invisible to the decider. `thread.delegation.model-choice.expire|pick` are added to `historyRequired` in `OrchestrationEngine.prepareCommandState.ts`, so resolution always sees the requested activity (no SQL or migration change).
- **D-3 (2026-10-15) Model sources are installed from one server layer (A5).** `makeWsRpcContext` is built once per server for the desktop/web route but once per connection for the mobile route, so a finalizer there would uninstall the sources when a mobile client disconnects. Sources are installed by a dedicated layer merged into the server application layer in `server.ts`, as the plan's A5 fallback prescribes.
- **D-4 (2026-10-15) Hold command field name.** The hold command carries the delegated message as `prompt` (not `message`), so existing `"message" in command` narrowings over the command union keep meaning "a user message with attachments".
- **D-5 (2026-10-15) Sweep query has no age cutoff.** The startup and 30 s sweep read `ProjectionThreadActivityRepository.listPendingDelegatedModelChoiceRequests` (requested activities with no matching resolved activity, using the existing kind index) instead of `listByKindSince(now − 1h)`. A hold older than an hour after a long outage is still resolved to the fallback rather than stranded.
- **D-6 (2026-10-15) Settings placement.** The `delegatedThreadModelChoice` switch is a new "Delegated threads" section in the AI settings panel (`DelegatedThreadsSettingsSection.tsx`), with settings-search entries, rather than a row inside an unrelated existing section.
- **D-7 (2026-10-15) Trunk card mirror is web-only.** The child's model choice is mirrored into a web-only `DelegatedChildSummary.modelChoice` (`app.types.ts`) rather than adding a field to the `ThreadDetailDelegatedChild` contract, which the server never fills. Detail hydration keeps a mirrored record and otherwise reads the summary from the trunk's own `delegation.child-linked` activity. Because that summary's status can be stale after a reload, the card shows only "Requested {X}" from it; live status and the picker come from the mirrored tributary record (the accepted reload limitation is unchanged).
- **D-8 (2026-10-15) Notice copy uses model ids in sentences.** Resolved records carry selections, not labels, so every sentence ("using gpt-5 in 7s", "used gpt-5") uses the model id for consistency; option buttons and "Use {label} now" use the catalog labels. The countdown text is excluded from the live region (`aria-live="off"`), so the notice is announced once.
- **D-9 (2026-10-15) The v1 `create_thread` surface stays frozen; bridges extend it.** `OpencodeV2/Orchestration.implementation.test.ts` asserts that V2's frozen bootstrap specs equal the Codex dynamic-tool specs for the five shared operations, and files under `OpencodeV2/` must not change before Phase 5. So `CREATE_THREAD_TOOL_DESCRIPTION` keeps its v1 text, a new `CREATE_THREAD_WITH_MODEL_CHOICE_TOOL_DESCRIPTION` extends it, and `createCodexThreadOrchestrationDynamicTools` returns the v1 surface by default; the Codex adapter opts in with `{ delegatedModelChoice: true }` (model-choice `create_thread` plus `list_available_models`). MCP, Copilot and Pi always use the extended surface. Phase 5 adds ABI-2 against the extended surface.
- **D-10 (2026-10-15) Lenient `modelSelection` tool schema.** The JSON/TypeBox `modelSelection` property has no required keys and allows extra keys, so client-side schema validation can never reject a `create_thread` call because of the model choice (user rule 1); the server parses it and falls back. Bridges pass it through raw. The shared `CREATE_THREAD_TOOL_PARAMETERS` keeps the MCP bridge's `maxLength` limits on title and task, which the server already enforces.
- **D-11 (2026-10-15) Pre-approval and catalog wording.** Claude's `allowedTools` pre-approves the read-only `list_available_models` (like `list_threads`), while `create_thread` keeps its per-action approval. The capability catalog is not filtered per provider, so the `thread.create` guide says "where `create_thread` offers `modelSelection`" and the new `thread.models.list` track states it is not in OpenCode V2 yet. The Copilot thread tools moved to `copilotThreadOrchestrationTools.threads.ts` (plus shared `…results.ts`) before the new tool was added.

### Review fixes (2026-10-15)

Recorded after the coordinator review. Each fix has a test that failed first (see the ledger).

- **D-12 (2026-10-15, H1) The startup window keeps unresolved holds.** After a restart, the startup operational window loaded no activities for idle threads, so the dispatch-safety block could not see the hold and flushed the held prompt with the trunk's model. The window's activity CTE (`ProjectionOperationalStateQuery.sql.ts`) now also selects threads with an unresolved `delegation.model-choice-requested`, and the per-thread activity list (`…threadSql.ts`) unions every unresolved requested activity beyond the row limit, so the block holds whatever the window size.
- **D-13 (2026-10-15, M2) A retry after a failed fallback still sends the message.** `decideHold` treated any existing `choiceId` as a no-op. When the hold failed, the fallback recorded a resolution but its turn start also failed, so a retry's hold was a no-op and no first message was ever sent. The hold is now a no-op only when its requested activity exists (the hold ran and owns the queued message), the held message was sent, or the choice was cancelled. Otherwise it fails with an invariant error, so `startDelegatedFirstTurn` continues its existing fallback path. `thread.delegation.model-choice.hold` joins `historyRequired` (extends D-2).
- **D-14 (2026-10-15, L7) A pick made while blocked wins the flush.** `queuedPromptToTurnStartCommand` now takes the resolved selection for the held message (`resolvedHeldModelSelection` in `@bigbud/shared/delegatedModelChoice`) before the queued prompt's own `modelSelection`. A pick made while dispatch was still blocked therefore starts the turn on the picked model.
- **D-15 (2026-10-15, M4 and L6; supersedes D-5) The sweep has an age cutoff and a keyset cursor.** `listPendingDelegatedModelChoiceRequests` takes `since` (now − 7 days, `MODEL_CHOICE_SWEEP_MAX_AGE_MS`) and an `(createdAt, activityId)` cursor, and skips threads that are being deleted. The reactor pages until it gets a short page. Rows that keep failing (for example, on a deleting thread) can no longer fill every page and starve newer holds.
- **D-16 (2026-10-15, M5; narrows OD6) Mobile clients do not count as connected.** The mobile client has no picker, and its command allowlist lacks the pick command, so counting it only delayed the fallback by up to 10 s. `retainExternalConsumer` and the mobile route's acquire/release are removed. `hasOpenConsumer()` counts only supervised desktop and web delivery sessions (this also removes L8). Follow-up: mobile-web picker plus allowlist (§11).
- **D-17 (2026-10-15, L5) An empty `modelSelection` means no request.** `null`, `{}` or an object of only `undefined` fields is treated as absent at the single create entry point (`isAbsentModelSelection` in `ThreadOrchestrationTools.modelChoice.ts`, used by `createThreadViaOrchestration`). Every bridge (Codex, Copilot, engine dispatcher, HTTP for MCP and Pi) reaches that one call site, so all of them behave exactly as today: no hold, no picker and no stored decision.
- **D-18 (2026-10-15, L9) The Codex opt-in is guarded by a test.** The parameter stays optional, because the frozen V2 parity test calls the factory with no arguments. `Codex/Adapter.test.ts` now asserts that the session's dynamic tools include `list_available_models` and a `create_thread` schema with `modelSelection`.
- **D-19 (2026-10-15, L10) Agent-supplied text is sanitized for display.** The notice and trunk card strip C0/C1 control, newline and bidi characters from the requested, used and fallback model text, and fall back to "model" when nothing printable remains. Provider display names are looked up with `Object.hasOwn`, so inherited keys such as `constructor` show as typed.

### Review fixes, round 2 (2026-10-16)

- **D-20 (2026-10-16, re-review #1, performance) The unresolved-hold set is computed once.** The H1 startup predicate was a correlated `EXISTS` with a nested `NOT EXISTS` per activity row, searched through the `(thread_id, …)` index. That cost was quadratic per thread: 48.7 s on a synthetic database with 20k activities on one thread. One shared fragment, `unresolvedModelChoiceRequestsCtes` in `persistence/DelegatedModelChoiceSql.ts`, now defines "unresolved request". It materializes the resolved and unresolved sets once through the existing `(kind, created_at)` index and anti-joins them through SQLite's automatic covering index. The startup window, the per-thread window and the sweep all use it. No migration or new index is needed.
- **D-21 (2026-10-16, re-review #3; supersedes the L6 part of D-15) The sweep has no age cutoff.** The 7-day cutoff left an over-age hold pending forever, with its tributary dispatch-blocked. A hold must never stay pending. The cutoff existed only to bound the scan, and D-20 makes the unbounded scan cheap: O(requests + resolutions), with keyset pages. `since` and `MODEL_CHOICE_SWEEP_MAX_AGE_MS` are removed, so an over-age hold is returned and expired as `restart-sweep`.
- **D-22 (2026-10-16, re-review #2) The hold-failure fallback is one atomic decision.** A hold that commits but reports failure (an interrupt or a timeout) used to be followed by a separate resolved-activity append and `turn.start`. That left the held copy queued, and the lifecycle flush sent it again. The fallback now dispatches `thread.delegation.model-choice.expire` with `resolvedBy: "server"` and a new optional `fallbackStart` (contract: `DelegatedFirstPrompt` plus the requested payload). If the hold is pending, it resolves and flushes the held message like any expiry. Otherwise `deciderThreads.delegationModelChoice.fallback.ts` records the fallback and starts the message in the same decision, and it never starts a message id that is already sent or queued. A later-arriving hold is a no-op (D-13).
- **D-23 (2026-10-16, re-review #4) The settings migration keeps concurrent local writes.** After the server patch, each local key is re-read and only `hiddenComposerProviders` is removed. A key whose list gained a provider in the meantime is kept for the next start.
- **D-24 (2026-10-16, re-review #5; extends D-17) A request must name a provider.** `isAbsentModelSelection` treats any object without a non-empty string `provider` as absent. That covers `{ provider: null }`, `{ provider: "" }`, a whitespace-only provider and `{ model }` alone. Non-object values (a bare string, an array) are still requests and fall back as invalid.
