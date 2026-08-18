import type { OrchestrationEvent, OrchestrationReadModel, ThreadId } from "@bigbud/contracts";
import { OrchestrationCommand } from "@bigbud/contracts";
import {
  Cause,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  PubSub,
  Queue,
  Semaphore,
  Stream,
} from "effect";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationCommandInvariantError, type OrchestrationDispatchError } from "../Errors.ts";
import { createEmptyReadModel } from "../projectorReadModel.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionOperationalStateQuery } from "../Services/ProjectionOperationalStateQuery.ts";
import { ProjectionCatalogQuery } from "../Services/ProjectionCatalogQuery.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { computerUseViaOrchestration } from "../../orchestration-tools/ThreadComputerUseTools.ts";
import { browserViaOrchestration } from "../../orchestration-tools/ThreadBrowserTools.ts";
import {
  archiveThreadViaOrchestration as archiveThreadViaThreadTools,
  getThreadStatusViaOrchestration as getThreadStatusViaThreadTools,
  listPinnedThreadsViaOrchestration as listPinnedThreadsViaThreadTools,
  renameThreadViaOrchestration as renameThreadViaThreadTools,
  setThreadPinnedViaOrchestration as setThreadPinnedViaThreadTools,
  createThreadViaOrchestration,
} from "../../orchestration-tools/ThreadOrchestrationTools.ts";
import { sendThreadMessageViaOrchestration } from "../../orchestration-tools/ThreadOrchestrationTools.sendMessage.ts";
import { listThreadsViaOrchestration } from "../../orchestration-tools/ThreadOrchestrationTools.listThreads.ts";
import { setThreadOrchestrationToolDispatcher } from "../../orchestration-tools/ThreadOrchestrationToolDispatcher.ts";
import { makeAgentWorkspaceTool } from "../../orchestration-tools/AgentWorkspaceTools.ts";
import { ProjectionNoteRepository } from "../../persistence/Services/ProjectionNotes.ts";
import { ProjectionKanbanRepository } from "../../persistence/Services/ProjectionKanban.ts";
import { rehydrateThreadTitleLocks } from "../../orchestration-tools/ThreadTitleLock.ts";
import { ComputerUse } from "../../computer-use/Services/ComputerUse.ts";
import { BrowserManager } from "../../browser/Services/BrowserManager.ts";
import { BrowserManagerLive } from "../../browser/Layers/BrowserManager.ts";
import {
  setVisibleBrowserControl,
  VisibleBrowserControl,
} from "../../browser/Services/VisibleBrowserControl.ts";
import { ServerConfig } from "../../startup/config.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts";
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
  commandToAggregateRef,
  type CommandEnvelope,
  makeCommandProcessor,
} from "./OrchestrationEngine.commandProcessing.ts";
import { makeDeletionFence } from "./OrchestrationEngine.deletionFence.ts";

const makeOrchestrationEngine = Effect.gen(function* () {
  const eventStore = yield* OrchestrationEventStore;
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

  const commandQueue = yield* Queue.unbounded<CommandEnvelope>();
  const eventPubSub = yield* PubSub.unbounded<OrchestrationEvent>();

  const processEnvelope = yield* makeCommandProcessor({
    commandQueue,
    eventPubSub,
    readModel: () => readModel,
    setReadModel: (nextReadModel) => {
      readModel = nextReadModel;
    },
  });

  const prepareCommandState = (command: OrchestrationCommand) => {
    if (threadStateHydrator === null) {
      return Effect.void;
    }
    if (command.type === "thread.create") {
      return Effect.gen(function* () {
        yield* threadStateHydrator.load(command.threadId, "operational");
        if (
          command.parentThread !== undefined &&
          command.parentThread.threadId !== command.threadId
        ) {
          yield* threadStateHydrator.load(command.parentThread.threadId, "operational");
        }
      });
    }
    const aggregate = commandToAggregateRef(command);
    if (aggregate.aggregateKind !== "thread") {
      return Effect.void;
    }
    const historyRequired =
      command.type === "thread.turn.start" ||
      command.type === "thread.checkpoint.revert" ||
      command.type === "thread.revert.complete";
    return Effect.gen(function* () {
      yield* threadStateHydrator.load(
        aggregate.aggregateId as ThreadId,
        historyRequired ? "history" : "operational",
      );
      if (command.type === "thread.turn.start" && command.sourceProposedPlan) {
        yield* threadStateHydrator.load(command.sourceProposedPlan.threadId, "history");
      }
    });
  };

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
      yield* Queue.offer(commandQueue, {
        command: recoveryCommand,
        result,
        startedAtMs: Date.now(),
      });
    }
  }

  const worker = Effect.forever(
    Queue.take(commandQueue).pipe(
      Effect.flatMap((envelope) =>
        commandSemaphore.withPermits(1)(
          prepareCommandState(envelope.command).pipe(
            Effect.andThen(deletionFence.assertAllows(envelope.command)),
            Effect.matchEffect({
              onFailure: (error) =>
                Deferred.fail(
                  envelope.result,
                  new OrchestrationCommandInvariantError({
                    commandType: envelope.command.type,
                    detail: error instanceof Error ? error.message : String(error),
                  }),
                ).pipe(Effect.asVoid),
              onSuccess: () =>
                deletionFence.acquire(envelope.command).pipe(
                  Effect.flatMap((acquired) =>
                    !acquired
                      ? Deferred.fail(
                          envelope.result,
                          new OrchestrationCommandInvariantError({
                            commandType: envelope.command.type,
                            detail: "A thread subtree is already being deleted.",
                          }),
                        ).pipe(Effect.asVoid)
                      : processEnvelope(envelope).pipe(
                          Effect.tap((accepted) =>
                            (envelope.command.type === "thread.delete" && !accepted) ||
                            (envelope.command.type === "thread.delete.finalize" && accepted) ||
                            (envelope.command.type === "thread.delete.abort" && accepted)
                              ? deletionFence.release(envelope.command)
                              : Effect.void,
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

  const readEvents: OrchestrationEngineShape["readEvents"] = (fromSequenceExclusive) =>
    eventStore.readFromSequence(fromSequenceExclusive);
  const readReplay: OrchestrationEngineShape["readReplay"] = (fromSequenceExclusive) =>
    eventStore.readReplay(fromSequenceExclusive);
  const readEventsByCommandId: OrchestrationEngineShape["readEventsByCommandId"] = (commandId) =>
    eventStore.readByCommandId!(commandId);

  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Effect.gen(function* () {
      const result = yield* Deferred.make<{ sequence: number }, OrchestrationDispatchError>();
      yield* Queue.offer(commandQueue, { command, result, startedAtMs: Date.now() });
      return yield* Deferred.await(result);
    });

  const engine: OrchestrationEngineShape = {
    threadDeletion,
    getReadModel,
    readEvents,
    readEventsByCommandId,
    readReplay,
    ...(threadStateHydrator === null
      ? {}
      : {
          ensureThreadState: (threadId: ThreadId, level: "operational" | "history") =>
            commandSemaphore
              .withPermits(1)(threadStateHydrator.load(threadId, level))
              .pipe(Effect.orDie),
        }),
    dispatch,
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (wsServer, ProviderRuntimeIngestion, CheckpointReactor, etc.)
    // each independently receive all domain events.
    get streamDomainEvents(): OrchestrationEngineShape["streamDomainEvents"] {
      return Stream.fromPubSub(eventPubSub);
    },
  };

  setThreadOrchestrationToolDispatcher({
    ...(Option.isSome(notes) && Option.isSome(kanban)
      ? {
          workspace: makeAgentWorkspaceTool({
            readModel: () => readModel,
            notes: notes.value,
            kanban: kanban.value,
          }),
        }
      : {}),
    rename: (input) =>
      renameThreadViaThreadTools({
        orchestrationEngine: engine,
        threadId: input.threadId,
        title: input.title,
      }),
    archive: (input) =>
      archiveThreadViaThreadTools({
        orchestrationEngine: engine,
        threadId: input.threadId,
      }),
    getStatus: (input) =>
      getThreadStatusViaThreadTools({
        orchestrationEngine: engine,
        threadDelegationRepository: input.threadDelegationRepository ?? threadDelegationRepository,
        callerThreadId: input.callerThreadId,
        threadId: input.threadId,
      }),
    listPinned: (input) =>
      listPinnedThreadsViaThreadTools({
        orchestrationEngine: engine,
        callerThreadId: input.callerThreadId,
      }),
    ...(Option.isSome(projectionCatalogQuery)
      ? {
          listThreads: (input) =>
            listThreadsViaOrchestration({
              projectionCatalogQuery: projectionCatalogQuery.value,
              ...input,
            }),
        }
      : {}),
    setPinned: (input) =>
      setThreadPinnedViaThreadTools({
        orchestrationEngine: engine,
        callerThreadId: input.callerThreadId,
        threadId: input.threadId,
        pinned: input.pinned,
      }),
    sendMessage: (input) =>
      sendThreadMessageViaOrchestration({ orchestrationEngine: engine, ...input }),
    computerUse: (input) =>
      Effect.gen(function* () {
        const settings = yield* serverSettingsService.getSettings.pipe(
          Effect.catch(() => Effect.succeed(DEFAULT_SERVER_SETTINGS)),
        );
        return yield* computerUseViaOrchestration({
          attachmentsDir: serverConfig.attachmentsDir,
          computerUse,
          computerUseEnabled: settings.computerUseEnabled,
          fileSystem,
          orchestrationEngine: engine,
          path,
          serverMode: serverConfig.mode,
          threadId: input.threadId,
          action: input.action,
          checkInIntervalMs: settings.computerUseCheckInIntervalMs,
          actionTimeoutMs: settings.computerUseActionTimeoutMs,
        });
      }),
    browser: (input) =>
      Effect.gen(function* () {
        const requestedTarget = input.action.target ?? "auto";
        if (requestedTarget === "visible" || (requestedTarget === "auto" && input.action.tabId)) {
          const thread = readModel.threads.find((candidate) => candidate.id === input.threadId);
          const turnId =
            thread?.session?.status === "running"
              ? (thread.session.activeTurnId ??
                (thread.latestTurn?.state === "running" ? thread.latestTurn.turnId : null))
              : null;
          if (!turnId) {
            return yield* Effect.fail(
              new Error("The visible browser requires an active agent turn."),
            );
          }
          return yield* visibleBrowser.execute({
            threadId: input.threadId,
            turnId,
            action: input.action,
          });
        }
        return yield* browserViaOrchestration({
          browser,
          threadId: input.threadId,
          action: input.action,
        });
      }),
    createThread: (input) =>
      createThreadViaOrchestration({
        orchestrationEngine: engine,
        threadDelegationRepository,
        projectionThreadWatchRepository: threadWatchRepository,
        callerThreadId: input.callerThreadId,
        sourceMessageId: input.sourceMessageId,
        invocationId: input.invocationId,
        title: input.title,
        task: input.task,
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
        watchForCompletion: input.watchForCompletion,
      }),
  });
  setVisibleBrowserControl(visibleBrowser);

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      setThreadOrchestrationToolDispatcher(null);
      setVisibleBrowserControl(null);
      yield* computerUse.dispose;
    }),
  );

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
