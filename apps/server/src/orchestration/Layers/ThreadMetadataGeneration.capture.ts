import { ModelSelection } from "@bigbud/contracts/orchestration/orchestration.provider";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import type { ThreadMetadataGenerationRepositoryShape } from "../../persistence/Services/ThreadMetadataGeneration.ts";
import { resolveDefaultChatCwd, type ServerSettingsShape } from "../../ws/serverSettings.ts";
import type { SettingsSnapshot } from "../../ws/serverSettings.snapshot.ts";
import { resolveWorkspaceExecutionTargetId } from "../../workspace-target/workspaceTarget.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import {
  MetadataCoordinatorError,
  type MetadataCoordinatorHost,
  type MetadataCoordinatorFailure,
} from "./ThreadMetadataGeneration.coordinator.types.ts";
import type {
  MetadataCapturedContext,
  MetadataCapturedPath,
} from "./ThreadMetadataGeneration.context.ts";
import { makeMetadataJobInput } from "./ThreadMetadataGeneration.jobs.ts";
import { metadataFingerprint } from "./ThreadMetadataGeneration.policy.ts";
import { metadataContextIsCurrent } from "./ThreadMetadataGeneration.current.ts";
import { loadMetadataContext } from "./ThreadMetadataGeneration.modelBinding.ts";
import { metadataSummaryAdapter } from "./ThreadMetadataGeneration.summary.ts";
import { metadataTitleAdapter } from "./ThreadMetadataGeneration.title.ts";
import type {
  MetadataSummaryRequest,
  MetadataTitleRequest,
  ThreadMetadataGenerationRequests,
} from "./ThreadMetadataGeneration.requests.ts";

export interface MetadataCaptureDependencies {
  readonly engine: OrchestrationEngineShape;
  readonly settings: ServerSettingsShape;
  readonly repository: ThreadMetadataGenerationRepositoryShape;
  readonly epochFor: (
    snapshot: SettingsSnapshot,
  ) => Effect.Effect<string, MetadataCoordinatorFailure>;
  readonly capturePath: (
    selection: typeof ModelSelection.Type,
    executionTarget: string,
    cwd?: string,
  ) => Effect.Effect<MetadataCapturedPath | null, MetadataCoordinatorFailure>;
  readonly now: MetadataCoordinatorHost["now"];
}

/** Capture immutable full-history inputs once. A duplicate event never replenishes a budget. */
export function makeMetadataRequestHandlers(input: MetadataCaptureDependencies) {
  const capture = Effect.fn("metadataRequests.capture")(function* (
    operation: "title" | "summary",
    request: MetadataTitleRequest | MetadataSummaryRequest,
  ) {
    const withSettings = input.settings.withSnapshotBarrier;
    const withHistory = input.engine.withThreadHistoryBarrier;
    if (!withSettings || !withHistory)
      return yield* new MetadataCoordinatorError({
        detail: "Metadata capture authority is unavailable.",
      });
    yield* withSettings((snapshot) =>
      withHistory(
        request.threadId,
        Effect.gen(function* () {
          const model = yield* input.engine.getReadModel();
          const thread = model.threads.find((entry) => entry.id === request.threadId);
          if (!thread || thread.archivedAt || thread.deletingAt || thread.deletedAt) return;
          const state = yield* input.repository.readMetadataState(thread.id);
          const epoch = yield* input.epochFor(snapshot);
          const target = resolveWorkspaceExecutionTargetId(thread);
          const configured = snapshot.settings.textGenerationModelSelection;
          const options = {
            cwd:
              resolveThreadWorkspaceCwd({ thread, projects: model.projects }) ??
              resolveDefaultChatCwd(snapshot.settings),
            expectedRevision: operation === "title" ? state.titleRevision : state.summaryRevision,
            configEpoch: epoch,
            configuredPrimary: configured !== null,
            primaryPath: null,
            threadPath: null,
          };
          const context: MetadataCapturedContext | null =
            operation === "title"
              ? metadataTitleAdapter.capture(thread, {
                  ...options,
                  message: (request as MetadataTitleRequest).messageText,
                  ...((request as MetadataTitleRequest).titleSeed !== undefined
                    ? { titleSeed: (request as MetadataTitleRequest).titleSeed! }
                    : {}),
                  ...((request as MetadataTitleRequest).attachments !== undefined
                    ? { attachments: (request as MetadataTitleRequest).attachments! }
                    : {}),
                })
              : metadataSummaryAdapter.capture(thread, {
                  ...options,
                  attemptedFrontier: state.summaryAttemptedFrontier,
                  ...((request as MetadataSummaryRequest).force !== undefined
                    ? { force: (request as MetadataSummaryRequest).force! }
                    : {}),
                });
          if (!context) return;
          const firstUser = thread.messages.find((message) => message.role === "user");
          const generationKey = metadataFingerprint(
            request.retryKey !== undefined
              ? { operation, retry: request.retryKey }
              : {
                  operation,
                  epoch,
                  revision: context.expectedRevision,
                  source: operation === "title" ? firstUser?.id : context.source.frontier,
                  retry: null,
                },
          );
          const belongsToRequest = (key: string) =>
            key === generationKey || key.startsWith(`${generationKey}:capture:`);
          // Check compatibility before coalescing, without probing provider identity.
          const open = yield* input.repository.findOpen(thread.id, operation);
          if (open._tag === "Some") {
            const prior = yield* loadMetadataContext(input.repository, open.value);
            const compatible =
              prior.configEpoch === epoch &&
              metadataContextIsCurrent(
                prior,
                model,
                state,
                resolveDefaultChatCwd(snapshot.settings),
              );
            if (compatible) {
              if (request.retryKey !== undefined && !belongsToRequest(open.value.generationKey))
                return yield* new MetadataCoordinatorError({
                  detail: "Metadata retry admission is deferred until existing work settles.",
                });
              return;
            }
            if (!(yield* input.repository.retireUndispatched(open.value, input.now()))) {
              if (request.retryKey !== undefined)
                return yield* new MetadataCoordinatorError({
                  detail: "Metadata retry admission is blocked by retained work.",
                });
              return;
            }
          }
          const primaryPath = Schema.is(ModelSelection)(configured)
            ? yield* input.capturePath(configured, target, context.workspace.cwd)
            : null;
          const verified = state.successfulModelJson
            ? yield* Schema.decodeEffect(Schema.fromJsonString(ModelSelection))(
                state.successfulModelJson,
              ).pipe(Effect.orElseSucceed(() => null))
            : null;
          const threadPath = verified
            ? yield* input.capturePath(verified, target, context.workspace.cwd)
            : null;
          const captured = {
            ...context,
            primaryPath,
            threadPath,
          };
          const admitted = yield* input.repository.createOrGet(
            makeMetadataJobInput({ context: captured, generationKey, at: input.now() }),
          );
          // Repository uniqueness also covers callers racing outside the history barrier.
          if (request.retryKey !== undefined && !belongsToRequest(admitted.generationKey))
            return yield* new MetadataCoordinatorError({
              detail: "Metadata retry was not associated with compatible durable work.",
            });
        }),
      ),
    ).pipe(
      Effect.catchTag("ServerSettingsError", () =>
        Effect.fail(new MetadataCoordinatorError({ detail: "Metadata settings are unavailable." })),
      ),
    );
  });
  return {
    title: (request: MetadataTitleRequest) => capture("title", request),
    summary: (request: MetadataSummaryRequest) => capture("summary", request),
  } satisfies Pick<ThreadMetadataGenerationRequests, "title" | "summary">;
}
