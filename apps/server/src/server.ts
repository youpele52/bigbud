import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";

import { ServerConfig, type ServerConfigShape } from "./startup/config";
import { RemoteProfileConfigurationError } from "./startup/config.remote.ts";
import { resolveRemoteMobileConfiguration } from "./startup/config.remoteMobile.ts";
import { assertRemoteServerProfile } from "./startup/config.remote.ts";
import { ensurePrivateRemoteStateRoot } from "./remote-backend/authority.files.ts";
import { RemoteBackendAuthorityError } from "./remote-backend/authority.record.ts";
import { RemoteBackendIdentityForServerLive } from "./remote-backend/identity.service.policy.ts";
import {
  RemoteCallbackBindingLive,
  withRemoteCallbackRuntime,
} from "./server.remote.callbackBinding.ts";
import { RemoteServerApplicationLive } from "./server.remote.ts";
import {
  RemoteRuntimeUpdateRemoteLive,
  RuntimeMaintenanceGateRemoteLive,
} from "./remote-backend/Layers/RemoteRuntimeUpdate.remote.ts";
import { RemoteMobileConsentGuardLive } from "./remote-backend/mobileConsentRevoke.ts";
import { RemoteMobileGatewayCompositionLive } from "./server.mobileOwner.ts";
import { StateDirLockLive } from "./startup/backendInstance";
import { withOwnershipShutdown } from "./startup/ownershipShutdown";
import { fixPath } from "./utils/os-jank";
import { makeRoutesLayer } from "./server.routes.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "./persistence/Layers/Sqlite";
import { withRemoteExecutionTargetDisconnects } from "./persistence/Layers/RemoteExecutionTargetDisconnects.ts";
import { ServerLifecycleEventsLive } from "./startup/serverLifecycleEvents";
import { withEngineTerminal } from "./server.engineTerminal.ts";
import { ThreadToolsActivationLive } from "./provider/Layers/OpencodeV2/ThreadToolsActivation.ts";
import { OpencodeServerManagerLive } from "./provider/Layers/Opencode/ServerManager";
import { OrchestrationEngineLive } from "./orchestration/Layers/OrchestrationEngine";
import { WorkspaceModeGateLive } from "./remote-backend/workspaceMode.gate.ts";
import { ThreadCoordinationGrantsLive } from "./orchestration-tools/Layers/ThreadCoordinationGrants.ts";
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
import { LocalShellProfilesLive } from "./terminal/Layers/LocalShellProfiles.ts";
import { ShellProfilesLive } from "./terminal/Layers/ShellProfiles.ts";
import { ShellLaunchPlannerLive } from "./terminal/Layers/ShellLaunchPlanner.ts";
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
import { RemoteAgentLocalControlLive } from "./remote-agent/remoteAgentLocalControl.layer.ts";
import { RemoteBackendDeploymentLive } from "./remote-backend/Layers/RemoteBackendDeployment.ts";
import { ObservabilityLive } from "./observability/Layers/Observability";
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
import { ThreadRetentionRepositoryLive } from "./persistence/Layers/ThreadRetentionRepository.ts";
import { PurgeJobRepositoryLive } from "./persistence/Layers/PurgeJobRepository.ts";
import { ThreadRetentionLive } from "./retention/Layers/ThreadRetention.ts";
import { HttpServerLive, PlatformServicesLive } from "./server.platform.ts";
import { makeRemoteAgentPtyAdapter } from "./remote-agent/remoteAgentPtyAdapter.ts";
import { isRemoteAgentExecutionTarget } from "./remote-agent/remoteAgentDefault.ts";
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
import {
  ProfileComputerUseLive,
  ProfileVisibleBrowserControlLive,
  ProfileOpenLive,
  ProfileAnalyticsLive,
  ProfileMobileControlLive,
  ProfileDeliveryLive,
} from "./server.profile.ts";
import { RemoteTerminalAvailabilityLive } from "./remote-backend/terminalAvailability.ts";
import { PtyAdapterLive } from "./server.pty.ts";

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
const TerminalLayerLive = TerminalManagerLive.pipe(
  Layer.provide(TerminalPtyLayerLive),
  Layer.provide(
    ShellLaunchPlannerLive.pipe(
      Layer.provideMerge(ShellProfilesLive),
      Layer.provide(LocalShellProfilesLive),
    ),
  ),
);

const OrchestrationEngineLayerLive = withEngineTerminal(
  OrchestrationEngineLive,
  TerminalLayerLive,
).pipe(
  Layer.provide(OrchestrationInfrastructureLayerLive),
  Layer.provide(ProfileComputerUseLive),
  Layer.provide(ProfileVisibleBrowserControlLive),
  // One shared in-memory grant store; grants and challenges are lost on restart by design.
  Layer.provide(ThreadCoordinationGrantsLive),
  Layer.provide(WorkspaceModeGateLive),
);

const OrchestrationCommandLayerLive = CommandGatewayLive.pipe(
  Layer.provideMerge(OrchestrationEngineLayerLive),
);

const OrchestrationLayerLive = Layer.mergeAll(
  OrchestrationInfrastructureLayerLive,
  ProfileComputerUseLive,
  ProfileVisibleBrowserControlLive,
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
  Layer.provideMerge(ProfileAnalyticsLive),
  Layer.provideMerge(
    Layer.mergeAll(ProfileOpenLive, EventLoopLagMonitorLive, Recovery.SleepEvidenceLayerLive),
  ),
  Layer.provideMerge(ServerLifecycleEventsLive),
  Layer.provideMerge(
    Layer.mergeAll(
      ProfileMobileControlLive.pipe(Layer.provide(ServerSettingsLive)),
      ProfileDeliveryLive,
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

const RemoteServerLive = withRemoteCallbackRuntime(
  // Runtime updates (M3 WP-4D) need runtime services and serve on the client routes.
  withServerShutdownSignal(
    RemoteServerApplicationLive.pipe(Layer.provide(RemoteRuntimeUpdateRemoteLive)),
  ),
  RuntimeServicesLive,
).pipe(
  Layer.provideMerge(RemoteCallbackBindingLive),
  // Under the state lock, before persistence: finishes a rollback restore, holds admission.
  Layer.provideMerge(RuntimeMaintenanceGateRemoteLive),
  // Admission consumers capture this real idle owner while runtime services are constructed.
  Layer.provideMerge(RemoteMobileGatewayCompositionLive),
  Layer.provideMerge(RemoteMobileConsentGuardLive),
  // Identity validation precedes runtime/persistence construction and both listeners.
  Layer.provideMerge(RemoteBackendIdentityForServerLive),
  Layer.provideMerge(RemoteTerminalAvailabilityLive),
  Layer.provide(StateDirLockLive),
  Layer.provide(ObservabilityLive),
  Layer.provideMerge(FetchHttpClient.layer),
  Layer.provideMerge(PlatformServicesLive),
);

export { makeRoutesLayer } from "./server.routes.ts";

function localServerLayer(config: ServerConfigShape) {
  fixPath();

  const httpListeningLayer = Layer.effectDiscard(
    Effect.gen(function* () {
      yield* HttpServer.HttpServer;
      const startup = yield* ServerRuntimeStartup;
      yield* startup.markHttpListening;
    }),
  );

  const serverApplicationLayer = Layer.mergeAll(
    // Persisted relay profiles replace the unavailable directory on the local backend (WP-3A).
    HttpRouter.serve(makeRoutesLayer, {
      disableLogger: !config.logWebSocketEvents,
    }).pipe(Layer.provide(RemoteBackendDeploymentLive)),
    httpListeningLayer,
    ThreadToolModelSourcesLive,
    RemoteAgentLocalControlLive,
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
}

type ServerApplicationLayer = Layer.Layer<
  never,
  Layer.Error<typeof RemoteServerLive> | Layer.Error<ReturnType<typeof localServerLayer>>,
  ServerConfig
>;

export const makeServerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    if (config.mode === "remote") {
      yield* Effect.try({
        try: () => {
          assertRemoteServerProfile(config);
          resolveRemoteMobileConfiguration({
            mode: config.mode,
            enabled: config.remoteMobile !== undefined,
            clientToken: config.authToken,
            gatewayCredential: config.remoteMobile
              ? Redacted.value(config.remoteMobile.gatewayCredential)
              : undefined,
          });
        },
        catch: () =>
          new RemoteProfileConfigurationError("The remote profile configuration is invalid."),
      });
      yield* Effect.tryPromise({
        try: () => ensurePrivateRemoteStateRoot(config.stateDir),
        catch: () =>
          new RemoteBackendAuthorityError(
            "unsafe-state",
            "The remote state root must be private before acquiring its backend lock.",
          ),
      });
      const application: ServerApplicationLayer = RemoteServerLive;
      return application;
    }

    const application: ServerApplicationLayer = localServerLayer(config);
    return application;
  }),
);

// Important: Only `ServerConfig` should be provided by the CLI layer!!! Don't let other requirements leak into the launch layer.
export const runServer = withOwnershipShutdown(
  Layer.launch(makeServerLayer),
) satisfies Effect.Effect<void, any, ServerConfig>;
