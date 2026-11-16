import { WorkspacePaths } from "../workspace/Services/WorkspacePaths.ts";
import { generateKeyPairSync } from "node:crypto";
import { RemoteBackendIdentityService } from "./identity.service.ts";
import { ThreadToolsActivationLive } from "../provider/Layers/OpencodeV2/ThreadToolsActivation.ts";
import * as Layer from "effect/Layer";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery";
import { ProjectionCatalogQuery } from "../orchestration/Services/ProjectionCatalogQuery";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine";
import { CommandGateway } from "../command-gateway/Services/CommandGateway.ts";
import { CheckpointDiffQuery } from "../checkpointing/Services/CheckpointDiffQuery";
import { Keybindings } from "../keybindings/keybindings";
import { Open } from "../utils/open";
import { GitManager } from "../git/Services/GitManager";
import { GitCore } from "../git/Services/GitCore";
import { GitStatusBroadcaster } from "../git/Services/GitStatusBroadcaster";
import { TerminalManager } from "../terminal/Services/Manager";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry";
import { DiscoveryRegistry } from "../provider/Services/DiscoveryRegistry";
import { ThreadShellRunner } from "../shell/Services/ThreadShellRunner";
import { ServerLifecycleEvents } from "../startup/serverLifecycleEvents";
import { ServerSettingsService } from "../ws/serverSettings";
import { ServerRuntimeStartup } from "../startup/serverRuntimeStartup";
import { WorkspaceEntries } from "../workspace/Services/WorkspaceEntries";
import { WorkspaceFileSystem } from "../workspace/Services/WorkspaceFileSystem";
import { WorkspaceRuntime } from "../workspace-runtime/Services/WorkspaceRuntime.ts";
import { ProjectSetupScriptRunner } from "../project/Services/ProjectSetupScriptRunner";
import { ProjectionNoteRepository } from "../persistence/Services/ProjectionNotes";
import { ProjectionKanbanRepository } from "../persistence/Services/ProjectionKanban.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import { OrchestrationBootstrapRecipeRepository } from "../persistence/Services/OrchestrationBootstrapRecipes.ts";
import { AutomationScheduleRepository } from "../persistence/Services/AutomationScheduleRepository.ts";
import { SchedulerReactor } from "../orchestration/Services/SchedulerReactor.ts";
import { MobileRemoteControl } from "../mobile/Services/MobileRemoteControl.ts";
import { DesktopSupervisorDelivery } from "../desktop-supervisor/desktopSupervisorDelivery.ts";
import { ConnectionDiagnostics } from "../connection-diagnostics/Services/ConnectionDiagnostics.ts";
import { ThreadRetention } from "../retention/Services/ThreadRetention.ts";

function unrelated(): never {
  throw new Error("Unmatched-route fixture called an unrelated RPC service");
}
const settings = Layer.mock(ServerSettingsService)({
  currentSnapshot: () => undefined,
  onSnapshotChange: () => () => {},
});

/** Unmatched-route probes must never call these unrelated RPC services. */
export const unrelatedGatewayServices = Layer.mergeAll(
  Layer.succeed(RemoteBackendIdentityService, {
    authority: {
      authorityId: "a".repeat(32),
      keyFingerprint: `sha256:${"b".repeat(64)}`,
      keyEpoch: 1,
    },
    installationFingerprint: `sha256:${"c".repeat(64)}`,
    publicKey: generateKeyPairSync("ed25519").publicKey,
    signChallenge: unrelated,
  }),
  Layer.mock(ProjectionSnapshotQuery)({}),
  Layer.mock(ProjectionCatalogQuery)({}),
  Layer.mock(OrchestrationEngineService)({}),
  Layer.mock(CommandGateway)({}),
  Layer.mock(CheckpointDiffQuery)({}),
  Layer.mock(Keybindings)({}),
  Layer.mock(Open)({}),
  Layer.mock(GitManager)({}),
  Layer.mock(GitCore)({}),
  Layer.mock(GitStatusBroadcaster)({}),
  Layer.mock(TerminalManager)({}),
  Layer.mock(ProviderService)({}),
  Layer.mock(ProviderRegistry)({}),
  Layer.mock(DiscoveryRegistry)({}),
  Layer.mock(ThreadShellRunner)({}),
  Layer.mock(ServerLifecycleEvents)({}),
  settings,
  // The nominal activation coordinator has private fields; construct its real pure owner and
  // scope its cleanup rather than inventing an incomplete instance or casting its type.
  ThreadToolsActivationLive.pipe(Layer.provide(settings)),
  Layer.mock(ServerRuntimeStartup)({}),
  Layer.mock(WorkspaceEntries)({}),
  Layer.mock(WorkspaceFileSystem)({}),
  Layer.mock(WorkspacePaths)({
    normalizeWorkspaceRoot: unrelated,
    resolveRelativePathWithinRoot: unrelated,
  }),
  Layer.mock(WorkspaceRuntime)({
    files: {
      writeFile: unrelated,
      readFilePreview: unrelated,
      readFileRange: unrelated,
      listDirectory: unrelated,
    },
    search: { searchEntries: unrelated, searchFileContents: unrelated },
    watch: { watchDirectory: unrelated },
  }),
  Layer.mock(ProjectSetupScriptRunner)({}),
  Layer.mock(ProjectionNoteRepository)({}),
  Layer.mock(ProjectionKanbanRepository)({}),
  Layer.mock(ProjectionThreadRepository)({}),
  Layer.mock(OrchestrationBootstrapRecipeRepository)({}),
  Layer.mock(AutomationScheduleRepository)({}),
  Layer.mock(SchedulerReactor)({}),
  Layer.mock(MobileRemoteControl)({}),
  Layer.mock(DesktopSupervisorDelivery)({
    open: unrelated,
    acknowledge: unrelated,
    acknowledgeBaseline: unrelated,
    close: unrelated,
    hasOpenConsumer: unrelated,
  }),
  Layer.mock(ConnectionDiagnostics)({ isServerShuttingDown: unrelated }),
  Layer.mock(ThreadRetention)({}),
);
