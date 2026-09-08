import { type ProviderKind, resolveExecutionTargetId } from "@bigbud/contracts";

import { isLocalExecutionTarget } from "../executionTargets.ts";
import {
  getProviderCapabilities,
  type ProviderCapabilitiesResolver,
} from "./providerCapabilities.ts";
import { getProviderRemoteWorkspaceConformance } from "./providerRemoteWorkspaceConformance.ts";

export function supportsProviderExecutionTarget(
  input: {
    readonly provider: ProviderKind;
    readonly executionTargetId: string | null | undefined;
  },
  resolveCapabilities: ProviderCapabilitiesResolver = getProviderCapabilities,
): boolean {
  const executionTargetId = resolveExecutionTargetId(input.executionTargetId);
  if (isLocalExecutionTarget(executionTargetId)) {
    return true;
  }

  return resolveCapabilities(input.provider).supportsRemoteProviderRuntime;
}

export function formatUnsupportedProviderExecutionTargetDetail(input: {
  readonly provider: ProviderKind;
  readonly executionTargetId: string | null | undefined;
  readonly surface: string;
}): string {
  return `${input.surface} is not implemented for provider '${input.provider}' on execution target '${resolveExecutionTargetId(input.executionTargetId)}' yet.`;
}

export function isUnsupportedProviderLocalRuntimeRemoteWorkspace(input: {
  readonly provider: ProviderKind;
  readonly providerRuntimeExecutionTargetId: string | null | undefined;
  readonly workspaceExecutionTargetId: string | null | undefined;
}): boolean {
  return (
    isLocalExecutionTarget(input.providerRuntimeExecutionTargetId) &&
    !isLocalExecutionTarget(input.workspaceExecutionTargetId) &&
    !getProviderRemoteWorkspaceConformance(input.provider).supportsLocalRuntimeRemoteWorkspace
  );
}

export function formatUnsupportedProviderLocalRuntimeRemoteWorkspaceDetail(input: {
  readonly provider: ProviderKind;
  readonly workspaceExecutionTargetId: string;
}): string {
  const conformance = getProviderRemoteWorkspaceConformance(input.provider);
  return `Provider '${input.provider}' cannot use a local provider runtime with remote workspace target '${input.workspaceExecutionTargetId}'. ${conformance.reason}`;
}
