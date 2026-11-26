import { isRemoteAgentExecutionTarget } from "../remote-agent/remoteAgentDefault.ts";
import type { PickerProofBoundTarget } from "../ssh/sshOwnerPickerProof.client.session.types.ts";
import { PickerProofOwnerError } from "../ssh/sshOwnerPickerProof.codec.wire.ts";
import { readSshOwnerProductionOwner } from "../ssh/sshOwnerProductionRegistry.ts";
import { descriptorServesTarget } from "../ssh/sshOwnerProductionTargets.ts";
import type { ProductionOwnerSource } from "../ssh/sshShellRunner.production.ts";
import type { WorkspaceTarget } from "../workspace-target/workspaceTarget.ts";
import {
  makeAcpTerminalApprovalProducer,
  type AcpTerminalApprovalProducer,
} from "./remoteWorkspaceAcpApproval.ts";
import { makeProductionAcpTerminalOwner } from "./remoteWorkspaceAcpTerminal.owner.production.ts";
import type { AcpTerminalSshOwner } from "./remoteWorkspaceAcpTerminal.owner.ts";
import type { SessionFsOwnerWorkspace } from "./remoteWorkspaceSessionFsBridge.owner.ts";

/**
 * W2 T-shell production ACP bridge composition. Under production activation an
 * `ssh:` remote workspace gets the same selected ACP bridge as the dev fixture:
 * bounded reads and writes through the live owner's workspace verbs (T-files)
 * on the exact target and the session's own root, and the approved `pwd`
 * terminal through the owner's ACP exec lease. There is no legacy fallback.
 *
 * @module remoteWorkspaceAcpBridge.production
 */
export interface ProductionAcpWorkspace {
  readonly sessionFsOwner: SessionFsOwnerWorkspace;
  readonly terminalOwner: AcpTerminalSshOwner;
  readonly producer: AcpTerminalApprovalProducer;
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

/** True when this workspace must use the production owner bridge. */
export function usesProductionAcpBridge(target: WorkspaceTarget): boolean {
  return (
    target.location === "remote" &&
    target.executionTargetId.startsWith("ssh:") &&
    !isRemoteAgentExecutionTarget(target.executionTargetId)
  );
}

export function makeProductionAcpWorkspace(input: {
  readonly targetId: string;
  readonly workspaceRoot: string;
  readonly owner?: ProductionOwnerSource;
}): ProductionAcpWorkspace {
  const read = input.owner ?? readSshOwnerProductionOwner;
  const { targetId, workspaceRoot } = input;
  // The generation observed on the latest resolution; approvals are bound to it.
  let generation = "";
  const resolve = async (): Promise<{ epoch: Uint8Array; bound: PickerProofBoundTarget }> => {
    const live = read();
    if (!live) throw new PickerProofOwnerError("ownerUnavailable");
    const descriptor = await live.descriptorFor(targetId);
    if (!descriptorServesTarget(descriptor, targetId))
      throw new PickerProofOwnerError("targetMismatch");
    return { epoch: live.handle.ownerEpoch, bound: live.handle.target(descriptor) };
  };
  const sessionFsOwner: SessionFsOwnerWorkspace = {
    targetId,
    workspaceRoot,
    withOwner: async (id, use) => {
      if (id !== targetId) throw new PickerProofOwnerError("targetMismatch");
      const { epoch, bound } = await resolve();
      generation = hex(bound.generation);
      // The session-FS fence compares owner epoch and target generation.
      return use({
        ownerEpoch: epoch,
        get trackedGitTargetGeneration() {
          return hex(bound.generation);
        },
        probeProofWorkspaceReadiness: (request) => bound.probeProofWorkspaceReadiness(request),
        readProofWorkspaceFile: (request) => bound.readProofWorkspaceFile(request),
        writeProofWorkspaceFile: (request) => bound.writeProofWorkspaceFile(request),
        createProofWorkspaceDirectory: (request) => bound.createProofWorkspaceDirectory(request),
        deleteProofWorkspaceEntry: (request) => bound.deleteProofWorkspaceEntry(request),
      });
    },
  };
  return {
    sessionFsOwner,
    terminalOwner: makeProductionAcpTerminalOwner({ targetId, workspaceRoot, owner: read }),
    producer: makeAcpTerminalApprovalProducer({
      targetId,
      workspaceRoot,
      generation: () => generation,
    }),
  };
}
