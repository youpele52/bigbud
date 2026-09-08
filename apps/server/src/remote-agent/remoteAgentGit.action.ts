import { Effect, ServiceMap } from "effect";
import type { RemoteAgentRuntimeBinding } from "./remoteAgentConnectionPool.ts";
import { remoteAgentOwners } from "./remoteAgentOwners.ts";
import { remoteAgentAdmission } from "./remoteAgentAdmission.ts";
import { remoteAgentRequestDigest } from "./remoteAgentRequestDigest.ts";
import { openRemoteAgentControl } from "./remoteAgentControl.ts";
import { pinRemoteAgentBuild } from "./remoteAgentInstall.registry.transitions.ts";
import { remoteAgentBuildId } from "./remoteAgentRuntime.ts";
import { currentRemoteAgentController } from "./remoteAgentController.ts";
import { reclaimDeadPreparedOwner } from "./remoteAgentOwners.ts";
import { scheduleRemoteAgentCleanup } from "./remoteAgentInstall.maintenance.ts";

export class RemoteAgentGitActionBinding extends ServiceMap.Service<
  RemoteAgentGitActionBinding,
  RemoteAgentRuntimeBinding
>()("bigbud/remote-agent/GitActionBinding") {}

/** Persist the logical action route before its first read or mutation, not per subcommand. */
export async function reserveRemoteAgentGitAction(
  target: string,
  actionId: string,
  request: unknown,
) {
  const store = remoteAgentOwners();
  const ownerKey = `git-action:${actionId}`;
  const digest = Buffer.from(remoteAgentRequestDigest(request)).toString("hex");
  let owner = await reclaimDeadPreparedOwner(store, await store.get(ownerKey));
  if (!owner) {
    const binding = await remoteAgentAdmission.resolveBinding(target);
    if (!binding) throw new Error("An explicit remote connection is required before Git work.");
    const controller = currentRemoteAgentController();
    owner = await store.reserve({
      ownerKey,
      invocationId: actionId,
      resourceId: actionId,
      target,
      connectionId: binding.connectionId ?? binding.runtime.generation,
      runtime: binding.runtime,
      epoch: binding.expectedEpoch,
      digest,
      controllerId: controller.id,
      controllerPid: controller.pid,
      controllerStartedAt: controller.startedAt,
      state: "prepared",
      outputSequence: 0,
      nextInputSequence: 1,
      inputAcknowledged: 0,
    });
  }
  if (owner.target !== target || owner.digest !== digest || owner.state === "terminal")
    throw new Error(
      "Git action identity is completed or conflicts with its original request; no work was redispatched.",
    );
  const control = await openRemoteAgentControl(target);
  await control.registry.update((state) =>
    pinRemoteAgentBuild(state, ownerKey, remoteAgentBuildId(owner.runtime)),
  );
  return { runtime: owner.runtime, expectedEpoch: owner.epoch, connectionId: owner.connectionId };
}

/** A completed action can be forgotten only after replay evidence is durable. */
export const completeRemoteAgentGitAction = (target: string, actionId: string) =>
  Effect.promise(async () => {
    const ownerKey = `git-action:${actionId}`;
    await remoteAgentOwners().update(ownerKey, (owner) => ({ ...owner, state: "terminal" }));
    const control = await openRemoteAgentControl(target);
    await control.registry.update((state) => ({
      ...state,
      revision: state.revision + 1,
      pins: state.pins.filter((pin) => pin.owner !== ownerKey),
    }));
    scheduleRemoteAgentCleanup(target);
  });
