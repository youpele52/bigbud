import { createHash, randomUUID } from "node:crypto";
import type { RemoteAgentRuntimeBinding } from "./remoteAgentConnectionPool.ts";
import { reclaimDeadPreparedOwner, remoteAgentOwners } from "./remoteAgentOwners.ts";
import { openRemoteAgentControl } from "./remoteAgentControl.ts";
import { remoteAgentBuildId } from "./remoteAgentRuntime.ts";
import { pinRemoteAgentBuild } from "./remoteAgentInstall.registry.transitions.ts";
import { currentRemoteAgentController } from "./remoteAgentController.ts";
import { scheduleRemoteAgentCleanup } from "./remoteAgentInstall.maintenance.ts";

export interface RemoteAgentWorkspaceMutation {
  readonly prepare: (operationId: string, digest: Uint8Array) => Promise<void>;
  readonly terminal: (operationId: string) => Promise<void>;
  readonly unknown: (operationId: string) => Promise<void>;
}

const workspaceMutationOwnerKey = (operationId: string) => `workspace-write:${operationId}`;

/** File writes have durable routing and pins, but missing responses never authorize a second write. */
export function makeRemoteAgentWorkspaceMutation(
  target: string,
  binding: RemoteAgentRuntimeBinding,
): RemoteAgentWorkspaceMutation {
  return {
    prepare: async (operationId, digest) => {
      const reservationId = randomUUID();
      const store = remoteAgentOwners();
      const controller = currentRemoteAgentController();
      await reclaimDeadPreparedOwner(
        store,
        await store.get(workspaceMutationOwnerKey(operationId)),
      );
      const owner = await store.reserve({
        ownerKey: workspaceMutationOwnerKey(operationId),
        controllerId: controller.id,
        controllerPid: controller.pid,
        controllerStartedAt: controller.startedAt,
        target,
        runtime: binding.runtime,
        epoch: binding.expectedEpoch,
        connectionId: binding.connectionId ?? binding.runtime.generation,
        resourceId: operationId,
        reservationId,
        digest:
          digest.byteLength === 32
            ? Buffer.from(digest).toString("hex")
            : createHash("sha256").update(digest).digest("hex"),
        state: "prepared",
        outputSequence: 0,
        nextInputSequence: 1,
        inputAcknowledged: 0,
      });
      if (owner.reservationId !== reservationId)
        throw new Error(
          "An existing file write cannot be replayed. Its original response is unavailable.",
        );
      let control: Awaited<ReturnType<typeof openRemoteAgentControl>>;
      try {
        control = await openRemoteAgentControl(target);
        await control.registry.update((state) =>
          pinRemoteAgentBuild(
            state,
            workspaceMutationOwnerKey(operationId),
            remoteAgentBuildId(binding.runtime),
          ),
        );
        await store.update(workspaceMutationOwnerKey(operationId), (current) => ({
          ...current,
          state: "may-have-been-sent",
        }));
      } catch (cause) {
        try {
          await store.rollbackPrepared?.(workspaceMutationOwnerKey(operationId), operationId);
        } catch {
          // Keep the durable owner when a local rollback cannot be proven.
        }
        throw cause;
      }
    },
    terminal: async (operationId) => {
      await remoteAgentOwners().update(workspaceMutationOwnerKey(operationId), (current) => ({
        ...current,
        state: "terminal",
      }));
      const control = await openRemoteAgentControl(target);
      await control.registry.update((state) => ({
        ...state,
        revision: state.revision + 1,
        pins: state.pins.filter((pin) => pin.owner !== workspaceMutationOwnerKey(operationId)),
      }));
      scheduleRemoteAgentCleanup(target);
    },
    unknown: async (operationId) => {
      await remoteAgentOwners().update(workspaceMutationOwnerKey(operationId), (current) =>
        current.state === "terminal" ? current : { ...current, state: "outcome-unknown" },
      );
    },
  };
}
