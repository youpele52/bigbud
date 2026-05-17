import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_SERVER_SETTINGS, ProjectId, ThreadId, WsRpcGroup } from "@bigbud/contracts";
import { Effect, FileSystem, Layer, Schedule, Stream } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";

import type { ServerConfigShape } from "./startup/config.ts";
import { deriveServerPaths, ServerConfig } from "./startup/config.ts";
import { makeRoutesLayer } from "./server.ts";
import {
  CheckpointDiffQuery,
  type CheckpointDiffQueryShape,
} from "./checkpointing/Services/CheckpointDiffQuery.ts";
import { GitCore, type GitCoreShape } from "./git/Services/GitCore.ts";
import { GitManager, type GitManagerShape } from "./git/Services/GitManager.ts";
import { GitStatusBroadcaster } from "./git/Services/GitStatusBroadcaster.ts";
import { Keybindings, type KeybindingsShape } from "./keybindings/keybindings.ts";
import { BrowserTraceCollector } from "./observability/Services/BrowserTraceCollector.ts";
import { Open, type OpenShape } from "./utils/open.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ProviderRegistry,
  type ProviderRegistryShape,
} from "./provider/Services/ProviderRegistry.ts";
import { ProviderService, type ProviderServiceShape } from "./provider/Services/ProviderService.ts";
import {
  DiscoveryRegistry,
  type DiscoveryRegistryShape,
} from "./provider/Services/DiscoveryRegistry.ts";
import {
  ServerLifecycleEvents,
  type ServerLifecycleEventsShape,
} from "./startup/serverLifecycleEvents.ts";
import {
  ServerRuntimeStartup,
  type ServerRuntimeStartupShape,
} from "./startup/serverRuntimeStartup.ts";
import { ServerSettingsService, type ServerSettingsShape } from "./ws/serverSettings.ts";
import { TerminalManager, type TerminalManagerShape } from "./terminal/Services/Manager.ts";
import { ProjectFaviconResolverLive } from "./project/Layers/ProjectFaviconResolver.ts";
import {
  ProjectSetupScriptRunner,
  type ProjectSetupScriptRunnerShape,
} from "./project/Services/ProjectSetupScriptRunner.ts";
import {
  ThreadShellRunner,
  type ThreadShellRunnerShape,
} from "./shell/Services/ThreadShellRunner.ts";
import { WorkspaceEntriesLive } from "./workspace/Layers/WorkspaceEntries.ts";
import { WorkspaceFileSystemLive } from "./workspace/Layers/WorkspaceFileSystem.ts";
import { WorkspacePathsLive } from "./workspace/Layers/WorkspacePaths.ts";

export const defaultProjectId = ProjectId.makeUnsafe("project-default");
export const defaultThreadId = ThreadId.makeUnsafe("thread-default");
export const defaultModelSelection = {
  provider: "codex",
  model: "gpt-5-codex",
} as const;

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<void> => {
    if (await predicate()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for expectation.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };

  return poll();
}

export const makeDefaultOrchestrationReadModel = () => {
  const now = new Date().toISOString();
  return {
    snapshotSequence: 0,
    updatedAt: now,
    projects: [
      {
        id: defaultProjectId,
        title: "Default Project",
        workspaceRoot: "/tmp/default-project",
        defaultModelSelection,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletingAt: null,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: defaultThreadId,
        projectId: defaultProjectId,
        title: "Default Thread",
        modelSelection: defaultModelSelection,
        interactionMode: "default" as const,
        runtimeMode: "full-access" as const,
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        latestTurn: null,
        messages: [],
        session: null,
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        deletedAt: null,
      },
    ],
  };
};

export const workspaceAndProjectServicesLayer = Layer.mergeAll(
  WorkspacePathsLive,
  WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive)),
  WorkspaceFileSystemLive.pipe(
    Layer.provide(WorkspacePathsLive),
    Layer.provide(WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive))),
  ),
  ProjectFaviconResolverLive,
);

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
    terminalManager?: Partial<TerminalManagerShape>;
    orchestrationEngine?: Partial<OrchestrationEngineShape>;
    projectionSnapshotQuery?: Partial<ProjectionSnapshotQueryShape>;
    checkpointDiffQuery?: Partial<CheckpointDiffQueryShape>;
    serverLifecycleEvents?: Partial<ServerLifecycleEventsShape>;
    serverRuntimeStartup?: Partial<ServerRuntimeStartupShape>;
  };
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const tempBaseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-router-test-" });
    const baseDir = options?.config?.baseDir ?? tempBaseDir;
    const devUrl = options?.config?.devUrl;
    const derivedPaths = yield* deriveServerPaths(baseDir, devUrl);
    const config: ServerConfigShape = {
      logLevel: "Info",
      traceMinLevel: "Info",
      traceTimingEnabled: true,
      traceBatchWindowMs: 200,
      traceMaxBytes: 10 * 1024 * 1024,
      traceMaxFiles: 10,
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpExportIntervalMs: 10_000,
      otlpServiceName: "t3-server",
      mode: "web",
      port: 0,
      host: "127.0.0.1",
      cwd: process.cwd(),
      baseDir,
      ...derivedPaths,
      staticDir: undefined,
      devUrl,
      noBrowser: true,
      authToken: undefined,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
      ...options?.config,
    };
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
        Layer.mock(Open)({
          ...options?.layers?.open,
        }),
      ),
      Layer.provide(
        Layer.mock(GitCore)({
          ...options?.layers?.gitCore,
        }),
      ),
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
        Layer.mock(ProjectSetupScriptRunner)({
          runForThread: () => Effect.succeed({ status: "no-script" as const }),
          ...options?.layers?.projectSetupScriptRunner,
        }),
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
      Layer.provide(
        Layer.mock(TerminalManager)({
          ...options?.layers?.terminalManager,
        }),
      ),
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
        Layer.mock(ProjectionSnapshotQuery)({
          getSnapshot: () => Effect.succeed(makeDefaultOrchestrationReadModel()),
          ...options?.layers?.projectionSnapshotQuery,
        }),
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
      Layer.provide(workspaceAndProjectServicesLayer),
      Layer.provide(layerConfig),
    );

    yield* Layer.build(appLayer);
    return config;
  });

export const wsRpcProtocolLayer = (wsUrl: string) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(NodeSocket.layerWebSocket(wsUrl)),
    Layer.provide(RpcSerialization.layerJson),
  );

export const makeWsRpcClient = RpcClient.make(WsRpcGroup);
export type WsRpcClient =
  typeof makeWsRpcClient extends Effect.Effect<infer Client, any, any> ? Client : never;

export const wsRpcOpenRetrySchedule = Schedule.spaced("100 millis");

export const withWsRpcClient = <A, E, R>(
  wsUrl: string,
  f: (client: WsRpcClient) => Effect.Effect<A, E, R>,
) => makeWsRpcClient.pipe(Effect.flatMap(f), Effect.provide(wsRpcProtocolLayer(wsUrl)));

export const withRetriedWsRpcClient = <A, E, R>(
  wsUrl: string,
  f: (client: WsRpcClient) => Effect.Effect<A, E, R>,
) =>
  withWsRpcClient(wsUrl, f).pipe(
    Effect.retry({
      schedule: wsRpcOpenRetrySchedule,
      times: 5,
      while: (error) => String(error).includes("SocketOpenError"),
    }),
  );

export const getHttpServerUrl = (pathname = "") =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address as HttpServer.TcpAddress;
    return `http://127.0.0.1:${address.port}${pathname}`;
  });

export const getWsServerUrl = (pathname = "") =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address as HttpServer.TcpAddress;
    return `ws://127.0.0.1:${address.port}${pathname}`;
  });

export const serverTestLayer = NodeServices.layer;
