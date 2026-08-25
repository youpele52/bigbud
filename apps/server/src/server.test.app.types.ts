import type { CheckpointDiffQueryShape } from "./checkpointing/Services/CheckpointDiffQuery.ts";
import type { GitCoreShape } from "./git/Services/GitCore.ts";
import type { GitManagerShape } from "./git/Services/GitManager.ts";
import type { KeybindingsShape } from "./keybindings/keybindings.ts";
import type { MobileRemoteControlShape } from "./mobile/Services/MobileRemoteControl.ts";
import type { PluginRegistryShape } from "./plugins/Services/PluginRegistry.ts";
import type { OrchestrationEngineShape } from "./orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionCatalogQueryShape } from "./orchestration/Services/ProjectionCatalogQuery.ts";
import type { ProjectionSnapshotQueryShape } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProjectionThreadRepositoryShape } from "./persistence/Services/ProjectionThreads.ts";
import type { ProjectSetupScriptRunnerShape } from "./project/Services/ProjectSetupScriptRunner.ts";
import type { DiscoveryRegistryShape } from "./provider/Services/DiscoveryRegistry.ts";
import type { ProviderRegistryShape } from "./provider/Services/ProviderRegistry.ts";
import type { ProviderServiceShape } from "./provider/Services/ProviderService.ts";
import type { ThreadShellRunnerShape } from "./shell/Services/ThreadShellRunner.ts";
import type { ServerConfigShape } from "./startup/config.ts";
import type { ServerLifecycleEventsShape } from "./startup/serverLifecycleEvents.ts";
import type { ServerRuntimeStartupShape } from "./startup/serverRuntimeStartup.ts";
import type { TerminalManagerShape } from "./terminal/Services/Manager.ts";
import type { OpenShape } from "./utils/open.ts";
import type { ServerSettingsShape } from "./ws/serverSettings.ts";
import type { WorkspaceRuntimeBackendShape } from "./workspace-runtime/Services/WorkspaceRuntime.ts";

export interface BuildAppUnderTestOptions {
  readonly config?: Partial<ServerConfigShape>;
  readonly layers?: {
    readonly keybindings?: Partial<KeybindingsShape>;
    readonly providerRegistry?: Partial<ProviderRegistryShape>;
    readonly providerService?: Partial<ProviderServiceShape>;
    readonly discoveryRegistry?: Partial<DiscoveryRegistryShape>;
    readonly serverSettings?: Partial<ServerSettingsShape>;
    readonly open?: Partial<OpenShape>;
    readonly gitCore?: Partial<GitCoreShape>;
    readonly gitManager?: Partial<GitManagerShape>;
    readonly projectSetupScriptRunner?: Partial<ProjectSetupScriptRunnerShape>;
    readonly threadShellRunner?: Partial<ThreadShellRunnerShape>;
    readonly mobileRemoteControl?: Partial<MobileRemoteControlShape>;
    readonly pluginRegistry?: Partial<PluginRegistryShape>;
    readonly terminalManager?: Partial<TerminalManagerShape>;
    readonly orchestrationEngine?: Partial<OrchestrationEngineShape>;
    readonly projectionSnapshotQuery?: Partial<ProjectionSnapshotQueryShape>;
    readonly projectionCatalogQuery?: Partial<ProjectionCatalogQueryShape>;
    readonly projectionThreadRepository?: Partial<ProjectionThreadRepositoryShape>;
    readonly checkpointDiffQuery?: Partial<CheckpointDiffQueryShape>;
    readonly serverLifecycleEvents?: Partial<ServerLifecycleEventsShape>;
    readonly serverRuntimeStartup?: Partial<ServerRuntimeStartupShape>;
    readonly remoteWorkspaceRuntime?: WorkspaceRuntimeBackendShape;
  };
}
