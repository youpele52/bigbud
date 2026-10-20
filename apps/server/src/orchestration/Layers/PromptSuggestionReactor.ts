/**
 * Generated prompt suggestions (Phase 7) for providers without native ones. After a turn
 * completes successfully it asks bigbud's text generation, with the thread's model (falling back
 * to the text-generation model), for the logical next user message, then attaches it like a
 * native suggestion.
 *
 * Bounds: one in-flight generation per thread (a new turn, user message, queue, revert,
 * archive or deletion interrupts it), a global concurrency cap and a timeout. It never blocks a
 * turn, never sends anything and attaches only while the turn is still the latest.
 *
 * @module PromptSuggestionReactor
 */
import {
  CommandId,
  EventId,
  type OrchestrationThread,
  type ProviderKind,
  type ProviderRuntimeEvent,
  type ServerSettings,
  type ServerSettingsError,
  type ThreadId,
  type TurnId,
} from "@bigbud/contracts";
import {
  Cause,
  Clock,
  Duration,
  Effect,
  FiberMap,
  Option,
  Schedule,
  Semaphore,
  Stream,
} from "effect";

import type { TextGenerationShape } from "../../git/Services/TextGeneration.ts";
import type { ProviderServiceError } from "../../provider/Errors.ts";
import type { ProviderAdapterCapabilities } from "../../provider/Services/ProviderAdapter.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import { buildPromptSuggestionActivity } from "../promptSuggestion.logic.ts";
import {
  buildPromptSuggestionTranscript,
  generatedSuggestionSkipReason,
  promptSuggestionCancelThreadId,
} from "./PromptSuggestionReactor.logic.ts";
import { lastSuccessfulThreadModel } from "../../git/Layers/InternalTextGeneration.success.ts";
import { hasTextGenerationUncertainty } from "@bigbud/shared/internalTextGeneration";
import { recordThreadTextGenerationStatusRequired } from "../../git/Layers/InternalTextGeneration.status.ts";
import { uncertainTextGenerationError } from "../../git/Layers/InternalTextGeneration.uncertainty.ts";
import { makeTextGenerationDispatchClaim } from "../../git/Layers/InternalTextGeneration.dispatch.ts";

export const PROMPT_SUGGESTION_TIMEOUT = Duration.seconds(15);
export const PROMPT_SUGGESTION_MAX_CONCURRENT = 2;

export interface PromptSuggestionReactorDeps {
  readonly orchestrationEngine: Pick<
    OrchestrationEngineShape,
    "getReadModel" | "dispatch" | "streamDomainEvents"
  >;
  readonly providerEvents: Stream.Stream<ProviderRuntimeEvent>;
  readonly getCapabilities: (
    provider: ProviderKind,
  ) => Effect.Effect<ProviderAdapterCapabilities, ProviderServiceError>;
  readonly textGeneration: Pick<TextGenerationShape, "generatePromptSuggestion">;
  readonly getSettings: Effect.Effect<ServerSettings, ServerSettingsError>;
  readonly resolveCwd: (thread: OrchestrationThread) => Effect.Effect<string>;
  readonly timeout?: Duration.Duration;
  readonly maxConcurrent?: number;
}

export const startPromptSuggestionReactor = Effect.fn("startPromptSuggestionReactor")(function* (
  deps: PromptSuggestionReactorDeps,
) {
  const inFlight = yield* FiberMap.make<ThreadId>();
  const permits = yield* Semaphore.make(deps.maxConcurrent ?? PROMPT_SUGGESTION_MAX_CONCURRENT);

  const readThread = (threadId: ThreadId) =>
    deps.orchestrationEngine
      .getReadModel()
      .pipe(Effect.map((model) => model.threads.find((thread) => thread.id === threadId)));

  // Ingestion applies `turn.completed` beside this reactor; wait briefly until it has.
  const settledThread = (threadId: ThreadId, turnId: TurnId) =>
    readThread(threadId).pipe(
      Effect.flatMap((thread) =>
        thread?.latestTurn?.turnId === turnId && thread.session?.activeTurnId === null
          ? Effect.succeed(thread)
          : Effect.fail("unsettled" as const),
      ),
      Effect.retry({ times: 20, schedule: Schedule.spaced("100 millis") }),
      Effect.option,
    );

  const generate = (threadId: ThreadId, turnId: TurnId) =>
    Effect.gen(function* () {
      const settings = yield* deps.getSettings;
      if (!settings.promptSuggestions || !settings.generatedPromptSuggestions) return;
      const thread = Option.getOrUndefined(yield* settledThread(threadId, turnId));
      if (!thread) return;
      if (hasTextGenerationUncertainty(thread.activities, "promptSuggestion", turnId)) return;
      const capabilities = yield* deps
        .getCapabilities(thread.modelSelection.provider)
        .pipe(Effect.option);
      if (Option.isSome(capabilities) && capabilities.value.nativePromptSuggestions === true)
        return;
      const skip = generatedSuggestionSkipReason(thread, turnId);
      const transcript = buildPromptSuggestionTranscript(thread.messages);
      if (skip !== null || transcript.length === 0) {
        yield* Effect.logDebug("generated prompt suggestion skipped", { threadId, turnId, skip });
        return;
      }
      const successfulModelSelection = lastSuccessfulThreadModel(thread);
      const modelSelection = settings.textGenerationModelSelection ?? successfulModelSelection;
      if (!modelSelection) return;
      const cwd = yield* deps.resolveCwd(thread);
      const claim = makeTextGenerationDispatchClaim(
        deps.orchestrationEngine,
        threadId,
        "promptSuggestion",
        turnId,
      );
      const generated = yield* permits.withPermits(1)(
        deps.textGeneration
          .generatePromptSuggestion({
            cwd,
            transcript,
            modelSelection,
            successfulModelSelection,
            beforeV2Dispatch: claim.beforeV2Dispatch,
          })
          .pipe(Effect.timeout(deps.timeout ?? PROMPT_SUGGESTION_TIMEOUT)),
      );
      if (claim.isClaimed())
        yield* recordThreadTextGenerationStatusRequired(
          deps.orchestrationEngine,
          threadId,
          "promptSuggestion",
          "completed",
          { turnId },
        );
      const latest = yield* readThread(threadId);
      if (!latest || generatedSuggestionSkipReason(latest, turnId) === "already-suggested") return;
      const createdAt = new Date(yield* Clock.currentTimeMillis).toISOString();
      const activity = buildPromptSuggestionActivity({
        thread: latest,
        turnId,
        raw: generated.suggestion,
        source: "generated",
        provider: generated.actualModelSelection?.provider ?? modelSelection.provider,
        eventId: EventId.makeUnsafe(`prompt-suggestion:${threadId}:${turnId}`),
        createdAt,
      });
      if (activity === null) return;
      yield* deps.orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe(`server:prompt-suggestion:${crypto.randomUUID()}`),
        threadId,
        activity,
        createdAt,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          if (Cause.hasInterruptsOnly(cause)) return;
          const uncertainty = uncertainTextGenerationError(cause);
          const failure = Cause.findErrorOption(cause);
          const timedOut = Option.isSome(failure) && Cause.isTimeoutError(failure.value);
          const thread = yield* readThread(threadId);
          if (
            uncertainty ||
            (thread && hasTextGenerationUncertainty(thread.activities, "promptSuggestion", turnId))
          )
            yield* recordThreadTextGenerationStatusRequired(
              deps.orchestrationEngine,
              threadId,
              "promptSuggestion",
              uncertainty || timedOut ? "uncertain" : "failed",
              {
                turnId,
                ...(uncertainty?.uncertaintyId ? { uncertaintyId: uncertainty.uncertaintyId } : {}),
              },
            );
          yield* Effect.logDebug("generated prompt suggestion unavailable", {
            threadId,
            turnId,
            cause: Cause.pretty(cause),
          });
        }),
      ),
    );

  yield* Effect.forkScoped(
    Stream.runForEach(deps.providerEvents, (event) =>
      event.type === "turn.completed" && event.payload.state === "completed" && event.turnId
        ? FiberMap.run(inFlight, event.threadId, generate(event.threadId, event.turnId)).pipe(
            Effect.asVoid,
          )
        : Effect.void,
    ),
  );
  yield* Effect.forkScoped(
    Stream.runForEach(deps.orchestrationEngine.streamDomainEvents, (event) => {
      const threadId = promptSuggestionCancelThreadId(event);
      return threadId === null ? Effect.void : FiberMap.remove(inFlight, threadId);
    }),
  );
});
