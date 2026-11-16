import { classifyRemoteAgentFailure } from "./remoteAgentFailure.classify.ts";
import type { RunSshCommandInput } from "../ssh/sshProcess.ts";
import { readRemoteAgentRegistryReadOnly } from "./remoteAgentReadOnlyStatus.ts";

export { buildRemoteAgentRegistryReadOnlyProbe } from "./remoteAgentReadOnlyStatus.ts";

/**
 * D5 evidence probe that never mutates an unapproved host: no directory creation, no lock, no
 * supervisor start. An unreadable or unparsable registry is not evidence of approval.
 */
export interface RemoteAgentApprovalEvidence {
  readonly approved: boolean;
  readonly unreadable: boolean;
  readonly hostTrustFailure?: string;
}

export async function readRemoteAgentApprovalEvidence(
  executionTargetId: string,
  run?: (input: RunSshCommandInput) => Promise<unknown>,
): Promise<RemoteAgentApprovalEvidence> {
  let state: Awaited<ReturnType<typeof readRemoteAgentRegistryReadOnly>>;
  try {
    state = await readRemoteAgentRegistryReadOnly(executionTargetId, run);
  } catch (cause) {
    const failure = classifyRemoteAgentFailure(cause);
    return {
      approved: false,
      unreadable: true,
      ...(failure?.kind === "ssh-host-trust" ? { hostTrustFailure: failure.message } : {}),
    };
  }
  return {
    approved:
      state?.builds.some(
        (build) => build.runtime.origin === "managed" && build.binary === "present",
      ) ?? false,
    unreadable: false,
  };
}

export async function remoteAgentHasManagedBuildReadOnly(
  executionTargetId: string,
  run?: (input: RunSshCommandInput) => Promise<unknown>,
): Promise<boolean> {
  return (await readRemoteAgentApprovalEvidence(executionTargetId, run)).approved;
}
