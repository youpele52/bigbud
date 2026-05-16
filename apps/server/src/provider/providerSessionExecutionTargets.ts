import { LOCAL_EXECUTION_TARGET_ID, resolveExecutionTargetId } from "@bigbud/contracts";

export interface ProviderSessionExecutionTargetsInput {
  readonly providerRuntimeExecutionTargetId?: string | null | undefined;
  readonly workspaceExecutionTargetId?: string | null | undefined;
  readonly executionTargetId?: string | null | undefined;
  readonly defaultProviderRuntimeExecutionTargetId?: string | null | undefined;
  readonly defaultWorkspaceExecutionTargetId?: string | null | undefined;
  readonly useLegacyExecutionTargetForProviderRuntime?: boolean;
}

export interface ProviderSessionExecutionTargets {
  readonly providerRuntimeExecutionTargetId: string;
  readonly workspaceExecutionTargetId: string;
  readonly executionTargetId: string;
}

export function resolveProviderSessionExecutionTargets(
  input: ProviderSessionExecutionTargetsInput,
): ProviderSessionExecutionTargets {
  const legacyProviderRuntimeExecutionTargetId =
    input.useLegacyExecutionTargetForProviderRuntime === false
      ? undefined
      : input.executionTargetId;
  const workspaceExecutionTargetId = resolveExecutionTargetId(
    input.workspaceExecutionTargetId ??
      input.executionTargetId ??
      input.defaultWorkspaceExecutionTargetId ??
      LOCAL_EXECUTION_TARGET_ID,
  );
  const providerRuntimeExecutionTargetId = resolveExecutionTargetId(
    input.providerRuntimeExecutionTargetId ??
      legacyProviderRuntimeExecutionTargetId ??
      input.defaultProviderRuntimeExecutionTargetId ??
      workspaceExecutionTargetId,
  );
  return {
    providerRuntimeExecutionTargetId,
    workspaceExecutionTargetId,
    executionTargetId: workspaceExecutionTargetId,
  };
}
