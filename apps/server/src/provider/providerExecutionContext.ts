import type { ExecutionTargetId } from "@bigbud/contracts";

import {
  resolveRemoteWorkspaceBridgeConfig,
  type RemoteWorkspaceBridgeConfig,
} from "../remote-workspace-bridge/remoteWorkspaceBridge.ts";
import {
  resolveProviderRuntimeTarget,
  type ProviderRuntimeTarget,
} from "../provider-runtime/providerRuntimeTarget.ts";
import {
  resolveWorkspaceTarget,
  type WorkspaceTarget,
} from "../workspace-target/workspaceTarget.ts";
import {
  resolveProviderSessionExecutionTargets,
  type ProviderSessionExecutionTargets,
} from "./providerSessionExecutionTargets.ts";

export interface ProviderExecutionContext {
  readonly providerRuntimeTarget: ProviderRuntimeTarget;
  readonly workspaceTarget: WorkspaceTarget;
  readonly remoteWorkspaceBridgeConfig: RemoteWorkspaceBridgeConfig | undefined;
  readonly executionTargets: ProviderSessionExecutionTargets;
}

export function resolveProviderExecutionContext(input: {
  readonly providerRuntimeExecutionTargetId?: ExecutionTargetId | null | undefined;
  readonly workspaceExecutionTargetId?: ExecutionTargetId | null | undefined;
  readonly executionTargetId?: ExecutionTargetId | null | undefined;
  readonly defaultProviderRuntimeExecutionTargetId?: ExecutionTargetId | null | undefined;
  readonly defaultWorkspaceExecutionTargetId?: ExecutionTargetId | null | undefined;
  readonly useLegacyExecutionTargetForProviderRuntime?: boolean;
  readonly cwd?: string | null | undefined;
}): ProviderExecutionContext {
  const executionTargets = resolveProviderSessionExecutionTargets(input);
  const providerRuntimeTarget = resolveProviderRuntimeTarget({
    executionTargetId: executionTargets.providerRuntimeExecutionTargetId,
  });
  const workspaceTarget = resolveWorkspaceTarget({
    executionTargetId: executionTargets.workspaceExecutionTargetId,
    cwd: input.cwd,
  });

  return {
    providerRuntimeTarget,
    workspaceTarget,
    remoteWorkspaceBridgeConfig: resolveRemoteWorkspaceBridgeConfig(workspaceTarget),
    executionTargets,
  };
}
