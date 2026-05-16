import { type ExecutionTargetId, resolveExecutionTargetId } from "@bigbud/contracts";

import { isLocalExecutionTarget } from "../executionTargets.ts";

export type WorkspaceLocation = "local" | "remote";

export interface WorkspaceTarget {
  readonly location: WorkspaceLocation;
  readonly executionTargetId: ExecutionTargetId;
  readonly cwd: string | undefined;
}

interface WorkspaceExecutionTargetFields {
  readonly executionTargetId?: ExecutionTargetId | null | undefined;
  readonly workspaceExecutionTargetId?: ExecutionTargetId | null | undefined;
}

function normalizeCwd(cwd: string | null | undefined): string | undefined {
  const trimmed = cwd?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function resolveWorkspaceTarget(input: {
  readonly executionTargetId: ExecutionTargetId | null | undefined;
  readonly cwd: string | null | undefined;
}): WorkspaceTarget {
  const executionTargetId = resolveExecutionTargetId(input.executionTargetId);
  return {
    location: isLocalExecutionTarget(executionTargetId) ? "local" : "remote",
    executionTargetId,
    cwd: normalizeCwd(input.cwd),
  };
}

export function resolveWorkspaceExecutionTargetId(
  input: WorkspaceExecutionTargetFields,
): ExecutionTargetId {
  return resolveExecutionTargetId(input.workspaceExecutionTargetId ?? input.executionTargetId);
}

export function isLocalWorkspaceTarget(target: WorkspaceTarget): boolean {
  return target.location === "local";
}

export function isRemoteWorkspaceTarget(target: WorkspaceTarget): boolean {
  return target.location === "remote";
}
