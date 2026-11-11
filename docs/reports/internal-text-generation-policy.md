# Internal text-generation policy

## Authoritative scope

### Durable title and elevator-summary recovery

Titles and elevator summaries share one durable recovery policy. It replaces the earlier four-stage title pipeline and its successful-submission threshold:

1. Allow up to two definitive failures of the primary text-generation selection, with one bounded retry delay (2 seconds).
2. When an explicitly configured selection has no available execution path, fails preflight, or reaches two definitive failures, retain an amber warning with a **Review AI settings** action linking directly to `/settings/ai`. Unavailability does not consume a paid attempt or claim failures; the durable warning retains the actual definitive-failure count.
3. Try the thread's verified successful selection once, only when it is a distinct exact execution path. An unavailable configured primary does not delay an already verified fallback; model-readiness waiting applies only while verified evidence is missing.
4. When the job ends `exhausted` or `unavailable` with only definitively failed or unavailable non-native attempt evidence, show one final amber notice for that thread and operation (see below) and stop. This includes a failed thread-model attempt, a thread target deduplicated against the definitively failed configured target (no redundant inference), and jobs with no usable attempt at all: no configured model, unusable paths, or no verified thread model by the original deadline. A prepared attempt cancelled at the deadline also qualifies, but only when it is durably marked as never dispatched (pristine revision-zero, non-native, no dispatch/result/provider evidence; migration 167); unmarked historical or possibly dispatched cancellations still suppress the notice. There is no automatic agent/tool fallback; the user or the thread's own agent completes the value through ordinary bigbud tools.

The shared job and attempt records retain the captured model/options, configuration epoch, execution/account fingerprints, workspace, source, and metadata revision. Duplicate delivery and service restart do not replenish a job's paid budget. Missing or unsupported paths do not count as completed provider failures. Dispatch ambiguity pauses paid recovery; lease expiry and an idle session are not evidence that external work never ran. Retained valid output is retried through canonical persistence only, not regenerated.

With no configured override, the primary path remains absent and a verified successful thread selection receives only the single thread-model attempt; a selected but unverified model is not proof of success. Historical prepared no-override primary captures are quarantined rather than resuming the obsolete budget. Readiness waits only until the original durable job deadline (30 minutes), not a separate 60-second cutoff. Existing active captures with an older short readiness timestamp can bind later proof before that original deadline. Neither late proof, duplicate delivery, nor service recomposition extends deadlines or releases exhausted, dispatched, uncertain, or retained-result budgets.

Local auxiliary dispatch admits exact Codex, Claude, Cursor, CLIProxy (through the Claude runner), Copilot titles and summaries, and constrained OpenCode V2 paths. The final application-owned `beforeDispatch` fence precedes subprocess spawn, Copilot `sendAndWait`, or V2 `session.generate`; rejection sends no inference request. The durable router does not invoke a hidden second provider after failure. V2 readback-proven idle sessions can be cleaned when admission rejects; ambiguous dispatched sessions remain retained. Copilot titles and summaries share one SDK setup and dispatch fence; summaries use the shared bounded prompt and schema-validated JSON output. Pi auxiliary execution remains unavailable because its old helper does not enforce safe exact unattended execution.

CLIProxy identity is an opaque endpoint/client-credential scope, bound to captured settings and the Claude binary, not attestation of a pooled upstream backend account. OpenCode V2 identity uses public provider/integration/active-credential APIs in the canonical workspace Location, under existing consent, native trust, and shared-mode guards. It requires one matching active credential connection and rejects environment/external connections, aliases, ambiguous active credentials, custom headers/body, and arbitrary SDK settings that could override authentication or routing. Credential rotation invalidates captured authority. Secrets are hashed, never retained in durable evidence. Repeated bounded public identity probes and live startup latency remain operationally unqualified.

Legacy OpenCode title/summary helpers retain exact model/subprovider/options and a pre-prompt fence, but the production lifecycle and server manager deliberately reject new legacy work. Execution identity therefore still excludes that retired provider. Tests using an injected manager qualify the helper contract only: **requested legacy production revival is not implemented**. No legacy selection is silently rewritten to V2.

Remote workspaces remain fail-closed at identity capture and dispatch. Existing local subprocess/SDK helpers do not establish remote account/runtime identity, canonical remote cwd, transport-bound admission, or remote session cleanup. The legacy manager's execution-target parameter alone cannot supply those missing contracts; V2 auxiliary authority is tied to a local registered transport and canonical filesystem paths. SSH metadata support therefore remains unavailable rather than running a local process against a remote cwd or borrowing ordinary conversation authority. These restrictions apply to metadata, not ordinary provider conversations.

The warning is durable and deduplicated by relevant configuration epoch. Renderer delivery uses server leases, shows before acknowledging, and retains bounded reconnect deduplication. It does not change settings, trigger generation, or expose raw provider output. A crash between presentation and acknowledgment can permit later redisplay; this is not an exactly-once UI guarantee.

Source/workspace/configuration changes and concurrent metadata edits invalidate late results. Failed summaries preserve existing content. A never-dispatched stale capture can be replaced without extending its original deadlines. Paid stale captures conservatively require a distinct explicit retry rather than automatically acquiring a fresh budget. Dispatched, uncertain, and retained-result reservations cannot be retired to admit replacement work.

Automatic maintenance never acquires manual title ownership, persists an ordinary chat message, advances summary cadence, or produces conversation-model success evidence. Ordinary user-directed rename retains its existing ownership behavior.

### Final notice and agent-completed metadata

When a title or summary job ends `exhausted` or `unavailable` with only definitively failed or unavailable, non-native attempt evidence, the server records one durable final warning per thread and operation (`metadata-final:<operation>:<thread>`). Terminal exhaustion and warning insertion share one transaction: an insertion failure rolls back exhaustion rather than losing the notice after scheduler visits stop. It is delivered through the same leased, acknowledged warning channel as the settings warning, with amber warning severity:

- **Title:** "This thread couldn't be named automatically. Rename it, or ask the agent in the thread to do it." The **Rename** action opens the existing manual rename.
- **Elevator summary:** "This thread's summary couldn't be created automatically. Ask the agent in the thread to write one."

Final-warning eligibility is checked during enqueue and again during pending-list and claim. No notice qualifies while an attempt is possibly dispatched, uncertain, or holding a retained result. Changed titles/revisions, explicit or meaningful existing summaries, and archived/deleting/deleted threads suppress pending notices. A title-derived summary placeholder at frontier zero is not an explicit summary. Notices never change settings, trigger generation, or expose raw provider output.

Agents complete the value through ordinary own-thread bigbud tools, available on every provider's orchestration surface (bigbud MCP bridge, Codex dynamic tools, Copilot, OpenCode, OpenCode V2, and Pi):

- `rename_thread` — existing behavior, including manual title ownership.
- `set_elevator_summary` — writes only the authenticated caller's own thread (no target identifier or excess arguments are accepted), sanitizes the summary with the existing normalization and 150-character limit, and records the visible-message frontier through canonical `thread.meta.update`. Canonical hooks advance the summary revision, fencing already captured automatic results. Trusted source/invocation identity and canonical receipts make identical replay idempotent without advancing the original frontier after later messages; changed payloads retain command-ID conflict protection.

OpenCode V2 adds implementation v5 / bootstrap ABI v5 / canonical request ABI v3 for this tool. Retained v1–v4 implementation closures, their manifest entries, and historical compatibility descriptors remain unchanged. The title notice's Rename action uses existing access-gated navigation and the existing inline input; it does not request generation. No manual summary UI is added.

These tools run only when the user (or the thread's agent at the user's request) invokes them; the recovery coordinator never starts an agent turn.

The earlier per-provider native fallback (isolated Claude, Copilot, and Pi drivers, native execution/admission/reconciliation/receipt code, the native router, and the Codex transport/unwired patch) has been removed. Shared normal-provider and auxiliary helpers and ordinary rename tools remain.

Migrations **160–166**, their numbering, registration, and bodies remain unchanged for already migrated development databases and production upgrades from migration 159. Native tables, historical schema/state values, `nativeWaitUntil`, and optional captured native-account evidence are compatibility remnants, not execution authority. Proven-never-dispatched prepared native attempts may be cancelled; possibly dispatched or retained-result evidence stays fenced as uncertain, and other historical native jobs are quarantined. Native output is not committed. Historical attempts, grants, requests, and receipts are not erased or reset to authorize replay; unused tables are intentional.

Focused tests inject provider boundaries and use disposable SQLite databases. **Live-provider qualification has not been performed.**

### Other internal text generation

Other generation outside conversation turns uses only:

1. The explicitly configured text-generation provider/model, if present.
2. The associated thread's most recently verified successful provider/model, if present.

A persisted selection is preserved, including an explicitly stored legacy-default model. Missing settings have no default. New threads and legacy threads without reliable successful-model evidence wait for a verified successful turn; selected models are not proof of success. Threadless generation may use only an explicit setting. Cross-provider fallback is authorized.

## Implementation inventory

| Caller                                                | Evidence / entry point                              | Policy                                                                                                                                                             |
| ----------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Thread titles                                         | `ProviderCommandReactorSessionOps.title.ts`         | Durable `ThreadMetadataGeneration` requests; exact auxiliary execution and canonical metadata commit.                                                              |
| Elevator summaries                                    | `ProviderCommandReactorHandlers.elevatorSummary.ts` | Same durable recovery coordinator; existing summary survives failure.                                                                                              |
| Worktree branch naming                                | `ProviderCommandReactorSessionOps.firstTurn.ts`     | Central `TextGeneration.generateBranchName`; no model means retain temporary branch.                                                                               |
| Commit messages / combined feature-branch suggestions | `GitManager.commitStep.ts`                          | Central `TextGeneration.generateCommitMessage`; threadless generation needs explicit preference. Custom commit messages bypass generation.                         |
| Pull-request titles / bodies                          | `GitManager.prStep.ts`                              | Central `TextGeneration.generatePrContent`; threadless generation needs explicit preference. Existing PR / push-only paths remain usable without a model.          |
| Generated prompt suggestions                          | `PromptSuggestionReactor.ts`                        | Central `TextGeneration.generatePromptSuggestion`; actual fallback provider is retained in provenance. Native provider suggestions are not extra generation calls. |
| Handoff documents, including chunked generation       | `wsHandoffJobs.ts`, `wsHandoffJobs.cli.ts`          | Same central candidate/attempt policy around the entire handoff job; failed candidates are not retried for every subsequent chunk.                                 |

`RoutingTextGeneration.ts` dispatches exact pairs. Unsupported or disabled providers fail that candidate rather than substituting another provider/model. Generic routing still includes provider-specific one-shot title/summary implementations used by the exact auxiliary paths above. Pi unattended titles reject the candidate before starting a process because the old path did not enforce its selected model; normal Pi chat is unchanged. Settings persistence, runtime telemetry, and provider-disable UI do not rewrite the configured pair.

## Success evidence and failure behavior

Git actions from a persisted thread carry its optional thread ID. `wsGitTextGenerationContext.ts` resolves that thread's durable success on the server and checks both canonical workspace execution target and cwd before passing the model into commit/branch/PR generation. A cwd alone never implies thread association.

- `ProviderRuntimeIngestion.successfulModel.ts` prefers authoritative actual-completion model/subprovider evidence bound to the completed turn and session epoch. It otherwise uses that turn's captured start identity, never a mutable global session snapshot at completion. OpenCode adapters carry their correlated assistant response model into the canonical completion event. Failed, cancelled, interrupted, stale-session, and rejected lifecycle events do not overwrite success evidence.
- Durable model evidence is separate from selected thread metadata and conversation messages. Internal generation/status activities are excluded from conversation work logs.
- Generic candidate routing deduplicates matching provider/model/sub-provider identities even when reasoning options differ. Each authorized generic candidate is attempted at most once. The metadata coordinator instead retains exact options and execution identity and uses the bounded recovery policy above.
- Title/summary jobs coalesce compatible concurrent requests. Failed summaries do not acquire fresh budgets on every subsequent message event. The prior content stays intact.
- Existing metadata-only Retry actions use `server.retryTextGeneration`. The stable request ID is passed into durable admission. Request settlement records bookkeeping, not proof of provider execution; SQL attempts own dispatch and replay authority. Incompatible retained work blocks retry admission instead of silently accepting and losing the request. Retries never send or replay chat messages, change model selection, or restart chat sessions.
- Legacy activity and command-receipt evidence remains authoritative even after activity-tail trimming. For titles and summaries, the shared metadata-state lookup lazily bootstraps a missing successful selection from complete canonical SQL history, choosing the greatest accepted event sequence, not activity IDs or timestamps. Recovery uses bounded pages and a two-second deadline including SQL acquisition; unknown, malformed, incomplete, or timed-out history cannot qualify a selection. A transaction and null-only update preserve newer canonical success, revisions, frontiers, immutable job budgets, and already captured paths/accounts. Once state contains success, normal reads do not rescan history; unsuccessful cold reads may retry the bounded scan. Model proof is not replay permission: operation-qualified legacy paid-work and unknown-evidence checks still run under the authoritative dispatch barriers. Known-no-dispatch stale requests settle without creating completed/started generation evidence. Ambiguous historical paid work is not automatically replayed.
- Temporary worktree branches deferred for lack of a verified model awaken on first verified success. Both scheduling and late-result handling guard the original branch/worktree/target identity; custom branches are never renamed.
- Existing manual/agent title locks and late-result guards remain in place.

## Persistence and validation boundaries

The implementation adds schema migrations for durable metadata jobs, attempts, warning delivery, model bindings, configuration epochs, final warnings, and the never-dispatched deadline-cancellation marker (plus now-unused tables from the removed native fallback). Historical migration bodies are unchanged. Migration registration is split between `Migrations.base.ts` (historical entries 1–100) and `Migrations.ts` (newer entries and execution).

Focused validation uses mocked external provider boundaries and disposable SQLite databases. Reopening a SQL runtime and recomposing services exercise durable recovery, but do not establish full OS-process restart or real-provider qualification. Tests cover warning insertion rollback, durable budgets/deduplication, claim/ack delivery, edit suppression, native-state retirement, exact auxiliary dispatch, own-thread authorization, and stale-summary races. The two focused metadata-warning and manual-rename browser test files pass (19 tests) using an already installed Brave executable through a temporary Playwright configuration; no browser runtime was installed. The default Playwright Chromium runtime remains unavailable. No live provider/auth probe, real-history mutation, production user-data migration, application restart, commit, or push is part of this validation.
