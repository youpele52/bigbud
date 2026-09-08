import { randomUUID } from "node:crypto";
import type {
  RemoteAgentConnectionPool,
  RemoteAgentRuntimeBinding,
} from "./remoteAgentConnectionPool.ts";
import {
  RemoteAgentProcessClient,
  RemoteAgentProcessError,
  type RemoteAgentProcessRunInput,
  type RemoteAgentProcessResult,
} from "./remoteAgentProcessClient.ts";
import {
  RemoteAgentWorkspaceClient,
  RemoteAgentWorkspaceError,
} from "./remoteAgentWorkspaceClient.ts";
import { remoteAgentAdmission } from "./remoteAgentAdmission.ts";
import { reclaimDeadPreparedOwner, remoteAgentOwners } from "./remoteAgentOwners.ts";
import { openRemoteAgentControl } from "./remoteAgentControl.ts";
import { pinRemoteAgentBuild } from "./remoteAgentInstall.registry.transitions.ts";
import { remoteAgentBuildId } from "./remoteAgentRuntime.ts";
import { currentRemoteAgentController } from "./remoteAgentController.ts";
import { scheduleRemoteAgentCleanup } from "./remoteAgentInstall.maintenance.ts";

export interface OwnedRemoteProcessInput {
  readonly binding?: RemoteAgentRuntimeBinding;
  readonly invocationId?: string;
  readonly ownerKey: string;
  readonly target: string;
  readonly cwd: string;
  readonly request: RemoteAgentProcessRunInput;
  readonly newAfterTerminal?: boolean;
}
export type OwnedRemoteProcessRunner = (
  input: OwnedRemoteProcessInput,
) => Promise<RemoteAgentProcessResult>;

/** Retryable application invocations resolve their original durable route before any dispatch. */
export function makeOwnedRemoteAgentProcess(
  pool: RemoteAgentConnectionPool,
): OwnedRemoteProcessRunner {
  return async (input) => {
    const store = remoteAgentOwners();
    let owner = await reclaimDeadPreparedOwner(store, await store.get(input.ownerKey));
    let created = false;
    const digest = Buffer.from(input.request.requestDigest).toString("hex");
    const invocationId = input.invocationId ?? input.request.operationId;
    const controller = currentRemoteAgentController();
    if (
      !owner ||
      owner.state === "prepared" ||
      (owner.state === "terminal" && input.newAfterTerminal && owner.invocationId !== invocationId)
    ) {
      const binding =
        owner?.state === "prepared"
          ? {
              runtime: owner.runtime,
              expectedEpoch: owner.epoch,
              connectionId: owner.connectionId,
            }
          : (input.binding ?? (await remoteAgentAdmission.resolveBinding(input.target)));
      if (!binding) throw new Error("An explicit remote connection is required before dispatch.");
      const resourceId = randomUUID();
      const reservationId = randomUUID();
      owner = await store.reserve(
        {
          ownerKey: input.ownerKey,
          controllerId: controller.id,
          controllerPid: controller.pid,
          controllerStartedAt: controller.startedAt,
          invocationId,
          reservationId,
          target: input.target,
          connectionId: binding.connectionId ?? binding.runtime.generation,
          runtime: binding.runtime,
          epoch: binding.expectedEpoch,
          resourceId,
          digest,
          state: "prepared",
          outputSequence: 0,
          nextInputSequence: 1,
          inputAcknowledged: 0,
        },
        input.newAfterTerminal,
      );
      created = owner.reservationId === reservationId;
    }
    if (!created && owner.state === "prepared" && owner.reservationId)
      throw new RemoteAgentProcessError(
        "PROCESS_IN_PROGRESS",
        "Another request is preparing this remote process; no duplicate dispatch was attempted.",
        "rejected",
      );
    if (
      owner.target !== input.target ||
      owner.digest !== digest ||
      (owner.invocationId && owner.invocationId !== invocationId)
    )
      throw new RemoteAgentProcessError(
        "PROCESS_OUTCOME_UNKNOWN",
        "Existing invocation has unresolved work with another request identity.",
      );
    const binding = { runtime: owner.runtime, expectedEpoch: owner.epoch };
    const clientFor = async (): Promise<RemoteAgentProcessClient> =>
      new RemoteAgentProcessClient(
        await pool.getBound(owner.target, binding, [
          "process.run",
          "process.attach",
          "workspace.files",
        ]),
        clientFor,
      );
    const rollbackPrepared = async () => {
      if (!created) return;
      await store.rollbackPrepared?.(input.ownerKey, owner.resourceId);
    };
    let client: RemoteAgentProcessClient;
    let control: Awaited<ReturnType<typeof openRemoteAgentControl>>;
    try {
      client = await clientFor();
      control = await openRemoteAgentControl(owner.target);
    } catch (cause) {
      try {
        await rollbackPrepared();
      } catch {
        // Keep the durable owner when a local rollback cannot be proven.
      }
      throw cause;
    }
    const buildId = remoteAgentBuildId(owner.runtime);
    const pinOwner = `${input.ownerKey}:${owner.resourceId}`;
    let result: RemoteAgentProcessResult;
    let workspaceRequestSent = false;
    try {
      await control.registry.update((state) => pinRemoteAgentBuild(state, pinOwner, buildId));
      if (!created || owner.state !== "prepared") {
        // Output acknowledgements may outlive the process that held their bytes. Never invent a full result.
        result = await client.attach({ operationId: owner.resourceId });
      } else {
        await store.update(input.ownerKey, (current) => ({
          ...current,
          state: "may-have-been-sent",
        }));
        workspaceRequestSent = true;
        await new RemoteAgentWorkspaceClient(client.connection).openWorkspace(
          input.request.workspaceHandle,
          input.cwd,
        );
        result = await client.run({ ...input.request, operationId: owner.resourceId });
      }
    } catch (cause) {
      const terminal =
        owner.state === "terminal" ||
        cause instanceof RemoteAgentWorkspaceError ||
        (cause instanceof RemoteAgentProcessError && cause.outcome !== "unknown");
      const resourceId = owner.resourceId;
      if (!workspaceRequestSent && !terminal && created) {
        try {
          await rollbackPrepared();
        } catch {
          // Keep the durable owner when a local rollback cannot be proven.
        }
      } else {
        await store.update(input.ownerKey, (current) =>
          current.resourceId !== resourceId
            ? current
            : { ...current, state: terminal ? "terminal" : "outcome-unknown" },
        );
      }
      if (terminal)
        await control.registry.update((state) => ({
          ...state,
          revision: state.revision + 1,
          pins: state.pins.filter((pin) => pin.owner !== pinOwner),
        }));
      if (terminal) scheduleRemoteAgentCleanup(owner.target);
      throw cause;
    }
    await store.update(input.ownerKey, (current) =>
      current.resourceId !== owner.resourceId ? current : { ...current, state: "terminal" },
    );
    await control.registry.update((state) => ({
      ...state,
      revision: state.revision + 1,
      pins: state.pins.filter((pin) => pin.owner !== pinOwner),
    }));
    scheduleRemoteAgentCleanup(owner.target);
    return result;
  };
}

export async function cancelOwnedRemoteProcess(
  pool: RemoteAgentConnectionPool,
  key: string,
): Promise<void> {
  const store = remoteAgentOwners();
  const owner = await store.get(key);
  if (!owner || owner.state === "terminal") return;
  const connection = await pool.getBound(owner.target, {
    runtime: owner.runtime,
    expectedEpoch: owner.epoch,
  });
  await new RemoteAgentProcessClient(connection).cancelAndWait({ operationId: owner.resourceId });
  await store.update(key, (current) =>
    current.resourceId !== owner.resourceId ? current : { ...current, state: "terminal" },
  );
  const control = await openRemoteAgentControl(owner.target);
  await control.registry.update((state) => ({
    ...state,
    revision: state.revision + 1,
    pins: state.pins.filter((pin) => pin.owner !== `${key}:${owner.resourceId}`),
  }));
  scheduleRemoteAgentCleanup(owner.target);
}
