import { Effect, Queue, Ref, Stream } from "effect";
import {
  KeybindingsConfigError,
  type OrchestrationEvent,
  type ProviderRuntimeEvent,
  type ServerDiscoveryCatalog,
  type ServerProvider,
  type ServerSettings,
  ServerSettingsError,
  type ServerConfig,
  type ServerConfigIssue,
  type ThinkingActivityDeltaEvent,
} from "@bigbud/contracts";
import type { OrchestrationEventStoreError } from "../persistence/Errors";
import {
  isThinkingStreamKind,
  thinkingActivityIdFromRuntimeEvent,
} from "../orchestration/thinkingActivity";
import { resolveTextGenByProbeStatus } from "./wsSettingsResolver";

export function makeOrderedOrchestrationDomainEventStream(input: {
  readonly orchestrationEngine: {
    getReadModel: () => Effect.Effect<{ readonly snapshotSequence: number }>;
    readEvents: (
      fromSequenceExclusive: number,
    ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError>;
    streamDomainEvents: Stream.Stream<OrchestrationEvent>;
  };
}) {
  return Effect.gen(function* () {
    const liveEventQueue = yield* Queue.unbounded<OrchestrationEvent>();
    yield* Stream.runForEach(input.orchestrationEngine.streamDomainEvents, (event) =>
      Queue.offer(liveEventQueue, event),
    ).pipe(Effect.forkScoped);
    yield* Effect.yieldNow;

    const snapshot = yield* input.orchestrationEngine.getReadModel();
    const fromSequenceExclusive = snapshot.snapshotSequence;
    const replayEvents: Array<OrchestrationEvent> = yield* Stream.runCollect(
      input.orchestrationEngine.readEvents(fromSequenceExclusive),
    ).pipe(
      Effect.map((events) => Array.from(events)),
      Effect.catch(() => Effect.succeed([] as Array<OrchestrationEvent>)),
    );
    const replayStream = Stream.fromIterable(replayEvents);
    const source = Stream.merge(replayStream, Stream.fromQueue(liveEventQueue));
    type SequenceState = {
      readonly nextSequence: number;
      readonly pendingBySequence: Map<number, OrchestrationEvent>;
    };
    const state = yield* Ref.make<SequenceState>({
      nextSequence: fromSequenceExclusive + 1,
      pendingBySequence: new Map<number, OrchestrationEvent>(),
    });

    return source.pipe(
      Stream.mapEffect((event) =>
        Ref.modify(
          state,
          ({ nextSequence, pendingBySequence }): [Array<OrchestrationEvent>, SequenceState] => {
            if (event.sequence < nextSequence || pendingBySequence.has(event.sequence)) {
              return [[], { nextSequence, pendingBySequence }];
            }

            const updatedPending = new Map(pendingBySequence);
            updatedPending.set(event.sequence, event);

            const emit: Array<OrchestrationEvent> = [];
            let expected = nextSequence;
            for (;;) {
              const expectedEvent = updatedPending.get(expected);
              if (!expectedEvent) break;
              emit.push(expectedEvent);
              updatedPending.delete(expected);
              expected += 1;
            }

            return [emit, { nextSequence: expected, pendingBySequence: updatedPending }];
          },
        ),
      ),
      Stream.flatMap((events) => Stream.fromIterable(events)),
      Stream.ensuring(Queue.shutdown(liveEventQueue)),
    );
  });
}

export function makeServerConfigUpdateStream(input: {
  readonly loadServerConfig: Effect.Effect<
    ServerConfig,
    KeybindingsConfigError | ServerSettingsError
  >;
  readonly keybindings: {
    streamChanges: Stream.Stream<{
      readonly issues: readonly ServerConfigIssue[];
    }>;
  };
  readonly providerRegistry: {
    streamChanges: Stream.Stream<ReadonlyArray<ServerProvider>>;
    getProviders: Effect.Effect<ReadonlyArray<ServerProvider>>;
  };
  readonly discoveryRegistry: {
    streamChanges: Stream.Stream<ServerDiscoveryCatalog>;
  };
  readonly serverSettings: {
    streamChanges: Stream.Stream<ServerSettings>;
  };
}) {
  return Effect.gen(function* () {
    const keybindingsUpdates = input.keybindings.streamChanges.pipe(
      Stream.map((event) => ({
        version: 1 as const,
        type: "keybindingsUpdated" as const,
        payload: { issues: event.issues },
      })),
    );
    const providerStatuses = input.providerRegistry.streamChanges.pipe(
      Stream.map((providers) => ({
        version: 1 as const,
        type: "providerStatuses" as const,
        payload: { providers },
      })),
    );
    const settingsUpdates = input.serverSettings.streamChanges.pipe(
      Stream.mapEffect((rawSettings) =>
        input.providerRegistry.getProviders.pipe(
          Effect.map((providers) => resolveTextGenByProbeStatus(rawSettings, providers)),
          Effect.map((settings) => ({
            version: 1 as const,
            type: "settingsUpdated" as const,
            payload: { settings },
          })),
        ),
      ),
    );
    const discoveryUpdates = input.discoveryRegistry.streamChanges.pipe(
      Stream.map((discovery) => ({
        version: 1 as const,
        type: "discoveryUpdated" as const,
        payload: { discovery },
      })),
    );

    return Stream.concat(
      Stream.make({
        version: 1 as const,
        type: "snapshot" as const,
        config: yield* input.loadServerConfig,
      }),
      Stream.merge(
        keybindingsUpdates,
        Stream.merge(providerStatuses, Stream.merge(settingsUpdates, discoveryUpdates)),
      ),
    );
  });
}

export function makeThinkingActivityDeltaStream(input: {
  readonly providerService: {
    readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
  };
  readonly serverSettings: {
    readonly getSettings: Effect.Effect<
      Pick<ServerSettings, "enableThinkingStreaming">,
      ServerSettingsError
    >;
  };
}) {
  return Effect.gen(function* () {
    const settings = yield* input.serverSettings.getSettings.pipe(
      Effect.catch((error) =>
        Effect.logWarning("thinking activity delta stream disabled: failed to load settings", {
          error,
        }).pipe(Effect.as({ enableThinkingStreaming: false })),
      ),
    );
    if (!settings.enableThinkingStreaming) {
      return Stream.empty;
    }

    return input.providerService.streamEvents.pipe(
      Stream.flatMap((event) =>
        event.type === "content.delta" && isThinkingStreamKind(event.payload.streamKind)
          ? Stream.succeed({
              type: "delta" as const,
              threadId: event.threadId,
              activityId: thinkingActivityIdFromRuntimeEvent({
                threadId: event.threadId,
                turnId: event.turnId,
                itemId: event.itemId,
                streamKind: event.payload.streamKind,
              }),
              turnId: event.turnId ?? null,
              provider: event.provider,
              streamKind: event.payload.streamKind,
              delta: event.payload.delta,
              createdAt: event.createdAt,
            } satisfies ThinkingActivityDeltaEvent)
          : Stream.empty,
      ),
    );
  });
}
