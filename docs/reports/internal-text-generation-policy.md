# Internal text-generation policy

## Authoritative scope

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
