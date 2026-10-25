# Internal text-generation policy

## Authoritative scope

### Staged title recovery (latest user direction)

The original no-repeat title job is superseded by four durable automatic stages: normal generation, one immediate normal retry, a third generation after three distinct successful user submissions, then a context-based rename-tool fallback. The first two stages each retain the existing preference → verified-thread policy (at most two provider calls per stage). Stages three and four use only the verified model/subprovider from the third successful user turn, never the global override or an unproven current selection. This bounds automatic work to four logical jobs / six provider invocations; a metadata-only explicit Retry is one logical job, not a reset of the automatic stages.

Successful-user-turn evidence joins server-validated submission bindings with actual successful runtime-model activities, deduplicating message and turn identities. Failed/cancelled turns, metadata generation, and tool-only events do not advance the threshold. Both orderings of submission acknowledgement and completion are supported. Stage claims/results use existing activity rows and command receipts; startup resumes bounded pending metadata jobs while consuming ambiguous already-started stages rather than replaying external work.

The final fallback generates a proposed title from the existing bounded user/assistant transcript, using the same exact verified pair, and executes the real `renameThreadViaOrchestration` handler as the owning thread with a stable invocation receipt. It does not send a provider chat turn, append hidden prompts, open a replacement conversation to force a callback, or fabricate a tool event. Raw tool names/contracts are unchanged. Existing lifecycle, workspace, title-version, custom-title, and tool ownership checks remain in force.

Title warnings require final fallback failure; summary generation policy is unchanged, with no rename-summary fallback. Both warnings wait for three verified successful user turns and are presented at most once per thread/operation in the renderer session, across activity revisions, dismissal, and navigation. A mounted warning retains its Retry/X controls. State is not persisted across app restart. The bounded 512-identity store never evicts seen identities: at saturation it suppresses new presentations until renderer restart rather than allowing an old warning to reappear.

All generation outside conversation turns uses only:

1. The explicitly configured text-generation provider/model, if present.
2. The associated thread's most recently verified successful provider/model, if present.

The user clarified that a persisted selection is preserved, including an explicitly stored legacy-default model. Missing settings have no default. New threads and legacy threads without reliable successful-model evidence wait for a verified successful turn; selected models are not proof of success. Threadless generation may use only an explicit setting. Cross-provider fallback is authorized.

## Implementation inventory

| Caller                                                | Evidence / entry point                              | Policy                                                                                                                                                             |
| ----------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Thread titles                                         | `ProviderCommandReactorSessionOps.firstTurn.ts`     | Central `TextGeneration.generateThreadTitle`; deferred jobs awaken on verified success.                                                                            |
| Elevator summaries                                    | `ProviderCommandReactorHandlers.elevatorSummary.ts` | Central `TextGeneration.generateThreadElevatorSummary`; existing summary survives failure.                                                                         |
| Worktree branch naming                                | `ProviderCommandReactorSessionOps.firstTurn.ts`     | Central `TextGeneration.generateBranchName`; no model means retain temporary branch.                                                                               |
| Commit messages / combined feature-branch suggestions | `GitManager.commitStep.ts`                          | Central `TextGeneration.generateCommitMessage`; threadless generation needs explicit preference. Custom commit messages bypass generation.                         |
| Pull-request titles / bodies                          | `GitManager.prStep.ts`                              | Central `TextGeneration.generatePrContent`; threadless generation needs explicit preference. Existing PR / push-only paths remain usable without a model.          |
| Generated prompt suggestions                          | `PromptSuggestionReactor.ts`                        | Central `TextGeneration.generatePromptSuggestion`; actual fallback provider is retained in provenance. Native provider suggestions are not extra generation calls. |
| Handoff documents, including chunked generation       | `wsHandoffJobs.ts`, `wsHandoffJobs.cli.ts`          | Same central candidate/attempt policy around the entire handoff job; failed candidates are not retried for every subsequent chunk.                                 |

`RoutingTextGeneration.ts` dispatches exact pairs. Unsupported or disabled providers fail that candidate rather than substituting another provider/model. Generic generation supports Codex, Claude, and Cursor; native Copilot/OpenCode titles and OpenCode summaries remain available. Pi unattended titles explicitly reject the candidate before starting a process because the old path did not enforce its selected model; normal Pi chat is unchanged. Settings persistence, runtime telemetry, and provider-disable UI no longer rewrite the configured pair.

## Success evidence and failure behavior

Git actions from a persisted thread carry its optional thread ID. `wsGitTextGenerationContext.ts` resolves that thread's durable success on the server and checks both canonical workspace execution target and cwd before passing the model into commit/branch/PR generation. A cwd alone never implies thread association.

- `ProviderRuntimeIngestion.successfulModel.ts` prefers authoritative actual-completion model/subprovider evidence bound to the completed turn and session epoch. It otherwise uses that turn's captured start identity, never a mutable global session snapshot at completion. OpenCode adapters carry their correlated assistant response model into the canonical completion event. Failed, cancelled, interrupted, stale-session, and rejected lifecycle events do not overwrite success evidence.
- The durable model activity is separate from selected thread metadata and conversation messages. Internal generation/status activities are excluded from conversation work logs.
- The policy deduplicates matching provider/model/sub-provider identities even when reasoning options differ. Each authorized candidate is attempted at most once; interruptions and invalid input do not fall through. Diagnostics identify operation, provider, model, attempt, and failure.
- Title/summary jobs coalesce concurrent requests. Failed summaries do not automatically retry on subsequent message events. The prior content stays intact.
- Durable, nonblocking title/summary notices expose a metadata-only Retry action through `server.retryTextGeneration`. The source notice ID defines one stable logical request; duplicate delivery cannot create another job. Persisted request/start/settlement activities use existing projection tables, without a migration. Startup recovers accepted-but-unstarted requests only. A request interrupted after durable execution ownership is ambiguous and is settled with a warning rather than automatically charging a provider again; the user can authorize a new Retry. Workspace/title fences are rechecked, and retries never send or replay chat messages, change model selection, or restart chat sessions.
- Temporary worktree branches deferred for lack of a verified model awaken on first verified success. Both scheduling and late-result handling guard the original branch/worktree/target identity; custom branches are never renamed.
- Existing manual/agent title locks and late-result guards remain in place.

## Safety

No applied migration was changed for this task, and no schema migration or user-data backfill is required. No live provider request, real-history mutation, application restart, commit, or push is part of validation. Provider tests use injected fakes and disposable fixtures.
