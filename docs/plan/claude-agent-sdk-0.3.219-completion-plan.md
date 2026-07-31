# Complete Claude Agent SDK 0.3.219 Modernization

> **Historical plan — superseded for execution on 2026-07-26.**
> Use `docs/plan/claude-agent-sdk-0.3.219-scoped-completion-plan.md` for current completion scope. This document preserves the execution proposal and completed evidence that existed before the scope decision; unchecked items below must not be treated as current requirements or as implemented work.

## Historical progress at supersession

- **Started:** 2026-07-25
- **Overall:** Superseded for execution; not completed
- **Last recorded batch:** Batch 4 — Complete Milestone 5 with a durable exactly-once request ledger
- **Last recorded task progression:** Task #5 completed; Task #6 was in progress.
- **Scoped successor:** `docs/plan/claude-agent-sdk-0.3.219-scoped-completion-plan.md`
- **Durable implementation history:** `docs/plan/claude-agent-sdk-0.3.219-modernization.md`

The following table is the last historical snapshot from this plan, not current execution status:

| Batch                                     | Status    |
| ----------------------------------------- | --------- |
| 0 — Safe structure and shared foundations | Completed |
| 1 — SDK compatibility and permissions     | Completed |
| 2 — Authoritative durable task model      | Completed |
| 3 — Bounded telemetry                     | Completed |
| 4 — Exactly-once request ledger           | Pending   |
| 5 — MCP lifecycle and elicitation         | Pending   |
| 6 — Interrupt, resume, rewind, and fork   | Pending   |
| 7 — Models, rollout, and release gate     | Pending   |

Do not update or execute the remaining batches from this historical plan. Record current retained, completed, and descoped work in the durable checklist and scoped successor. Preserve the completed evidence below as historical evidence.

## Context

When this execution plan began, the modernization checklist in `docs/plan/claude-agent-sdk-0.3.219-modernization.md` had substantial partial implementation, but none of Milestones 0–8 was fully complete.

This plan originally proposed preserving the then-current working tree and provider-neutral behavior for Codex, OpenCode, Pi, shared task projection, work log, and `FloatingPlanCard`. The scoped successor now defines completion; this paragraph does not require implementation of the superseded MCP-management, rewind, fork, migration, UI, or rollout proposals below.

Safe defaults:

- Optional/high-volume features are independently rollout-gated; correctness and security fixes are never gated.
- Forwarded subagent text, MCP mutation controls, SDK file rewind, and native fork begin disabled by default.
- Required bigbud/remote workspace bridges are protected and non-toggleable; optional MCP servers are nonblocking.
- Rewind is supported only for eligible local sessions with SDK file checkpointing and a matching durable checkpoint; unsupported remote/legacy sessions fail before mutation.
- Native fork defaults to an explicitly labeled conversation-only fork sharing the workspace; isolated worktree creation is a separate explicit choice when available, and remote limitations are surfaced.
- New observability uses low-cardinality internal metrics and strictly allowlisted anonymous analytics fields, with no prompts, task text, answers, paths, URLs, tokens, raw SDK payloads, or native identifiers.

## Execution strategy

Work in dependency-ordered batches. Preserve unrelated edits, avoid blanket snapshot regeneration, and do not check off an item until its focused tests and milestone quality gates pass.

### Batch 0 — Establish safe structure and shared foundations — Completed

- [x] Split oversized Claude session, turn, runtime ingestion, activity mapping, payload schema, and lifecycle test files by concern using dot-notation modules.
- [x] Add provider-neutral task freshness/order comparison, task patch merge semantics, and bounded/redacted display-value helpers in `packages/shared/src/providerRuntime.ts`.
- [x] Add conservative Claude rollout settings and settings patch fields for modern tasks, bounded progress/hooks, forwarded subagent text, MCP controls, file checkpoint/rewind, and native fork.
- [x] Keep all scoped production modules <=400 lines and edited lifecycle tests <=400 lines.
- [x] Run focused tests and required quality gates.

#### Batch 0 verification evidence

- `bun run --cwd packages/shared vitest run src/providerRuntime.test.ts` — 3 passed.
- `bun run --cwd packages/contracts vitest run src/core/settings.test.ts src/orchestration/providerRuntime.test.ts` — 22 passed.
- `bun run --cwd apps/server vitest run src/ws/serverSettings.test.ts src/provider/Layers/Claude/Adapter.lifecycle.test.ts src/provider/Layers/Claude/Adapter.lifecycle.result.test.ts src/orchestration/Layers/ProviderRuntimeIngestion.activities.tasks.test.ts` — 15 passed.
- `bun fmt` — passed.
- `bun lint` — passed with pre-existing non-blocking warnings.
- `bun typecheck` — passed with pre-existing non-blocking Effect recommendations.

### Batch 1 — Finish Milestones 0 and 1 — Completed

- [x] Expand the SDK compatibility layer into narrow typed decoders for task/system/tool, hook, permission, result/API/retry, refusal/fallback, fast mode, command, MCP, elicitation, session, and native UUID message families.
- [x] Route handlers through normalized decoder output and keep unknown/invalid diagnostics bounded and payload-free.
- [x] Expand deterministic redacted fixtures and typed builders; strengthen `FakeClaudeQuery` conformance and control coverage.
- [x] Preserve and verify the guarded opt-in real SDK smoke test and fixture-redaction procedure.
- [x] Track effective permission mode and make plan-mode restoration transition-based and exactly once.
- [x] Add realistic local/remote MCP and foreground/background Agent callback tests with native correlation.
- [x] Run focused tests, `bun fmt`, `bun lint`, and `bun typecheck`; update Milestones 0 and 1 evidence/checkmarks.

#### Batch 1 progress evidence

- Effective permission transitions are tracked in `Adapter.types.ts`, initialized in `Adapter.session.ts`, and applied only when changed in `Adapter.ts`.
- Unknown-message warning details in `Adapter.stream.handlers.ts` and `Adapter.stream.system.ts` now retain only the SDK version and safe discriminator rather than raw SDK objects.
- `bun run --cwd apps/server vitest run src/provider/Layers/Claude/Adapter.session.permissions.test.ts src/provider/Layers/Claude/Adapter.sdk.test.ts src/provider/Layers/Claude/Adapter.sdk.fixtures.test.ts` — 16 passed.
- `bun run --cwd apps/server vitest run src/provider/Layers/Claude/Adapter.sdk.smoke.test.ts src/provider/Layers/Claude/ClaudeRemoteWorkspaceBridge.test.ts src/provider/Layers/Claude/Adapter.session.permissions.test.ts` — 11 passed, 1 guarded smoke test skipped as intended.
- Intermediate verification: `bun fmt`, `bun lint`, and `bun typecheck` passed while decoder/fixture/control/correlation coverage was still being completed.
- Partial follow-up: normalized decoders now cover task lifecycle/background, hooks, result/API retry/fast-mode fields, refusal fallback/no-fallback, command updates, MCP initialization/elicitation completion, permission callback correlation, and structured user tool-result presence. Synthetic redacted fixtures cover these consumed families, and callback lifecycle references now retain SDK request and agent IDs when available.
- Focused follow-up verification: `bun run --cwd apps/server vitest run src/provider/Layers/Claude/Adapter.sdk.test.ts src/provider/Layers/Claude/Adapter.sdk.fixtures.test.ts src/provider/Layers/Claude/Adapter.session.permissions.test.ts src/provider/Layers/Claude/Adapter.threadid.test.ts src/provider/Layers/Claude/Adapter.test.ts src/provider/Layers/Claude/ClaudeRemoteWorkspaceBridge.test.ts src/provider/Layers/Claude/Adapter.sdk.smoke.test.ts` — 31 passed, 1 guarded smoke test skipped.
- Completion verification: `bun run --cwd apps/server vitest run src/provider/Layers/Claude/Adapter.sdk.fixtures.test.ts src/provider/Layers/Claude/Adapter.sdk.routing.test.ts src/provider/Layers/Claude/Adapter.sdk.test.ts src/provider/Layers/Claude/Adapter.approval.sdk.test.ts src/provider/Layers/Claude/Adapter.session.permissions.test.ts src/provider/Layers/Claude/Adapter.stream.test.ts src/provider/Layers/Claude/Adapter.plan.test.ts src/provider/Layers/Claude/Adapter.lifecycle.result.test.ts src/provider/Layers/Claude/Adapter.text.test.ts src/provider/Layers/Claude/Adapter.session.test.ts src/provider/Layers/Claude/Adapter.threadid.test.ts src/provider/Layers/Claude/ClaudeRemoteWorkspaceBridge.test.ts src/provider/Layers/Claude/Adapter.sdk.smoke.test.ts` — 50 passed, 1 guarded smoke test skipped.
- Completion verification: `bun fmt` — passed; `bun lint` — passed with pre-existing task-map and test-length warnings; `bun typecheck` — passed with pre-existing Copilot Effect recommendations.
- The Batch 1 SDK boundary now emits only allowlisted diagnostic raw envelopes, normalized projections for every Batch 1 decoder family, typed deterministic fixtures, and correlated local/remote MCP plus foreground/background Agent approval coverage.

Critical files include `Adapter.sdk.ts`, `Adapter.sdk.messages.ts`, `Adapter.stream.handlers*.ts`, `Adapter.stream.system.ts`, `Adapter.session*.ts`, `Adapter.approval.ts`, fixture JSON/builders, and focused SDK/session tests.

### Batch 2 — Complete Milestones 2 and 3 with one authoritative durable task model — Completed

- [x] Define source semantics: modern task inputs are patches; TaskList/background snapshots replace only their own membership; TodoWrite remains isolated compatibility state.
- [x] Replace local timestamp ordering with canonical freshness and correct membership, terminal-state, structured-result, provisional-promotion, removal, and empty-plan behavior.
- [x] Extend provider-neutral task contracts with additive freshness/source and removal/replacement semantics.
- [x] Reuse the same merge/comparator in reducer, ingestion, live projector, durable projection, and snapshot reconstruction.
- [x] Add a registered durable task projection migration/repository and guarded historical backfill.
- [x] Add local and remote modern Claude traces through the shared provider-neutral plan card.
- [x] Cover reducer, schema, ingestion, migration, replay, projector, snapshot, stale-order, and live/cold convergence tests.
- [x] Run focused tests, `bun fmt`, `bun lint`, and `bun typecheck`; update Milestones 2 and 3.

#### Batch 2 verification evidence

- `bun run --cwd apps/server vitest run src/orchestration/Layers/ProviderRuntimeIngestion.activities.tasks.test.ts src/provider/Layers/Claude/Adapter.tasks.test.ts src/provider/Layers/Claude/Adapter.stream.plan.modern.test.ts src/orchestration/projector.tasks.test.ts src/orchestration/Layers/ProjectionPipeline.projector.tasks.test.ts src/orchestration/Layers/ProjectionSnapshotQuery.snapshot.test.ts src/persistence/Layers/ProjectionThreadTasks.test.ts src/persistence/Migrations/046_ProjectionThreadTasks.test.ts` — 22 passed.
- `bun run --cwd apps/web vitest run src/logic/session/session.logic.plan.test.ts` — 9 passed.
- `bun run --cwd apps/server vitest run src/provider/Layers/Codex/Adapter.task.test.ts src/orchestration/Layers/ProviderRuntimeIngestion.activities.tasks.test.ts src/orchestration/projector.tasks.test.ts src/orchestration/Layers/ProjectionPipeline.projector.tasks.test.ts` — 8 passed.
- `bun fmt`, `bun lint`, and `bun typecheck` — passed, with the documented non-blocking warnings.

Critical files include `Adapter.tasks.*`, task contracts/events, `ProviderRuntimeIngestion.processor.events.ts`, `projectorTasks.ts`, `ProjectionSnapshotQueryAssembly.snapshot.ts`, persistence migrations/repositories, and task/plan browser tests.

### Batch 3 — Complete Milestone 4 with bounded telemetry — Completed

- [x] Add an ingestion-time activity governor with explicit per-turn/category/logical-identity row, update, depth, and byte budgets.
- [x] Coalesce only repetitive nonterminal progress; never suppress approvals, input/elicitation, failures, errors, or terminal states.
- [x] Emit one stable aggregate suppression activity per turn/category.
- [x] Sanitize all persisted/work-log display data and retain only allowlisted provider-neutral metadata.
- [x] Use deterministic hook/task/tool-progress/tool-summary/suppression identities.
- [x] Keep forwarded subagent text default-off and project it as bounded nested task/subagent activity when enabled.
- [x] Add high-volume ordering, ceiling, truncation/redaction, duplicate, terminal, replay, and browser tests.
- [x] Run focused tests, `bun fmt`, `bun lint`, and `bun typecheck`; update Milestone 4.

#### Batch 3 verification evidence

- Focused server tests for governor, tooling redaction, task activity, and forwarded subagent projection — 21 passed; governor coverage includes independent turn/category/logical-identity byte ceilings and terminal-event preservation.
- Shared bounded-display tests — 3 passed; Claude rollout settings tests — 15 passed.
- `bun fmt`, `bun lint`, and `bun typecheck` — passed with existing non-blocking warnings.

### Batch 4 — Complete Milestone 5 with a durable exactly-once request ledger — Pending

- [ ] Replace separate approval/user-input maps with one bounded ledger covering approval, structured input, and MCP elicitation.
- [ ] Generalize pending-approval persistence through a registered migration while excluding prompts, answers, URLs, tokens, and raw payloads.
- [x] Make callback and UI response replay idempotent, contradictory decisions typed conflicts, permission updates exactly once, and lifecycle events transition-based.
- [x] Cancel pending approval and structured user-input requests symmetrically on stop and interrupt; MCP elicitation remains a later milestone.
- [x] Rehydrate safe in-memory request/dedup state before single-flight `Query.reinitialize()` stream recovery and use persisted resume cursors for restart fallback.
- [x] Add callback/UI replay, conflict, permission, cancellation, reinitialize, fallback-routing, and duplicate-delivery tests.
- [ ] Run the full Batch 4 persistence gate and update Milestone 5.

### Batch 5 — Complete Milestone 6 with provider-neutral MCP lifecycle and elicitation — Pending

> **Superseded scope:** The scoped successor retains core MCP readiness/status reconciliation, required-bridge protection, elicitation, redaction, and internal typed SDK operations. It descopes the proposed durable end-user management projection, public commands/RPC, and management UI. The unchecked items below are historical proposals, not implementation evidence.

- [ ] Add a durable replaceable MCP snapshot with bounded status/display, ownership, required/toggleable metadata, and supported actions.
- [ ] Add provider-neutral refresh/reconnect/toggle/dynamic-replace commands, capabilities, service routing, typed outcomes, projection, RPC, and UI.
- [ ] Reconcile SDK initialization and `mcpServerStatus()` through one reducer and bounded polling/backoff flow.
- [ ] Protect required bigbud/remote bridges and keep optional servers nonblocking.
- [ ] Respect SDK ownership limits for reconnect/toggle/dynamic replacement.
- [ ] Route `onElicitation` through the request ledger without persisting URLs, submitted values, or tokens; cancel on timeout/interrupt/stop/recovery loss.
- [ ] Add a registered durable MCP projection migration and snapshot support.
- [ ] Add contract, service, adapter, redaction, polling, elicitation, migration, and browser tests.
- [ ] Run focused tests, `bun fmt`, `bun lint`, and `bun typecheck`; update Milestone 6.

### Batch 6 — Complete Milestone 7: interrupt, resume, rewind, and fork — Pending

> **Superseded scope:** The scoped successor retains interrupt reconciliation, bounded deduplication, recovery, and safe resume. Coordinated transcript/file rewind and native conversation fork are descoped. Current release behavior requires rewind to be unsupported before filesystem mutation and native fork to remain unavailable. The unchecked items below must not be marked completed.

- [ ] Stamp bigbud-originated SDK user messages with native UUIDs and maintain bounded safe queue/dedup state.
- [ ] Reconcile typed interrupt receipts and deterministic legacy no-receipt behavior without dropping or duplicating prompts.
- [ ] Validate resume cursors against durable compatible assistant boundaries and checkpoint lineage.
- [ ] Add typed rewind preflight/execution outcomes; require idle/no pending requests, eligible local workspace, enabled checkpointing, known SDK UUID, matching checkpoint, and successful SDK dry-run before mutation.
- [ ] Refactor checkpoint revert ordering so Claude files are never restored before transcript rewind safety is known.
- [ ] Coordinate SDK rewind, checkpoint/files, transcript/tasks/read model, and restart/resume; report unsupported/partial/failure honestly.
- [ ] Add explicit provider-neutral native fork with distinct destination thread/session and explicit shared-workspace versus worktree semantics.
- [ ] Document portability/constraints and add interrupt, dedup, resume, rewind, fork, remote, idempotency, and browser tests.
- [ ] Run focused tests, `bun fmt`, `bun lint`, and `bun typecheck`; update Milestone 7.

### Batch 7 — Complete Milestone 8 and the release gate — Pending

> **Superseded scope:** The scoped successor retains model discovery, normalized status/usage, privacy-safe metrics, existing reversible settings, regression coverage, and the scoped release gate. Rewind/fork metrics and preview rollout, plus a new staged canary framework, are descoped.

- [ ] Refresh the minimal fallback model catalog and aliases.
- [ ] Add typed live/live-empty/unavailable/invalid discovery with authoritative valid live results and deterministic custom/live deduplication.
- [ ] Normalize model usage, fallback/reroute/refusal/API/retry, command lifecycle, and fast-mode-disabled state.
- [ ] Add privacy-safe low-cardinality metrics and analytics allowlist tests for every modernization subsystem.
- [ ] Document and execute staged rollout from fixtures/task canary through bounded progress/MCP and high-risk rewind/fork.
- [ ] Add cross-provider regression tests and complete browser/visual scenarios.
- [ ] Run the full release gate and update every remaining checklist item.

Critical files include `Provider.capabilities.ts`, `Provider.ts`, observability/analytics modules, settings UI/server settings, runtime status handlers, documentation, and browser tests/screenshots.

## Migration and compatibility rules

- Add migrations sequentially after the current highest migration and register each in `apps/server/src/persistence/Migrations.ts` and `migrationEntries`.
- Expected migration groups: durable task projection/backfill, generalized safe request ledger, and durable MCP snapshot.
- Test fresh install, upgrade, malformed legacy JSON, and safe/idempotent backfill behavior.
- Keep contract changes additive with decoding defaults. Historical snapshots without tasks/MCP/request state remain readable.
- Use old activity-derived task reconstruction only as a compatibility fallback until the durable task table is proven; new writes use the durable projection.
- Never migrate or persist secrets, submitted answers, auth URLs, tokens, prompts, task text in telemetry, or raw SDK payloads.
- Preserve the provider-neutral plan/work-log/UI path and explicitly regression-test Codex, OpenCode, and Pi.

## Verification protocol

For every batch:

1. Run focused server/web tests for the changed behavior.
2. Record current commands/results under the corresponding milestone in `docs/plan/claude-agent-sdk-0.3.219-modernization.md` and follow the scoped successor; do not update this historical plan as the active execution record.
3. Run `bun fmt`, `bun lint`, and `bun typecheck` before marking the batch complete.
4. Keep all non-test TypeScript files <=400 lines; heavily edited tests target <=400 and never exceed 500.
5. Never run `bun test`; use `bun run test`.

The following was this plan's original post-milestone verification proposal. Current completion is governed by the scoped successor:

1. Run `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test`.
2. Run the guarded authenticated smoke test with `BIGBUD_CLAUDE_SDK_SMOKE=1` in its disposable workspace.
3. Launch the real app and visually verify all final-release-gate flows, including local and remote Claude behavior and cross-provider regressions.
4. Fix known stale `tasks: []` snapshot expectations deliberately after the durable task model is correct; never blanket-refresh snapshots.
5. Do not declare completion until every milestone item, completion rule, and final release-gate item is checked with recorded evidence. If authentication or environment access blocks the guarded smoke or real-app validation, report it rather than marking those items complete.
