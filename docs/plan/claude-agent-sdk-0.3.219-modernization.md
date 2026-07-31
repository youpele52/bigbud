# Claude Agent SDK 0.3.219 modernization

## Status

- **Started:** 2026-07-25
- **Overall:** In progress
- **Current scope:** Complete the retained Milestones 6–8 work under `claude-agent-sdk-0.3.219-scoped-completion-plan.md`.
- **Task progression:** Task #5 completed; retained Tasks #6–#8 work remains in progress.
- **Checklist snapshot:** Milestones 6–8 are completed for retained scope. Across the original 37 Milestones 6–8 implementation items, 32 are completed and 5 are descoped. The 15-item scoped final release gate remains.
- **Authoritative completion scope:** `docs/plan/claude-agent-sdk-0.3.219-scoped-completion-plan.md`
- **Source audit:** `/Users/youpele/.claude/plans/check-the-current-claude-sharded-token.md`
- **Approved implementation plan:** `/Users/youpele/.claude/plans/whimsical-hopping-hare.md`

This is the durable implementation checklist. Check an item only after its focused tests and required quality gates pass. Preserve unrelated committed and uncommitted work throughout.

## Completion rules

- [ ] Preserve provider-neutral runtime contracts, task projection, work log, and `FloatingPlanCard` behavior.
- [ ] Keep non-test TypeScript files at or below 400 lines.
- [ ] Keep heavily edited tests near 400 lines and never above 500.
- [ ] Never run `bun test`; use `bun run test`.
- [ ] Record focused test commands and results below each milestone.
- [ ] Run `bun fmt`, `bun lint`, and `bun typecheck` before completing each milestone.
- [ ] Run `bun run test` and real-app verification before declaring the modernization complete.

---

## Milestone 0 — Establish the SDK 0.3.219 compatibility boundary

**Status:** Completed

### Implementation

- [x] Pin `@anthropic-ai/claude-agent-sdk` to exact `0.3.219` in `apps/server/package.json`.
- [x] Regenerate `bun.lock` for SDK 0.3.219.
- [x] Align the older SDK dependency in `scripts/package.json` to exact `0.3.219` (lockfile refresh still requires approved `bun install`).
- [x] Add a focused Claude SDK compatibility module using real SDK types.
- [x] Replace the ad hoc `ClaudeQueryRuntime` signatures with an SDK-derived supported Query surface.
- [x] Preserve typed interrupt receipts.
- [x] Add `reinitialize`, MCP status/control, and rewind methods needed by later milestones.
- [x] Extend `FakeClaudeQuery` with deterministic typed results/errors and call tracking.
- [x] Add safe decoders/guards for task, background-task, permission, result, retry/API status, refusal/fallback, fast-mode, command, and MCP message families.
- [x] Add redacted SDK 0.3.219 fixtures and typed fixture builders.
- [x] Add an opt-in real-SDK smoke test using a disposable fixture workspace.
- [x] Document deterministic fixture refresh and redaction.
- [x] Ensure unknown-message diagnostics use a safe discriminator and SDK version.

### Focused tests

- [x] SDK compatibility/decoder tests
- [x] Fake query conformance tests
- [x] Session startup tests
- [x] Guarded real-SDK smoke test

### Verification evidence

- Focused tests: `Adapter.sdk.test.ts`, `Adapter.sdk.fixtures.test.ts`, `Adapter.sdk.routing.test.ts`, `Adapter.approval.sdk.test.ts`, session/stream/lifecycle/thread/plan/remote bridge tests, and `Adapter.sdk.smoke.test.ts` — 50 passed, 1 smoke test skipped by default.
- `bun fmt`: passed.
- `bun lint`: passed with pre-existing task-map and test-length warnings.
- `bun typecheck`: passed; pre-existing Copilot Effect language-service recommendations remain.
- Lockfile is pinned to exact SDK 0.3.219; no additional install was required for this batch.

---

## Milestone 1 — Correct permission configuration and runtime modes

**Status:** Completed

- [x] Set `allowDangerouslySkipPermissions: true` only for full-access `bypassPermissions` sessions.
- [x] Ensure approval-required and auto-accept-edits never enable dangerous bypass.
- [x] Preserve turn-scoped plan mode and restore the configured base mode exactly once.
- [x] Test approval-required, auto-accept-edits, full-access, and plan transitions.
- [x] Test local/remote MCP approval behavior.
- [x] Test foreground/background Agent tool behavior, including native agent correlation.
- [x] Add bounded internal diagnostics for effective mode and bypass intent.

### Verification evidence

- Focused tests: `Adapter.session.permissions.test.ts`, `Adapter.approval.sdk.test.ts`, `Adapter.threadid.test.ts`, `Adapter.test.ts`, and remote bridge tests — included in the 50 passed, 1 guarded skip Batch 1 suite.
- Local and remote MCP approval tests preserve `requestId`, `toolUseID`, and `agentID`; foreground and background Agent callbacks prove both allow and deny permission behavior.
- `bun fmt`: passed.
- `bun lint`: passed with pre-existing task-map and test-length warnings.
- `bun typecheck`: passed; pre-existing Copilot Effect language-service recommendations remain.

---

## Milestone 2 — Reconcile Claude tasks authoritatively

**Status:** Completed

- [x] Split typed task decoding, state reconciliation, and event emission by concern.
- [x] Treat TaskCreate/TaskUpdate/TaskGet/tool results/`task_updated` as incremental inputs.
- [x] Treat `TaskList` as an authoritative task-list/foreground snapshot.
- [x] Treat `background_tasks_changed` as an authoritative live background-membership snapshot.
- [x] Keep legacy `TodoWrite` in an isolated compatibility namespace.
- [x] Track source membership, native dedup keys, observed order, snapshot generations, terminal state, and background state.
- [x] Reject duplicate/stale inputs and prevent terminal-to-active regressions.
- [x] Promote provisional IDs without duplicate rows.
- [x] Clear process-scoped background membership on a new SDK process/session.
- [x] Normalize native statuses into `pending`, `inProgress`, `completed`, `failed`, and `stopped`.
- [x] Emit only changed `task.updated` records.
- [x] Emit `turn.plan.updated` only when the ordered visible plan changes.
- [x] Keep modern remote task tools and make `TodoWrite` an explicit fallback.
- [x] Prove task tools never classify as file changes.

### Focused tests

- [x] TaskList stale-task removal
- [x] Background membership replacement/removal
- [x] Delayed snapshot versus newer patch
- [x] Terminal-state preservation
- [x] Provisional-to-durable promotion
- [x] Repeated snapshot idempotency
- [x] No duplicate task/plan events
- [x] Local and remote modern task trace through the shared plan card

### Verification evidence

- Focused tests: task reducer/plan tests, local/remote shared-plan trace, durable projection, snapshot, and migration tests — 22 passed; web shared-plan test — 9 passed
- `bun fmt`: passed
- `bun lint`: passed with existing test-file length warnings and two non-blocking allocation warnings
- `bun typecheck`: passed; pre-existing Copilot Effect language-service recommendations remain

---

## Milestone 3 — Harden durable task projection

**Status:** Completed

- [x] Give `OrchestrationThread.tasks` a decoding default of `[]`.
- [x] Preserve request, agent, parent-agent, parent-tool, parent-task, subagent, background, blocker, progress, tool, usage, terminal, source-tool, and turn metadata end to end.
- [x] Populate Claude correlation metadata from SDK task/tool/system events.
- [x] Map equivalent Codex metadata where available.
- [x] Merge omitted metadata on partial updates rather than clearing it.
- [x] Add a canonical freshness/order key to durable task updates.
- [x] Reject stale updates in live projection.
- [x] Apply the same freshness policy during persisted snapshot reconstruction.
- [x] Use stable task activity identity.
- [x] Add historical snapshot compatibility, schema round-trip, ingestion, replay, projector, and snapshot tests.

### Verification evidence

- Focused tests: `projector.tasks.test.ts`, `ProjectionPipeline.projector.tasks.test.ts`, `ProjectionSnapshotQuery.snapshot.test.ts`, `ProjectionThreadTasks.test.ts`, `046_ProjectionThreadTasks.test.ts`, ingestion/task reducer/plan tests — 22 passed; Codex task metadata tests — 8 passed; web shared-plan test — 9 passed
- `bun fmt`: passed
- `bun lint`: passed with existing test-file length warnings and two non-blocking allocation warnings
- `bun typecheck`: passed; pre-existing Copilot Effect language-service recommendations remain

---

## Milestone 4 — Bound hook, progress, summary, and subagent telemetry

**Status:** Completed

- [x] Define explicit per-turn/per-hook/per-task/per-tool activity budgets.
- [x] Bound hook output, stdout, stderr, summaries, and structured detail.
- [x] Add a single aggregate suppression diagnostic for repetitive updates.
- [x] Use stable logical identities for hook, task, tool-progress, and tool-summary activities.
- [x] Never suppress approval, user input, failure, or terminal events.
- [x] Preserve safe provider-neutral tool and MCP display metadata.
- [x] Add a disabled-by-default Claude rollout flag for forwarded subagent text.
- [x] Project forwarded text as bounded nested task/subagent activity.
- [x] Add high-volume ordering, truncation, row-count, terminal-event, and duplicate-ID tests.

### Verification evidence

- Focused tests: activity governor, tooling redaction, task activity, and forwarded-subagent adapter coverage — 21 passed; the governor now verifies turn/category/logical-identity byte ceilings in addition to row/update limits; `packages/shared` display-value tests — 3 passed; rollout settings tests — 15 passed
- `bun fmt`: passed
- `bun lint`: passed with existing test-file length warnings and two non-blocking allocation warnings
- `bun typecheck`: passed; pre-existing Copilot Effect language-service recommendations remain

---

## Milestone 5 — Make approvals, user input, and recovery exactly-once

**Status:** Completed

- [x] Add a bounded request ledger for approval/user-input replay and retain legacy maps as compatibility mirrors during migration.
- [x] Store pending/resolved result, timestamps, native request/agent/tool IDs, and session-permission application state in the bounded session ledger.
- [x] Return the stored SDK result for replayed resolved callbacks.
- [x] Make repeated identical UI responses idempotent.
- [x] Return typed conflicts for contradictory second decisions.
- [x] Apply `acceptForSession` updates exactly once.
- [x] Emit request lifecycle activities once per state transition.
- [x] Add a single-flight `Query.reinitialize()` recovery path.
- [x] Rehydrate in-memory request ledgers before processing redelivered callbacks.
- [x] Deduplicate native messages across recovery; request/task identities remain bounded by their existing ledgers and projections.
- [x] Fall back to persisted resume-restart only when appropriate.
- [x] Add callback replay, browser retry/conflict, reinitialize, failure, and interrupt tests.

### Verification evidence

- Focused tests: `Adapter.threadid.test.ts`, `Adapter.plan.test.ts`, `Adapter.session.test.ts`, `Adapter.approval.sdk.test.ts`, `Adapter.approval.lifecycle.test.ts`, `Adapter.requestLedger.test.ts`, `Adapter.recovery.dedup.test.ts`, and `Adapter.recovery.test.ts` — passed, including native approval replay, exactly-once session-permission application, stored user-input replay, bounded ledger rehydration, native-message recovery deduplication, and stop-time cancellation coverage
- `bun fmt`: passed
- `bun lint`: passed with existing test-file length warnings and one non-blocking allocation warning
- `bun typecheck`: Claude sources passed; the server package still reports pre-existing discovery/provider-registry/thread-tools fixture interface errors and Copilot Effect recommendations

---

## Milestone 6 — Complete core provider-neutral MCP lifecycle and elicitation

**Status:** Completed

**Scoped boundary:** This milestone covers canonical MCP status/readiness, required-bridge protection, elicitation, and SDK-owned internal typed operations. It does not include an end-user MCP management product.

- [x] Define canonical MCP statuses: pending, connected, needs-auth, failed, disabled.
- [x] Define bounded server metadata and provider-neutral typed refresh/reconnect/toggle/replace operations for adapter-internal SDK ownership.
- [x] Extend provider adapter/service capabilities with typed unsupported outcomes.
- [x] Normalize `system.init.mcp_servers` and `Query.mcpServerStatus()` into the same replaceable state.
- [x] Poll after initialization, reinitialize, and explicit MCP actions with bounded backoff.
- [x] Implement `onElicitation` through the provider-neutral user-input ledger.
- [x] Redact URLs, tokens, and submitted values from activities and telemetry.
- [x] Cancel elicitation on timeout, interrupt, or session stop.
- [x] Keep bigbud orchestration MCP mandatory and non-toggleable.
- [x] Decide and test `alwaysLoad` policy for required bridges; keep optional/user servers nonblocking by default.
- [x] Implement SDK-managed reconnect/toggle/dynamic replacement within SDK ownership limits for internal typed operations.
- [x] Add missing contract, adapter, service, ingestion, elicitation, and required-bridge protection tests.

### Descoped by the scoped completion plan

- **Descoped:** End-user MCP toggle, reconnect, replace, and management UI.
- **Descoped:** Public RPC/UI commands whose only purpose is end-user MCP management.
- **Descoped:** A new durable end-user MCP management projection; any such product requires a separate future plan.

### Verification evidence

- Completion follow-up: timeout, interrupt, stop, and recovery-loss elicitation cancellation; contract decoding; ingestion redaction; and required bridge lifecycle tests — 17 server tests and 8 contract tests passed.
- `bun fmt`, `bun lint`, and `bun typecheck`: passed; only existing non-blocking warnings and Copilot Effect recommendations remain.
- Scoped MCP lifecycle follow-up: canonical init/poll snapshot replacement, required-only bounded polling, startup failure cleanup, optional-server nonblocking behavior, recovery/explicit refresh, required-control protection, duplicate elicitation replay, and redacted resolution — 27 focused tests passed.
- No public MCP management RPC, HTTP route, web client, or UI control exists; SDK-owned controls remain adapter-internal.
- Focused tests: `providerMcp.test.ts` (required/optional readiness), Claude session/elicitation/interrupt tests, SDK control tests — passed.
- `bun fmt`: passed.
- `bun lint`: passed with existing warnings.
- Server typecheck: Claude sources pass; existing Copilot Effect language-service recommendations remain.
- Full gate: `bun run test` — 324 server test files passed, 1,280 tests passed, 2 guarded tests skipped; all 9 Turbo tasks succeeded.

---

## Milestone 7 — Reconcile interrupts, deduplication, recovery, and safe resume

**Status:** Completed for retained scope

- [x] Track native UUIDs and queue state for bigbud-originated user messages.
- [x] Consume typed interrupt receipts and reconcile queued/cancelled IDs.
- [x] Support deterministic no-receipt fallback behavior.
- [x] Maintain bounded native message/task/request dedup state across recovery.
- [x] Validate `resumeSessionAt` against a known compatible assistant boundary/checkpoint.
- **Descoped:** Preflight and execute coordinated Claude transcript/file rewind.
- **Descoped:** Resolve an SDK user-message UUID and durable checkpoint for rewind mutation.
- **Descoped:** Run SDK file-rewind dry-run as part of a rewind implementation.
- **Descoped:** Coordinate SDK rewind, provider transcript/task state, checkpoint state, and session restart/resume.
- [x] Return a typed unsupported outcome before any filesystem mutation when coordinated Claude rewind is unavailable.
- [x] Prevent the checkpoint reactor from restoring Claude files while transcript rewind is unsupported.
- **Descoped:** Add a provider-neutral native fork action or destination thread/workspace implementation.
- [x] Document safe resume plus the unsupported rewind/fork, local/remote, checkpoint, model/provider, and recovery boundaries.
- [x] Add interrupt, deduplication, resume, unsupported rewind/fork no-mutation, remote-boundary, and idempotency tests.

### Verification evidence

- Scoped completion follow-up: bounded prompt/native/task identities, task epoch advancement, actual reinitialize replay suppression, malformed persisted resume-boundary rejection, pending-request turn guard, and unsupported Claude checkpoint revert before provider/filesystem mutation — 43 focused tests passed.
- `bun fmt`, `bun lint`, and `bun typecheck`: passed; only existing warnings and Copilot Effect recommendations remain.
- Focused tests: `Adapter.resume.test.ts`, `Adapter.interrupt.test.ts`, Claude session UUID and recovery-dedup tests — 23 passed in the remaining-milestone suite.
- `bun fmt`: passed.
- `bun lint`: passed with existing warnings.
- Server typecheck: Claude sources pass; existing Copilot Effect language-service recommendations remain.
- Full gate: `bun run test` — 324 server test files passed, 1,280 tests passed, 2 guarded tests skipped; all 9 Turbo tasks succeeded.

---

## Milestone 8 — Refresh models, normalize status and metrics, and retain reversible rollout

**Status:** Completed for retained scope

- [x] Refresh the fallback Claude model catalog and aliases.
- [x] Keep live `initializationResult().models` discovery authoritative.
- [x] Distinguish successful empty discovery from unavailable discovery.
- [x] Merge custom and live models without duplicates.
- [x] Record bounded internal discovery source/version/timing.
- [x] Normalize canonical model/provider usage, fallback/reroute, refusal/API status, command lifecycle, and fast-mode-disabled reason.
- [x] Add reversible rollout settings for optional task, hook/progress, forwarded text, MCP, rewind, and fork behavior; existing rewind/fork fields remain default-off compatibility fields and do not establish runtime support.
- [x] Keep compatibility, permission, and replay correctness fixes ungated.
- [x] Add privacy-safe metrics for retained modernization subsystems: initialization, unknown messages, task reconciliation/deduplication, activity suppression, approval replay/conflicts, interrupts, reinitialize, and core MCP lifecycle.
- [x] Verify telemetry never contains prompts, tool data, paths, URLs/tokens, task text, answers, or raw SDK payloads.
- [x] Use existing reversible settings and focused verification for retained optional task, bounded progress, forwarded-text, and MCP behavior; do not add a new staged canary framework.

### Descoped scope clauses

- **Descoped:** Rewind/fork feature metrics and preview rollout stages.
- **Descoped:** A new staged canary framework beyond existing reversible settings and focused verification.

### Verification evidence

- Scoped completion follow-up: validated four-state SDK discovery, alias/capability parity, deterministic fallback/custom deduplication, canonical cached-token accounting, explicit usage availability, bounded status diagnostics, real reversible task/progress/MCP settings, retained-only metrics, and sensitive-dimension rejection — 56 server tests and 24 contract tests passed.
- `bun fmt`, `bun lint`, and `bun typecheck`: passed; only existing warnings and Copilot Effect recommendations remain.
- Focused tests: `Provider.capabilities.test.ts` (discovery state/source/timing), modernization metrics tests — passed in the remaining-milestone suite.
- `bun fmt`: passed.
- `bun lint`: passed with existing warnings.
- Server typecheck: Claude sources pass; existing Copilot Effect language-service recommendations remain.
- Full gate: `bun run test` — 324 server test files passed, 1,280 tests passed, 2 guarded tests skipped; all 9 Turbo tasks succeeded.

---

## Scoped final release gate

- [ ] Local modern Claude task card updates live and removes stale tasks.
- [ ] Remote modern Claude task card behaves identically.
- [ ] Legacy/resumed TodoWrite remains compatible.
- [ ] Permission mode matrix and callback replay are correct.
- [ ] Background subagent hierarchy/progress/interrupt leaves no orphan task and stays within budgets.
- [ ] MCP required/optional readiness and elicitation work without secret leakage.
- [ ] Interrupt/reinitialize/resume produce no duplicate assistant text, tasks, approvals, inputs, or prompts.
- [ ] Claude advertises conversation rewind as unsupported, and checkpoint revert fails before filesystem mutation.
- [ ] Native fork remains unavailable and creates no partial destination conversation or workspace.
- [ ] Codex, OpenCode, Copilot, and Pi shared plan/task/work-log behavior remains unchanged.
- [ ] Run and visually verify bigbud Tasks card, work log, approvals, subagent presentation, MCP state, and session transitions.
- [ ] `bun fmt`
- [ ] `bun lint`
- [ ] `bun typecheck`
- [ ] `bun run test`
