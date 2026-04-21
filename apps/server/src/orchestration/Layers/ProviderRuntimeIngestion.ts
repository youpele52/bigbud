/**
 * ProviderRuntimeIngestion — thin shell Layer wiring.
 *
 * Sets up caches and wires the `ProviderRuntimeIngestionLive` Effect Layer.
 * Per-event processing is delegated to `makeRuntimeEventProcessor` from
 * `ProviderRuntimeIngestion.processor.ts`.
 *
 * @module ProviderRuntimeIngestion
 */
import { MessageId, ThreadId } from "@bigbud/contracts";
import { Cache, Cause, Duration, Effect, Layer, Option, Scope, Stream } from "effect";
import { type DrainableWorker, makeDrainableWorker } from "@bigbud/shared/DrainableWorker";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProviderRuntimeIngestionService,
  type ProviderRuntimeIngestionShape,
} from "../Services/ProviderRuntimeIngestion.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import {
  type RuntimeIngestionInput,
  type TurnStartRequestedDomainEvent,
  BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY,
  BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY,
  MAX_BUFFERED_ASSISTANT_CHARS,
  TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
} from "./ProviderRuntimeIngestion.helpers.ts";
import {
  makeRuntimeEventProcessor,
  type RuntimeProcessorCacheHelpers,
  type RuntimeProcessorServices,
} from "./ProviderRuntimeIngestion.processor.ts";

const TURN_MESSAGE_IDS_BY_TURN_TTL = Duration.minutes(120);
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL = Duration.minutes(120);
const BUFFERED_PROPOSED_PLAN_BY_ID_TTL = Duration.minutes(120);

const providerTurnKey = (threadId: ThreadId, turnId: string) => `${threadId}:${turnId}`;

const make = Effect.fn("make")(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const serverSettingsService = yield* ServerSettingsService;

  const turnMessageIdsByTurnKey = yield* Cache.make<string, Set<MessageId>>({
    capacity: TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
    timeToLive: TURN_MESSAGE_IDS_BY_TURN_TTL,
    lookup: () => Effect.succeed(new Set<MessageId>()),
  });

  const bufferedAssistantTextByMessageId = yield* Cache.make<MessageId, string>({
    capacity: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL,
    lookup: () => Effect.succeed(""),
  });

  const bufferedProposedPlanById = yield* Cache.make<string, { text: string; createdAt: string }>({
    capacity: BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_PROPOSED_PLAN_BY_ID_TTL,
    lookup: () => Effect.succeed({ text: "", createdAt: "" }),
  });

  const rememberAssistantMessageId = (threadId: ThreadId, turnId: string, messageId: MessageId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingIds) =>
        Cache.set(
          turnMessageIdsByTurnKey,
          providerTurnKey(threadId, turnId),
          Option.match(existingIds, {
            onNone: () => new Set([messageId]),
            onSome: (ids) => {
              const nextIds = new Set(ids);
              nextIds.add(messageId);
              return nextIds;
            },
          }),
        ),
      ),
    );

  const forgetAssistantMessageId = (threadId: ThreadId, turnId: string, messageId: MessageId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingIds) =>
        Option.match(existingIds, {
          onNone: () => Effect.void,
          onSome: (ids) => {
            const nextIds = new Set(ids);
            nextIds.delete(messageId);
            if (nextIds.size === 0) {
              return Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId));
            }
            return Cache.set(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId), nextIds);
          },
        }),
      ),
    );

  const getAssistantMessageIdsForTurn = (threadId: ThreadId, turnId: string) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.map((existingIds) =>
        Option.getOrElse(existingIds, (): Set<MessageId> => new Set<MessageId>()),
      ),
    );

  const clearAssistantMessageIdsForTurn = (threadId: ThreadId, turnId: string) =>
    Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId));

  const appendBufferedAssistantText = (messageId: MessageId, delta: string) =>
    Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.flatMap(
        Effect.fn("appendBufferedAssistantText")(function* (existingText) {
          const nextText = Option.match(existingText, {
            onNone: () => delta,
            onSome: (text) => `${text}${delta}`,
          });
          if (nextText.length <= MAX_BUFFERED_ASSISTANT_CHARS) {
            yield* Cache.set(bufferedAssistantTextByMessageId, messageId, nextText);
            return "";
          }

          // Safety valve: flush full buffered text as an assistant delta to cap memory.
          yield* Cache.invalidate(bufferedAssistantTextByMessageId, messageId);
          return nextText;
        }),
      ),
    );

  const takeBufferedAssistantText = (messageId: MessageId) =>
    Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.flatMap((existingText) =>
        Cache.invalidate(bufferedAssistantTextByMessageId, messageId).pipe(
          Effect.as(Option.getOrElse(existingText, () => "")),
        ),
      ),
    );

  const clearBufferedAssistantText = (messageId: MessageId) =>
    Cache.invalidate(bufferedAssistantTextByMessageId, messageId);

  const appendBufferedProposedPlan = (planId: string, delta: string, createdAt: string) =>
    Cache.getOption(bufferedProposedPlanById, planId).pipe(
      Effect.flatMap((existingEntry) => {
        const existing = Option.getOrUndefined(existingEntry);
        return Cache.set(bufferedProposedPlanById, planId, {
          text: `${existing?.text ?? ""}${delta}`,
          createdAt:
            existing?.createdAt && existing.createdAt.length > 0 ? existing.createdAt : createdAt,
        });
      }),
    );

  const takeBufferedProposedPlan = (planId: string) =>
    Cache.getOption(bufferedProposedPlanById, planId).pipe(
      Effect.flatMap((existingEntry) =>
        Cache.invalidate(bufferedProposedPlanById, planId).pipe(
          Effect.as(Option.getOrUndefined(existingEntry)),
        ),
      ),
    );

  const clearBufferedProposedPlan = (planId: string) =>
    Cache.invalidate(bufferedProposedPlanById, planId);

  const clearBufferedAssistantTextAlias = (messageId: MessageId) =>
    clearBufferedAssistantText(messageId);

  const clearTurnStateForSession = Effect.fn("clearTurnStateForSession")(function* (
    threadId: ThreadId,
  ) {
    const prefix = `${threadId}:`;
    const proposedPlanPrefix = `plan:${threadId}:`;
    const turnKeys = Array.from(yield* Cache.keys(turnMessageIdsByTurnKey));
    const proposedPlanKeys = Array.from(yield* Cache.keys(bufferedProposedPlanById));
    yield* Effect.forEach(
      turnKeys,
      Effect.fn(function* (key) {
        if (!key.startsWith(prefix)) {
          return;
        }

        const messageIds = yield* Cache.getOption(turnMessageIdsByTurnKey, key);
        if (Option.isSome(messageIds)) {
          yield* Effect.forEach(messageIds.value, clearBufferedAssistantTextAlias, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
        }

        yield* Cache.invalidate(turnMessageIdsByTurnKey, key);
      }),
      { concurrency: 1 },
    ).pipe(Effect.asVoid);
    yield* Effect.forEach(
      proposedPlanKeys,
      (key) =>
        key.startsWith(proposedPlanPrefix)
          ? Cache.invalidate(bufferedProposedPlanById, key)
          : Effect.void,
      { concurrency: 1 },
    ).pipe(Effect.asVoid);
  });

  const processorServices: RuntimeProcessorServices = {
    orchestrationEngine,
    providerService,
    serverSettingsService,
    projectionTurnRepository,
  };

  const cacheHelpers: RuntimeProcessorCacheHelpers = {
    rememberAssistantMessageId,
    forgetAssistantMessageId,
    getAssistantMessageIdsForTurn,
    clearAssistantMessageIdsForTurn,
    appendBufferedAssistantText,
    takeBufferedAssistantText,
    clearBufferedAssistantText,
    appendBufferedProposedPlan,
    takeBufferedProposedPlan,
    clearBufferedProposedPlan,
    clearTurnStateForSession,
  };

  const processRuntimeEvent = makeRuntimeEventProcessor(processorServices, cacheHelpers);

  const processDomainEvent = (_event: TurnStartRequestedDomainEvent) => Effect.void;

  const processInput = (input: RuntimeIngestionInput) =>
    input.source === "runtime" ? processRuntimeEvent(input.event) : processDomainEvent(input.event);

  const processInputSafely = (input: RuntimeIngestionInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider runtime ingestion failed to process event", {
          source: input.source,
          eventId: input.event.eventId,
          eventType: input.event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  // Per-thread worker map: each thread gets its own DrainableWorker so that
  // processing a large burst of events for one thread does not delay ingestion
  // for any other thread.
  const threadWorkers = new Map<string, DrainableWorker<RuntimeIngestionInput>>();
  const outerScope = yield* Effect.scope;

  const getOrCreateThreadWorker = (threadId: string) => {
    const existing = threadWorkers.get(threadId);
    if (existing !== undefined) {
      return Effect.succeed(existing);
    }
    return makeDrainableWorker(processInputSafely).pipe(
      Effect.provideService(Scope.Scope, outerScope),
      Effect.tap((worker) => Effect.sync(() => threadWorkers.set(threadId, worker))),
    );
  };

  const start: ProviderRuntimeIngestionShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(providerService.streamEvents, (event) =>
        getOrCreateThreadWorker(event.threadId).pipe(
          Effect.flatMap((worker) => worker.enqueue({ source: "runtime", event })),
        ),
      ),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.turn-start-requested") {
          return Effect.void;
        }
        return getOrCreateThreadWorker(event.payload.threadId).pipe(
          Effect.flatMap((worker) => worker.enqueue({ source: "domain", event })),
        );
      }),
    );
  });

  return {
    start,
    // Lazily capture workers at drain time so newly-created thread workers are
    // included. Runs all active per-thread drain effects concurrently.
    drain: Effect.suspend(() =>
      Effect.forEach(Array.from(threadWorkers.values()), (worker) => worker.drain, {
        concurrency: "unbounded",
      }),
    ).pipe(Effect.asVoid),
  } satisfies ProviderRuntimeIngestionShape;
});

export const ProviderRuntimeIngestionLive = Layer.effect(
  ProviderRuntimeIngestionService,
  make(),
).pipe(Layer.provide(ProjectionTurnRepositoryLive));
