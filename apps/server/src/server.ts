// TODO: Split by concern when this file is next touched.
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
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
import { pluginAssetRouteLayer } from "./ws/http.plugins";
import { mobileWebsocketRpcRouteLayer } from "./ws/ws.mobile";
import { OpenLive } from "./utils/open";
import { layerConfig as SqlitePersistenceLayerLive } from "./persistence/Layers/Sqlite";
import { ServerLifecycleEventsLive } from "./startup/serverLifecycleEvents";
import { AnalyticsServiceLayerLive } from "./telemetry/Layers/AnalyticsService";
import { makeProviderLogSecurity } from "./server.providerLogs.ts";
import { ProviderSessionDirectoryLive } from "./provider/Layers/ProviderSessionDirectory";
import { ProviderSessionRuntimeRepositoryLive } from "./persistence/Layers/ProviderSessionRuntime";
import { makeCodexAdapterLive } from "./provider/Layers/Codex/Adapter";
import { makeClaudeAdapterLive } from "./provider/Layers/Claude/Adapter";
import { CliProxyCompositionLive } from "./provider/Layers/CliProxy/Composition";
import { makeCopilotAdapterLive } from "./provider/Layers/Copilot/Adapter";
import { makeCursorAdapterLive } from "./provider/Layers/Cursor/Adapter";
import { makeDevinAdapterLive } from "./provider/Layers/Devin/Adapter";
import { makeKilocodeAdapterLive } from "./provider/Layers/Kilocode/Adapter";
import { makeOpencodeAdapterLive } from "./provider/Layers/Opencode/Adapter";
import { makePiAdapterLive } from "./provider/Layers/Pi/Adapter";
import { OpencodeServerManagerLive } from "./provider/Layers/Opencode/ServerManager";
import { makeProviderAdapterRegistryLive } from "./provider/Layers/ProviderAdapterRegistry";
import { makeProviderServiceLive } from "./provider/Layers/ProviderService";
import { OrchestrationEngineLive } from "./orchestration/Layers/OrchestrationEngine";
import { OrchestrationProjectionPipelineLive } from "./orchestration/Layers/ProjectionPipeline";
import { OrchestrationEventStoreLive } from "./persistence/Layers/OrchestrationEventStore";
import { OrchestrationCommandReceiptRepositoryLive } from "./persistence/Layers/OrchestrationCommandReceipts";
import { AutomationScheduleRepositoryLive } from "./persistence/Layers/AutomationScheduleRepository";
import { CheckpointDiffQueryLive } from "./checkpointing/Layers/CheckpointDiffQuery";
import { OrchestrationProjectionSnapshotQueryLive } from "./orchestration/Layers/ProjectionSnapshotQuery";
import { ProjectionCatalogQueryLive } from "./orchestration/Layers/ProjectionCatalogQuery";
import { ProjectionOperationalStateQueryLive } from "./orchestration/Layers/ProjectionOperationalStateQuery";
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
import { makeProviderRegistryLive } from "./provider/Layers/ProviderRegistry";
import { DiscoveryRegistryLive } from "./provider/Layers/DiscoveryRegistry";
import {
  OptionalProviderRegistrations,
  type OptionalProviderRegistration,
} from "./provider/ProviderRegistration";
import {
  isProviderRegistered,
  makeProviderCapabilitiesResolver,
} from "./provider/providerCapabilities";
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
import { EntityPurgeLive } from "./deletion/Layers/EntityPurge";
import { ThreadRetentionRepositoryLive } from "./persistence/Layers/ThreadRetentionRepository.ts";
import { VisibleBrowserControlLive } from "./browser/Layers/VisibleBrowserControl.ts";
import { PurgeJobRepositoryLive } from "./persistence/Layers/PurgeJobRepository.ts";
import { ThreadRetentionLive } from "./retention/Layers/ThreadRetention.ts";
import { HttpServerLive, PlatformServicesLive } from "./server.platform.ts";
import { PluginRegistryLive } from "./plugins/Layers/PluginRegistry";
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
  ProjectionCatalogQueryLive,
  ProjectionOperationalStateQueryLive,
  OrchestrationEventInfrastructureLayerLive,
  AutomationInfrastructureLayerLive,
  OrchestrationProjectionPipelineLayerLive,
  EntityPurgeLive.pipe(Layer.provide(OrchestrationProjectionPipelineLayerLive)),
  ThreadRetentionRepositoryLive,
  PurgeJobRepositoryLive,
);

const ComputerUseLayerLive = ComputerUseLive.pipe(
  Layer.provideMerge(BrowserManagerLive),
  Layer.provide(CuaDriverLive),
  Layer.provide(OpenLive),
);

const OrchestrationLayerLive = Layer.mergeAll(
  OrchestrationInfrastructureLayerLive,
  ComputerUseLayerLive,
  VisibleBrowserControlLive,
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationInfrastructureLayerLive),
    Layer.provide(ComputerUseLayerLive),
    Layer.provide(VisibleBrowserControlLive),
  ),
);

const ThreadRetentionLayerLive = ThreadRetentionLive.pipe(
  Layer.provide(OrchestrationLayerLive),
  Layer.provide(ServerSettingsLive),
);

const CheckpointingLayerLive = Layer.empty.pipe(
  Layer.provideMerge(CheckpointDiffQueryLive),
  Layer.provideMerge(CheckpointStoreLive),
);

const makeProviderLayerLive = (
  optionalRegistrations: ReadonlyArray<OptionalProviderRegistration>,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const { baseDir, devUrl, providerEventLogPath } = yield* ServerConfig;
      const sql = yield* SqlClient.SqlClient;
      const { canonicalEventLogger, nativeEventLogger, settleThreadLogs } =
        yield* makeProviderLogSecurity({ baseDir, devUrl, providerEventLogPath, sql });
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
      const piAdapterLayer = makePiAdapterLive(
        nativeEventLogger ? { nativeEventLogger } : undefined,
      );
      const adapterRegistryLayer = makeProviderAdapterRegistryLive({
        optionalRegistrations: optionalRegistrations.map((registration) => ({
          provider: registration.provider,
          service: registration.adapterService,
        })),
      }).pipe(
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
      const getProviderCapabilities = makeProviderCapabilitiesResolver(optionalRegistrations);
      return makeProviderServiceLive({
        ...(canonicalEventLogger ? { canonicalEventLogger } : {}),
        settleThreadLogs,
        getProviderCapabilities,
        isProviderComposed: (provider) => isProviderRegistered(provider, optionalRegistrations),
      }).pipe(Layer.provide(adapterRegistryLayer), Layer.provide(providerSessionDirectoryLayer));
    }),
  );

const ProviderInfrastructureLayerLive = Layer.unwrap(
  Effect.gen(function* () {
    const optionalRegistrations = yield* OptionalProviderRegistrations;
    return Layer.mergeAll(
      makeProviderLayerLive(optionalRegistrations),
      makeProviderRegistryLive({
        optionalRegistrations: optionalRegistrations.map((registration) => ({
          provider: registration.provider,
          service: registration.providerService,
        })),
      }),
    );
  }),
).pipe(Layer.provide(CliProxyCompositionLive));

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
  Layer.provideMerge(ThreadRetentionLayerLive),
  Layer.provideMerge(ProjectionPersistenceLayerLive),
  Layer.provideMerge(ProviderInfrastructureLayerLive),
  Layer.provideMerge(TerminalLayerLive),
  Layer.provideMerge(PersistenceLayerLive),
  Layer.provideMerge(KeybindingsLive),
  Layer.provideMerge(DiscoveryRegistryLive),
  Layer.provideMerge(PluginRegistryLive),
  Layer.provideMerge(ServerSettingsLive),
  Layer.provideMerge(
    ThreadShellRunnerLive.pipe(Layer.provide(PtyAdapterLive), Layer.provide(PersistenceLayerLive)),
  ),
  Layer.provideMerge(WorkspaceLayerLive),
  Layer.provideMerge(ProjectFaviconResolverLive),
  // Shared OpenCode server manager — must be a singleton so health-checks and sessions share one process
  Layer.provideMerge(OpencodeServerManagerLive),
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
  pluginAssetRouteLayer,
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
