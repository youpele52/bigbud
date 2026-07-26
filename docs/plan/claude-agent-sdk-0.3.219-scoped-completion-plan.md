# Complete Claude Agent SDK 0.3.219 Modernization — Scoped Plan

## Status

- **Created:** 2026-07-26
- **Overall:** In progress
- **Supersedes for execution:** `claude-agent-sdk-0.3.219-completion-plan.md`
- **Durable implementation history:** `claude-agent-sdk-0.3.219-modernization.md`
- **Current focus:** Batch 5 — run the scoped release gate and record external validation blockers honestly.

The original modernization checklist remains the implementation history. This plan is the authoritative completion scope. When an original item is no longer required, mark it **Descoped** in the durable checklist with a reference to this plan instead of leaving it indefinitely pending or claiming it was implemented.

## Outcome

Complete the Claude Agent SDK 0.3.219 modernization with:

- reliable SDK compatibility and permission behavior;
- authoritative task projection and bounded activity telemetry;
- exactly-once approval, user-input, and recovery behavior;
- safe provider-neutral MCP status and elicitation support;
- correct interrupt, deduplication, recovery, and resume behavior;
- authoritative model discovery and normalized provider status;
- privacy-safe diagnostics and regression coverage.

Completion does **not** require shipping coordinated transcript/file rewind, native conversation fork, or an end-user MCP server-management product.

## Scope decisions

### Retained

- MCP initialization/status reconciliation and bounded polling.
- Required bigbud MCP bridge protection and readiness.
- Optional MCP servers remaining nonblocking.
- MCP elicitation through the existing user-input lifecycle.
- Internal typed MCP refresh/control operations already supported by the SDK.
- Interrupt receipt reconciliation and deterministic no-receipt behavior.
- Bounded message, task, and request deduplication across recovery.
- Safe `Query.reinitialize()` and persisted resume-restart fallback.
- Validation of known compatible resume boundaries.
- Claude model fallback catalog, live discovery, empty/unavailable distinction, and custom/live deduplication.
- Normalized Claude usage/status events where the SDK provides reliable values.
- Explicitly unavailable usage where reliable values do not exist.
- Privacy-safe low-cardinality diagnostics and metrics.
- Cross-provider task, plan-card, work-log, and session regression coverage.

### Descoped

- End-user MCP toggle, reconnect, replace, and management UI.
- Public RPC/UI commands whose only purpose is end-user MCP management.
- Coordinated Claude transcript-and-file rewind.
- SDK rewind dry-run, checkpoint lineage mutation, and rewind restart orchestration.
- Native Claude conversation fork.
- Fork destination workspace/worktree creation and isolation semantics.
- Rewind/fork preview rollout stages and feature metrics.
- A staged canary framework beyond the existing reversible settings and focused verification.

### Required unsupported behavior

Descoped does not mean silent or unsafe:

- Claude must advertise rewind as unsupported until transcript and files can be coordinated atomically.
- A Claude checkpoint revert must fail before filesystem mutation when transcript rewind is unsupported.
- Native fork must remain unavailable unless a later plan defines destination conversation and workspace semantics.
- Existing decoding-compatible rollout fields may remain default-off; they must not imply working UI or runtime support.
- Documentation and tests must describe these boundaries explicitly.

## Completion rules

- Preserve provider-neutral runtime contracts and shared task, plan-card, and work-log behavior.
- Keep all changed non-test TypeScript files at or below 400 lines.
- Keep new or heavily edited test files at or below 400 lines and never above 500.
- Reuse existing request-ledger, MCP normalization, runtime-ingestion, discovery, metrics, and checkpoint patterns.
- Do not add a new library or a parallel state model.
- Do not persist prompts, answers, task text, tool payloads, paths, URLs, tokens, or raw SDK messages in telemetry.
- Never run `bun test`; use `bun run test`.
- Run `bun fmt`, `bun lint`, and `bun typecheck` before completing each batch.
- Run `bun run test` before declaring the scoped modernization complete.
- Preserve unrelated committed and uncommitted work.

## Batch 1 — Reconcile the durable plans

### Work

- [x] Update Milestone 6 to distinguish core MCP lifecycle/elicitation from descoped end-user MCP management.
- [x] Update Milestone 7 title and scope to interrupt, deduplication, recovery, and safe resume.
- [x] Mark rewind/fork implementation items **Descoped**, not completed.
- [x] Replace rewind/fork success release gates with unsupported-before-mutation verification.
- [x] Update Milestone 8 rollout and metrics items to exclude rewind/fork and a new canary framework.
- [x] Point the old completion plan to this scoped plan as its successor.

### Done when

- The durable checklist has no ambiguous pending items for intentionally removed scope.
- Counts distinguish completed, remaining, and descoped work.

## Batch 2 — Finish core MCP lifecycle and elicitation

### Work

- [x] Confirm initialization and `mcpServerStatus()` feed the same replaceable canonical snapshot.
- [x] Verify bounded polling after initialization, reinitialize, and internal explicit refresh.
- [x] Verify the required bigbud orchestration bridge blocks readiness when unavailable.
- [x] Verify optional/user MCP servers never block session readiness.
- [x] Verify required bridges cannot be disabled or removed through internal SDK controls.
- [x] Verify elicitation uses the request ledger and resolves exactly once.
- [x] Verify elicitation cancellation on timeout, interrupt, session stop, and recovery loss.
- [x] Verify MCP activities and diagnostics redact URLs, tokens, submitted values, and native payloads.
- [x] Add missing contract, adapter, service, ingestion, elicitation, and required-bridge tests.
- [x] Do not add new public MCP management RPCs or UI.

### Focused verification

- `apps/server/src/provider/providerMcp.test.ts`
- Claude MCP/session/elicitation/interrupt tests
- Provider service routing/capability tests
- Runtime ingestion MCP tests
- Contract decoding tests

### Done when

- Required and optional readiness behavior is deterministic.
- Elicitation is exactly-once and secret-free.
- Internal SDK-owned operations remain typed and are absent on unsupported adapters.
- Milestone 6 core scope is complete.

## Batch 3 — Finish interrupt, recovery, and safe resume

### Work

- [x] Verify native UUID tracking for bigbud-originated messages remains bounded.
- [x] Verify typed interrupt receipts reconcile queued and cancelled IDs.
- [x] Verify legacy/no-receipt interrupt fallback cannot duplicate or lose prompts.
- [x] Verify message, request, and task deduplication survives `reinitialize()`.
- [x] Verify persisted resume-restart is used only when reinitialize is unavailable or fails appropriately.
- [x] Verify `resumeSessionAt` accepts only known compatible assistant boundaries.
- [x] Verify pending approval and elicitation state blocks unsafe lifecycle transitions.
- [x] Keep Claude `conversationRewind` capability set to `unsupported`.
- [x] Verify Claude checkpoint revert fails before restoring files.
- [x] Keep native fork unavailable and document conversation/workspace constraints.
- [x] Add focused local, remote, replay, idempotency, and unsupported-boundary tests.

### Focused verification

- `Adapter.interrupt.test.ts`
- `Adapter.recovery.test.ts`
- `Adapter.recovery.dedup.test.ts`
- `Adapter.resume.test.ts`
- `Adapter.requestLedger.test.ts`
- `CheckpointReactor.revert.test.ts`
- Provider capability/routing tests

### Done when

- Interrupt/recovery/resume produce no duplicate assistant text, tasks, approvals, inputs, or prompts.
- Unsupported rewind/fork requests cannot partially mutate conversation or filesystem state.
- Milestone 7 retained scope is complete.

## Batch 4 — Finish discovery, status normalization, and privacy

### Work

- [x] Verify fallback Claude model aliases and capabilities.
- [x] Keep valid live SDK model discovery authoritative.
- [x] Preserve successful empty discovery separately from unavailable or invalid discovery.
- [x] Merge custom models deterministically without case-insensitive duplicates.
- [x] Record only bounded discovery status, source, SDK version, and duration.
- [x] Normalize reliable Claude model/provider usage into canonical provider-neutral fields.
- [x] Report usage as unavailable when the SDK does not provide reliable values.
- [x] Normalize fallback/reroute, refusal/API status, command lifecycle, and fast-mode-disabled reason.
- [x] Keep compatibility, permission, replay, redaction, and deduplication correctness ungated.
- [x] Retain reversible settings for optional task/progress/forwarded-text/MCP behavior.
- [x] Keep rewind/fork settings default-off and nonfunctional until a future dedicated plan removes or implements them.
- [x] Wire privacy-safe metrics for retained modernization subsystems only.
- [x] Add allowlist tests proving telemetry rejects prompts, tool data, paths, URLs/tokens, task text, answers, native IDs, and raw SDK payloads.

### Focused verification

- `Provider.capabilities.test.ts`
- Claude SDK routing/result/status tests
- Provider runtime usage/status contract tests
- `Metrics.claude.test.ts`
- Analytics allowlist tests
- Server settings tests

### Done when

- Discovery state is explicit and deterministic.
- Canonical status and usage are accurate or explicitly unavailable.
- Diagnostics and telemetry contain only low-cardinality allowlisted values.
- Milestone 8 retained scope is complete.

## Batch 5 — Scoped release gate

### Functional verification

- [ ] Local modern Claude task card updates live and removes stale tasks.
- [ ] Remote modern Claude task card behaves identically.
- [ ] Legacy/resumed `TodoWrite` remains compatible.
- [ ] Permission mode matrix and callback replay are correct.
- [ ] Background subagent hierarchy/progress/interrupt leaves no orphan task and stays within budgets.
- [ ] Required/optional MCP readiness and elicitation work without secret leakage.
- [ ] Interrupt/reinitialize/resume produce no duplicate assistant text, tasks, approvals, inputs, or prompts.
- [ ] Claude rewind is reported unsupported before filesystem mutation.
- [ ] Native fork is unavailable and does not create a partial destination.
- [ ] Codex, OpenCode, Copilot, and Pi shared plan/task/work-log behavior remains unchanged.
- [ ] Visually verify Tasks card, work log, approvals, subagent presentation, MCP state, and session transitions in the real app.

### Repository verification

- [ ] `bun fmt`
- [ ] `bun lint`
- [ ] `bun typecheck`
- [ ] `bun run test`
- [ ] Guarded Claude SDK smoke test in its disposable fixture workspace when authentication is available.

### Done when

- Every retained item is implemented and checked with evidence.
- Every removed item is marked **Descoped** with this plan as the reason.
- Required gates pass.
- Any unavailable authenticated smoke or real-app environment is recorded as an external validation blocker rather than misreported as passing.

## Future plans

Create separate product plans before implementing either area:

1. **Claude coordinated rewind**
   - SDK-supported transcript boundary and dry-run contract
   - durable checkpoint lineage
   - atomicity/compensation model
   - local/remote restrictions
   - honest partial-failure recovery

2. **Native conversation fork**
   - destination thread and provider-session identity
   - shared workspace versus isolated worktree semantics
   - model/provider portability
   - remote workspace restrictions
   - idempotency and cleanup

3. **End-user MCP management**
   - durable MCP projection
   - public RPC and authorization model
   - settings UI and server ownership
   - required-bridge protection
   - OAuth and secret-handling UX
