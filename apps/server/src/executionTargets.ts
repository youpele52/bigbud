import { LOCAL_EXECUTION_TARGET_ID, resolveExecutionTargetId } from "@bigbud/contracts";

export function isLocalExecutionTarget(executionTargetId: string | null | undefined): boolean {
  return resolveExecutionTargetId(executionTargetId) === LOCAL_EXECUTION_TARGET_ID;
}

export function formatRemoteExecutionTargetDetail(input: {
  readonly executionTargetId: string | null | undefined;
  readonly surface: string;
}): string {
  return `${input.surface} is not implemented for execution target '${resolveExecutionTargetId(input.executionTargetId)}' yet.`;
}
