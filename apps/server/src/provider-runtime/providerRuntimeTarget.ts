import { type ExecutionTargetId, resolveExecutionTargetId } from "@bigbud/contracts";

import { isLocalExecutionTarget } from "../executionTargets.ts";

export type ProviderRuntimeLocation = "local" | "remote";

export interface ProviderRuntimeTarget {
  readonly location: ProviderRuntimeLocation;
  readonly executionTargetId: ExecutionTargetId;
}

export function resolveProviderRuntimeTarget(input: {
  readonly executionTargetId: ExecutionTargetId | null | undefined;
}): ProviderRuntimeTarget {
  const executionTargetId = resolveExecutionTargetId(input.executionTargetId);
  return {
    location: isLocalExecutionTarget(executionTargetId) ? "local" : "remote",
    executionTargetId,
  };
}

export function isLocalProviderRuntimeTarget(target: ProviderRuntimeTarget): boolean {
  return target.location === "local";
}

export function isRemoteProviderRuntimeTarget(target: ProviderRuntimeTarget): boolean {
  return target.location === "remote";
}
