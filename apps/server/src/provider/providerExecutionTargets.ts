import { type ProviderKind, resolveExecutionTargetId } from "@bigbud/contracts";

import { isLocalExecutionTarget } from "../executionTargets.ts";

export function supportsProviderExecutionTarget(input: {
  readonly provider: ProviderKind;
  readonly executionTargetId: string | null | undefined;
}): boolean {
  const executionTargetId = resolveExecutionTargetId(input.executionTargetId);
  if (isLocalExecutionTarget(executionTargetId)) {
    return true;
  }

  return input.provider === "codex" || input.provider === "opencode" || input.provider === "pi";
}

export function formatUnsupportedProviderExecutionTargetDetail(input: {
  readonly provider: ProviderKind;
  readonly executionTargetId: string | null | undefined;
  readonly surface: string;
}): string {
  return `${input.surface} is not implemented for provider '${input.provider}' on execution target '${resolveExecutionTargetId(input.executionTargetId)}' yet.`;
}
