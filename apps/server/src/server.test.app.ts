import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts";
import { Effect, Layer, Option, Stream } from "effect";
import { HttpRouter } from "effect/unstable/http";

import {
  CheckpointDiffQuery,
  type CheckpointDiffQueryShape,
} from "./checkpointing/Services/CheckpointDiffQuery.ts";
import { GitCore, type GitCoreShape } from "./git/Services/GitCore.ts";
import { GitManager, type GitManagerShape } from "./git/Services/GitManager.ts";
import { GitStatusBroadcaster } from "./git/Services/GitStatusBroadcaster.ts";
import { Keybindings, type KeybindingsShape } from "./keybindings/keybindings.ts";
import {
  MobileRemoteControl,
  type MobileRemoteControlShape,
} from "./mobile/Services/MobileRemoteControl.ts";
import { BrowserTraceCollector } from "./observability/Services/BrowserTraceCollector.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { SchedulerReactor } from "./orchestration/Services/SchedulerReactor.ts";
import { ProjectionKanbanRepository } from "./persistence/Services/ProjectionKanban.ts";
import { ProjectionNoteRepository } from "./persistence/Services/ProjectionNotes.ts";
import { AutomationScheduleRepository } from "./persistence/Services/AutomationScheduleRepository.ts";
import {
  ProjectionThreadRepository,
  type ProjectionThreadRepositoryShape,
} from "./persistence/Services/ProjectionThreads.ts";
import {
  ProjectSetupScriptRunner,
  type ProjectSetupScriptRunnerShape,
} from "./project/Services/ProjectSetupScriptRunner.ts";
import {
  DiscoveryRegistry,
  type DiscoveryRegistryShape,
} from "./provider/Services/DiscoveryRegistry.ts";
import {
  ProviderRegistry,
  type ProviderRegistryShape,
} from "./provider/Services/ProviderRegistry.ts";
import { ProviderService, type ProviderServiceShape } from "./provider/Services/ProviderService.ts";
import { makeRoutesLayer } from "./server.ts";
import {
  ThreadShellRunner,
  type ThreadShellRunnerShape,
} from "./shell/Services/ThreadShellRunner.ts";
import type { ServerConfigShape } from "./startup/config.ts";
import { ServerConfig } from "./startup/config.ts";
import {
  ServerLifecycleEvents,
  type ServerLifecycleEventsShape,
} from "./startup/serverLifecycleEvents.ts";
import {
  ServerRuntimeStartup,
  type ServerRuntimeStartupShape,
} from "./startup/serverRuntimeStartup.ts";
import { TerminalManager, type TerminalManagerShape } from "./terminal/Services/Manager.ts";
import { Open, type OpenShape } from "./utils/open.ts";
import { buildTestServerConfig } from "./server.test.app.config.ts";
import {
  workspaceAndProjectServicesLayer,
  makeDefaultOrchestrationReadModel,
  defaultThreadId,
} from "./server.test.fixtures.ts";
import { ServerSettingsService, type ServerSettingsShape } from "./ws/serverSettings.ts";

export const buildAppUnderTest = (options?: {
  config?: Partial<ServerConfigShape>;
  layers?: {
    keybindings?: Partial<KeybindingsShape>;
    providerRegistry?: Partial<ProviderRegistryShape>;
    providerService?: Partial<ProviderServiceShape>;
    discoveryRegistry?: Partial<DiscoveryRegistryShape>;
    serverSettings?: Partial<ServerSettingsShape>;
    open?: Partial<OpenShape>;
    gitCore?: Partial<GitCoreShape>;
    gitManager?: Partial<GitManagerShape>;
    projectSetupScriptRunner?: Partial<ProjectSetupScriptRunnerShape>;
    threadShellRunner?: Partial<ThreadShellRunnerShape>;
    mobileRemoteControl?: Partial<MobileRemoteControlShape>;
    terminalManager?: Partial<TerminalManagerShape>;
    orchestrationEngine?: Partial<OrchestrationEngineShape>;
    projectionSnapshotQuery?: Partial<ProjectionSnapshotQueryShape>;
    projectionThreadRepository?: Partial<ProjectionThreadRepositoryShape>;
    checkpointDiffQuery?: Partial<CheckpointDiffQueryShape>;
    serverLifecycleEvents?: Partial<ServerLifecycleEventsShape>;
    serverRuntimeStartup?: Partial<ServerRuntimeStartupShape>;
  };
}) =>
  Effect.gen(function* () {
    const config = yield* buildTestServerConfig(options);
    const layerConfig = Layer.succeed(ServerConfig, config);

    const appLayer = HttpRouter.serve(makeRoutesLayer, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provide(
        Layer.mock(Keybindings)({
          streamChanges: Stream.empty,
          ...options?.layers?.keybindings,
        }),
      ),
      Layer.provide(
        Layer.mock(ProviderRegistry)({
          getProviders: Effect.succeed([]),
          refresh: () => Effect.succeed([]),
          streamChanges: Stream.empty,
          ...options?.layers?.providerRegistry,
        }),
      ),
      Layer.provide(
        Layer.mock(ProviderService)({
          startSession: () => Effect.die("not implemented"),
          startSessionFresh: () => Effect.die("not implemented"),
          sendTurn: () => Effect.die("not implemented"),
          interruptTurn: () => Effect.die("not implemented"),
          respondToRequest: () => Effect.die("not implemented"),
          respondToUserInput: () => Effect.die("not implemented"),
          stopSession: () => Effect.die("not implemented"),
          listSessions: () => Effect.succeed([]),
          getCapabilities: () => Effect.die("not implemented"),
          rollbackConversation: () => Effect.die("not implemented"),
          streamEvents: Stream.empty,
          ...options?.layers?.providerService,
        }),
      ),
      Layer.provide(
        Layer.mock(DiscoveryRegistry)({
          getCatalog: Effect.succeed({ agents: [], skills: [] }),
          refresh: () => Effect.succeed({ agents: [], skills: [] }),
          streamChanges: Stream.empty,
          ...options?.layers?.discoveryRegistry,
        }),
      ),
      Layer.provide(
        Layer.mock(ServerSettingsService)({
          start: Effect.void,
          ready: Effect.void,
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
          updateSettings: () => Effect.succeed(DEFAULT_SERVER_SETTINGS),
          streamChanges: Stream.empty,
          ...options?.layers?.serverSettings,
        }),
      ),
      Layer.provide(
        Layer.mock(MobileRemoteControl)({
          createPairing: () => Effect.die("not implemented"),
          getPairingStatus: () => Effect.succeed(null),
          exchangePairing: () => Effect.die("not implemented"),
          listSessions: Effect.succeed([]),
          revokeSession: () => Effect.void,
          validateSessionToken: () => Effect.succeed(null),
          ...options?.layers?.mobileRemoteControl,
        }),
      ),
      Layer.provide(Layer.mock(Open)({ ...options?.layers?.open })),
      Layer.provide(Layer.mock(GitCore)({ ...options?.layers?.gitCore })),
      Layer.provide(
        Layer.mock(GitManager)({
          invalidateStatus: () => Effect.void,
          ...options?.layers?.gitManager,
        }),
      ),
      Layer.provide(
        Layer.mock(GitStatusBroadcaster)({
          subscribe: () => Effect.succeed(Stream.empty),
          refreshLocalStatus: () =>
            Effect.succeed({
              isRepo: true,
              hasOriginRemote: false,
              isDefaultBranch: true,
              branch: "main",
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
            }),
          invalidateLocal: () => Effect.void,
          invalidateRemote: () => Effect.void,
        }),
      ),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionKanbanRepository)({
            list: () => Effect.succeed([]),
            getById: () => Effect.succeed(Option.none()),
            create: (input) =>
              Effect.succeed({
                cardId: "mock-card-id" as never,
                projectId: input.projectId,
                title: input.title,
                status: input.status,
                absolutePath: "/mock/kanban/global/mock.md",
                content: input.content,
                createdAt: input.createdAt,
                updatedAt: input.updatedAt,
              }),
            update: (input) =>
              Effect.succeed({
                cardId: input.cardId,
                projectId: null,
                title: input.title,
                status: "backlog" as const,
                absolutePath: "/mock/kanban/global/mock.md",
                content: input.content,
                createdAt: input.updatedAt,
                updatedAt: input.updatedAt,
              }),
            move: (input) =>
              Effect.succeed({
                cardId: input.cardId,
                projectId: null,
                title: "Mock card",
                status: input.status,
                absolutePath: "/mock/kanban/global/mock.md",
                content: "# Mock card\n",
                createdAt: input.updatedAt,
                updatedAt: input.updatedAt,
              }),
            reorderWithinStatus: (input) =>
              Effect.succeed({
                cardId: input.cardId,
                projectId: null,
                title: "Mock card",
                status: input.status,
                absolutePath: "/mock/kanban/global/mock.md",
                content: "# Mock card\n",
                createdAt: input.updatedAt,
                updatedAt: input.updatedAt,
              }),
            deleteById: () => Effect.void,
          }),
          Layer.mock(ProjectionNoteRepository)({
            list: () => Effect.succeed([]),
            getById: () => Effect.succeed(Option.none()),
            create: (input) =>
              Effect.succeed({
                noteId: "mock-note-id" as never,
                projectId: input.projectId,
                title: input.title,
                absolutePath: "/mock/notes/global/mock.md",
                content: input.content,
                createdAt: input.createdAt,
                updatedAt: input.updatedAt,
              }),
            update: (input) =>
              Effect.succeed({
                noteId: input.noteId,
                projectId: null,
                title: input.title,
                absolutePath: "/mock/notes/global/mock.md",
                content: input.content,
                createdAt: input.updatedAt,
                updatedAt: input.updatedAt,
              }),
            deleteById: () => Effect.void,
          }),
          Layer.mock(ProjectSetupScriptRunner)({
            runForThread: () => Effect.succeed({ status: "no-script" as const }),
            ...options?.layers?.projectSetupScriptRunner,
          }),
        ),
      ),
      Layer.provide(
        Layer.mock(ThreadShellRunner)({
          run: ({ command, cwd }) =>
            Effect.succeed({
              output: command.trim() === "pwd" ? cwd : "",
              exitCode: 0,
            }),
          closeThread: () => Effect.void,
          ...options?.layers?.threadShellRunner,
        }),
      ),
      Layer.provide(Layer.mock(TerminalManager)({ ...options?.layers?.terminalManager })),
      Layer.provide(
        Layer.mock(OrchestrationEngineService)({
          getReadModel: () => Effect.succeed(makeDefaultOrchestrationReadModel()),
          readEvents: () => Stream.empty,
          dispatch: () => Effect.succeed({ sequence: 0 }),
          streamDomainEvents: Stream.empty,
          ...options?.layers?.orchestrationEngine,
        }),
      ),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionSnapshotQuery)({
            getSnapshot: () => Effect.succeed(makeDefaultOrchestrationReadModel()),
            ...options?.layers?.projectionSnapshotQuery,
          }),
          Layer.mock(ProjectionThreadRepository)({
            getById: ({ threadId }) => {
              const thread = makeDefaultOrchestrationReadModel().threads.find(
                (candidate) => candidate.id === threadId,
              );
              return Effect.succeed(
                thread
                  ? Option.some({
                      threadId: thread.id,
                      projectId: thread.projectId,
                      title: thread.title,
                      purpose: "standard",
                      elevatorSummary: thread.elevatorSummary,
                      elevatorSummaryMessageCount: thread.elevatorSummaryMessageCount,
                      providerRuntimeExecutionTargetId: "local",
                      workspaceExecutionTargetId: "local",
                      executionTargetId: "local",
                      modelSelection: thread.modelSelection,
                      runtimeMode: thread.runtimeMode,
                      interactionMode: thread.interactionMode,
                      branch: thread.branch,
                      worktreePath: thread.worktreePath,
                      latestTurnId: null,
                      createdAt: thread.createdAt,
                      updatedAt: thread.updatedAt,
                      archivedAt: thread.archivedAt,
                      deletingAt: null,
                      deletedAt: thread.deletedAt,
                    })
                  : Option.none(),
              );
            },
            listByProjectId: () => Effect.succeed([]),
            upsert: () => Effect.void,
            deleteById: () => Effect.void,
            ...options?.layers?.projectionThreadRepository,
          }),
          Layer.mock(AutomationScheduleRepository)({
            create: () => Effect.die("not implemented"),
            getById: () => Effect.succeed(Option.none()),
            listByProject: () => Effect.succeed([]),
            listAll: () => Effect.succeed([]),
            claimDue: () => Effect.succeed([]),
            update: () => Effect.die("not implemented"),
            updateNextRun: () => Effect.void,
            pause: () => Effect.void,
            resume: () => Effect.void,
            complete: () => Effect.void,
            delete: () => Effect.void,
            recordRunStarted: () => Effect.void,
            recordRunDispatched: () => Effect.void,
            recordRunFinished: () => Effect.void,
            recordRunFailed: () => Effect.void,
            listRuns: () => Effect.succeed([]),
            claimOccurrence: () => Effect.succeed(Option.none()),
            getRunByOccurrence: () => Effect.succeed(Option.none()),
            getStartedRunByMessageId: () => Effect.succeed(Option.none()),
            listStartedRuns: () => Effect.succeed([]),
            releaseLease: () => Effect.void,
          }),
          Layer.mock(SchedulerReactor)({
            start: () => Effect.void,
            triggerNow: () => Effect.succeed({ status: "dispatched" as const }),
          }),
        ),
      ),
      Layer.provide(
        Layer.mock(CheckpointDiffQuery)({
          getTurnDiff: () =>
            Effect.succeed({
              threadId: defaultThreadId,
              fromTurnCount: 0,
              toTurnCount: 0,
              diff: "",
            }),
          getFullThreadDiff: () =>
            Effect.succeed({
              threadId: defaultThreadId,
              fromTurnCount: 0,
              toTurnCount: 0,
              diff: "",
            }),
          ...options?.layers?.checkpointDiffQuery,
        }),
      ),
      Layer.provide(
        Layer.mock(ServerLifecycleEvents)({
          publish: (event) => Effect.succeed({ ...(event as any), sequence: 1 }),
          snapshot: Effect.succeed({ sequence: 0, events: [] }),
          stream: Stream.empty,
          ...options?.layers?.serverLifecycleEvents,
        }),
      ),
      Layer.provide(
        Layer.mock(ServerRuntimeStartup)({
          awaitCommandReady: Effect.void,
          markHttpListening: Effect.void,
          enqueueCommand: (effect) => effect,
          ...options?.layers?.serverRuntimeStartup,
        }),
      ),
      Layer.provide(
        Layer.mock(BrowserTraceCollector)({
          record: () => Effect.void,
        }),
      ),
      (layer) =>
        layer.pipe(Layer.provide(workspaceAndProjectServicesLayer), Layer.provide(layerConfig)),
    );

    yield* Layer.build(appLayer);
    return config;
  });
