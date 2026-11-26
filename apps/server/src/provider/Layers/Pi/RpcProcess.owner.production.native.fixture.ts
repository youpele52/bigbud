import { ThreadId } from "@bigbud/contracts/core/baseSchemas";

import { resolveProviderRuntimeTarget } from "../../../provider-runtime/providerRuntimeTarget.ts";
import type { SshOwnerProductionHandle } from "../../../ssh/sshOwnerProductionClient.ts";
import type { SshOwnerProductionRegistration } from "../../../ssh/sshOwnerProductionRegistry.ts";
import { resolveWorkspaceTarget } from "../../../workspace-target/workspaceTarget.ts";
import type { LiveTarget } from "../OpencodeV2/ServerManager.sshOwner.production.native.fixture.ts";
import { resolveProductionPiRpcOwner } from "./RpcProcess.owner.production.ts";
import { createPiRpcProcess } from "./RpcProcess.ts";

/**
 * Shared W2 T-prov live helpers: trust a target on the production owner, register it as the live
 * owner for one target, and start Pi through the composed product path.
 *
 * @module RpcProcess.owner.production.native.fixture
 */

export async function trusted(handle: SshOwnerProductionHandle, target: LiveTarget) {
  const bound = handle.target(target.descriptor);
  const state = await bound.inspectTrust();
  if (state.state === "approvalRequired") await bound.approveTrust(state.challenge);
  return bound;
}

export const registration = (handle: SshOwnerProductionHandle, target: LiveTarget) =>
  ({ handle, descriptorFor: async () => target.descriptor }) as SshOwnerProductionRegistration;

export async function startPi(
  handle: SshOwnerProductionHandle,
  target: LiveTarget,
  thread: string,
  sessionFile?: string,
) {
  const targetId = target.descriptor.targetId;
  const selected = await resolveProductionPiRpcOwner(targetId, {
    activation: true,
    devSelected: false,
    production: () => registration(handle, target),
  });
  if (!selected) throw new Error("no production Pi owner");
  return createPiRpcProcess({
    binaryPath: "pi",
    providerRuntimeTarget: resolveProviderRuntimeTarget({ executionTargetId: targetId }),
    workspaceTarget: resolveWorkspaceTarget({ executionTargetId: targetId, cwd: target.cwd }),
    ...(sessionFile !== undefined ? { sessionFile } : {}),
    ownerBinding: { ...selected, threadId: ThreadId.makeUnsafe(thread), sessionEpoch: 1 },
  });
}
