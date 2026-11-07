import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http";

import { ServerConfig } from "./startup/config";
import { StateDirLockLive } from "./startup/backendInstance";
import { withOwnershipShutdown } from "./startup/ownershipShutdown";
import { fixPath } from "./utils/os-jank";
import { makeRoutesLayer } from "./server.routes.ts";
import { OpenLive } from "./utils/open";
import { layerConfig as SqlitePersistenceLayerLive } from "./persistence/Layers/Sqlite";
import { withRemoteExecutionTargetDisconnects } from "./persistence/Layers/RemoteExecutionTargetDisconnects.ts";
import { ServerLifecycleEventsLive } from "./startup/serverLifecycleEvents";
import { AnalyticsServiceLayerLive } from "./telemetry/Layers/AnalyticsService";
import { withEngineTerminal } from "./server.engineTerminal.ts";
import { ThreadToolsActivationLive } from "./provider/Layers/OpencodeV2/ThreadToolsActivation.ts";
import { OpencodeServerManagerLive } from "./provider/Layers/Opencode/ServerManager";
import { OrchestrationEngineLive } from "./orchestration/Layers/OrchestrationEngine";
import { CommandGatewayLive } from "./command-gateway/Layers/CommandGateway.ts";
import { OrchestrationProjectionPipelineLive } from "./orchestration/Layers/ProjectionPipeline";
import { OrchestrationEventStoreLive } from "./persistence/Layers/OrchestrationEventStore";
import { OrchestrationCommandReceiptRepositoryLive } from "./persistence/Layers/OrchestrationCommandReceipts";
import { OrchestrationBootstrapRecipeRepositoryLive } from "./persistence/Layers/OrchestrationBootstrapRecipes.ts";
import { AutomationScheduleRepositoryLive } from "./persistence/Layers/AutomationScheduleRepository";
import { CheckpointDiffQueryLive } from "./checkpointing/Layers/CheckpointDiffQuery";
import { OrchestrationProjectionSnapshotQueryLive } from "./orchestration/Layers/ProjectionSnapshotQuery";
import { ProjectionCatalogQueryLive } from "./orchestration/Layers/ProjectionCatalogQuery";
import { ProjectionOperationalStateQueryLive } from "./orchestration/Layers/ProjectionOperationalStateQuery";
import { CheckpointStoreLive } from "./checkpointing/Layers/CheckpointStore";
import { makeGitLayerLive } from "./git/Layers/GitComposition.ts";
import { TerminalManagerLive } from "./terminal/Layers/Manager";
import { PtyAdapter } from "./terminal/Services/PTY";
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
import { ThreadOrganizationReactorLive } from "./orchestration/Layers/ThreadOrganizationReactor.ts";
import { ThreadToolModelSourcesLive } from "./orchestration-tools/ThreadOrchestrationTools.modelSources.ts";
import { DiscoveryRegistryLive } from "./provider/Layers/DiscoveryRegistry";
import { ServerSettingsLive } from "./ws/serverSettings";
import { ProjectFaviconResolverLive } from "./project/Layers/ProjectFaviconResolver";
import { makeConfiguredRemoteAgentLayers } from "./remote-agent/remoteAgentServerLayer.ts";
import { ObservabilityLive } from "./observability/Layers/Observability";
import { ComputerUseLayerLive } from "./server.computerUse.ts";
import { ThreadShellRunnerLive } from "./shell/Layers/ThreadShellRunner";
import { ProjectionNoteRepositoryLive } from "./persistence/Layers/ProjectionNotes";
import { ProjectionKanbanRepositoryLive } from "./persistence/Layers/ProjectionKanban";
import { ProjectionThreadRepositoryLive } from "./persistence/Layers/ProjectionThreads";
import { ProjectionProjectRepositoryLive } from "./persistence/Layers/ProjectionProjects.ts";
import { ProjectionThreadWatchRepositoryLive } from "./persistence/Layers/ProjectionThreadWatches";
import { LearningJobRepositoryLive } from "./persistence/Layers/LearningJobs";
import { SkillChangeProposalRepositoryLive } from "./persistence/Layers/SkillChangeProposals";
import { LearningReactorLive } from "./orchestration/Layers/LearningReactor";
import { MemoryStoreLive } from "./learning/Layers/MemoryStore";
import { MobileRemoteControlLive } from "./mobile/Layers/MobileRemoteControl";
import { ThreadRetentionRepositoryLive } from "./persistence/Layers/ThreadRetentionRepository.ts";
import { VisibleBrowserControlLive } from "./browser/Layers/VisibleBrowserControl.ts";
import { PurgeJobRepositoryLive } from "./persistence/Layers/PurgeJobRepository.ts";
import { ThreadRetentionLive } from "./retention/Layers/ThreadRetention.ts";
import { HttpServerLive, PlatformServicesLive } from "./server.platform.ts";
import { makeRemoteAgentPtyAdapter } from "./remote-agent/remoteAgentPtyAdapter.ts";
import { isRemoteAgentExecutionTarget } from "./remote-agent/remoteAgentDefault.ts";
import { DesktopSupervisorDeliveryLive } from "./desktop-supervisor/desktopSupervisorDelivery.layer.ts";
import { ConnectionDiagnosticsLive } from "./connection-diagnostics/Layers/ConnectionDiagnostics.ts";
import { EventLoopLagMonitorLive } from "./connection-diagnostics/Layers/EventLoopLagMonitor.ts";
import { withServerShutdownSignal } from "./connection-diagnostics/Layers/ServerShutdownSignal.ts";
import { DirectResourceCleanupRepositoryLive } from "./persistence/Layers/DirectResourceCleanupRepository.ts";
import { DirectResourceCleanupExecutorLive } from "./deletion/Layers/DirectResourceCleanupExecutor.ts";
import { DirectResourceCleanupRecoveryLive } from "./deletion/Layers/DirectResourceCleanupRecovery.ts";
import * as Recovery from "./server.recoveryLayers.ts";
import { ProcessLedgerLive } from "./process-ledger/Layers/ProcessLedger.ts";
import { makeProviderInfrastructureLayerLive } from "./server.providerLayers.ts";
import { BackgroundMaintenanceLayerLive } from "./server.maintenanceLayers.ts";
import { ThreadBranchCopyLive } from "./orchestration/Layers/ThreadBranchCopy.ts";
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
  Layer.provideMerge(
    OrchestrationReactorLive.pipe(
      Layer.provide(LearningReactorLive),
      Layer.provide(ThreadOrganizationReactorLive),
    ),
  ),
  Layer.provideMerge(ProviderRuntimeIngestionLive),
  Layer.provideMerge(Recovery.ProviderTurnSupervisorLive),
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
  OrchestrationBootstrapRecipeRepositoryLive,
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
  ThreadRetentionRepositoryLive,
  PurgeJobRepositoryLive,
  Recovery.RecoveryPersistenceLayerLive,
);

const configuredRemoteAgentLayers = makeConfiguredRemoteAgentLayers();
const RemoteAgentLayerLive = configuredRemoteAgentLayers.services;
const WorkspaceLayerLive = configuredRemoteAgentLayers.workspace;
const TerminalPtyLayerLive = configuredRemoteAgentLayers.enabled
  ? Layer.effect(
      PtyAdapter,
      Effect.gen(function* () {
        const base = yield* PtyAdapter;
        const resolver = configuredRemoteAgentLayers.ptyResolver;
        if (!resolver) return base;
        return makeRemoteAgentPtyAdapter(base, resolver, isRemoteAgentExecutionTarget);
      }),
    ).pipe(Layer.provide(PtyAdapterLive))
  : PtyAdapterLive;
const TerminalLayerLive = TerminalManagerLive.pipe(Layer.provide(TerminalPtyLayerLive));

const OrchestrationEngineLayerLive = withEngineTerminal(
  OrchestrationEngineLive,
  TerminalLayerLive,
).pipe(
  Layer.provide(OrchestrationInfrastructureLayerLive),
  Layer.provide(ComputerUseLayerLive),
  Layer.provide(VisibleBrowserControlLive),
);

const OrchestrationCommandLayerLive = CommandGatewayLive.pipe(
  Layer.provideMerge(OrchestrationEngineLayerLive),
);

const OrchestrationLayerLive = Layer.mergeAll(
  OrchestrationInfrastructureLayerLive,
  ComputerUseLayerLive,
  VisibleBrowserControlLive,
  OrchestrationCommandLayerLive,
);

const ThreadBranchCopyLayerLive = ThreadBranchCopyLive.pipe(Layer.provide(OrchestrationLayerLive));

const ThreadRetentionLayerLive = ThreadRetentionLive.pipe(
  Layer.provide(OrchestrationLayerLive),
  Layer.provide(ServerSettingsLive),
);

const CheckpointingLayerLive = Layer.empty.pipe(
  Layer.provideMerge(CheckpointDiffQueryLive),
  Layer.provideMerge(CheckpointStoreLive),
);

const ProviderInfrastructureLayerLive = makeProviderInfrastructureLayerLive(
  configuredRemoteAgentLayers,
);

// Disconnect flags load before any SqlClient consumer, including remote-agent startup work.
const PersistenceLayerLive = withRemoteExecutionTargetDisconnects(SqlitePersistenceLayerLive);

const NotesPersistenceLayerLive = ProjectionNoteRepositoryLive;
const KanbanPersistenceLayerLive = ProjectionKanbanRepositoryLive;
const ThreadProjectionPersistenceLayerLive = Layer.mergeAll(
  ProjectionThreadRepositoryLive,
  ProjectionProjectRepositoryLive,
);
const ProjectionPersistenceLayerLive = Layer.mergeAll(
  KanbanPersistenceLayerLive,
  NotesPersistenceLayerLive,
  ThreadProjectionPersistenceLayerLive,
  ProjectionThreadWatchRepositoryLive,
  LearningJobRepositoryLive,
  SkillChangeProposalRepositoryLive,
  MemoryStoreLive,
);

const GitLayerLive = makeGitLayerLive(RemoteAgentLayerLive);
const DirectResourceCleanupLayerLive = DirectResourceCleanupRecoveryLive.pipe(
  Layer.provideMerge(DirectResourceCleanupExecutorLive),
  Layer.provideMerge(DirectResourceCleanupRepositoryLive),
  Layer.provideMerge(OrchestrationProjectionPipelineLayerLive),
  Layer.provideMerge(OrchestrationEngineLayerLive),
  Layer.provide(PersistenceLayerLive),
);

const RuntimeDependenciesLive = ReactorLayerLive.pipe(
  Layer.provideMerge(BackgroundMaintenanceLayerLive),
  // Core Services
  Layer.provideMerge(Layer.mergeAll(RemoteAgentLayerLive, CheckpointingLayerLive)),
  Layer.provideMerge(GitLayerLive),
  Layer.provideMerge(OrchestrationLayerLive),
  Layer.provideMerge(Layer.mergeAll(ThreadRetentionLayerLive, ThreadBranchCopyLayerLive)),
  Layer.provideMerge(ProjectionPersistenceLayerLive),
  Layer.provideMerge(DiscoveryRegistryLive),
  Layer.provideMerge(ProviderInfrastructureLayerLive),
  Layer.provideMerge(Layer.mergeAll(ThreadToolsActivationLive, TerminalLayerLive)),
  Layer.provideMerge(PersistenceLayerLive),
  Layer.provideMerge(Layer.mergeAll(KeybindingsLive, DirectResourceCleanupLayerLive)),
  Layer.provideMerge(ServerSettingsLive),
  Layer.provideMerge(
    ThreadShellRunnerLive.pipe(Layer.provide(PtyAdapterLive), Layer.provide(PersistenceLayerLive)),
  ),
  Layer.provideMerge(WorkspaceLayerLive),
  Layer.provideMerge(ProjectFaviconResolverLive),
  // Retained by the legacy OpenCode text-generation infrastructure.
  Layer.provideMerge(OpencodeServerManagerLive),
  // Misc.
  Layer.provideMerge(AnalyticsServiceLayerLive),
  Layer.provideMerge(
    Layer.mergeAll(OpenLive, EventLoopLagMonitorLive, Recovery.SleepEvidenceLayerLive),
  ),
  Layer.provideMerge(ServerLifecycleEventsLive),
  Layer.provideMerge(
    Layer.mergeAll(
      MobileRemoteControlLive.pipe(Layer.provide(ServerSettingsLive)),
      DesktopSupervisorDeliveryLive,
      ConnectionDiagnosticsLive,
    ),
  ),
  // One sleep epoch view shared by every evidence source and the recovery coordinator.
  // The process ledger sits below every layer that spawns provider children; it reaps a dead
  // backend's orphans in the background at startup.
).pipe(Layer.provideMerge(Recovery.SystemSleepEpochsLive), Layer.provideMerge(ProcessLedgerLive));

const RuntimeServicesLive = ServerRuntimeStartupLive.pipe(
  Layer.provideMerge(RuntimeDependenciesLive),
);

export { makeRoutesLayer } from "./server.routes.ts";

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
      ThreadToolModelSourcesLive,
    );

    // The shutdown signal finalizes first, before routes close their WebSocket streams.
    return withServerShutdownSignal(serverApplicationLayer).pipe(
      Layer.provideMerge(RuntimeServicesLive),
      Layer.provideMerge(HttpServerLive),
      // One backend per state directory: acquired before the port binds and persistence opens,
      // released after both close.
      Layer.provide(StateDirLockLive),
      Layer.provide(ObservabilityLive),
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provideMerge(PlatformServicesLive),
    );
  }),
);

// Important: Only `ServerConfig` should be provided by the CLI layer!!! Don't let other requirements leak into the launch layer.
export const runServer = withOwnershipShutdown(
  Layer.launch(makeServerLayer),
) satisfies Effect.Effect<void, any, ServerConfig>;
