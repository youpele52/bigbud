import {
  isRemoteAgentTargetApproved,
  resolveRemoteAgentTarget,
  type RemoteAgentSavedTarget,
} from "../remote-agent/remoteAgentLocalControl.targets.ts";
import type { RemoteAgentApprovalEvidence } from "../remote-agent/remoteAgentLocalControl.approval.ts";
import { deploymentError, type DeploymentApproval } from "./deployment.types.ts";

/**
 * D5, reused unchanged: a host is approved when a saved project uses the remote agent for exactly
 * this target, or its registry already holds a managed build (read-only probe). Deployment never
 * asks for consent itself; an unapproved host is refused before any remote mutation.
 */
export function makeDeploymentApproval(input: {
  readonly listSavedTargets: () => Promise<ReadonlyArray<RemoteAgentSavedTarget>>;
  readonly evidence: (executionTargetId: string) => Promise<RemoteAgentApprovalEvidence>;
}) {
  return async (executionTargetId: string): Promise<DeploymentApproval> => {
    const saved = await input.listSavedTargets();
    const resolved = resolveRemoteAgentTarget(executionTargetId, saved);
    if (!resolved.ok || resolved.executionTargetId !== executionTargetId)
      throw deploymentError(
        "invalid-target",
        "Deployment needs an exact SSH remote-agent target ID, not an alias.",
      );
    let hostTrustFailure: string | undefined;
    const approved = await isRemoteAgentTargetApproved({
      executionTargetId,
      saved: resolved.saved,
      hasManagedBuild: async (target) => {
        const evidence = await input.evidence(target);
        hostTrustFailure = evidence.hostTrustFailure;
        return evidence.approved;
      },
    });
    return { approved, ...(hostTrustFailure ? { hostTrustFailure } : {}) };
  };
}
