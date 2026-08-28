import type { OrchestrationReadModel, ThreadId } from "@bigbud/contracts";
import {
  Cause,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  Semaphore,
} from "effect";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { OrchestrationCommandInvariantError, type OrchestrationDispatchError } from "../Errors.ts";
import { createEmptyReadModel } from "../projectorReadModel.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionOperationalStateQuery } from "../Services/ProjectionOperationalStateQuery.ts";
import { ProjectionCatalogQuery } from "../Services/ProjectionCatalogQuery.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { ProjectionNoteRepository } from "../../persistence/Services/ProjectionNotes.ts";
import { ProjectionKanbanRepository } from "../../persistence/Services/ProjectionKanban.ts";
import { rehydrateThreadTitleLocks } from "../../orchestration-tools/ThreadTitleLock.ts";
import { ComputerUse } from "../../computer-use/Services/ComputerUse.ts";
import { BrowserManager } from "../../browser/Services/BrowserManager.ts";
import { BrowserManagerLive } from "../../browser/Layers/BrowserManager.ts";
import { VisibleBrowserControl } from "../../browser/Services/VisibleBrowserControl.ts";
import { ServerConfig } from "../../startup/config.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { ThreadDelegationRepository } from "../../persistence/Services/ThreadDelegations.ts";
import { ThreadDelegationRepositoryLive } from "../../persistence/Layers/ThreadDelegations.ts";
import { ProjectionThreadWatchRepository } from "../../persistence/Services/ProjectionThreadWatches.ts";
import { ProjectionThreadWatchRepositoryLive } from "../../persistence/Layers/ProjectionThreadWatches.ts";
import { ThreadRetentionRepositoryLive } from "../../persistence/Layers/ThreadRetentionRepository.ts";
import { ThreadDeletion, ThreadDeletionLive } from "../../deletion/Services/ThreadDeletion.ts";
import { VisibleBrowserControlLive } from "../../browser/Layers/VisibleBrowserControl.ts";
import { makeThreadStateHydrator } from "./OrchestrationEngine.hydration.ts";
import { makeQueuedPromptFlushCommand } from "../QueuedPromptFlush.logic.ts";
import {
  type CommandEnvelope,
  makeCommandProcessor,
} from "./OrchestrationEngine.commandProcessing.ts";
import { settlePreflightFailure } from "./OrchestrationEngine.preflight.ts";
import { makeDeletionFence } from "./OrchestrationEngine.deletionFence.ts";
import { makeThreadOwnershipResolver } from "./OrchestrationEngine.ownership.ts";
import { makePrepareCommandState } from "./OrchestrationEngine.prepareCommandState.ts";
import { makeCommandOutcomeQuery } from "./OrchestrationEngine.commandOutcome.ts";
import { makeOrchestrationDomainEventDistribution } from "./OrchestrationEngine.domainEvents.ts";
import { installOrchestrationEngineToolDispatchers } from "./OrchestrationEngine.toolDispatcher.ts";
import { calculateCommandPayloadDigest } from "../commandDigest.ts";
import {
  ORCHESTRATION_COMMAND_DEADLINE_MS,
  ORCHESTRATION_COMMAND_QUEUE_CAPACITY,
  ORCHESTRATION_COMMAND_QUEUE_RESERVED_CAPACITY,
  makeBoundedCommandAdmission,
  withCommandAdmissionDeadline,
} from "../../command-admission/CommandAdmission.ts";
const makeOrchestrationEngine = Effect.gen(function* () {
  const eventStore = yield* OrchestrationEventStore;
  const commandReceiptRepository = yield* OrchestrationCommandReceiptRepository;
  const projectionPipeline = yield* OrchestrationProjectionPipeline;
  const operationalQueryOption = yield* Effect.serviceOption(ProjectionOperationalStateQuery);
  const projectionCatalogQuery = yield* Effect.serviceOption(ProjectionCatalogQuery);
  const computerUse = yield* ComputerUse;
  const browser = yield* BrowserManager;
  const visibleBrowser = yield* VisibleBrowserControl;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  const serverSettingsService = yield* ServerSettingsService;
  const threadDelegationRepository = yield* ThreadDelegationRepository;
  const threadWatchRepository = yield* ProjectionThreadWatchRepository;
  const notes = yield* Effect.serviceOption(ProjectionNoteRepository);
  const kanban = yield* Effect.serviceOption(ProjectionKanbanRepository);
  const threadDeletion = yield* ThreadDeletion;

  let readModel = createEmptyReadModel(new Date().toISOString());
  const commandSemaphore = yield* Semaphore.make(1);
  const serverEpoch = crypto.randomUUID();
  const threadStateHydrator = Option.isSome(operationalQueryOption)
    ? makeThreadStateHydrator({
        query: operationalQueryOption.value,
        eventStore,
        readModel: () => readModel,
        install: ({ threadId, thread, project }) => {
          const threads = thread
            ? [...readModel.threads.filter((candidate) => candidate.id !== threadId), thread]
            : readModel.threads.filter((candidate) => candidate.id !== threadId);
          const projects = project
            ? [...readModel.projects.filter((candidate) => candidate.id !== project.id), project]
            : readModel.projects;
          readModel = { ...readModel, projects, threads };
        },
      })
    : null;
  const commandAdmission = yield* makeBoundedCommandAdmission<CommandEnvelope>({
    capacity: ORCHESTRATION_COMMAND_QUEUE_CAPACITY,
    queue: "orchestration",
    reservedCapacity: ORCHESTRATION_COMMAND_QUEUE_RESERVED_CAPACITY,
  });
  const domainEvents = yield* makeOrchestrationDomainEventDistribution({
    initialSequence: () => readModel.snapshotSequence,
    readReplay: eventStore.readReplay,
  });
  const processEnvelope = yield* makeCommandProcessor({
    commandAdmission,
    publishDomainEvent: domainEvents.publish,
    readModel: () => readModel,
    setReadModel: (nextReadModel) => {
      readModel = nextReadModel;
    },
  });

  const prepareCommandState = makePrepareCommandState({ threadStateHydrator });
  const deletionFence = makeDeletionFence({
    threadDeletion,
    readModel: () => readModel,
  });
  yield* projectionPipeline.bootstrap;
  readModel = Option.isSome(operationalQueryOption)
    ? yield* operationalQueryOption.value.getStartupOperationalState()
    : readModel;
  rehydrateThreadTitleLocks([]);
  for (const thread of readModel.threads) {
    const recoveryCommand = makeQueuedPromptFlushCommand({
      threadId: thread.id,
      readModel,
      createdAt: new Date().toISOString(),
    });
    if (recoveryCommand) {
      const result = yield* Deferred.make<{ sequence: number }, OrchestrationDispatchError>();
      yield* commandAdmission.offer(
        {
          command: recoveryCommand,
          payloadDigest: calculateCommandPayloadDigest(recoveryCommand),
          result,
          startedAtMs: Date.now(),
        },
        "internal",
      );
    }
  }
  const worker = Effect.forever(
    commandAdmission.take.pipe(
      Effect.flatMap((envelope) =>
        commandSemaphore.withPermits(1)(
          prepareCommandState(envelope.command).pipe(
            Effect.andThen(deletionFence.assertAllows(envelope.command)),
            Effect.matchEffect({
              onFailure: (error) => {
                if (!Schema.is(OrchestrationCommandInvariantError)(error)) {
                  return Deferred.fail(envelope.result, error as OrchestrationDispatchError).pipe(
                    Effect.asVoid,
                  );
                }
                return settlePreflightFailure({
                  receipts: commandReceiptRepository,
                  readModelSequence: readModel.snapshotSequence,
                  envelope,
                  error,
                });
              },
              onSuccess: () =>
                deletionFence.acquire(envelope.command).pipe(
                  Effect.flatMap((acquired) =>
                    !acquired
                      ? Effect.gen(function* () {
                          const invariant = new OrchestrationCommandInvariantError({
                            commandType: envelope.command.type,
                            detail: "A thread subtree is already being deleted.",
                          });
                          yield* settlePreflightFailure({
                            receipts: commandReceiptRepository,
                            readModelSequence: readModel.snapshotSequence,
                            envelope,
                            error: invariant,
                          });
                        })
                      : processEnvelope(envelope).pipe(
                          Effect.tap((accepted) =>
                            deletionFence.releaseAfterProcess(envelope.command, accepted),
                          ),
                          Effect.asVoid,
                        ),
                  ),
                ),
            }),
          ),
        ),
      ),
    ),
  );
  yield* Effect.forkScoped(worker);
  yield* Effect.forkScoped(
    projectionPipeline.backfillUsageContributions.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("usage contribution backfill failed", {
          cause: Cause.pretty(cause),
        }),
      ),
    ),
  );
  yield* Effect.logDebug("orchestration engine started").pipe(
    Effect.annotateLogs({ sequence: readModel.snapshotSequence }),
  );
  const getReadModel: OrchestrationEngineShape["getReadModel"] = () =>
    Effect.sync((): OrchestrationReadModel => readModel);
  const resolveThreadOwnership = makeThreadOwnershipResolver({
    serverEpoch,
    commandSemaphore,
    eventStore,
    readModel: () => readModel,
    hydrate:
      threadStateHydrator === null
        ? null
        : (threadId) => threadStateHydrator.load(threadId, "operational"),
  });
  const getCommandOutcome: NonNullable<OrchestrationEngineShape["getCommandOutcome"]> =
    makeCommandOutcomeQuery({
      serverEpoch,
      canonicalRevision: () => readModel.snapshotSequence,
      receipts: commandReceiptRepository,
    });
  const readEvents: OrchestrationEngineShape["readEvents"] = (fromSequenceExclusive) =>
    eventStore.readFromSequence(fromSequenceExclusive);
  const readReplay: OrchestrationEngineShape["readReplay"] = (fromSequenceExclusive, limit) =>
    eventStore.readReplay(fromSequenceExclusive, limit);
  const readEventsByCommandId: OrchestrationEngineShape["readEventsByCommandId"] = (commandId) =>
    eventStore.readByCommandId!(commandId);
  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Effect.gen(function* () {
      const result = yield* Deferred.make<{ sequence: number }, OrchestrationDispatchError>();
      yield* commandAdmission.offer({
        command,
        payloadDigest: calculateCommandPayloadDigest(command),
        result,
        startedAtMs: Date.now(),
      });
      return yield* withCommandAdmissionDeadline(Deferred.await(result), {
        queue: "orchestration",
        deadlineMs: ORCHESTRATION_COMMAND_DEADLINE_MS,
      });
    });
  const engine: OrchestrationEngineShape = {
    threadDeletion,
    getCommandOutcome,
    getReadModel,
    resolveThreadOwnership,
    readEvents,
    readEventsByCommandId,
    readReplay,
    openDeliveryLiveCapture: domainEvents.openDeliveryCapture,
    ...(threadStateHydrator === null
      ? {}
      : {
          ensureThreadState: (threadId: ThreadId, level: "operational" | "history") =>
            commandSemaphore
              .withPermits(1)(threadStateHydrator.load(threadId, level))
              .pipe(Effect.orDie),
        }),
    dispatch,
    get streamDomainEvents(): OrchestrationEngineShape["streamDomainEvents"] {
      return domainEvents.streamGeneral();
    },
  };

  yield* installOrchestrationEngineToolDispatchers({
    browser,
    computerUse,
    engine,
    fileSystem,
    kanban,
    notes,
    path,
    projectionCatalogQuery,
    readModel: () => readModel,
    serverConfig,
    serverSettingsService,
    threadDelegationRepository,
    threadWatchRepository,
    visibleBrowser,
  });

  return engine satisfies OrchestrationEngineShape;
});

export const OrchestrationEngineLive = Layer.effect(
  OrchestrationEngineService,
  makeOrchestrationEngine,
).pipe(
  Layer.provide(BrowserManagerLive),
  Layer.provide(VisibleBrowserControlLive),
  Layer.provide(ThreadDelegationRepositoryLive),
  Layer.provide(ProjectionThreadWatchRepositoryLive),
  Layer.provide(ThreadRetentionRepositoryLive),
  Layer.provide(ThreadDeletionLive),
);
