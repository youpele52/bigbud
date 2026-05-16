import {
  LOCAL_EXECUTION_TARGET_ID,
  resolveExecutionTargetId,
  type ExecutionTargetId,
} from "@bigbud/contracts";

export type ProviderRuntimeLocation = "local" | "remote";

export interface ExplicitExecutionTargets {
  readonly providerRuntimeExecutionTargetId: ExecutionTargetId;
  readonly workspaceExecutionTargetId: ExecutionTargetId;
  readonly executionTargetId: ExecutionTargetId;
}

interface ExecutionTargetFields {
  readonly executionTargetId?: ExecutionTargetId | null | undefined;
  readonly workspaceExecutionTargetId?: ExecutionTargetId | null | undefined;
  readonly providerRuntimeExecutionTargetId?: ExecutionTargetId | null | undefined;
}

export function buildExplicitExecutionTargets(input: {
  readonly workspaceExecutionTargetId?: ExecutionTargetId | null | undefined;
  readonly providerRuntimeExecutionTargetId?: ExecutionTargetId | null | undefined;
  readonly providerRuntimeLocation?: ProviderRuntimeLocation;
}): ExplicitExecutionTargets {
  const workspaceExecutionTargetId = resolveExecutionTargetId(input.workspaceExecutionTargetId);
  const providerRuntimeExecutionTargetId = resolveExecutionTargetId(
    input.providerRuntimeExecutionTargetId ??
      (input.providerRuntimeLocation === "local"
        ? LOCAL_EXECUTION_TARGET_ID
        : workspaceExecutionTargetId),
  );

  return {
    providerRuntimeExecutionTargetId,
    workspaceExecutionTargetId,
    executionTargetId: workspaceExecutionTargetId,
  };
}

export function resolveWorkspaceExecutionTargetId(input: ExecutionTargetFields): ExecutionTargetId {
  return resolveExecutionTargetId(input.workspaceExecutionTargetId ?? input.executionTargetId);
}

export function resolveProviderRuntimeExecutionTargetId(
  input: ExecutionTargetFields,
): ExecutionTargetId {
  return resolveExecutionTargetId(
    input.providerRuntimeExecutionTargetId ?? resolveWorkspaceExecutionTargetId(input),
  );
}
