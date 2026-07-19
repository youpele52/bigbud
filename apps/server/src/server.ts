import path from "node:path";

import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http";

import { ServerConfig } from "./startup/config";
import {
  attachmentsRouteLayer,
  otlpTracesProxyRouteLayer,
  projectFaviconRouteLayer,
  staticAndDevRouteLayer,
  workspacePdfViewerRouteLayer,
  workspaceFilePreviewRouteLayer,
} from "./ws/http";
import { mobilePairingRoutesLayer } from "./ws/http.mobile";
import { mobileWebStaticRouteLayer } from "./ws/http.mobileWeb";
import { threadOrchestrationToolsRouteLayer } from "./ws/http.threadTools";
import { fixPath } from "./utils/os-jank";
import { websocketRpcRouteLayer } from "./ws/ws";
import { mobileWebsocketRpcRouteLayer } from "./ws/ws.mobile";
import { OpenLive } from "./utils/open";
import { layerConfig as SqlitePersistenceLayerLive } from "./persistence/Layers/Sqlite";
import { ServerLifecycleEventsLive } from "./startup/serverLifecycleEvents";
import { AnalyticsServiceLayerLive } from "./telemetry/Layers/AnalyticsService";
import {
  cleanupProviderLogDirectories,
  makeEventNdjsonLogger,
} from "./provider/Layers/EventNdjsonLogger";
import { ProviderSessionDirectoryLive } from "./provider/Layers/ProviderSessionDirectory";
import { ProviderSessionRuntimeRepositoryLive } from "./persistence/Layers/ProviderSessionRuntime";
import { makeCodexAdapterLive } from "./provider/Layers/Codex/Adapter";
import { makeClaudeAdapterLive } from "./provider/Layers/Claude/Adapter";
import { makeCopilotAdapterLive } from "./provider/Layers/Copilot/Adapter";
import { makeCursorAdapterLive } from "./provider/Layers/Cursor/Adapter";
import { makeDevinAdapterLive } from "./provider/Layers/Devin/Adapter";
import { makeKilocodeAdapterLive } from "./provider/Layers/Kilocode/Adapter";
import { makeOpencodeAdapterLive } from "./provider/Layers/Opencode/Adapter";
import { makePiAdapterLive } from "./provider/Layers/Pi/Adapter";
import { CliProxyAdapterLive } from "./provider/Layers/CliProxy/Adapter";
import { CliProxyProviderLive } from "./provider/Layers/CliProxy/Provider";
import { isCliProxyExperimentEnabled } from "./provider/Layers/CliProxy/config";
import { OpencodeServerManagerLive } from "./provider/Layers/Opencode/ServerManager";
import { ProviderAdapterRegistryLive } from "./provider/Layers/ProviderAdapterRegistry";
import { makeProviderServiceLive } from "./provider/Layers/ProviderService";
import { OrchestrationEngineLive } from "./orchestration/Layers/OrchestrationEngine";
import { OrchestrationProjectionPipelineLive } from "./orchestration/Layers/ProjectionPipeline";
import { OrchestrationEventStoreLive } from "./persistence/Layers/OrchestrationEventStore";
import { OrchestrationCommandReceiptRepositoryLive } from "./persistence/Layers/OrchestrationCommandReceipts";
import { AutomationScheduleRepositoryLive } from "./persistence/Layers/AutomationScheduleRepository";
import { CheckpointDiffQueryLive } from "./checkpointing/Layers/CheckpointDiffQuery";
import { OrchestrationProjectionSnapshotQueryLive } from "./orchestration/Layers/ProjectionSnapshotQuery";
import { CheckpointStoreLive } from "./checkpointing/Layers/CheckpointStore";
import { GitCoreLive } from "./git/Layers/GitCore";
import { GitHubCliLive } from "./git/Layers/GitHubCli";
import { RoutingTextGenerationLive } from "./git/Layers/RoutingTextGeneration";
import { TerminalManagerLive } from "./terminal/Layers/Manager";
import { GitManagerLive } from "./git/Layers/GitManager";
import { GitStatusBroadcasterLive } from "./git/Layers/GitStatusBroadcaster";
import { KeybindingsLive } from "./keybindings/keybindings";
import { ServerRuntimeStartup, ServerRuntimeStartupLive } from "./startup/serverRuntimeStartup";
import { OrchestrationReactorLive } from "./orchestration/Layers/OrchestrationReactor";
import {
  DefaultSchedulerConfigLive,
  SchedulerReactorLive,
} from "./orchestration/Layers/SchedulerReactor";
import { RuntimeReceiptBusLive } from "./orchestration/Layers/RuntimeReceiptBus";
import { ProviderRuntimeIngestionLive } from "./orchestration/Layers/ProviderRuntimeIngestion";
import { ProviderCommandReactorLive } from "./orchestration/Layers/ProviderCommandReactor";
import { CheckpointReactorLive } from "./orchestration/Layers/CheckpointReactor";
import { ThreadWatchReactorLive } from "./orchestration/Layers/ThreadWatchReactor";
import { ProviderRegistryLive } from "./provider/Layers/ProviderRegistry";
import { DiscoveryRegistryLive } from "./provider/Layers/DiscoveryRegistry";
import { ServerSettingsLive } from "./ws/serverSettings";
import { ProjectFaviconResolverLive } from "./project/Layers/ProjectFaviconResolver";
import { WorkspaceEntriesLive } from "./workspace/Layers/WorkspaceEntries";
import { WorkspaceFileSystemLive } from "./workspace/Layers/WorkspaceFileSystem";
import { WorkspacePathsLive } from "./workspace/Layers/WorkspacePaths";
import { ProjectSetupScriptRunnerLive } from "./project/Layers/ProjectSetupScriptRunner";
import { ObservabilityLive } from "./observability/Layers/Observability";
import { BrowserManagerLive } from "./browser/Layers/BrowserManager";
import { CuaDriverLive } from "./computer-use/Layers/CuaDriver";
import { ComputerUseLive } from "./computer-use/Layers/ComputerUse";
import { ThreadShellRunnerLive } from "./shell/Layers/ThreadShellRunner";
import { ProjectionNoteRepositoryLive } from "./persistence/Layers/ProjectionNotes";
import { ProjectionKanbanRepositoryLive } from "./persistence/Layers/ProjectionKanban";
import { ProjectionThreadRepositoryLive } from "./persistence/Layers/ProjectionThreads";
import { ProjectionThreadWatchRepositoryLive } from "./persistence/Layers/ProjectionThreadWatches";
import { LearningJobRepositoryLive } from "./persistence/Layers/LearningJobs";
import { SkillChangeProposalRepositoryLive } from "./persistence/Layers/SkillChangeProposals";
import { LearningReactorLive } from "./orchestration/Layers/LearningReactor";
import { MemoryStoreLive } from "./learning/Layers/MemoryStore";
import { MobileRemoteControlLive } from "./mobile/Layers/MobileRemoteControl";

const PtyAdapterLive = Layer.unwrap(
  Effect.gen(function* () {
    if (typeof Bun !== "undefined") {
      const BunPTY = yield* Effect.promise(() => import("./terminal/Layers/BunPTY"));
      return BunPTY.layer;
    } else {
      const NodePTY = yield* Effect.promise(() => import("./terminal/Layers/NodePTY"));
      return NodePTY.layer;
    }
  }),
);

const HttpServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    if (typeof Bun !== "undefined") {
      const BunHttpServer = yield* Effect.promise(
        () => import("@effect/platform-bun/BunHttpServer"),
      );
      return BunHttpServer.layer({
        port: config.port,
        ...(config.host ? { hostname: config.host } : {}),
      });
    } else {
      const [NodeHttpServer, NodeHttp] = yield* Effect.all([
        Effect.promise(() => import("@effect/platform-node/NodeHttpServer")),
        Effect.promise(() => import("node:http")),
      ]);
      return NodeHttpServer.layer(NodeHttp.createServer, {
        host: config.host,
        port: config.port,
      });
    }
  }),
);

const PlatformServicesLive = Layer.unwrap(
  Effect.gen(function* () {
    if (typeof Bun !== "undefined") {
      const { layer } = yield* Effect.promise(() => import("@effect/platform-bun/BunServices"));
      return layer;
    } else {
      const { layer } = yield* Effect.promise(() => import("@effect/platform-node/NodeServices"));
      return layer;
    }
  }),
);

const ReactorLayerLive = Layer.empty.pipe(
  Layer.provideMerge(OrchestrationReactorLive.pipe(Layer.provide(LearningReactorLive))),
  Layer.provideMerge(ProviderRuntimeIngestionLive),
  Layer.provideMerge(ProviderCommandReactorLive),
  Layer.provideMerge(CheckpointReactorLive),
  Layer.provideMerge(SchedulerReactorLive),
  Layer.provideMerge(ThreadWatchReactorLive),
  Layer.provideMerge(RuntimeReceiptBusLive),
  Layer.provideMerge(DefaultSchedulerConfigLive),
);

const OrchestrationEventInfrastructureLayerLive = Layer.mergeAll(
  OrchestrationEventStoreLive,
  OrchestrationCommandReceiptRepositoryLive,
);

const AutomationInfrastructureLayerLive = AutomationScheduleRepositoryLive;

const OrchestrationProjectionPipelineLayerLive = OrchestrationProjectionPipelineLive.pipe(
  Layer.provide(OrchestrationEventStoreLive),
);

const OrchestrationInfrastructureLayerLive = Layer.mergeAll(
  OrchestrationProjectionSnapshotQueryLive,
  OrchestrationEventInfrastructureLayerLive,
  AutomationInfrastructureLayerLive,
  OrchestrationProjectionPipelineLayerLive,
);

const OrchestrationLayerLive = Layer.mergeAll(
  OrchestrationInfrastructureLayerLive,
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationInfrastructureLayerLive),
    Layer.provide(
      ComputerUseLive.pipe(Layer.provide(BrowserManagerLive), Layer.provide(CuaDriverLive)),
    ),
  ),
);

const CheckpointingLayerLive = Layer.empty.pipe(
  Layer.provideMerge(CheckpointDiffQueryLive),
  Layer.provideMerge(CheckpointStoreLive),
);

const ProviderLayerLive = Layer.unwrap(
  Effect.gen(function* () {
    const { baseDir, devUrl, providerEventLogPath } = yield* ServerConfig;
    yield* cleanupProviderLogDirectories([
      path.join(baseDir, "userdata", "logs", "provider"),
      path.join(baseDir, "dev", "logs", "provider"),
    ]);
    const nativeEventLogger =
      devUrl !== undefined
        ? yield* makeEventNdjsonLogger(providerEventLogPath, {
            stream: "native",
          })
        : undefined;
    const canonicalEventLogger =
      devUrl !== undefined
        ? yield* makeEventNdjsonLogger(providerEventLogPath, {
            stream: "canonical",
          })
        : undefined;
    const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(ProviderSessionRuntimeRepositoryLive),
    );
    const codexAdapterLayer = makeCodexAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : undefined,
    );
    const claudeAdapterLayer = makeClaudeAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : undefined,
    );
    const copilotAdapterLayer = makeCopilotAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : undefined,
    );
    const cursorAdapterLayer = makeCursorAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : undefined,
    );
    const devinAdapterLayer = makeDevinAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : undefined,
    );
    const kilocodeAdapterLayer = makeKilocodeAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : undefined,
    );
    const opencodeAdapterLayer = makeOpencodeAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : undefined,
    );
    const piAdapterLayer = makePiAdapterLive(nativeEventLogger ? { nativeEventLogger } : undefined);
    const adapterRegistryLayer = ProviderAdapterRegistryLive.pipe(
      Layer.provide(codexAdapterLayer),
      Layer.provide(claudeAdapterLayer),
      Layer.provide(copilotAdapterLayer),
      Layer.provide(cursorAdapterLayer),
      Layer.provide(devinAdapterLayer),
      Layer.provide(kilocodeAdapterLayer),
      Layer.provide(opencodeAdapterLayer),
      Layer.provide(piAdapterLayer),
      Layer.provideMerge(providerSessionDirectoryLayer),
    );
    return makeProviderServiceLive(
      canonicalEventLogger ? { canonicalEventLogger } : undefined,
    ).pipe(Layer.provide(adapterRegistryLayer), Layer.provide(providerSessionDirectoryLayer));
  }),
);

const ExperimentalCliProxyLayer = Layer.unwrap(
  Effect.sync(() =>
    isCliProxyExperimentEnabled()
      ? Layer.mergeAll(CliProxyAdapterLive, CliProxyProviderLive)
      : Layer.empty,
  ),
);

const PersistenceLayerLive = Layer.empty.pipe(Layer.provideMerge(SqlitePersistenceLayerLive));

const NotesPersistenceLayerLive = ProjectionNoteRepositoryLive;
const KanbanPersistenceLayerLive = ProjectionKanbanRepositoryLive;
const ThreadProjectionPersistenceLayerLive = ProjectionThreadRepositoryLive;
const ProjectionPersistenceLayerLive = Layer.mergeAll(
  KanbanPersistenceLayerLive,
  NotesPersistenceLayerLive,
  ThreadProjectionPersistenceLayerLive,
  ProjectionThreadWatchRepositoryLive,
  LearningJobRepositoryLive,
  SkillChangeProposalRepositoryLive,
  MemoryStoreLive,
);

const GitLayerLive = Layer.empty.pipe(
  Layer.provideMerge(
    GitManagerLive.pipe(
      Layer.provideMerge(ProjectSetupScriptRunnerLive),
      Layer.provideMerge(GitCoreLive),
      Layer.provideMerge(GitHubCliLive),
      Layer.provideMerge(RoutingTextGenerationLive),
    ),
  ),
  Layer.provideMerge(GitStatusBroadcasterLive.pipe(Layer.provideMerge(GitCoreLive))),
  Layer.provideMerge(GitCoreLive),
);

const TerminalLayerLive = TerminalManagerLive.pipe(Layer.provide(PtyAdapterLive));

const WorkspaceLayerLive = Layer.mergeAll(
  WorkspacePathsLive,
  WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive)),
  WorkspaceFileSystemLive.pipe(
    Layer.provide(WorkspacePathsLive),
    Layer.provide(WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive))),
  ),
);

const RuntimeDependenciesLive = ReactorLayerLive.pipe(
  // Core Services
  Layer.provideMerge(CheckpointingLayerLive),
  Layer.provideMerge(GitLayerLive),
  Layer.provideMerge(OrchestrationLayerLive),
  Layer.provideMerge(ProjectionPersistenceLayerLive),
  Layer.provideMerge(ProviderLayerLive.pipe(Layer.provideMerge(ExperimentalCliProxyLayer))),
  Layer.provideMerge(TerminalLayerLive),
  Layer.provideMerge(PersistenceLayerLive),
  Layer.provideMerge(KeybindingsLive),
  Layer.provideMerge(ProviderRegistryLive.pipe(Layer.provideMerge(ExperimentalCliProxyLayer))),
  Layer.provideMerge(DiscoveryRegistryLive),
  Layer.provideMerge(ServerSettingsLive),
  Layer.provideMerge(ThreadShellRunnerLive.pipe(Layer.provide(PtyAdapterLive))),
  Layer.provideMerge(WorkspaceLayerLive),
  Layer.provideMerge(ProjectFaviconResolverLive),
  // Shared OpenCode server manager — must be a singleton so health-checks and sessions share one process
  Layer.provideMerge(OpencodeServerManagerLive),
  // Browser automation for agent-driven web tasks
  Layer.provideMerge(BrowserManagerLive),
  // Misc.
  Layer.provideMerge(AnalyticsServiceLayerLive),
  Layer.provideMerge(OpenLive),
  Layer.provideMerge(ServerLifecycleEventsLive),
  Layer.provideMerge(MobileRemoteControlLive.pipe(Layer.provide(ServerSettingsLive))),
);

const RuntimeServicesLive = ServerRuntimeStartupLive.pipe(
  Layer.provideMerge(RuntimeDependenciesLive),
);

export const makeRoutesLayer = Layer.mergeAll(
  attachmentsRouteLayer,
  otlpTracesProxyRouteLayer,
  projectFaviconRouteLayer,
  workspacePdfViewerRouteLayer,
  workspaceFilePreviewRouteLayer,
  mobilePairingRoutesLayer,
  mobileWebStaticRouteLayer,
  staticAndDevRouteLayer,
  threadOrchestrationToolsRouteLayer,
  websocketRpcRouteLayer,
  mobileWebsocketRpcRouteLayer,
);

export const makeServerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;

    fixPath();

    const httpListeningLayer = Layer.effectDiscard(
      Effect.gen(function* () {
        yield* HttpServer.HttpServer;
        const startup = yield* ServerRuntimeStartup;
        yield* startup.markHttpListening;
      }),
    );

    const serverApplicationLayer = Layer.mergeAll(
      HttpRouter.serve(makeRoutesLayer, {
        disableLogger: !config.logWebSocketEvents,
      }),
      httpListeningLayer,
    );

    return serverApplicationLayer.pipe(
      Layer.provideMerge(RuntimeServicesLive),
      Layer.provideMerge(HttpServerLive),
      Layer.provide(ObservabilityLive),
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provideMerge(PlatformServicesLive),
    );
  }),
);

// Important: Only `ServerConfig` should be provided by the CLI layer!!! Don't let other requirements leak into the launch layer.
export const runServer = Layer.launch(makeServerLayer) satisfies Effect.Effect<
  never,
  any,
  ServerConfig
>;
